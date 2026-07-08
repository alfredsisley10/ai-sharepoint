import { ContextSource, ContextCredential, ReadCaps } from "../types";
import { fetchJson, htmlToText } from "../http";
import { UserDirectory, contactOf } from "../userDirectory";
import { findOwnerLabel } from "./confluenceOwnership";
import { enc, baseOf } from "./confluenceCommon";
import { DnsPathProbe, probeDnsPaths, classifyDnsOutcome } from "../../core/dnsDiagnostics";
import { flattenNetworkError } from "../../core/networkDiagnostics";

/**
 * Confluence page "currency" review (ADR-0043): is a page still current?
 *  - **Links** — extract the page's outbound links and verify they still
 *    resolve (dead-link detection).
 *  - **Owner tags** — verify the sAMAccountNames in the owner label are still
 *    **active** users (via the injected user directory).
 *  - **Staleness** — how long since the page was last updated.
 * Read-only analysis; the assistant turns the report into cleanup proposals.
 */

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
  /** The fetch failed for DNS reasons and the two-path DNS probe (ADR-0043
   *  follow-up; see core/dnsDiagnostics) could not verify the link from this
   *  network vantage. UNVERIFIABLE is *not* broken: on an Entra-joined
   *  workstation an intranet name may only resolve through the VPN's DNS path
   *  (NRPT), so a scan run off-VPN must not condemn the link. */
  unverifiable?: true;
  /** Plain-language DNS-vantage note (from classifyDnsOutcome). */
  dnsNote?: string;
}

/** A fetch failure whose cause chain says the NAME didn't resolve
 *  (getaddrinfo ENOTFOUND / EAI_AGAIN) — a vantage question, not proof the
 *  link target is dead. Node's fetch hides the errno behind a generic "fetch
 *  failed", so the shared cause-chain flattener is used to see it. */
function isDnsFailure(err: unknown): boolean {
  return /enotfound|eai_again|getaddrinfo|err_name_not_resolved/.test(flattenNetworkError(err));
}

function hostnameOf(url: string): string | undefined {
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
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

async function checkOne(
  url: string,
  timeoutMs: number,
  probeHost?: (host: string) => Promise<DnsPathProbe>,
): Promise<LinkCheck> {
  const fetchWith = (method: "HEAD" | "GET") =>
    fetch(url, { method, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
  const attempt = async (): Promise<LinkCheck> => {
    let res = await fetchWith("HEAD");
    if (res.status === 405 || res.status === 501) res = await fetchWith("GET");
    return { url, ok: res.ok, status: res.status };
  };
  try {
    return await attempt();
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // DNS-shaped failure: probe both resolver paths (OS/NRPT vs direct) before
    // judging. Probes run ONLY here, so the happy path pays nothing.
    const host = probeHost && isDnsFailure(err) ? hostnameOf(url) : undefined;
    if (host && probeHost) {
      const probe = await probeHost(host);
      const { note } = classifyDnsOutcome(probe);
      if (probe.osPath === true) {
        // The OS resolver — the stack fetch itself uses — CAN resolve the
        // name, so the failure was likely a transient resolver hiccup: retry
        // the fetch once. A response (any status) is a real answer.
        try {
          return await attempt();
        } catch {
          // Still failing with a resolvable name: unverifiable, not broken.
        }
      }
      return { url, ok: false, error, unverifiable: true, dnsNote: note };
    }
    return { url, ok: false, error };
  }
}

/** Per-run DNS-probe memos, keyed by the shared link cache so a space-wide
 *  sweep probes each distinct HOST at most once (WeakMap: freed with the run). */
const hostProbesByCache = new WeakMap<Map<string, Promise<LinkCheck>>, Map<string, Promise<DnsPathProbe>>>();

/** Check links for liveness (HEAD, falling back to GET), bounded concurrency.
 *  Only absolute http(s) URLs are checked; relative links are reported as
 *  unchecked (resolving them needs the page context, left to the caller).
 *
 *  `cache` (optional) memoizes each URL's in-flight/settled check across pages:
 *  a space-wide sweep of hundreds of pages linking the same handful of intranet
 *  hosts collapses from thousands of requests to one-per-distinct-URL.
 *
 *  When a fetch fails with a DNS-shaped error, both DNS paths of the
 *  workstation are probed (`dnsProbe`, default `probeDnsPaths`) once per
 *  distinct host, and the link is classified UNVERIFIABLE — not broken — when
 *  the name is merely invisible from this network vantage (off-VPN / NRPT). */
export async function checkLinks(
  urls: string[],
  timeoutMs: number,
  concurrency = 6,
  cache?: Map<string, Promise<LinkCheck>>,
  dnsProbe: (host: string) => Promise<DnsPathProbe> = probeDnsPaths,
): Promise<LinkCheck[]> {
  const absolute = urls.filter((u) => /^https?:\/\//i.test(u)).slice(0, MAX_LINKS_CHECKED);
  let hostProbes = cache ? hostProbesByCache.get(cache) : undefined;
  if (!hostProbes) {
    hostProbes = new Map<string, Promise<DnsPathProbe>>();
    if (cache) hostProbesByCache.set(cache, hostProbes);
  }
  const probes = hostProbes;
  const probeHost = (host: string): Promise<DnsPathProbe> => {
    let p = probes.get(host);
    if (!p) {
      p = dnsProbe(host);
      probes.set(host, p);
    }
    return p;
  };
  const check = cache
    ? (u: string) => {
        let p = cache.get(u);
        if (!p) {
          p = checkOne(u, timeoutMs, probeHost);
          cache.set(u, p);
        }
        return p;
      }
    : (u: string) => checkOne(u, timeoutMs, probeHost);
  return mapPool(absolute, concurrency, check);
}

export interface CurrencyReport {
  pageId: string;
  title: string;
  url: string;
  brokenLinks: LinkCheck[];
  /** Links whose fetch failed for DNS-vantage reasons (see LinkCheck.unverifiable).
   *  Deliberately NOT in `brokenLinks` and NOT counted in `issues`: the space
   *  dossier flags any page with issues as a data-quality problem, and a scan
   *  run off-VPN must not falsely flag every page that links intranet hosts. */
  unverifiableLinks: LinkCheck[];
  /** Human line for the unverifiable links, when any (for renderers):
   *  "2 link(s) unverifiable from this network vantage (DNS)". */
  unverifiableNote?: string;
  workingLinks: number;
  uncheckedRelativeLinks: number;
  owners: Array<{ sam: string; active: boolean; contact?: string }>;
  inactiveOwners: string[];
  hasOwnerLabel: boolean;
  lastUpdated?: string;
  staleDays?: number;
  issues: string[];
  /** Plain-text of the page body (capped at `caps.maxBodyChars`), captured from
   *  the same fetch as the review so callers needing the current content of a
   *  flagged page don't re-fetch it. */
  bodyText?: string;
  /** The page's Confluence version number, from the same fetch. */
  version?: number;
}

interface PageForReview {
  id?: string;
  title?: string;
  body?: { storage?: { value?: string } };
  version?: { when?: string; number?: number };
  metadata?: { labels?: { results?: Array<{ name?: string }> } };
  _links?: { webui?: string };
}

/** Review a page's currency: dead links + stale/invalid owner tags + age.
 *
 *  `dir` is the active-employee directory (LDAP/M365). Pass `undefined` when
 *  NO directory is configured: labeled owners are then treated as **active
 *  (unverified)** — the same semantics resolveOwners uses — so a fully-tagged
 *  healthy space is never flagged 100% "inactive owner(s)"/ownerless just
 *  because activity can't be checked. With no directory there is no evidence
 *  anyone is inactive, so no "inactive owner(s)" issue can be raised. */
export async function reviewPageCurrency(
  source: ContextSource,
  credential: ContextCredential,
  pageId: string,
  dir: UserDirectory | undefined,
  caps: ReadCaps,
  now: () => string = () => new Date().toISOString(),
  linkCache?: Map<string, Promise<LinkCheck>>,
  dnsProbe?: (host: string) => Promise<DnsPathProbe>,
): Promise<CurrencyReport> {
  const page = await fetchJson<PageForReview>(
    `${baseOf(source)}/rest/api/content/${enc(pageId)}?expand=body.storage,version,metadata.labels`,
    credential,
    caps.timeoutMs,
  );
  const html = page.body?.storage?.value ?? "";
  const labels = (page.metadata?.labels?.results ?? []).map((l) => String(l.name ?? "")).filter(Boolean);

  const links = extractLinks(html);
  const checked = await checkLinks(links, caps.timeoutMs, 6, linkCache, dnsProbe ?? probeDnsPaths);
  // UNVERIFIABLE (DNS vantage) is a third state — neither broken nor working.
  const brokenLinks = checked.filter((c) => !c.ok && !c.unverifiable);
  const unverifiableLinks = checked.filter((c) => c.unverifiable);
  const uncheckedRelativeLinks = links.filter((u) => !/^https?:\/\//i.test(u)).length;

  const ownerSams = findOwnerLabel(labels) ?? [];
  const owners = await Promise.all(
    ownerSams.map(async (sam) => {
      // No directory wired → active-by-default (UNVERIFIED). A directory
      // FAULT steps down to the same unverified answer instead of failing
      // the review or falsely deactivating the owner (mirrors resolveOwners'
      // checkActive step-down in confluenceOwnership.ts).
      if (!dir) return { sam, active: true };
      try {
        const rec = await dir(sam);
        return { sam, active: rec?.active ?? false, ...(contactOf(rec) ? { contact: contactOf(rec) } : {}) };
      } catch {
        return { sam, active: true };
      }
    }),
  );
  const inactiveOwners = owners.filter((o) => !o.active).map((o) => o.sam);

  let staleDays: number | undefined;
  if (page.version?.when) {
    const ageMs = Date.parse(now()) - Date.parse(page.version.when);
    if (!Number.isNaN(ageMs)) staleDays = Math.max(0, Math.floor(ageMs / 86_400_000));
  }

  // NOTE: unverifiable links raise NO issue on purpose — the dossier's
  // data-quality flag fires on any issue (flagsFor in spaceDossier.ts), and a
  // vantage problem is a fact about THIS scan, not about the page. They are
  // surfaced separately via `unverifiableLinks` / `unverifiableNote`.
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
    unverifiableLinks,
    ...(unverifiableLinks.length
      ? { unverifiableNote: `${unverifiableLinks.length} link(s) unverifiable from this network vantage (DNS)` }
      : {}),
    workingLinks: checked.filter((c) => c.ok).length,
    uncheckedRelativeLinks,
    owners,
    inactiveOwners,
    hasOwnerLabel: ownerSams.length > 0,
    ...(page.version?.when ? { lastUpdated: page.version.when } : {}),
    ...(staleDays !== undefined ? { staleDays } : {}),
    issues,
    ...(html ? { bodyText: htmlToText(html, caps.maxBodyChars) } : {}),
    ...(Number.isFinite(page.version?.number) && (page.version?.number ?? 0) > 0
      ? { version: page.version!.number }
      : {}),
  };
}
