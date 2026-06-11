/**
 * Pre-cached source catalogs (pilot request): the global set of Confluence
 * spaces / Jira projects+filters+queues, fetched once with user consent and
 * kept locally for instant browsing — with an explicit expiry so it can be
 * refreshed, and checkpointed loading so big instances are never overtaxed.
 */

export interface CatalogEntry {
  name: string;
  locator: string;
  kind: "query";
  detail: string;
}

export interface SourceCatalog {
  fetchedAt: string;
  expiresAt: string;
  /** False when the user stopped at a checkpoint — a usable prefix. */
  complete: boolean;
  entries: CatalogEntry[];
}

export const DEFAULT_CATALOG_TTL_HOURS = 24;

export function buildCatalog(
  entries: CatalogEntry[],
  complete: boolean,
  fetchedAt: string,
  ttlHours: number,
): SourceCatalog {
  const expiresAt = new Date(
    new Date(fetchedAt).getTime() + Math.max(1, ttlHours) * 3_600_000,
  ).toISOString();
  return { fetchedAt, expiresAt, complete, entries };
}

export function isExpired(catalog: SourceCatalog, nowIso: string): boolean {
  return nowIso >= catalog.expiresAt;
}

/** Age label for UI ("2 h ago", "3 d ago"). */
export function catalogAge(catalog: SourceCatalog, nowIso: string): string {
  const ms = Math.max(0, new Date(nowIso).getTime() - new Date(catalog.fetchedAt).getTime());
  const hours = ms / 3_600_000;
  if (hours < 1) return `${Math.max(1, Math.round(ms / 60_000))} min ago`;
  if (hours < 48) return `${Math.round(hours)} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/**
 * Pause-aware pacing for catalog loads: `shouldContinue` is awaited between
 * every page/request. While the user is being asked, the load is parked —
 * no requests hit the source — which is itself the throttle.
 */
export type LoadCheckpoint = () => Promise<boolean>;
