import {
  TimedAuthor,
  ContributorTally,
  tallyContributorsWeighted,
  ActivePredicate,
  DEFAULT_RECENCY_HALF_LIFE_DAYS,
} from "../context/adapters/confluenceOwnership";
import { classifyError, ErrorCode } from "../core/errors";
import { redactText } from "../core/redaction";

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

/** A captured read failure: REDACTED (server bodies can echo emails/PII into
 *  error messages, and this record travels in the tool's success payload where
 *  the wrapper's redactError never runs) and bounded, plus its classification. */
export interface SpReadError {
  message: string;
  kind: string;
}

/** Failure kinds that ABORT instead of degrading (parity with the Confluence
 *  ownership pipeline's ABORT_KINDS): a rejected credential invalidates every
 *  subsequent read with the same credential (and the throw is what feeds the
 *  ADR-0009 auth-lockout breaker in the caller), and a throttling server must
 *  be backed off from, not swept. */
const ABORT_KINDS: ErrorCode[] = ["auth.failed", "graph.throttled"];

/** Capture a read failure as a redacted, bounded, classified record — or
 *  RETHROW when the kind must abort (see ABORT_KINDS). */
export function captureSpReadError(err: unknown): SpReadError {
  const kind = classifyError(err);
  if (ABORT_KINDS.includes(kind)) throw err;
  return { message: redactText(err instanceof Error ? err.message : String(err)).slice(0, 300), kind };
}

export interface SpOwnerResolution {
  /** email/UPN of the resolved owner(s). */
  owners: string[];
  basis: "page-contributor" | "none";
  considered?: ContributorTally[];
  note?: string;
  /** How activity was checked: "directory" = LDAP/M365 verified; "off" = no
   *  directory configured (owners unverified by design); "unavailable" = a
   *  directory IS configured but failed during this run, so the resolution
   *  stepped down to unverified rather than failing. */
  verification?: "directory" | "off" | "unavailable";
  /** WHY verification is "unavailable": the directory's own (redacted) error,
   *  so the outage is troubleshootable rather than just announced. */
  directoryFault?: string;
  /** Present when the versions READ failed (threaded from
   *  fetchSharePointPageEditors) — so the tool output can say "the read
   *  failed" instead of the misleading "no version history". */
  readError?: SpReadError;
}

/**
 * Resolve a SharePoint page's owner from its editors: rank by recency-weighted
 * activity, then pick the most-active who is a current active employee.
 * `isActive` is the email-keyed active predicate (from the directory). Pure.
 *
 * HARDENED (parity with Confluence): a throwing `isActive` (directory outage)
 * degrades activity checks to "assume active, report unverified" instead of
 * failing the run — the returned `verification` and `directoryFault` fields
 * make the step-down explainable. A failed versions read is threaded through
 * as `readError` so "read failed" stays distinguishable from "no editors".
 */
export async function resolveSharePointOwners(
  editors: SpEditor[],
  isActive: ActivePredicate,
  opts: {
    nowMs: number;
    halfLifeDays?: number;
    /** Whether an active-employee directory (LDAP/M365) backs `isActive` —
     *  drives the `verification` report (mirrors Confluence's directoryWired). */
    directoryWired?: boolean;
    /** The captured versions-read failure, when the editor fetch failed. */
    readError?: SpReadError;
  },
): Promise<SpOwnerResolution> {
  const ranked = tallyContributorsWeighted(
    editors.map((e): TimedAuthor => ({ sam: e.identity, ...(e.whenMs !== undefined ? { whenMs: e.whenMs } : {}) })),
    { nowMs: opts.nowMs, halfLifeDays: opts.halfLifeDays ?? DEFAULT_RECENCY_HALF_LIFE_DAYS },
  );

  // Activity checks step DOWN on a directory fault: after the first thrown
  // lookup every editor is treated as active (unverified) and the fault is
  // reported — a flaky LDAP mustn't turn "who owns this page" into an error,
  // it must turn it into a less-reliable answer the user is told about.
  let directoryFault: string | undefined;
  const checkActive = async (identity: string): Promise<boolean> => {
    if (directoryFault !== undefined) return true;
    try {
      return await isActive(identity);
    } catch (err) {
      directoryFault = redactText(err instanceof Error ? err.message : String(err)).slice(0, 300);
      return true;
    }
  };

  const finish = (r: Pick<SpOwnerResolution, "owners" | "basis" | "considered" | "note">): SpOwnerResolution => ({
    ...r,
    verification: opts.directoryWired ? (directoryFault ? "unavailable" : "directory") : "off",
    ...(directoryFault ? { directoryFault } : {}),
    ...(opts.readError ? { readError: opts.readError } : {}),
  });

  for (const c of ranked) {
    if (await checkActive(c.sam)) {
      // If the directory faulted MID-walk, restart with the plain top
      // contributor — the deterministic unverified answer (the same one a
      // from-the-start outage yields) — instead of whichever candidate the
      // fault happened to land on.
      return finish({
        owners: [directoryFault !== undefined ? ranked[0].sam : c.sam],
        basis: "page-contributor",
        considered: ranked,
      });
    }
  }
  // The "why none" note reflects what actually happened: a failed read is a
  // fixable degradation, not the content fact "this page has no history".
  return finish({
    owners: [],
    basis: "none",
    note: opts.readError
      ? "The page's version history could not be READ — a read failure, not an empty history (see the read error for what failed)."
      : ranked.length
        ? "No recent editor is a current active employee (per the directory)."
        : "No version history / editors available for this page.",
  });
}

/** Editors plus the read outcome: `readError` present = the versions read
 *  FAILED, distinguishable from a genuinely empty history (no readError). */
export interface SpEditorsRead {
  editors: SpEditor[];
  readError?: SpReadError;
}

/**
 * Fetch a modern page's editors via Graph list-item versions. `getJson` is the
 * SharePointClient's request method (injected). Degrades instead of failing:
 * a failed read comes back as a captured `readError` (some tenants restrict
 * the versions endpoint), so ownership steps down to "read failed" — never a
 * silent "no editors". EXCEPT auth.failed / graph.throttled, which are
 * RETHROWN deliberately: the throw feeds the caller's auth-lockout breaker
 * and throttle backoff (see ABORT_KINDS).
 */
export async function fetchSharePointPageEditors(
  getJson: (path: string) => Promise<unknown>,
  siteId: string,
  sitePagesListId: string,
  itemId: string,
  top = 50,
): Promise<SpEditorsRead> {
  try {
    const payload = await getJson(
      `/sites/${siteId}/lists/${sitePagesListId}/items/${itemId}/versions?$top=${top}`,
    );
    return { editors: extractPageEditors(payload) };
  } catch (err) {
    return { editors: [], readError: captureSpReadError(err) };
  }
}
