import { ContextSource, ContextCredential, ReadCaps } from "../types";
import { fetchJson } from "../http";

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

const enc = encodeURIComponent;
const baseOf = (source: Pick<ContextSource, "baseUrl">): string => source.baseUrl.replace(/\/$/, "");
const webUrl = (source: Pick<ContextSource, "baseUrl">, webui?: string): string =>
  webui ? `${baseOf(source)}${webui}` : baseOf(source);

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
  manageablePages: number;
  gaps: ManageabilityGap[];
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
  const listed = await fetchJson<{ results?: Array<{ id?: string; title?: string; _links?: { webui?: string } }> }>(
    `${baseOf(source)}/rest/api/content?spaceKey=${enc(spaceKey)}&type=page&limit=${maxPages}`,
    credential,
    caps.timeoutMs,
  );
  const pages = listed.results ?? [];
  const gaps: ManageabilityGap[] = [];
  for (const p of pages) {
    const id = String(p.id ?? "");
    if (!id) continue;
    const restrictions = await getPageRestrictions(source, credential, id, caps.timeoutMs).catch(() => undefined);
    if (!restrictions) continue;
    const access = assessPageAccess(restrictions, username);
    if (access.canRead && access.canWrite) continue;
    const missing: Array<"read" | "write"> = [];
    if (!access.canRead) missing.push("read");
    if (!access.canWrite) missing.push("write");
    gaps.push({
      pageId: id,
      title: p.title ?? "(untitled)",
      url: webUrl(source, p._links?.webui),
      missing,
      readRestrictedTo: restrictions.read,
      updateRestrictedTo: restrictions.update,
    });
  }
  return {
    spaceKey,
    user: username,
    checkedPages: pages.length,
    manageablePages: pages.length - gaps.length,
    gaps,
  };
}

/** Prepare an access-request notification to the space admins (pure). */
export function prepareAccessRequestNote(report: ManageabilityReport): string {
  if (!report.gaps.length) {
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
  ].join("\n");
}
