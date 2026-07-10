import { ContextSource, ContextCredential, ReadCaps } from "../types";
import { fetchJson } from "../http";
import { classifyError } from "../../core/errors";
import { enc, baseOf, webUrl } from "./confluenceCommon";

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
 * Fetch EVERY page of a paginated content listing by walking `start` until an
 * EMPTY batch (or the hard cap) is hit. The single-`limit` calls elsewhere
 * truncate; this doesn't. `pageSize` is the per-request batch — but Confluence
 * may CLAMP the effective page size below the requested `limit`, so a
 * short-but-nonempty batch is NOT proof of the last page (stopping there
 * silently truncated large listings to one clamped batch). `start` therefore
 * advances by what was actually RECEIVED, and when the response exposes a
 * top-level `_links`, the absence of `_links.next` is trusted as the server's
 * own authoritative last-page signal (saving the trailing empty-batch read).
 */
export async function fetchAllPages(
  credential: ContextCredential,
  url: (start: number, limit: number) => string,
  caps: ReadCaps,
  hardCap = 2000,
  pageSize = 100,
): Promise<ContentResult[]> {
  const out: ContentResult[] = [];
  let start = 0;
  while (out.length < hardCap) {
    const res = await fetchJson<{ results?: ContentResult[]; _links?: { next?: string } }>(
      url(start, pageSize),
      credential,
      caps.timeoutMs,
    );
    const batch = res.results ?? [];
    out.push(...batch);
    if (batch.length === 0) break;
    if (res._links && !res._links.next) break;
    start += batch.length;
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
 *  parent id (last ancestor) so buildPageTree can nest them.
 *
 *  Reliability (the reported "500 when viewing subtree views"): Confluence's
 *  `descendant/page` endpoint materializes the ENTIRE subtree server-side in one
 *  shot — and `expand=ancestors` re-expands the breadcrumb for every node — so on
 *  large or deeply-nested trees (and on Data Center in particular) it routinely
 *  answers **500**. So it's a FAST PATH only: when it errors with a server/network
 *  failure we fall back to a bounded, breadth-first walk over the cheap, stable
 *  single-level `child/page` endpoint, which never 500s the way the whole-subtree
 *  materialization does, needs no `expand`, and degrades per-branch (one
 *  unreadable node is skipped, not fatal). Auth / permission / not-found errors
 *  are NOT retried this way — a different endpoint won't fix them. */
export async function getDescendantPages(
  source: ContextSource,
  credential: ContextCredential,
  pageId: string,
  caps: ReadCaps,
  hardCap = 2000,
): Promise<Array<PageRef & { parentId?: string }>> {
  try {
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
  } catch (err) {
    // A server/upstream error (500/502/504, timeout, non-JSON block page →
    // classified network/unknown) is exactly the case the child-walk recovers.
    // Anything terminal (bad credential, forbidden, not-found) is rethrown.
    const code = classifyError(err);
    if (code !== "network" && code !== "unknown") throw err;
    return walkDescendantsByChildren(source, credential, pageId, caps, hardCap);
  }
}

/**
 * Enumerate a subtree by walking `child/page` breadth-first from the root — the
 * resilient fallback for `getDescendantPages` when the whole-subtree
 * `descendant/page` endpoint 500s. Each discovered page carries its immediate
 * `parentId` (the node we found it under), so `buildPageTree` nests it exactly
 * as the fast path would. Bounded by `hardCap` (total pages) and `maxDepth`
 * (levels), and a `seen` set guards against cycles/re-parenting. A single branch
 * that fails to list (a restricted or transiently-erroring node) is skipped so
 * one bad page can't sink the whole tree; a session-wide auth failure still
 * aborts.
 */
export async function walkDescendantsByChildren(
  source: ContextSource,
  credential: ContextCredential,
  rootId: string,
  caps: ReadCaps,
  hardCap = 2000,
  maxDepth = 15,
): Promise<Array<PageRef & { parentId?: string }>> {
  const out: Array<PageRef & { parentId: string }> = [];
  const seen = new Set<string>([rootId]);
  let frontier = [rootId];
  for (let depth = 0; depth < maxDepth && frontier.length && out.length < hardCap; depth += 1) {
    const next: string[] = [];
    for (const parentId of frontier) {
      if (out.length >= hardCap) break;
      let children: PageRef[];
      try {
        children = await getChildPages(source, credential, parentId, caps, Math.min(1000, hardCap));
      } catch (err) {
        // A bad credential invalidates the whole walk; any other single-node
        // failure (a restricted page, a transient 500 on one node) is skipped.
        if (classifyError(err) === "auth.failed") throw err;
        continue;
      }
      for (const child of children) {
        if (!child.id || seen.has(child.id) || out.length >= hardCap) continue;
        seen.add(child.id);
        out.push({ ...child, parentId });
        next.push(child.id);
      }
    }
    frontier = next;
  }
  return out.slice(0, hardCap);
}

/** EVERY page in a space, flat and fully paginated, in a single sweep.
 *
 *  For a whole-space pass (the dossier), enumerating root pages and then
 *  recursively walking each root's subtree issues one request per interior
 *  node and re-materializes overlapping subtrees; the flat `content?spaceKey=`
 *  listing returns the same set in `total/pageSize` requests with no per-node
 *  tree walk. Tree *shape* is lost (no parentId), which the dossier doesn't
 *  need — it reviews each page independently. */
export async function getSpacePages(
  source: ContextSource,
  credential: ContextCredential,
  spaceKey: string,
  caps: ReadCaps,
  hardCap = 2000,
): Promise<PageRef[]> {
  const results = await fetchAllPages(
    credential,
    (start, limit) =>
      `${baseOf(source)}/rest/api/content?spaceKey=${enc(spaceKey)}&type=page&start=${start}&limit=${limit}`,
    caps,
    hardCap,
  );
  return results.map((c) => toRef(source, c)).filter((p) => p.id);
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

/** Flatten a tree back to a list in DFS (parent-before-children) order, each
 *  node carrying its immediate `parentId` and `depth` (root = 0). The
 *  area-scoped dossier enumerates in this order so an inventory indented by
 *  depth reads as the tree; orphans buildPageTree re-parented to the root come
 *  out at depth 1 like any other direct child. Pure. */
export function flattenPageTree(root: PageNode): Array<PageRef & { parentId?: string; depth: number }> {
  const out: Array<PageRef & { parentId?: string; depth: number }> = [];
  const walk = (n: PageNode, depth: number, parentId?: string) => {
    out.push({ id: n.id, title: n.title, url: n.url, depth, ...(parentId ? { parentId } : {}) });
    for (const c of n.children) walk(c, depth + 1, n.id);
  };
  walk(root, 0);
  return out;
}

/** The views of the page tree that are cached read-through (TtlCache). */
export type HierarchyCacheView = "ancestors" | "children" | "descendants" | "roots";

/** Cache locator for a NAVIGATION read — the single key shape shared by the
 *  hierarchy tool and the dossier's area walk, so a subtree explored moments
 *  ago is reused by the dossier (and vice versa) instead of re-walked. Pure;
 *  contextService prefixes it with the source id via TtlCache.key. */
export function hierarchyCacheLocator(view: HierarchyCacheView, target: string): string {
  return `${view}:${target}`;
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

