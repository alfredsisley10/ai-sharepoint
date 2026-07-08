import { ContextSource, ContextCredential } from "../types";
import { fetchJson } from "../http";
import { AppError, classifyError, ErrorCode } from "../../core/errors";
import { redactText } from "../../core/redaction";
import { CONFLUENCE_WRITE_HEADERS } from "./confluenceWrite";
import { enc, baseOf as base } from "./confluenceCommon";

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
 *
 * RESOLUTION IS HARDENED AND AUDITED: every method step (label → page
 * contributors → space contributors → space owners) records what it attempted
 * and what happened (`OwnershipAuditStep`), a failing step degrades the run
 * instead of aborting it, and a failing directory steps activity checks down
 * to "unverified" with a notice — so a partial outage still yields the best
 * available answer, and the audit trail says exactly how it was reached.
 */

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
  /** Recency-weighted score (present only from tallyContributorsWeighted);
   *  drives ranking so "most active of recent history" beats a long-departed
   *  but historically prolific editor. */
  score?: number;
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

/** A version authorship with its timestamp, for recency weighting. */
export interface TimedAuthor {
  sam: string;
  /** Epoch ms of the edit; undefined contributions get the smallest weight. */
  whenMs?: number;
}

export const DEFAULT_RECENCY_HALF_LIFE_DAYS = 180;

/**
 * Rank contributors by a **recency-weighted** score: each authorship counts as
 * `0.5 ^ (ageDays / halfLifeDays)`, so a recent edit is worth far more than an
 * old one (default half-life 180 days). This honors "most ACTIVE contributor of
 * recent history" — a prolific editor who left two years ago no longer outranks
 * someone editing the page this quarter. `count` keeps the raw authorship count
 * for transparency; ranking is by `score` (tie-break count, then name). Pure —
 * `nowMs` is injected. Authors with no timestamp get a floor weight so they
 * still register below any dated contribution.
 */
export function tallyContributorsWeighted(
  authors: TimedAuthor[],
  opts: { nowMs: number; halfLifeDays?: number },
): ContributorTally[] {
  const halfLife = opts.halfLifeDays ?? DEFAULT_RECENCY_HALF_LIFE_DAYS;
  const dayMs = 86_400_000;
  const agg = new Map<string, { count: number; score: number }>();
  for (const a of authors) {
    const sam = (a.sam ?? "").trim().toLowerCase();
    if (!sam) continue;
    const ageDays = a.whenMs === undefined ? undefined : Math.max(0, (opts.nowMs - a.whenMs) / dayMs);
    const weight = ageDays === undefined ? 1e-6 : Math.pow(0.5, ageDays / halfLife);
    const prev = agg.get(sam) ?? { count: 0, score: 0 };
    agg.set(sam, { count: prev.count + 1, score: prev.score + weight });
  }
  return [...agg.entries()]
    .map(([sam, v]) => ({ sam, count: v.count, score: v.score }))
    .sort((a, b) => b.score - a.score || b.count - a.count || a.sam.localeCompare(b.sam));
}

/** Is this sAMAccountName an active user? Injected (LDAP / M365). */
export type ActivePredicate = (sam: string) => Promise<boolean>;

/** The resolution methods, in priority order. */
export type OwnershipStepId = "owner-label" | "page-contributors" | "space-contributors" | "space-owners";

export const OWNERSHIP_STEP_ORDER: OwnershipStepId[] = [
  "owner-label",
  "page-contributors",
  "space-contributors",
  "space-owners",
];

/** Human names for the audit rendering. */
export const OWNERSHIP_STEP_LABELS: Record<OwnershipStepId, string> = {
  "owner-label": "Owner label",
  "page-contributors": "Page contribution history",
  "space-contributors": "Space contribution history",
  "space-owners": "Configured space owner(s)",
};

/**
 * One entry of the ownership audit trail: which method was tried and what
 * happened. `hit` = this method determined the owner; `no-result` = the method
 * ran but found nothing usable; `failed` = the underlying read errored (the
 * pipeline stepped down to the next method); `skipped` = not attempted because
 * an earlier method already answered.
 */
export interface OwnershipAuditStep {
  step: OwnershipStepId;
  outcome: "hit" | "no-result" | "failed" | "skipped";
  /** What happened, in plain words (rendered verbatim to the user). */
  detail: string;
  /** Classified error when outcome === "failed". */
  error?: { message: string; kind: string };
  /** Ranked candidates this step weighed (transparency/troubleshooting). */
  considered?: ContributorTally[];
}

export interface OwnerResolution {
  owners: string[];
  basis: "label" | "page-contributor" | "space-contributor" | "space-owner" | "none";
  /** Ranked candidates considered for the contributor paths (for transparency). */
  considered?: ContributorTally[];
  note?: string;
  /** Full per-method audit trail — how ownership was (or wasn't) determined. */
  audit?: OwnershipAuditStep[];
  /** How activity was checked: "directory" = LDAP/M365 verified; "off" = no
   *  directory configured (owners unverified by design); "unavailable" = a
   *  directory IS configured but failed during this run, so the pipeline
   *  stepped down to unverified rather than failing. */
  verification?: "directory" | "off" | "unavailable";
  /** WHY verification is "unavailable": the directory's own (redacted) error,
   *  so the outage is troubleshootable rather than just announced. */
  directoryFault?: string;
  /** User-facing step-down notices accumulated during the run. */
  degraded?: string[];
}

/** Either a pre-fetched value or a lazy supplier that may fail — a failing
 *  supplier becomes an audited `failed` step instead of aborting the run. */
type Supplied<T> = T | (() => Promise<T>);

async function supply<T>(v: Supplied<T>): Promise<T> {
  return typeof v === "function" ? (v as () => Promise<T>)() : v;
}

/** Audit-safe error capture: REDACTED (server bodies can echo emails/PII into
 *  error messages, and the audit travels in the tool's success payload where
 *  the wrapper's redactError never runs) and bounded. */
function errInfo(err: unknown): { message: string; kind: string } {
  const raw = err instanceof Error ? err.message : String(err);
  return { message: redactText(raw).slice(0, 400), kind: classifyError(err) };
}

/** Failure kinds that ABORT resolution instead of stepping down: a rejected
 *  credential invalidates every subsequent read with the same credential (and
 *  the throw is what feeds the ADR-0009 auth-lockout breaker in the caller),
 *  and a throttling server must be backed off from, not swept. */
const ABORT_KINDS: ErrorCode[] = ["auth.failed", "graph.throttled"];

function rethrowIfAbort(err: unknown): void {
  if (ABORT_KINDS.includes(classifyError(err))) throw err;
}

/**
 * Resolve a page's owner(s) from the priority pipeline (pure; all IO injected):
 * owner label → most-prolific active page contributor → most-prolific active
 * space contributor → configured space owners. The space tally is lazy
 * (expensive) and only computed when the page itself yields no owner.
 *
 * HARDENED: each input may be a supplier whose failure is captured in the
 * audit trail (the pipeline continues with the next method), and a throwing
 * `isActive` (directory outage) degrades activity checks to "assume active,
 * report unverified" instead of failing the run. The returned `audit`,
 * `verification` and `degraded` fields make the outcome fully explainable.
 *
 * Two failure kinds ABORT instead of stepping down (the throw is deliberate —
 * it feeds the caller's auth-lockout breaker and throttle backoff): a rejected
 * credential (`auth.failed`) and a throttling source (`graph.throttled`),
 * since every remaining read would use the same credential/connection.
 */
export async function resolveOwners(input: {
  pageLabels: Supplied<string[]>;
  pageContributors: Supplied<ContributorTally[]>;
  /** Lazy space sweep. OMIT it when the space can't be swept and say why in
   *  `spaceSkippedReason` — the audit then records an honest "skipped" instead
   *  of a fabricated failure or a misleading "empty space". */
  spaceContributors?: () => Promise<ContributorTally[]>;
  spaceSkippedReason?: string;
  isActive: ActivePredicate;
  /** Last resort: the administratively-configured space owners/admins. Often
   *  NOT the effective owner (they can't fix the content), so tried only after
   *  the contributor paths — and reported with basis "space-owner" so callers
   *  can flag it as administrative rather than effective. */
  spaceOwners?: () => Promise<string[]>;
  marker?: string;
  /** Whether an active-employee directory (LDAP/AD) backs `isActive`. Drives
   *  the `verification` report and the wording of an empty result (no
   *  directory → "no contributor history" rather than "no ACTIVE one"). */
  directoryWired?: boolean;
}): Promise<OwnerResolution> {
  const marker = input.marker ?? DEFAULT_OWNER_MARKER;
  const audit: OwnershipAuditStep[] = [];

  // Activity checks step DOWN on a directory fault: after the first thrown
  // lookup every contributor is treated as active (unverified) and the fault
  // is reported — a flaky LDAP mustn't turn "who owns this page" into an
  // error, it must turn it into a less-reliable answer the user is told about.
  let directoryFault: string | undefined;
  const checkActive = async (sam: string): Promise<boolean> => {
    if (directoryFault !== undefined) return true;
    try {
      return await input.isActive(sam);
    } catch (err) {
      directoryFault = redactText(err instanceof Error ? err.message : String(err)).slice(0, 300);
      return true;
    }
  };

  /**
   * Pick the owner from a ranked list, verified when possible. If the
   * directory faults MID-walk, restart with the plain top contributor — the
   * deterministic unverified answer (the same one a from-the-start outage
   * yields) — instead of whichever candidate the fault happened to land on.
   */
  const pickActive = async (ranked: ContributorTally[]): Promise<string | undefined> => {
    const faultBefore = directoryFault !== undefined;
    for (const c of ranked) {
      if (await checkActive(c.sam)) {
        if (!faultBefore && directoryFault !== undefined) return ranked[0]!.sam;
        return c.sam;
      }
    }
    return undefined;
  };

  // Any step that FOUND candidates which then failed the active check — drives
  // an accurate "why none" note (a directory answer, not missing history).
  let sawVetoedCandidates = false;

  const finish = (
    r: Pick<OwnerResolution, "owners" | "basis" | "considered" | "note">,
    determinedBy?: OwnershipStepId,
  ): OwnerResolution => {
    if (determinedBy) {
      const after = OWNERSHIP_STEP_ORDER.slice(OWNERSHIP_STEP_ORDER.indexOf(determinedBy) + 1);
      for (const step of after) {
        audit.push({
          step,
          outcome: "skipped",
          detail:
            step === "space-owners" && !input.spaceOwners
              ? "no space-owner lookup available for this source"
              : "not attempted — an earlier method already determined the owner",
        });
      }
    }
    const degraded: string[] = [];
    if (directoryFault) {
      degraded.push(
        `The configured directory failed during active-employee checks (${directoryFault}) — owners in this run are UNVERIFIED. Check the LDAP/Active Directory connector and re-run with refresh to verify.`,
      );
    }
    for (const a of audit) {
      if (a.outcome === "failed") {
        degraded.push(`${OWNERSHIP_STEP_LABELS[a.step]} could not be read: ${a.error?.message ?? "unknown error"}`);
      }
    }
    return {
      ...r,
      audit,
      verification: input.directoryWired ? (directoryFault ? "unavailable" : "directory") : "off",
      ...(directoryFault ? { directoryFault } : {}),
      ...(degraded.length ? { degraded } : {}),
    };
  };

  // 1. Explicit owner label — authoritative when present.
  let labelReadFailed = false;
  try {
    const labels = await supply(input.pageLabels);
    const labelOwners = findOwnerLabel(labels, marker);
    if (labelOwners && labelOwners.length) {
      const activity = await Promise.all(labelOwners.map((s) => checkActive(s)));
      const inactive = labelOwners.filter((_, i) => !activity[i]);
      audit.push({
        step: "owner-label",
        outcome: "hit",
        detail: `an explicit "${marker}|…" label names ${labelOwners.join(", ")} — authoritative`,
      });
      return finish(
        {
          owners: labelOwners,
          basis: "label",
          ...(inactive.length && !directoryFault
            ? { note: `Owner label present; inactive per directory: ${inactive.join(", ")}` }
            : {}),
        },
        "owner-label",
      );
    }
    audit.push({
      step: "owner-label",
      outcome: "no-result",
      detail: labels.length
        ? `no "${marker}|…" label among the page's ${labels.length} label(s)`
        : "the page has no labels",
    });
  } catch (err) {
    rethrowIfAbort(err);
    labelReadFailed = true;
    audit.push({ step: "owner-label", outcome: "failed", detail: "could not read the page's labels", error: errInfo(err) });
  }

  // 2. Most-prolific (recency-weighted) ACTIVE page contributor.
  let pageReadFailed = false;
  try {
    const ranked = await supply(input.pageContributors);
    if (!ranked.length) {
      audit.push({ step: "page-contributors", outcome: "no-result", detail: "the page's version history yielded no contributors" });
    } else {
      const owner = await pickActive(ranked);
      if (owner) {
        audit.push({
          step: "page-contributors",
          outcome: "hit",
          detail: `top ${directoryFault || !input.directoryWired ? "" : "ACTIVE "}recency-weighted contributor of ${ranked.length}: ${owner}${
            directoryFault ? " (unverified — the directory failed during checks)" : ""
          }`,
          considered: ranked.slice(0, 5),
        });
        return finish({ owners: [owner], basis: "page-contributor", considered: ranked }, "page-contributors");
      }
      sawVetoedCandidates = true;
      audit.push({
        step: "page-contributors",
        outcome: "no-result",
        detail: `${ranked.length} contributor(s) found, but none is an active employee per the directory`,
        considered: ranked.slice(0, 5),
      });
    }
  } catch (err) {
    rethrowIfAbort(err);
    pageReadFailed = true;
    audit.push({
      step: "page-contributors",
      outcome: "failed",
      detail: "could not read the page's version history",
      error: errInfo(err),
    });
  }

  // 3. Most-prolific (recency-weighted) ACTIVE space contributor. The sweep is
  // the EXPENSIVE step (a page listing + per-page history), so it is skipped —
  // honestly, in the audit — when there's no space to sweep or when both
  // page-level reads already failed (a systemic fault: the same reads would
  // fail again ×N pages, turning one sick instance into a minutes-long crawl).
  if (!input.spaceContributors) {
    audit.push({
      step: "space-contributors",
      outcome: "skipped",
      detail: `not attempted — ${input.spaceSkippedReason ?? "no space sweep is available for this source"}`,
    });
  } else if (labelReadFailed && pageReadFailed) {
    audit.push({
      step: "space-contributors",
      outcome: "skipped",
      detail: "not attempted — both page-level reads failed (a systemic problem); fix those first, then re-run with refresh",
    });
  } else {
    try {
      const spaceRanked = await input.spaceContributors();
      if (!spaceRanked.length) {
        audit.push({ step: "space-contributors", outcome: "no-result", detail: "the space's version history yielded no contributors" });
      } else {
        const owner = await pickActive(spaceRanked);
        if (owner) {
          audit.push({
            step: "space-contributors",
            outcome: "hit",
            detail: `top ${directoryFault || !input.directoryWired ? "" : "ACTIVE "}recency-weighted contributor across the space: ${owner}${
              directoryFault ? " (unverified — the directory failed during checks)" : ""
            }`,
            considered: spaceRanked.slice(0, 5),
          });
          return finish({ owners: [owner], basis: "space-contributor", considered: spaceRanked }, "space-contributors");
        }
        sawVetoedCandidates = true;
        audit.push({
          step: "space-contributors",
          outcome: "no-result",
          detail: `${spaceRanked.length} space contributor(s) found, but none is an active employee per the directory`,
          considered: spaceRanked.slice(0, 5),
        });
      }
    } catch (err) {
      rethrowIfAbort(err);
      audit.push({
        step: "space-contributors",
        outcome: "failed",
        detail: "could not read the space's version history",
        error: errInfo(err),
      });
    }
  }

  // 4. Administratively-configured space owners (last resort).
  if (input.spaceOwners) {
    try {
      const configured = await input.spaceOwners();
      const activeConfigured: string[] = [];
      for (const raw of configured) {
        const sam = (raw ?? "").trim().toLowerCase();
        if (sam && (await checkActive(sam))) activeConfigured.push(sam);
      }
      if (activeConfigured.length) {
        audit.push({
          step: "space-owners",
          outcome: "hit",
          detail: `configured space owner(s): ${activeConfigured.join(", ")} — administratively assigned, may not be the effective owner`,
        });
        return finish(
          {
            owners: activeConfigured,
            basis: "space-owner",
            note: "No active contributor found; falling back to the configured space owner(s) — administratively assigned, may not be the effective owner.",
          },
          "space-owners",
        );
      }
      if (configured.length) sawVetoedCandidates = true;
      audit.push({
        step: "space-owners",
        outcome: "no-result",
        detail: configured.length
          ? `${configured.length} configured owner(s), none active per the directory`
          : "the space has no configured owners",
      });
    } catch (err) {
      rethrowIfAbort(err);
      audit.push({ step: "space-owners", outcome: "failed", detail: "could not read the space's configured owners", error: errInfo(err) });
    }
  } else {
    audit.push({ step: "space-owners", outcome: "skipped", detail: "no space-owner lookup available for this source" });
  }

  const failedSteps = audit.filter((a) => a.outcome === "failed");
  // The "why none" note reflects what actually happened: reads failing is a
  // fixable degradation; candidates-found-but-all-vetoed is a directory
  // answer; genuinely empty history is a content fact — three very different
  // user actions.
  const note = failedSteps.length
    ? `Owner resolution was DEGRADED — ${failedSteps.length} method(s) failed (${failedSteps
        .map((f) => OWNERSHIP_STEP_LABELS[f.step])
        .join("; ")}) and the remaining methods found no owner. See the audit trail, fix the failing read(s), and re-run with refresh.`
    : sawVetoedCandidates
      ? "Candidates were found, but none passed the active-employee check — every candidate appears inactive (or the directory can't resolve them). The audit trail lists who was considered."
      : "No contributor history was found on the page or in the space, so no owner could be inferred (this is not an LDAP/directory problem — even unverified resolution needs some edit history).";
  return finish({ owners: [], basis: "none", note });
}

// ---------------------------------------------------------------------------
// Confluence IO
// ---------------------------------------------------------------------------

/** Re-throw a fetch error with the endpoint it hit, so audit trails and error
 *  reports say WHICH read failed (a bare "Not found (404)" is undiagnosable
 *  when a resolution makes four different calls). Classification/summary are
 *  preserved. */
function withEndpoint(endpoint: string, err: unknown): AppError {
  const msg = err instanceof Error ? err.message : String(err);
  return new AppError(`${endpoint} → ${msg}`, classifyError(err), err instanceof AppError ? err.userSummary : undefined);
}

/** A page's label names. GET /rest/api/content/{id}/label */
export async function getConfluencePageLabels(
  source: ContextSource,
  credential: ContextCredential,
  pageId: string,
  timeoutMs: number,
): Promise<string[]> {
  const endpoint = `/rest/api/content/${enc(pageId)}/label`;
  try {
    const res = await fetchJson<{ results?: Array<{ name?: string }> }>(
      `${base(source)}${endpoint}`,
      credential,
      timeoutMs,
    );
    return (res.results ?? []).map((l) => String(l.name ?? "")).filter(Boolean);
  } catch (err) {
    throw withEndpoint(`GET ${endpoint}`, err);
  }
}

interface VersionBy {
  username?: string;
  publicName?: string;
  accountId?: string;
}

/**
 * Where the versions LIST lives differs by deployment: Confluence Cloud serves
 * it at `/rest/api/content/{id}/version`, but Server/Data Center only exposes
 * it under `/rest/experimental` — its `/rest/api` tree has no version list, so
 * the Cloud path 404s even though the page and its history are perfectly
 * readable (the classic "I can see the history in the browser but the API says
 * not found"). Try the deployment's home path first, fall back to the other on
 * a 404 (covers a mislabeled deployment), and remember per instance what
 * worked so the fallback probe isn't repeated on every page.
 */
const VERSION_PREFIXES = { cloud: "/rest/api", datacenter: "/rest/experimental" } as const;
const versionPrefixMemo = new Map<string, string>();

/** Test hook: forget which version-endpoint prefix worked per instance. */
export function clearVersionPrefixMemo(): void {
  versionPrefixMemo.clear();
}

function versionPrefixOrder(source: ContextSource): string[] {
  const home = VERSION_PREFIXES[source.deployment === "datacenter" ? "datacenter" : "cloud"];
  const other = home === VERSION_PREFIXES.cloud ? VERSION_PREFIXES.datacenter : VERSION_PREFIXES.cloud;
  const memo = versionPrefixMemo.get(base(source));
  return memo ? [memo, memo === home ? other : home] : [home, other];
}

/** One paged sweep of the versions list under a given REST prefix. */
async function readVersionAuthors(
  source: ContextSource,
  credential: ContextCredential,
  pageId: string,
  timeoutMs: number,
  maxVersions: number,
  prefix: string,
): Promise<TimedAuthor[]> {
  const authors: TimedAuthor[] = [];
  const pageSize = 100;
  for (let start = 0; authors.length < maxVersions; start += pageSize) {
    let res: { results?: Array<{ by?: VersionBy; when?: string }> };
    try {
      res = await fetchJson<{ results?: Array<{ by?: VersionBy; when?: string }> }>(
        `${base(source)}${prefix}/content/${enc(pageId)}/version?start=${start}&limit=${pageSize}`,
        credential,
        timeoutMs,
      );
    } catch (err) {
      // A 404 MID-pagination (permission shift, flaky intermediary) must not
      // discard the versions already read behind a misleading "not found" —
      // keep the partial tally. Only a first-request failure escapes to drive
      // the cross-deployment prefix fallback.
      if (start > 0 && classifyError(err) === "graph.notFound") break;
      throw err;
    }
    const results = res.results ?? [];
    for (const v of results) {
      const sam = v.by?.username ?? v.by?.publicName ?? v.by?.accountId;
      if (!sam) continue;
      const whenMs = v.when ? Date.parse(v.when) : NaN;
      authors.push({ sam, ...(Number.isNaN(whenMs) ? {} : { whenMs }) });
    }
    if (results.length < pageSize) break;
  }
  return authors;
}

/** Raw version authorships for a page WITH edit timestamps (paged, bounded).
 *  DC: by.username = sAMAccountName; Cloud falls back to publicName/accountId.
 *  Deployment-aware endpoint with cross-deployment 404 fallback (see above). */
async function pageVersionAuthors(
  source: ContextSource,
  credential: ContextCredential,
  pageId: string,
  timeoutMs: number,
  maxVersions: number,
): Promise<TimedAuthor[]> {
  const prefixes = versionPrefixOrder(source);
  let firstNon404: AppError | undefined;
  for (const prefix of prefixes) {
    try {
      const authors = await readVersionAuthors(source, credential, pageId, timeoutMs, maxVersions, prefix);
      versionPrefixMemo.set(base(source), prefix);
      return authors;
    } catch (err) {
      const kind = classifyError(err);
      // A 404 falls through to the other deployment's path. So does a 403 —
      // WAFs/proxies commonly block the path shape they don't expect (e.g.
      // /rest/experimental) while the other prefix works; a GENUINE permission
      // 403 fails on both and surfaces below. Auth rejection, throttling and
      // network faults are systemic: surface immediately with the endpoint.
      if (kind !== "graph.notFound" && kind !== "graph.forbidden") {
        throw withEndpoint(`GET ${prefix}/content/${pageId}/version`, err);
      }
      if (kind === "graph.forbidden" && !firstNon404) {
        firstNon404 = withEndpoint(`GET ${prefix}/content/${pageId}/version`, err);
      }
    }
  }
  if (firstNon404) throw firstNon404;
  throw new AppError(
    `Version history not found (404) for page ${pageId} — tried ${prefixes
      .map((p) => `${p}/content/${pageId}/version`)
      .join(" and ")}.`,
    "graph.notFound",
    "The page may be readable while its version-history endpoint 404s. Check: (1) the pageId is the NUMERIC content id (not a tiny-link token or a page title); (2) the connector's base URL includes the context path your browser uses (e.g. https://host/confluence for Data Center, https://site.atlassian.net/wiki for Cloud); (3) the connector's deployment type (cloud vs datacenter) matches the instance — Server/DC serves the versions list under /rest/experimental. If the browser shows the page history but this still 404s, a proxy/WAF may be blocking the REST path.",
  );
}

/** Page contributors tallied from its version history (most prolific first). */
export async function getConfluencePageContributors(
  source: ContextSource,
  credential: ContextCredential,
  pageId: string,
  timeoutMs: number,
  maxVersions = 300,
): Promise<ContributorTally[]> {
  const authors = await pageVersionAuthors(source, credential, pageId, timeoutMs, maxVersions);
  return tallyContributors(authors.map((a) => a.sam));
}

/** Page contributors ranked by RECENCY-WEIGHTED activity ("most active of
 *  recent history"), using each version's edit timestamp. */
export async function getConfluencePageContributorsWeighted(
  source: ContextSource,
  credential: ContextCredential,
  pageId: string,
  timeoutMs: number,
  nowMs: number,
  maxVersions = 300,
  halfLifeDays = DEFAULT_RECENCY_HALF_LIFE_DAYS,
): Promise<ContributorTally[]> {
  const authors = await pageVersionAuthors(source, credential, pageId, timeoutMs, maxVersions);
  return tallyContributorsWeighted(authors, { nowMs, halfLifeDays });
}

async function spaceVersionAuthors(
  source: ContextSource,
  credential: ContextCredential,
  spaceKey: string,
  timeoutMs: number,
  maxPages: number,
  maxVersionsPerPage: number,
): Promise<TimedAuthor[]> {
  const listEndpoint = `/rest/api/content?spaceKey=${enc(spaceKey)}&type=page&limit=${maxPages}`;
  let listed: { results?: Array<{ id?: string }> };
  try {
    listed = await fetchJson<{ results?: Array<{ id?: string }> }>(
      `${base(source)}${listEndpoint}`,
      credential,
      timeoutMs,
    );
  } catch (err) {
    throw withEndpoint(`GET ${listEndpoint}`, err);
  }
  const ids = (listed.results ?? []).map((p) => String(p.id ?? "")).filter(Boolean);
  const authors: TimedAuthor[] = [];
  let readable = 0;
  let failed = 0;
  let lastErr: unknown;
  // Per-page histories are independent reads, so sweep them in BATCHES of 5
  // concurrent reads (the dossier's bounded-concurrency batch loop) instead of
  // one page at a time. Semantics preserved: abort kinds still rethrow per
  // failure, and the "opened with nothing but failures → systemic, bail"
  // check runs BETWEEN batches — so the opening batch may record up to 5
  // failures before the check, and the failure count keeps the systemic error
  // message truthful about how many pages were actually attempted.
  const concurrency = 5;
  for (let i = 0; i < ids.length && !(readable === 0 && failed >= 3); i += concurrency) {
    const batch = ids.slice(i, i + concurrency);
    const settled = await Promise.all(
      batch.map(async (id) => {
        try {
          return {
            ok: true as const,
            authors: await pageVersionAuthors(source, credential, id, timeoutMs, maxVersionsPerPage),
          };
        } catch (err) {
          return { ok: false as const, err };
        }
      }),
    );
    for (const s of settled) {
      if (s.ok) {
        authors.push(...s.authors);
        readable += 1;
      } else {
        // Abort kinds are systemic by definition — stop the sweep immediately
        // (the throw feeds the caller's breaker/backoff instead of hammering).
        rethrowIfAbort(s.err);
        // One unreadable page shouldn't void the space tally… but a sweep that
        // OPENS with failures and no successes is systemic (endpoint shape,
        // auth, proxy) — the loop condition bails before the next batch
        // instead of burning a timeout per remaining page on a sick instance.
        lastErr = s.err;
        failed += 1;
      }
    }
  }
  // EVERY attempted page failing is a systemic problem that must surface as a
  // failure, not masquerade as "empty history".
  if (ids.length > 0 && readable === 0 && failed > 0) {
    const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
    const scope = failed === ids.length ? `the ${ids.length}` : `the first ${failed} of ${ids.length}`;
    throw new AppError(
      `Could not read version history for any of ${scope} sampled page(s) in space ${spaceKey}. Last error: ${msg}`,
      classifyError(lastErr),
      lastErr instanceof AppError ? lastErr.userSummary : undefined,
    );
  }
  return authors;
}

/** Space contributors ranked by RECENCY-WEIGHTED activity. */
export async function getConfluenceSpaceContributorsWeighted(
  source: ContextSource,
  credential: ContextCredential,
  spaceKey: string,
  timeoutMs: number,
  nowMs: number,
  maxPages = 25,
  maxVersionsPerPage = 100,
  halfLifeDays = DEFAULT_RECENCY_HALF_LIFE_DAYS,
): Promise<ContributorTally[]> {
  const authors = await spaceVersionAuthors(source, credential, spaceKey, timeoutMs, maxPages, maxVersionsPerPage);
  return tallyContributorsWeighted(authors, { nowMs, halfLifeDays });
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
        CONFLUENCE_WRITE_HEADERS,
        { method: "DELETE" },
      );
    }
  }
  const label = buildOwnerLabel(sams, marker);
  await fetchJson<unknown>(
    `${base(source)}/rest/api/content/${enc(pageId)}/label`,
    credential,
    timeoutMs,
    CONFLUENCE_WRITE_HEADERS,
    { method: "POST", body: [{ prefix: "global", name: label }] },
  );
  return label;
}
