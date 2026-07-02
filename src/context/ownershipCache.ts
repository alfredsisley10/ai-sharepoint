import { OwnerResolution } from "./adapters/confluenceOwnership";

/**
 * Ownership-result cache (info-sprawl cleanup). Resolving a page's effective
 * owner walks version history and validates each contributor against the
 * directory — expensive to redo on every cleanup pass. This caches the resolved
 * result per page for a few days, is exportable/importable (so the team shares
 * one computed set and a restart doesn't recompute everything), and has a
 * `refresh` escape hatch at the call site. Pure core; the store is the vscode
 * wrapper.
 */

export interface CachedOwnership {
  resolution: OwnerResolution;
  labels: string[];
  directoryWired: boolean;
  directoryLabel?: string;
  ownerContacts?: Array<{ sam: string; displayName?: string; contact?: string; active?: boolean }>;
}

export interface OwnershipCacheEntry {
  /** `${sourceId}:${pageId}`. */
  key: string;
  value: CachedOwnership;
  /** Epoch ms resolved. */
  at: number;
}

/** Ownership changes only when the page is edited or someone leaves — default
 *  to a week; a `refresh` at the call site forces a recompute sooner. */
export const DEFAULT_OWNERSHIP_TTL_MS = 7 * 86_400_000;

export function ownershipKey(sourceId: string, pageId: string): string {
  return `${sourceId}:${pageId}`;
}

export function isFresh(entry: OwnershipCacheEntry | undefined, nowMs: number, ttlMs: number): boolean {
  return !!entry && nowMs - entry.at < ttlMs;
}

export function pruneEntries(entries: OwnershipCacheEntry[], nowMs: number, ttlMs: number): OwnershipCacheEntry[] {
  return entries.filter((e) => isFresh(e, nowMs, ttlMs));
}

export const OWNERSHIP_CACHE_SCHEMA = "ownership-cache/v1";

export interface OwnershipCacheExport {
  schema: typeof OWNERSHIP_CACHE_SCHEMA;
  exportedAt: string;
  entries: OwnershipCacheEntry[];
}

export function buildOwnershipCacheExport(entries: OwnershipCacheEntry[], exportedAt: string): OwnershipCacheExport {
  return { schema: OWNERSHIP_CACHE_SCHEMA, exportedAt, entries };
}

export function isOwnershipCacheExport(x: unknown): x is OwnershipCacheExport {
  return (
    !!x &&
    typeof x === "object" &&
    (x as OwnershipCacheExport).schema === OWNERSHIP_CACHE_SCHEMA &&
    Array.isArray((x as OwnershipCacheExport).entries)
  );
}

/** Merge imported entries with existing, keeping the FRESHER per key. */
export function mergeOwnershipCache(
  existing: OwnershipCacheEntry[],
  incoming: OwnershipCacheEntry[],
): OwnershipCacheEntry[] {
  const by = new Map<string, OwnershipCacheEntry>();
  for (const e of existing) by.set(e.key, e);
  for (const e of incoming) {
    const cur = by.get(e.key);
    if (!cur || e.at > cur.at) by.set(e.key, e);
  }
  return [...by.values()];
}
