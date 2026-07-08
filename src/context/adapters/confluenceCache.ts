import { ContextSource, ContextCredential, ReadCaps } from "../types";
import { fetchJson, htmlToText } from "../http";
import type { AuthorityScope } from "./confluenceAuthority";
import { enc, baseOf, webUrl } from "./confluenceCommon";

/**
 * Confluence local content cache (ADR-0042): snapshot the essential content of
 * a space / subtree / page locally so frequently-used data is fast during
 * cleanup or design initiatives (no re-fetch per analysis pass). Each entry
 * keeps the page **version**, so the cache doubles as the drift baseline —
 * "know we're not deploying onto a page that changed underneath us."
 *
 * The cache is persistence-agnostic: it holds entries in memory and
 * serializes to a plain array the caller persists (globalState / storage).
 */


export interface ConfluencePageCacheEntry {
  id: string;
  title: string;
  version: number;
  bodyText: string;
  labels: string[];
  parentId?: string;
  spaceKey?: string;
  webUrl: string;
  cachedAt: string;
}

interface ContentItem {
  id?: string;
  title?: string;
  version?: { number?: number };
  space?: { key?: string };
  ancestors?: Array<{ id?: string }>;
  body?: { storage?: { value?: string } };
  metadata?: { labels?: { results?: Array<{ name?: string }> } };
  _links?: { webui?: string };
}

/** The expand needed to populate a cache entry in one read. */
export const CACHE_EXPAND = "body.storage,version,space,ancestors,metadata.labels";

/** Map a Confluence content payload (expanded per CACHE_EXPAND) → cache entry. */
export function buildCacheEntry(
  source: ContextSource,
  content: ContentItem,
  maxBodyChars: number,
  now: () => string,
): ConfluencePageCacheEntry {
  const ancestors = content.ancestors ?? [];
  const labels = (content.metadata?.labels?.results ?? []).map((l) => String(l.name ?? "")).filter(Boolean);
  return {
    id: String(content.id ?? ""),
    title: content.title ?? "(untitled)",
    version: content.version?.number ?? 1,
    bodyText: htmlToText(content.body?.storage?.value ?? "", maxBodyChars),
    labels,
    ...(ancestors.length ? { parentId: String(ancestors[ancestors.length - 1].id) } : {}),
    ...(content.space?.key ? { spaceKey: content.space.key } : {}),
    webUrl: webUrl(source, content._links?.webui),
    cachedAt: now(),
  };
}

export interface StaleEntry {
  id: string;
  title: string;
  cachedVersion: number;
  liveVersion: number;
}

/** In-memory content cache for one source, with serialize/load + drift check. */
export class ConfluenceContentCache {
  private readonly entries = new Map<string, ConfluencePageCacheEntry>();

  /** True when the most recent `cacheConfluenceScope` snapshot hit its page
   *  cap — pages beyond the cap are NOT in the cache, so review passes and
   *  drift checks over that scope are PARTIAL and any note built on them must
   *  say so. Runtime-only (not serialized). */
  lastSnapshotTruncated = false;

  constructor(readonly sourceId: string, initial: ConfluencePageCacheEntry[] = []) {
    for (const e of initial) this.entries.set(e.id, e);
  }

  put(entry: ConfluencePageCacheEntry): void {
    if (entry.id) this.entries.set(entry.id, entry);
  }

  get(pageId: string): ConfluencePageCacheEntry | undefined {
    return this.entries.get(pageId);
  }

  list(): ConfluencePageCacheEntry[] {
    return [...this.entries.values()];
  }

  bySpace(spaceKey: string): ConfluencePageCacheEntry[] {
    return this.list().filter((e) => e.spaceKey === spaceKey);
  }

  size(): number {
    return this.entries.size;
  }

  serialize(): ConfluencePageCacheEntry[] {
    return this.list();
  }

  /** Cached pages whose live version differs from the cached one (drift). Only
   *  considers pages present in BOTH the cache and the `live` map. */
  stale(live: Map<string, number>): StaleEntry[] {
    const out: StaleEntry[] = [];
    for (const e of this.entries.values()) {
      const liveVersion = live.get(e.id);
      if (liveVersion !== undefined && liveVersion !== e.version) {
        out.push({ id: e.id, title: e.title, cachedVersion: e.version, liveVersion });
      }
    }
    return out;
  }
}

/**
 * Walk a `start`+`limit` content listing to completion, bounded by `hardCap`,
 * and report whether the cap TRUNCATED the listing. Termination mirrors the
 * hierarchy module's `fetchAllPages`: only an EMPTY batch — or the server's
 * own absent `_links.next` — proves the last page, because Confluence may
 * clamp the effective page size below the requested `limit` (a single
 * `limit=N` request silently truncated the snapshot/drift listing to the
 * first clamped batch, with no indication anything was missing).
 */
async function fetchAllItems(
  credential: ContextCredential,
  url: (start: number, limit: number) => string,
  caps: ReadCaps,
  hardCap: number,
  pageSize = 100,
): Promise<{ items: ContentItem[]; truncated: boolean }> {
  const items: ContentItem[] = [];
  let start = 0;
  while (items.length < hardCap) {
    const res = await fetchJson<{ results?: ContentItem[]; _links?: { next?: string } }>(
      url(start, pageSize),
      credential,
      caps.timeoutMs,
    );
    const batch = res.results ?? [];
    items.push(...batch);
    if (batch.length === 0) return { items, truncated: false };
    if (res._links && !res._links.next) {
      return { items: items.slice(0, hardCap), truncated: items.length > hardCap };
    }
    start += batch.length;
  }
  // Cap reached without the server signalling the end — more pages may exist
  // beyond the snapshot, so the caller must not present it as complete.
  return { items: items.slice(0, hardCap), truncated: true };
}

/** Fetch the pages of a scope (space / subtree / page) and populate the cache,
 *  returning how many entries were cached. Listings are PAGINATED (bounded by
 *  `maxPages`); when the cap cuts the listing short, the truncation is
 *  recorded on `cache.lastSnapshotTruncated` so callers can say the snapshot
 *  (and any drift check built on it) is partial. */
export async function cacheConfluenceScope(
  source: ContextSource,
  credential: ContextCredential,
  scope: AuthorityScope,
  caps: ReadCaps,
  cache: ConfluenceContentCache,
  now: () => string,
  maxPages = 200,
): Promise<number> {
  const base = baseOf(source);
  const items: ContentItem[] = [];
  let truncated = false;
  if (scope.kind === "page" && scope.pageId) {
    items.push(
      await fetchJson<ContentItem>(`${base}/rest/api/content/${enc(scope.pageId)}?expand=${enc(CACHE_EXPAND)}`, credential, caps.timeoutMs),
    );
  } else if (scope.kind === "subtree" && scope.pageId) {
    const root = await fetchJson<ContentItem>(
      `${base}/rest/api/content/${enc(scope.pageId)}?expand=${enc(CACHE_EXPAND)}`,
      credential,
      caps.timeoutMs,
    ).catch(() => undefined);
    if (root) items.push(root);
    const r = await fetchAllItems(
      credential,
      (start, limit) =>
        `${base}/rest/api/content/${enc(scope.pageId ?? "")}/descendant/page?expand=${enc(CACHE_EXPAND)}&start=${start}&limit=${limit}`,
      caps,
      maxPages,
    );
    items.push(...r.items);
    truncated = r.truncated;
  } else {
    const r = await fetchAllItems(
      credential,
      (start, limit) =>
        `${base}/rest/api/content?spaceKey=${enc(scope.spaceKey ?? "")}&type=page&expand=${enc(CACHE_EXPAND)}&start=${start}&limit=${limit}`,
      caps,
      maxPages,
    );
    items.push(...r.items);
    truncated = r.truncated;
  }
  cache.lastSnapshotTruncated = truncated;
  let n = 0;
  for (const c of items) {
    if (!c?.id) continue;
    cache.put(buildCacheEntry(source, c, caps.maxBodyChars, now));
    n += 1;
  }
  return n;
}

/** The drift check's live-version map. It IS a `Map<id, version>` (so
 *  `ConfluenceContentCache.stale()` consumes it unchanged) that additionally
 *  carries whether the live listing hit the page cap — a truncated listing
 *  means the drift check only compared the first `maxPages` pages, so the
 *  drift note must not claim the whole scope was checked. */
export interface ScopeVersions extends Map<string, number> {
  /** Set (true) when the live listing hit `maxPages` — the check is PARTIAL. */
  truncated?: boolean;
}

/** Fetch the CURRENT version number of each page in a scope (lightweight —
 *  `expand=version` only), as a Map<id, version>. Feeds `ConfluenceContentCache
 *  .stale()` for the drift check ("which cached pages changed underneath us").
 *  Listings are PAGINATED (bounded by `maxPages`); a cap hit is reported on
 *  the returned map's `truncated` field. */
export async function fetchScopeVersions(
  source: ContextSource,
  credential: ContextCredential,
  scope: AuthorityScope,
  caps: ReadCaps,
  maxPages = 200,
): Promise<ScopeVersions> {
  const base = baseOf(source);
  const out: ScopeVersions = new Map<string, number>();
  const add = (c?: ContentItem) => {
    if (c?.id) out.set(String(c.id), c.version?.number ?? 1);
  };
  if (scope.kind === "page" && scope.pageId) {
    add(await fetchJson<ContentItem>(`${base}/rest/api/content/${enc(scope.pageId)}?expand=version`, credential, caps.timeoutMs));
    return out;
  }
  if (scope.kind === "subtree" && scope.pageId) {
    add(await fetchJson<ContentItem>(`${base}/rest/api/content/${enc(scope.pageId)}?expand=version`, credential, caps.timeoutMs).catch(() => undefined));
    const r = await fetchAllItems(
      credential,
      (start, limit) =>
        `${base}/rest/api/content/${enc(scope.pageId ?? "")}/descendant/page?expand=version&start=${start}&limit=${limit}`,
      caps,
      maxPages,
    );
    for (const c of r.items) add(c);
    if (r.truncated) out.truncated = true;
    return out;
  }
  const r = await fetchAllItems(
    credential,
    (start, limit) =>
      `${base}/rest/api/content?spaceKey=${enc(scope.spaceKey ?? "")}&type=page&expand=version&start=${start}&limit=${limit}`,
    caps,
    maxPages,
  );
  for (const c of r.items) add(c);
  if (r.truncated) out.truncated = true;
  return out;
}
