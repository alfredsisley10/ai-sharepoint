import { ContextSource, ContextCredential, ReadCaps } from "../types";
import { fetchJson } from "../http";
import { classifyError } from "../../core/errors";
import { redactText } from "../../core/redaction";
import { enc, baseOf, webUrl } from "./confluenceCommon";
import { fetchAllPages } from "./confluenceHierarchy";

/**
 * Confluence space "manageability" entitlement review (ADR-0044): can the
 * signed-in user **read and write every page** in a space? The usual reason
 * they can't is **page-level restrictions** that exclude them. This audits each
 * page's read/update restrictions, summarizes the gaps, and prepares an access
 * request for the space admins who can grant access.
 *
 * Note: group membership isn't resolved here, so a page restricted to a *group*
 * the user belongs to is conservatively reported as a gap (the restriction's
 * groups are included so an admin can verify). Read-only audit.
 */

export interface RestrictionSet {
  users: string[];
  groups: string[];
}
export interface PageRestrictions {
  read: RestrictionSet;
  update: RestrictionSet;
}

function parseSet(op: unknown): RestrictionSet {
  const r = ((op as { restrictions?: unknown })?.restrictions ?? {}) as {
    user?: { results?: Array<{ username?: string; accountId?: string }> };
    group?: { results?: Array<{ name?: string }> };
  };
  return {
    users: (r.user?.results ?? []).map((u) => String(u.username ?? u.accountId ?? "")).filter(Boolean),
    groups: (r.group?.results ?? []).map((g) => String(g.name ?? "")).filter(Boolean),
  };
}

/** Parse `/restriction/byOperation` → read/update restriction sets (pure). */
export function parseRestrictions(payload: unknown): PageRestrictions {
  const p = (payload ?? {}) as { read?: unknown; update?: unknown };
  return { read: parseSet(p.read), update: parseSet(p.update) };
}

export interface PageAccess {
  canRead: boolean;
  canWrite: boolean;
}

/** Can `username` read/update a page given its restrictions? (pure). A
 *  restriction is "active" when it lists any users or groups; an active
 *  restriction that doesn't explicitly list the user blocks them (groups
 *  unresolved → conservative). */
export function assessPageAccess(r: PageRestrictions, username: string): PageAccess {
  const u = username.toLowerCase();
  const active = (s: RestrictionSet) => s.users.length > 0 || s.groups.length > 0;
  const listed = (s: RestrictionSet) => s.users.some((x) => x.toLowerCase() === u);
  return {
    canRead: !active(r.read) || listed(r.read),
    canWrite: !active(r.update) || listed(r.update),
  };
}

/** A page's read+update restrictions. GET /content/{id}/restriction/byOperation */
export async function getPageRestrictions(
  source: ContextSource,
  credential: ContextCredential,
  pageId: string,
  timeoutMs: number,
): Promise<PageRestrictions> {
  const res = await fetchJson<unknown>(
    `${baseOf(source)}/rest/api/content/${enc(pageId)}/restriction/byOperation?expand=restrictions.user,restrictions.group`,
    credential,
    timeoutMs,
  );
  return parseRestrictions(res);
}

/** The signed-in Confluence user's username (sam on Data Center). */
export async function getCurrentConfluenceUser(
  source: ContextSource,
  credential: ContextCredential,
  timeoutMs: number,
): Promise<string> {
  const me = await fetchJson<{ username?: string; accountId?: string }>(
    `${baseOf(source)}/rest/api/user/current`,
    credential,
    timeoutMs,
  );
  return String(me.username ?? me.accountId ?? "");
}

export interface ManageabilityGap {
  pageId: string;
  title: string;
  url: string;
  missing: Array<"read" | "write">;
  readRestrictedTo: RestrictionSet;
  updateRestrictedTo: RestrictionSet;
}

export interface ManageabilityReport {
  spaceKey: string;
  user: string;
  checkedPages: number;
  /** Pages whose restrictions were READ successfully and showed no gap. Pages
   *  whose restriction check FAILED are counted in `checkFailures`, not here —
   *  an unchecked page is unknown, not manageable. */
  manageablePages: number;
  gaps: ManageabilityGap[];
  /** Pages whose restriction read failed (non-systemic errors only — an auth
   *  rejection or throttle aborts the whole audit instead). When > 0 the audit
   *  is INCOMPLETE and must not be read as an all-clear. */
  checkFailures?: number;
  /** One redacted sample of the failing restriction reads, for troubleshooting. */
  checkFailureSample?: string;
}

/** Audit a space: which pages the user can't fully manage (read + write). */
export async function reviewSpaceManageability(
  source: ContextSource,
  credential: ContextCredential,
  spaceKey: string,
  username: string,
  caps: ReadCaps,
  maxPages = 200,
): Promise<ManageabilityReport> {
  // Paginated listing (start+limit, bounded by maxPages) — a single
  // limit=maxPages request silently truncated the audit to the server's
  // clamped first batch, so pages beyond it were never checked at all.
  const listed = await fetchAllPages(
    credential,
    (start, limit) =>
      `${baseOf(source)}/rest/api/content?spaceKey=${enc(spaceKey)}&type=page&start=${start}&limit=${limit}`,
    caps,
    maxPages,
  );
  const pages = listed
    .map((p) => ({ id: String(p.id ?? ""), title: p.title, webui: p._links?.webui }))
    .filter((p) => p.id);
  const gaps: ManageabilityGap[] = [];
  let checkFailures = 0;
  let checkFailureSample: string | undefined;
  // Restriction reads are independent — batches of 5 concurrent reads (the
  // dossier's bounded-concurrency batch loop) instead of one page at a time.
  const concurrency = 5;
  for (let i = 0; i < pages.length; i += concurrency) {
    const batch = pages.slice(i, i + concurrency);
    const restrictionSets = await Promise.all(
      batch.map(async (p) => {
        try {
          return await getPageRestrictions(source, credential, p.id, caps.timeoutMs);
        } catch (err) {
          // A rejected credential or a throttling server invalidates every
          // remaining read with the same credential/connection — ABORT the
          // audit (mirrors confluenceOwnership's ABORT_KINDS) rather than
          // "completing" it having checked nothing.
          const kind = classifyError(err);
          if (kind === "auth.failed" || kind === "graph.throttled") throw err;
          // Any other per-page failure is COUNTED (with one redacted sample)
          // so the report can say the audit is INCOMPLETE — a swallowed
          // failure used to read as "manageable", and a fully-failing
          // restrictions endpoint produced gaps:[] — a false all-clear.
          checkFailures += 1;
          checkFailureSample ??= redactText(err instanceof Error ? err.message : String(err)).slice(0, 300);
          return undefined;
        }
      }),
    );
    for (let k = 0; k < batch.length; k += 1) {
      const restrictions = restrictionSets[k];
      if (!restrictions) continue;
      const p = batch[k];
      const access = assessPageAccess(restrictions, username);
      if (access.canRead && access.canWrite) continue;
      const missing: Array<"read" | "write"> = [];
      if (!access.canRead) missing.push("read");
      if (!access.canWrite) missing.push("write");
      gaps.push({
        pageId: p.id,
        title: p.title ?? "(untitled)",
        url: webUrl(source, p.webui),
        missing,
        readRestrictedTo: restrictions.read,
        updateRestrictedTo: restrictions.update,
      });
    }
  }
  return {
    spaceKey,
    user: username,
    checkedPages: pages.length,
    manageablePages: pages.length - gaps.length - checkFailures,
    gaps,
    ...(checkFailures > 0
      ? { checkFailures, ...(checkFailureSample ? { checkFailureSample } : {}) }
      : {}),
  };
}

/** Prepare an access-request notification to the space admins (pure). When
 *  restriction checks FAILED (`checkFailures > 0`) the note says the audit is
 *  INCOMPLETE — a run whose restriction reads all failed (revoked credential,
 *  blocked endpoint, …) must never read as "you can manage everything". */
export function prepareAccessRequestNote(report: ManageabilityReport): string {
  const failures = report.checkFailures ?? 0;
  const failureDetail = `the restriction check failed on ${failures} of ${report.checkedPages} page(s)${
    report.checkFailureSample ? ` (sample error: ${report.checkFailureSample})` : ""
  }`;
  if (!report.gaps.length) {
    if (failures > 0) {
      return [
        `No confirmed access gaps for ${report.user} in space ${report.spaceKey}, but this audit is INCOMPLETE — ${failureDetail}.`,
        `The failed pages were NOT verified — do not treat this as "${report.user} can manage everything". Fix the failing restriction reads and re-run the review.`,
      ].join("\n");
    }
    return `${report.user} can already manage all ${report.checkedPages} pages in space ${report.spaceKey} — no access request needed.`;
  }
  const lines = report.gaps.map(
    (g) => `- ${g.title} (${g.url}) — missing: ${g.missing.join(" + ")}`,
  );
  return [
    `Access request for Confluence space ${report.spaceKey}`,
    "",
    `${report.user} needs to manage all pages but lacks access to ${report.gaps.length} of ${report.checkedPages} page(s):`,
    ...lines,
    "",
    `Please grant ${report.user} read/write on these pages (or add them to the listed restriction users/groups) so the content can be managed.`,
    ...(failures > 0
      ? [
          "",
          `Note: this audit is INCOMPLETE — ${failureDetail}. Those pages were not verified and may hide further gaps; fix the failing reads and re-run.`,
        ]
      : []),
  ].join("\n");
}
