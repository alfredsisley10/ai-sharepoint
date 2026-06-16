import { ContextSource, ContextCredential, ReadCaps } from "../types";
import { fetchJson, htmlToText } from "../http";
import type { AuthorityScope } from "./confluenceAuthority";

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

const enc = encodeURIComponent;
const baseOf = (source: Pick<ContextSource, "baseUrl">): string => source.baseUrl.replace(/\/$/, "");
const webUrl = (source: Pick<ContextSource, "baseUrl">, webui?: string): string =>
  webui ? `${baseOf(source)}${webui}` : baseOf(source);

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

/** Fetch the pages of a scope (space / subtree / page) and populate the cache,
 *  returning how many entries were cached. */
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
    const res = await fetchJson<{ results?: ContentItem[] }>(
      `${base}/rest/api/content/${enc(scope.pageId)}/descendant/page?expand=${enc(CACHE_EXPAND)}&limit=${maxPages}`,
      credential,
      caps.timeoutMs,
    );
    items.push(...(res.results ?? []));
  } else {
    const res = await fetchJson<{ results?: ContentItem[] }>(
      `${base}/rest/api/content?spaceKey=${enc(scope.spaceKey ?? "")}&type=page&expand=${enc(CACHE_EXPAND)}&limit=${maxPages}`,
      credential,
      caps.timeoutMs,
    );
    items.push(...(res.results ?? []));
  }
  let n = 0;
  for (const c of items) {
    if (!c?.id) continue;
    cache.put(buildCacheEntry(source, c, caps.maxBodyChars, now));
    n += 1;
  }
  return n;
}
