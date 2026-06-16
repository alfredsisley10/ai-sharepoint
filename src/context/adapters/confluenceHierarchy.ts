import { ContextSource, ContextCredential, ReadCaps } from "../types";
import { fetchJson } from "../http";

/**
 * Confluence page HIERARCHY & RELATIONSHIPS (ADR-0044). The connector could
 * read a page and its immediate parent, but had no way to walk the tree —
 * enumerate a page's CHILDREN, its full ANCESTOR path, or a whole SUBTREE — and
 * every listing it did do truncated at a single `limit` with no pagination, so
 * large spaces/subtrees came back incomplete. This module fixes both:
 *
 *  - `getPageAncestors`  — the breadcrumb (root → … → immediate parent).
 *  - `getChildPages`     — the immediate children (fully paginated).
 *  - `getDescendantPages`— the whole subtree, flattened, each carrying its
 *                          immediate parent so a real tree can be assembled.
 *  - `getSpaceRootPages` — the top of a space's tree.
 *  - `getPageHierarchy`  — ancestors + the page + its children, in one read.
 *  - `buildPageTree`     — pure: flat descendants → nested tree.
 *
 * Confluence content lists paginate with `start`+`limit`; `fetchAllPages`
 * follows them to completion (bounded by a generous hard cap) so enumeration is
 * COMPLETE, not truncated.
 */

const enc = encodeURIComponent;

function baseOf(source: Pick<ContextSource, "baseUrl">): string {
  return source.baseUrl.replace(/\/$/, "");
}

function webUrl(source: Pick<ContextSource, "baseUrl">, webui?: string): string {
  return webui ? `${baseOf(source)}${webui}` : baseOf(source);
}

export interface PageRef {
  id: string;
  title: string;
  url: string;
}

export interface PageNode extends PageRef {
  children: PageNode[];
}

interface ContentResult {
  id?: string;
  title?: string;
  _links?: { webui?: string };
  ancestors?: Array<{ id?: string }>;
}

function toRef(source: ContextSource, c: ContentResult): PageRef {
  return { id: String(c.id ?? ""), title: c.title ?? "(untitled)", url: webUrl(source, c._links?.webui) };
}

/**
 * Fetch EVERY page of a paginated content listing by walking `start` until a
 * short page (or the hard cap) is hit. The single-`limit` calls elsewhere
 * truncate; this doesn't. `pageSize` is the per-request batch.
 */
export async function fetchAllPages(
  credential: ContextCredential,
  url: (start: number, limit: number) => string,
  caps: ReadCaps,
  hardCap = 2000,
  pageSize = 100,
): Promise<ContentResult[]> {
  const out: ContentResult[] = [];
  for (let start = 0; out.length < hardCap; start += pageSize) {
    const res = await fetchJson<{ results?: ContentResult[] }>(url(start, pageSize), credential, caps.timeoutMs);
    const batch = res.results ?? [];
    out.push(...batch);
    if (batch.length < pageSize) break;
  }
  return out.slice(0, hardCap);
}

export interface AncestorsResult {
  page: PageRef;
  /** Root → … → immediate parent (empty for a root page). */
  ancestors: PageRef[];
  parent?: PageRef;
  spaceKey?: string;
}

/** The page's breadcrumb: its ordered ancestor path (root first) + space. */
export async function getPageAncestors(
  source: ContextSource,
  credential: ContextCredential,
  pageId: string,
  caps: ReadCaps,
): Promise<AncestorsResult> {
  const c = await fetchJson<{
    id?: string;
    title?: string;
    _links?: { webui?: string };
    space?: { key?: string };
    ancestors?: ContentResult[];
  }>(`${baseOf(source)}/rest/api/content/${enc(pageId)}?expand=ancestors,space`, credential, caps.timeoutMs);
  const ancestors = (c.ancestors ?? []).map((a) => toRef(source, a));
  return {
    page: toRef(source, c),
    ancestors,
    ...(ancestors.length ? { parent: ancestors[ancestors.length - 1] } : {}),
    ...(c.space?.key ? { spaceKey: c.space.key } : {}),
  };
}

/** A page's IMMEDIATE children (fully paginated). */
export async function getChildPages(
  source: ContextSource,
  credential: ContextCredential,
  pageId: string,
  caps: ReadCaps,
  hardCap = 1000,
): Promise<PageRef[]> {
  const results = await fetchAllPages(
    credential,
    (start, limit) => `${baseOf(source)}/rest/api/content/${enc(pageId)}/child/page?start=${start}&limit=${limit}`,
    caps,
    hardCap,
  );
  return results.map((c) => toRef(source, c)).filter((p) => p.id);
}

/** The whole SUBTREE under a page, flattened — each node carries its immediate
 *  parent id (last ancestor) so buildPageTree can nest them. */
export async function getDescendantPages(
  source: ContextSource,
  credential: ContextCredential,
  pageId: string,
  caps: ReadCaps,
  hardCap = 2000,
): Promise<Array<PageRef & { parentId?: string }>> {
  const results = await fetchAllPages(
    credential,
    (start, limit) =>
      `${baseOf(source)}/rest/api/content/${enc(pageId)}/descendant/page?expand=ancestors&start=${start}&limit=${limit}`,
    caps,
    hardCap,
  );
  return results
    .map((c) => {
      const anc = c.ancestors ?? [];
      const parentId = anc.length ? String(anc[anc.length - 1].id ?? "") : undefined;
      return { ...toRef(source, c), ...(parentId ? { parentId } : {}) };
    })
    .filter((p) => p.id);
}

/** A space's ROOT pages (the top of its tree), fully paginated. */
export async function getSpaceRootPages(
  source: ContextSource,
  credential: ContextCredential,
  spaceKey: string,
  caps: ReadCaps,
  hardCap = 1000,
): Promise<PageRef[]> {
  const results = await fetchAllPages(
    credential,
    (start, limit) =>
      `${baseOf(source)}/rest/api/space/${enc(spaceKey)}/content/page?depth=root&start=${start}&limit=${limit}`,
    caps,
    hardCap,
  );
  return results.map((c) => toRef(source, c)).filter((p) => p.id);
}

export interface PageHierarchy {
  page: PageRef;
  ancestors: PageRef[];
  parent?: PageRef;
  children: PageRef[];
  childCount: number;
  spaceKey?: string;
}

/** Everything about a page's place in the tree in one read: its breadcrumb
 *  (ancestors), immediate parent, and immediate children. */
export async function getPageHierarchy(
  source: ContextSource,
  credential: ContextCredential,
  pageId: string,
  caps: ReadCaps,
): Promise<PageHierarchy> {
  const [anc, children] = await Promise.all([
    getPageAncestors(source, credential, pageId, caps),
    getChildPages(source, credential, pageId, caps),
  ]);
  return {
    page: anc.page,
    ancestors: anc.ancestors,
    ...(anc.parent ? { parent: anc.parent } : {}),
    children,
    childCount: children.length,
    ...(anc.spaceKey ? { spaceKey: anc.spaceKey } : {}),
  };
}

/**
 * Assemble a nested tree from a flat descendant list (each node carrying its
 * immediate parentId) rooted at `root`. Nodes whose parent isn't in the set
 * attach to the root (defensive). Pure.
 */
export function buildPageTree(root: PageRef, nodes: Array<PageRef & { parentId?: string }>): PageNode {
  const byId = new Map<string, PageNode>();
  const rootNode: PageNode = { ...root, children: [] };
  byId.set(root.id, rootNode);
  for (const n of nodes) byId.set(n.id, { id: n.id, title: n.title, url: n.url, children: [] });
  for (const n of nodes) {
    const parent = (n.parentId && byId.get(n.parentId)) || rootNode;
    parent.children.push(byId.get(n.id)!);
  }
  return rootNode;
}

/** Count the nodes in a tree (excluding the root). Pure. */
export function countTreeNodes(node: PageNode): number {
  return node.children.reduce((sum, c) => sum + 1 + countTreeNodes(c), 0);
}

/** Render a tree as an indented outline for the model. Pure. */
export function renderPageTree(node: PageNode, maxDepth = 8): string {
  const lines: string[] = [];
  const walk = (n: PageNode, depth: number) => {
    lines.push(`${"  ".repeat(depth)}- ${n.title} (${n.id})`);
    if (depth < maxDepth) for (const c of n.children) walk(c, depth + 1);
    else if (n.children.length) lines.push(`${"  ".repeat(depth + 1)}… ${n.children.length} more (depth limit)`);
  };
  walk(node, 0);
  return lines.join("\n");
}

/** Discriminated result of a hierarchy exploration (built by contextService,
 *  rendered by the chat tool). */
export type HierarchyResult =
  | { kind: "context"; hierarchy: PageHierarchy }
  | { kind: "ancestors"; ancestors: AncestorsResult }
  | { kind: "children"; page: PageRef; children: PageRef[] }
  | { kind: "subtree"; root: PageRef; tree: PageNode; count: number }
  | { kind: "roots"; spaceKey: string; roots: PageRef[] };

