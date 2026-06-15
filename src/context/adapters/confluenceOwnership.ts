import { ContextSource, ContextCredential } from "../types";
import { fetchJson } from "../http";

/**
 * Confluence page-ownership construct (ADR-0039). Determines and manages the
 * *likely owner* of a page from CONTRIBUTION history (accountability), not the
 * often-inaccurate Confluence space owner. Reusable building blocks:
 *
 *  1. An explicit **owner label** — a single Confluence label of the form
 *     `<marker>|sam1|sam2` (pipe-delimited AD sAMAccountNames). Labels can't
 *     hold emails (Confluence's label-content limits), so sam names are the
 *     identifier. When present, it is authoritative.
 *  2. Otherwise the **most prolific contributor to the page that is also an
 *     active user** (active-ness is an injected predicate — LDAP / M365).
 *  3. Otherwise the **most prolific active contributor for the whole space**.
 *
 * Ownership is used to know who to contact for updates or to notify before an
 * archive, and can be written back as the owner label.
 *
 * Designed for Confluence Data Center, where a version author's `by.username`
 * IS the AD sAMAccountName (Cloud exposes accountId/publicName instead).
 */

const enc = encodeURIComponent;
const base = (source: Pick<ContextSource, "baseUrl">): string => source.baseUrl.replace(/\/$/, "");

export const DEFAULT_OWNER_MARKER = "owners";

/** Confluence lowercases labels and forbids spaces; sam names are alphanumeric
 *  (+ . _ -), so just trim/space-strip/lowercase. */
export function sanitizeSam(s: string): string {
  return (s ?? "").trim().toLowerCase().replace(/\s+/g, "");
}

/** Build the owner label `<marker>|sam1|sam2` (lowercased, deduped, ordered). */
export function buildOwnerLabel(sams: string[], marker = DEFAULT_OWNER_MARKER): string {
  const clean = [...new Set(sams.map(sanitizeSam).filter(Boolean))];
  return [marker.toLowerCase(), ...clean].join("|");
}

/** Parse a label → owner sam names, or undefined if it isn't the owner label. */
export function parseOwnerLabel(label: string, marker = DEFAULT_OWNER_MARKER): string[] | undefined {
  const parts = (label ?? "").split("|").map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2 || parts[0].toLowerCase() !== marker.toLowerCase()) return undefined;
  return [...new Set(parts.slice(1).map((s) => s.toLowerCase()))];
}

/** Find the owner label among a page's labels → sam names (first match). */
export function findOwnerLabel(labels: string[], marker = DEFAULT_OWNER_MARKER): string[] | undefined {
  for (const l of labels) {
    const sams = parseOwnerLabel(l, marker);
    if (sams) return sams;
  }
  return undefined;
}

export interface ContributorTally {
  sam: string;
  count: number;
}

/** Tally author sam names → counts, ranked by count desc then name. */
export function tallyContributors(authors: string[]): ContributorTally[] {
  const counts = new Map<string, number>();
  for (const a of authors) {
    const sam = (a ?? "").trim().toLowerCase();
    if (!sam) continue;
    counts.set(sam, (counts.get(sam) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([sam, count]) => ({ sam, count }))
    .sort((a, b) => b.count - a.count || a.sam.localeCompare(b.sam));
}

/** Is this sAMAccountName an active user? Injected (LDAP / M365). */
export type ActivePredicate = (sam: string) => Promise<boolean>;

export interface OwnerResolution {
  owners: string[];
  basis: "label" | "page-contributor" | "space-contributor" | "none";
  /** Ranked candidates considered for the contributor paths (for transparency). */
  considered?: ContributorTally[];
  note?: string;
}

async function firstActive(ranked: ContributorTally[], isActive: ActivePredicate): Promise<string | undefined> {
  for (const c of ranked) {
    if (await isActive(c.sam)) return c.sam;
  }
  return undefined;
}

/**
 * Resolve a page's owner(s) from the priority pipeline (pure; all IO injected):
 * owner label → most-prolific active page contributor → most-prolific active
 * space contributor. The space tally is lazy (expensive) and only computed when
 * the page itself yields no active owner.
 */
export async function resolveOwners(input: {
  pageLabels: string[];
  pageContributors: ContributorTally[];
  spaceContributors: () => Promise<ContributorTally[]>;
  isActive: ActivePredicate;
  marker?: string;
}): Promise<OwnerResolution> {
  const marker = input.marker ?? DEFAULT_OWNER_MARKER;

  const labelOwners = findOwnerLabel(input.pageLabels, marker);
  if (labelOwners && labelOwners.length) {
    const activity = await Promise.all(labelOwners.map((s) => input.isActive(s)));
    const inactive = labelOwners.filter((_, i) => !activity[i]);
    return {
      owners: labelOwners,
      basis: "label",
      ...(inactive.length ? { note: `Owner label present; inactive per directory: ${inactive.join(", ")}` } : {}),
    };
  }

  const pageOwner = await firstActive(input.pageContributors, input.isActive);
  if (pageOwner) {
    return { owners: [pageOwner], basis: "page-contributor", considered: input.pageContributors };
  }

  const spaceRanked = await input.spaceContributors();
  const spaceOwner = await firstActive(spaceRanked, input.isActive);
  if (spaceOwner) {
    return { owners: [spaceOwner], basis: "space-contributor", considered: spaceRanked };
  }

  return { owners: [], basis: "none", note: "No active contributor found on the page or in the space." };
}

// ---------------------------------------------------------------------------
// Confluence IO
// ---------------------------------------------------------------------------

/** A page's label names. GET /rest/api/content/{id}/label */
export async function getConfluencePageLabels(
  source: ContextSource,
  credential: ContextCredential,
  pageId: string,
  timeoutMs: number,
): Promise<string[]> {
  const res = await fetchJson<{ results?: Array<{ name?: string }> }>(
    `${base(source)}/rest/api/content/${enc(pageId)}/label`,
    credential,
    timeoutMs,
  );
  return (res.results ?? []).map((l) => String(l.name ?? "")).filter(Boolean);
}

interface VersionBy {
  username?: string;
  publicName?: string;
  accountId?: string;
}

/** Raw version-author sam names for a page (paged, bounded). DC: by.username =
 *  sAMAccountName; Cloud falls back to publicName/accountId. */
async function pageVersionAuthors(
  source: ContextSource,
  credential: ContextCredential,
  pageId: string,
  timeoutMs: number,
  maxVersions: number,
): Promise<string[]> {
  const authors: string[] = [];
  const pageSize = 100;
  for (let start = 0; authors.length < maxVersions; start += pageSize) {
    const res = await fetchJson<{ results?: Array<{ by?: VersionBy }> }>(
      `${base(source)}/rest/api/content/${enc(pageId)}/version?start=${start}&limit=${pageSize}`,
      credential,
      timeoutMs,
    );
    const results = res.results ?? [];
    for (const v of results) {
      const sam = v.by?.username ?? v.by?.publicName ?? v.by?.accountId;
      if (sam) authors.push(sam);
    }
    if (results.length < pageSize) break;
  }
  return authors;
}

/** Page contributors tallied from its version history (most prolific first). */
export async function getConfluencePageContributors(
  source: ContextSource,
  credential: ContextCredential,
  pageId: string,
  timeoutMs: number,
  maxVersions = 300,
): Promise<ContributorTally[]> {
  return tallyContributors(await pageVersionAuthors(source, credential, pageId, timeoutMs, maxVersions));
}

/** Most prolific contributors for a SPACE — bounded: tally version authors
 *  across the space's pages (capped). An approximation, not a full crawl. */
export async function getConfluenceSpaceContributors(
  source: ContextSource,
  credential: ContextCredential,
  spaceKey: string,
  timeoutMs: number,
  maxPages = 25,
  maxVersionsPerPage = 100,
): Promise<ContributorTally[]> {
  const listed = await fetchJson<{ results?: Array<{ id?: string }> }>(
    `${base(source)}/rest/api/content?spaceKey=${enc(spaceKey)}&type=page&limit=${maxPages}`,
    credential,
    timeoutMs,
  );
  const ids = (listed.results ?? []).map((p) => String(p.id ?? "")).filter(Boolean);
  const authors: string[] = [];
  for (const id of ids) {
    try {
      authors.push(...(await pageVersionAuthors(source, credential, id, timeoutMs, maxVersionsPerPage)));
    } catch {
      // one unreadable page shouldn't void the space tally
    }
  }
  return tallyContributors(authors);
}

/** Write the owner label on a page: remove any existing owner label, add the
 *  new pipe-delimited one. Uses the source's own API token. */
export async function setConfluencePageOwners(
  source: ContextSource,
  credential: ContextCredential,
  pageId: string,
  sams: string[],
  timeoutMs: number,
  marker = DEFAULT_OWNER_MARKER,
): Promise<string> {
  const existing = await getConfluencePageLabels(source, credential, pageId, timeoutMs);
  for (const l of existing) {
    if (parseOwnerLabel(l, marker)) {
      await fetchJson<unknown>(
        `${base(source)}/rest/api/content/${enc(pageId)}/label?name=${enc(l)}`,
        credential,
        timeoutMs,
        undefined,
        { method: "DELETE" },
      );
    }
  }
  const label = buildOwnerLabel(sams, marker);
  await fetchJson<unknown>(
    `${base(source)}/rest/api/content/${enc(pageId)}/label`,
    credential,
    timeoutMs,
    undefined,
    { method: "POST", body: [{ prefix: "global", name: label }] },
  );
  return label;
}
