import { ContextSource, ContextCredential, ReadCaps } from "../types";
import { fetchJson, htmlToText } from "../http";

/**
 * Confluence "authoritative source" construct (ADR-0040). Declare a **space**,
 * **page**, or **subtree** (a page + its descendants) as authoritative for a
 * **topic**, then use it as the baseline to sweep the REST of Confluence for
 * **conflicting or misleading** content that needs cleanup — because we don't
 * control what others publish about a topic.
 *
 * Reusable primitives (the agent does the actual compare/flag):
 *  - a self-describing **authority label** `authoritative|<topic-slug>`;
 *  - **gather** the authoritative content (the truth for the topic);
 *  - **find conflict candidates** elsewhere in Confluence (topic search that
 *    excludes the authoritative scope).
 */

const enc = encodeURIComponent;
const baseOf = (source: Pick<ContextSource, "baseUrl">): string => source.baseUrl.replace(/\/$/, "");
const webUrl = (source: Pick<ContextSource, "baseUrl">, webui?: string): string =>
  webui ? `${baseOf(source)}${webui}` : baseOf(source);

export const DEFAULT_AUTHORITY_MARKER = "authoritative";

/** Topic → a Confluence-label-safe slug (lowercase, hyphenated, bounded). */
export function topicSlug(topic: string): string {
  return (topic ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** Build an authority label `authoritative|<topic-slug>`. */
export function buildAuthorityLabel(topic: string, marker = DEFAULT_AUTHORITY_MARKER): string {
  return `${marker.toLowerCase()}|${topicSlug(topic)}`;
}

/** Parse an authority label → topic slug, or undefined if it isn't one. */
export function parseAuthorityLabel(label: string, marker = DEFAULT_AUTHORITY_MARKER): string | undefined {
  const parts = (label ?? "").split("|").map((p) => p.trim()).filter(Boolean);
  if (parts.length !== 2 || parts[0].toLowerCase() !== marker.toLowerCase()) return undefined;
  return parts[1].toLowerCase();
}

/** Topics a content item declares itself authoritative for (from its labels). */
export function findAuthorityTopics(labels: string[], marker = DEFAULT_AUTHORITY_MARKER): string[] {
  return [...new Set(labels.map((l) => parseAuthorityLabel(l, marker)).filter((t): t is string => !!t))];
}

export type AuthorityScopeKind = "space" | "page" | "subtree";

export interface AuthorityScope {
  /** Free-text topic (used for the conflict search) and/or its slug. */
  topic: string;
  kind: AuthorityScopeKind;
  /** Whole-space scope, and the space to exclude from the conflict sweep. */
  spaceKey?: string;
  /** Page (kind "page") or subtree root (kind "subtree"). */
  pageId?: string;
}

export interface ScopePage {
  id: string;
  title: string;
  text: string;
  url: string;
}

interface ContentItem {
  id?: string;
  title?: string;
  body?: { storage?: { value?: string } };
  _links?: { webui?: string };
}

function toScopePage(source: ContextSource, c: ContentItem, maxBodyChars: number): ScopePage {
  return {
    id: String(c.id ?? ""),
    title: c.title ?? "(untitled)",
    text: htmlToText(c.body?.storage?.value ?? "", maxBodyChars),
    url: webUrl(source, c._links?.webui),
  };
}

/** Gather the authoritative content for a scope (bounded), as plain text. */
export async function gatherAuthorityPages(
  source: ContextSource,
  credential: ContextCredential,
  scope: AuthorityScope,
  caps: ReadCaps,
  maxPages = 50,
): Promise<ScopePage[]> {
  const base = baseOf(source);
  if (scope.kind === "page") {
    if (!scope.pageId) return [];
    const c = await fetchJson<ContentItem>(
      `${base}/rest/api/content/${enc(scope.pageId)}?expand=body.storage`,
      credential,
      caps.timeoutMs,
    );
    return [toScopePage(source, c, caps.maxBodyChars)];
  }
  const path =
    scope.kind === "subtree" && scope.pageId
      ? `${base}/rest/api/content/${enc(scope.pageId)}/descendant/page?expand=body.storage&limit=${maxPages}`
      : `${base}/rest/api/content?spaceKey=${enc(scope.spaceKey ?? "")}&type=page&expand=body.storage&limit=${maxPages}`;
  const res = await fetchJson<{ results?: ContentItem[] }>(path, credential, caps.timeoutMs);
  const pages = (res.results ?? []).map((c) => toScopePage(source, c, caps.maxBodyChars));
  // A subtree's authoritative content includes the root page itself.
  if (scope.kind === "subtree" && scope.pageId && !pages.some((p) => p.id === scope.pageId)) {
    const root = await fetchJson<ContentItem>(
      `${base}/rest/api/content/${enc(scope.pageId)}?expand=body.storage`,
      credential,
      caps.timeoutMs,
    ).catch(() => undefined);
    if (root) pages.unshift(toScopePage(source, root, caps.maxBodyChars));
  }
  return pages;
}

/** Build the CQL to find pages about a topic, optionally excluding a space
 *  (the authoritative space). Pure/testable. */
export function buildTopicSearchCql(topic: string, excludeSpaceKey?: string): string {
  const q = topic.replace(/"/g, '\\"');
  return [`type = page`, `text ~ "${q}"`, ...(excludeSpaceKey ? [`space != "${excludeSpaceKey}"`] : [])].join(" AND ");
}

export interface ConflictCandidate {
  id: string;
  title: string;
  url: string;
  excerpt?: string;
  space?: string;
}

/** Find candidate pages elsewhere in Confluence that discuss the topic and may
 *  conflict with the authoritative scope. Excludes the authoritative space (via
 *  CQL) and the authoritative page ids (post-filter). The agent then compares
 *  each candidate against the gathered authoritative content. */
export async function findConflictCandidates(
  source: ContextSource,
  credential: ContextCredential,
  topic: string,
  exclude: { spaceKey?: string; pageIds?: string[] },
  caps: ReadCaps,
): Promise<ConflictCandidate[]> {
  const cql = buildTopicSearchCql(topic, exclude.spaceKey);
  const res = await fetchJson<{
    results?: Array<{
      content?: { id?: string; title?: string; _links?: { webui?: string }; space?: { key?: string } };
      title?: string;
      excerpt?: string;
      _links?: { webui?: string };
    }>;
  }>(`${baseOf(source)}/rest/api/search?cql=${enc(cql)}&limit=${caps.maxResults}`, credential, caps.timeoutMs);
  const excludeIds = new Set((exclude.pageIds ?? []).map(String));
  const out: ConflictCandidate[] = [];
  for (const r of res.results ?? []) {
    const id = String(r.content?.id ?? "");
    if (!id || excludeIds.has(id)) continue;
    out.push({
      id,
      title: r.content?.title ?? r.title ?? "(untitled)",
      url: webUrl(source, r.content?._links?.webui ?? r._links?.webui),
      ...(r.excerpt ? { excerpt: htmlToText(r.excerpt, 300) } : {}),
      ...(r.content?.space?.key ? { space: r.content.space.key } : {}),
    });
    if (out.length >= caps.maxResults) break;
  }
  return out;
}
