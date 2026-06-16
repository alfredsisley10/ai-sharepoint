import { ContextSource, ContextCredential, ReadCaps } from "../types";
import { fetchJson } from "../http";
import { UserDirectory, contactOf } from "../userDirectory";
import { findOwnerLabel } from "./confluenceOwnership";

/**
 * Confluence page "currency" review (ADR-0043): is a page still current?
 *  - **Links** — extract the page's outbound links and verify they still
 *    resolve (dead-link detection).
 *  - **Owner tags** — verify the sAMAccountNames in the owner label are still
 *    **active** users (via the injected user directory).
 *  - **Staleness** — how long since the page was last updated.
 * Read-only analysis; the assistant turns the report into cleanup proposals.
 */

const enc = encodeURIComponent;
const baseOf = (source: Pick<ContextSource, "baseUrl">): string => source.baseUrl.replace(/\/$/, "");

const MAX_LINKS_CHECKED = 60;

/** Distinct outbound link targets (href) from storage HTML (pure). */
export function extractLinks(html: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /href\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const href = m[1].trim();
    if (!href || /^(javascript:|#|mailto:|tel:)/i.test(href)) continue;
    if (!seen.has(href)) {
      seen.add(href);
      out.push(href);
    }
  }
  return out;
}

export interface LinkCheck {
  url: string;
  ok: boolean;
  status?: number;
  error?: string;
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) results[i] = await fn(items[i]);
  });
  await Promise.all(workers);
  return results;
}

async function checkOne(url: string, timeoutMs: number): Promise<LinkCheck> {
  const fetchWith = (method: "HEAD" | "GET") =>
    fetch(url, { method, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
  try {
    let res = await fetchWith("HEAD");
    if (res.status === 405 || res.status === 501) res = await fetchWith("GET");
    return { url, ok: res.ok, status: res.status };
  } catch (err) {
    return { url, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Check links for liveness (HEAD, falling back to GET), bounded concurrency.
 *  Only absolute http(s) URLs are checked; relative links are reported as
 *  unchecked (resolving them needs the page context, left to the caller). */
export async function checkLinks(urls: string[], timeoutMs: number, concurrency = 6): Promise<LinkCheck[]> {
  const absolute = urls.filter((u) => /^https?:\/\//i.test(u)).slice(0, MAX_LINKS_CHECKED);
  return mapPool(absolute, concurrency, (u) => checkOne(u, timeoutMs));
}

export interface CurrencyReport {
  pageId: string;
  title: string;
  url: string;
  brokenLinks: LinkCheck[];
  workingLinks: number;
  uncheckedRelativeLinks: number;
  owners: Array<{ sam: string; active: boolean; contact?: string }>;
  inactiveOwners: string[];
  hasOwnerLabel: boolean;
  lastUpdated?: string;
  staleDays?: number;
  issues: string[];
}

interface PageForReview {
  id?: string;
  title?: string;
  body?: { storage?: { value?: string } };
  version?: { when?: string };
  metadata?: { labels?: { results?: Array<{ name?: string }> } };
  _links?: { webui?: string };
}

/** Review a page's currency: dead links + stale/invalid owner tags + age. */
export async function reviewPageCurrency(
  source: ContextSource,
  credential: ContextCredential,
  pageId: string,
  dir: UserDirectory,
  caps: ReadCaps,
  now: () => string = () => new Date().toISOString(),
): Promise<CurrencyReport> {
  const page = await fetchJson<PageForReview>(
    `${baseOf(source)}/rest/api/content/${enc(pageId)}?expand=body.storage,version,metadata.labels`,
    credential,
    caps.timeoutMs,
  );
  const html = page.body?.storage?.value ?? "";
  const labels = (page.metadata?.labels?.results ?? []).map((l) => String(l.name ?? "")).filter(Boolean);

  const links = extractLinks(html);
  const checked = await checkLinks(links, caps.timeoutMs);
  const brokenLinks = checked.filter((c) => !c.ok);
  const uncheckedRelativeLinks = links.filter((u) => !/^https?:\/\//i.test(u)).length;

  const ownerSams = findOwnerLabel(labels) ?? [];
  const owners = await Promise.all(
    ownerSams.map(async (sam) => {
      const rec = await dir(sam);
      return { sam, active: rec?.active ?? false, ...(contactOf(rec) ? { contact: contactOf(rec) } : {}) };
    }),
  );
  const inactiveOwners = owners.filter((o) => !o.active).map((o) => o.sam);

  let staleDays: number | undefined;
  if (page.version?.when) {
    const ageMs = Date.parse(now()) - Date.parse(page.version.when);
    if (!Number.isNaN(ageMs)) staleDays = Math.max(0, Math.floor(ageMs / 86_400_000));
  }

  const issues: string[] = [];
  if (brokenLinks.length) issues.push(`${brokenLinks.length} broken link(s)`);
  if (!ownerSams.length) issues.push("no owner tag");
  else if (inactiveOwners.length) issues.push(`inactive owner(s): ${inactiveOwners.join(", ")}`);
  if (staleDays !== undefined && staleDays > 365) issues.push(`not updated in ${staleDays} days`);

  return {
    pageId: String(page.id ?? pageId),
    title: page.title ?? "(untitled)",
    url: page._links?.webui ? `${baseOf(source)}${page._links.webui}` : baseOf(source),
    brokenLinks,
    workingLinks: checked.length - brokenLinks.length,
    uncheckedRelativeLinks,
    owners,
    inactiveOwners,
    hasOwnerLabel: ownerSams.length > 0,
    ...(page.version?.when ? { lastUpdated: page.version.when } : {}),
    ...(staleDays !== undefined ? { staleDays } : {}),
    issues,
  };
}
