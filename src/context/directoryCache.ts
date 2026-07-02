import { UserRecord, UserDirectory } from "./userDirectory";

/**
 * Read-through cache for user-directory lookups (ADR-0041 support). Directory
 * data (is-active, email, display name) moves slowly, and LDAP/Graph lookups
 * are relatively expensive, so results are cached for **days** to cut lookup
 * overhead during ownership resolution and owner notification. Pure core;
 * `directoryCacheStore.ts` is the persistence wrapper, and the cache is
 * exportable/importable so it survives a restart.
 */

export interface DirectoryCacheEntry {
  sam: string;
  /** The resolved record, or null for a confirmed "no such user" — negatives
   *  are cached too, so a ghost contributor isn't re-queried every pass. */
  record: UserRecord | null;
  /** Epoch ms when resolved. */
  at: number;
}

/** Directory data is slowly-moving; default to a multi-day TTL. */
export const DEFAULT_DIRECTORY_TTL_MS = 5 * 86_400_000; // 5 days

export function isFresh(
  entry: DirectoryCacheEntry | undefined,
  nowMs: number,
  ttlMs: number,
): boolean {
  return !!entry && nowMs - entry.at < ttlMs;
}

/** Drop entries older than the TTL (for periodic pruning). Pure. */
export function pruneEntries(
  entries: DirectoryCacheEntry[],
  nowMs: number,
  ttlMs: number,
): DirectoryCacheEntry[] {
  return entries.filter((e) => isFresh(e, nowMs, ttlMs));
}

/**
 * Wrap a live `UserDirectory` with a read-through cache. On a hit within TTL the
 * cached record is returned without touching the directory; otherwise the live
 * lookup runs and its result (including a negative) is written back. `now`/TTL
 * are injected so this is deterministic and testable.
 */
export function cachedUserDirectory(
  live: UserDirectory,
  cache: {
    get: (sam: string) => DirectoryCacheEntry | undefined;
    put: (entry: DirectoryCacheEntry) => Promise<void> | void;
  },
  opts: { now: () => number; ttlMs?: number },
): UserDirectory {
  const ttl = opts.ttlMs ?? DEFAULT_DIRECTORY_TTL_MS;
  return async (sam: string): Promise<UserRecord | undefined> => {
    const key = sam.trim().toLowerCase();
    if (!key) return undefined;
    const hit = cache.get(key);
    if (isFresh(hit, opts.now(), ttl)) return hit!.record ?? undefined;
    const record = (await live(key)) ?? null;
    await cache.put({ sam: key, record, at: opts.now() });
    return record ?? undefined;
  };
}

// ---------------------------------------------------------------------------
// Export / import — the cache is portable so a user keeps it across restarts.
// ---------------------------------------------------------------------------

export const DIRECTORY_CACHE_SCHEMA = "directory-cache/v1";

export interface DirectoryCacheExport {
  schema: typeof DIRECTORY_CACHE_SCHEMA;
  exportedAt: string;
  entries: DirectoryCacheEntry[];
}

export function buildDirectoryCacheExport(
  entries: DirectoryCacheEntry[],
  exportedAt: string,
): DirectoryCacheExport {
  return { schema: DIRECTORY_CACHE_SCHEMA, exportedAt, entries };
}

export function isDirectoryCacheExport(x: unknown): x is DirectoryCacheExport {
  return (
    !!x &&
    typeof x === "object" &&
    (x as DirectoryCacheExport).schema === DIRECTORY_CACHE_SCHEMA &&
    Array.isArray((x as DirectoryCacheExport).entries)
  );
}

/** Merge imported entries with existing, keeping the FRESHER record per sam. */
export function mergeDirectoryCache(
  existing: DirectoryCacheEntry[],
  incoming: DirectoryCacheEntry[],
): DirectoryCacheEntry[] {
  const by = new Map<string, DirectoryCacheEntry>();
  for (const e of existing) by.set(e.sam.toLowerCase(), e);
  for (const e of incoming) {
    const key = e.sam.toLowerCase();
    const cur = by.get(key);
    if (!cur || e.at > cur.at) by.set(key, { ...e, sam: key });
  }
  return [...by.values()];
}
