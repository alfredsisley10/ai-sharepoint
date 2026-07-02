import {
  TimedAuthor,
  ContributorTally,
  tallyContributorsWeighted,
  ActivePredicate,
  DEFAULT_RECENCY_HALF_LIFE_DAYS,
} from "../context/adapters/confluenceOwnership";

/**
 * SharePoint page ownership (info-sprawl cleanup, parity with Confluence
 * ADR-0039). SharePoint has no owner-label construct, so a page's effective
 * owner is the most RECENTLY-active editor from its version history who is a
 * current active employee. Contributors are identified by EMAIL/UPN (what Graph
 * returns), validated via the email-keyed directory (userDirectory).
 *
 * Modern pages live in the "Site Pages" library; their editor history is the
 * underlying list item's versions (Graph `.../lists/{id}/items/{id}/versions`).
 * The version-parsing + ranking here is pure and unit-tested; the Graph fetch
 * is a thin injected reader so this module stays transport-free.
 */

/** One version's editor as returned by Graph list-item versions. */
interface GraphVersion {
  lastModifiedDateTime?: string;
  lastModifiedBy?: { user?: { email?: string; userPrincipalName?: string; displayName?: string } };
}

export interface SpEditor {
  /** email/UPN identity (lowercased). */
  identity: string;
  displayName?: string;
  whenMs?: number;
}

/** Extract editors (with timestamps) from a Graph list-item versions payload.
 *  Pure. Versions without an identifiable user are skipped. */
export function extractPageEditors(payload: unknown): SpEditor[] {
  const versions = (payload as { value?: GraphVersion[] })?.value ?? [];
  const out: SpEditor[] = [];
  for (const v of versions) {
    const u = v.lastModifiedBy?.user;
    const identity = (u?.email ?? u?.userPrincipalName ?? "").trim().toLowerCase();
    if (!identity) continue;
    const whenMs = v.lastModifiedDateTime ? Date.parse(v.lastModifiedDateTime) : NaN;
    out.push({ identity, ...(u?.displayName ? { displayName: u.displayName } : {}), ...(Number.isNaN(whenMs) ? {} : { whenMs }) });
  }
  return out;
}

export interface SpOwnerResolution {
  /** email/UPN of the resolved owner(s). */
  owners: string[];
  basis: "page-contributor" | "none";
  considered?: ContributorTally[];
  note?: string;
}

/**
 * Resolve a SharePoint page's owner from its editors: rank by recency-weighted
 * activity, then pick the most-active who is a current active employee.
 * `isActive` is the email-keyed active predicate (from the directory). Pure.
 */
export async function resolveSharePointOwners(
  editors: SpEditor[],
  isActive: ActivePredicate,
  opts: { nowMs: number; halfLifeDays?: number },
): Promise<SpOwnerResolution> {
  const ranked = tallyContributorsWeighted(
    editors.map((e): TimedAuthor => ({ sam: e.identity, ...(e.whenMs !== undefined ? { whenMs: e.whenMs } : {}) })),
    { nowMs: opts.nowMs, halfLifeDays: opts.halfLifeDays ?? DEFAULT_RECENCY_HALF_LIFE_DAYS },
  );
  for (const c of ranked) {
    if (await isActive(c.sam)) {
      return { owners: [c.sam], basis: "page-contributor", considered: ranked };
    }
  }
  return {
    owners: [],
    basis: "none",
    note: ranked.length
      ? "No recent editor is a current active employee (per the directory)."
      : "No version history / editors available for this page.",
  };
}

/**
 * Fetch a modern page's editors via Graph list-item versions. `getJson` is the
 * SharePointClient's request method (injected). Best-effort: returns [] when the
 * versions endpoint is unavailable (some tenants restrict it), so ownership
 * degrades to "no owner" rather than failing the cleanup pass.
 */
export async function fetchSharePointPageEditors(
  getJson: (path: string) => Promise<unknown>,
  siteId: string,
  sitePagesListId: string,
  itemId: string,
  top = 50,
): Promise<SpEditor[]> {
  try {
    const payload = await getJson(
      `/sites/${siteId}/lists/${sitePagesListId}/items/${itemId}/versions?$top=${top}`,
    );
    return extractPageEditors(payload);
  } catch {
    return [];
  }
}
