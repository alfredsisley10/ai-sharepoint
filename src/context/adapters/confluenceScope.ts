import { ConfluenceWriteScope } from "../types";

/**
 * Confluence URL → instance-base + scope parsing (ADR-0040). The guiding rule:
 * a Confluence connector ALWAYS reads globally — its `baseUrl` is the instance
 * root, so search/read/ownership/currency span the whole site — while a MANAGED
 * connector additionally carries a `writeScope` (the specific space or page the
 * user onboarded) that bounds only the MUTATING operations (page write,
 * archive, remove-from-search). Determining ownership and drafting an owner
 * notification are reads and are never bounded by the write scope.
 *
 * Handles both deployments and both space kinds, because the onboarding URL the
 * user pastes drives everything:
 *   - Data Center / Server: host root, or a context path (…/confluence/…);
 *     `/display/<KEY>`, `/spaces/<KEY>`, `/pages/viewpage.action?pageId=…`.
 *   - Cloud: the `/wiki` context path; `/spaces/<KEY>/pages/<id>/<title>`.
 *   - PERSONAL spaces, whose key starts with "~": DC `~username` / `~userkey`,
 *     Cloud `~<accountId>` (the id may contain a ":" → "%3A" when encoded). The
 *     leading "~" is an RFC-3986 *unreserved* character, so it survives
 *     encodeURIComponent untouched and needs no special-casing in REST paths or
 *     CQL — these helpers simply preserve it end-to-end.
 */

/** Path segments that mark the start of Confluence's own routing; everything
 *  before the first one is the deployment's context path (instance root). */
const APP_MARKERS = new Set([
  "display",
  "spaces",
  "pages",
  "x",
  "rest",
  "label",
  "dashboard.action",
  "dosearchsite.action",
]);

export type ConfluenceScopeKind = "instance" | "space" | "page";

/** What a URL pointed at (richer than the stored ConfluenceWriteScope: a
 *  display URL can name a page by title without carrying its id). */
export interface ConfluenceScope {
  kind: ConfluenceScopeKind;
  /** Space key, including a leading "~" for personal spaces. */
  spaceKey?: string;
  /** Numeric page id when the URL carried one. */
  pageId?: string;
  /** Page title slug when a /display URL named a page but not its id. */
  pageTitle?: string;
}

export interface ParsedConfluenceUrl {
  /** Instance base for GLOBAL reads: origin + any context path (e.g. "/wiki"
   *  on Cloud, "/confluence" on a context-path DC), no trailing slash. */
  baseUrl: string;
  scope: ConfluenceScope;
}

/** A personal space key — the tilde-prefixed convention shared by DC
 *  (`~jdoe`) and Cloud (`~<accountId>`). */
export function isPersonalSpaceKey(key: string | undefined): boolean {
  return !!key && key.trim().startsWith("~");
}

function splitInstance(u: URL): { base: string; rest: string[] } {
  const segs = u.pathname.split("/").filter(Boolean);
  const idx = segs.findIndex((s) => APP_MARKERS.has(s.toLowerCase()));
  if (idx === -1) {
    // No app marker: the whole path is the deployment's context path.
    const ctx = segs.length ? `/${segs.join("/")}` : "";
    return { base: `${u.protocol}//${u.host}${ctx}`, rest: [] };
  }
  const ctx = idx > 0 ? `/${segs.slice(0, idx).join("/")}` : "";
  return { base: `${u.protocol}//${u.host}${ctx}`, rest: segs.slice(idx) };
}

function scopeFromRest(rest: string[], params: URLSearchParams): ConfluenceScope {
  if (rest.length === 0) return { kind: "instance" };
  const head = rest[0].toLowerCase();
  const dec = (s: string) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };

  if (head === "display") {
    // /display/<KEY> [ /<Title…> ]
    if (rest.length === 1) return { kind: "instance" };
    const spaceKey = dec(rest[1]);
    if (rest.length >= 3) {
      // Classic /display titles encode spaces as "+" in the path segment.
      return { kind: "page", spaceKey, pageTitle: dec(rest.slice(2).join("/").replace(/\+/g, " ")) };
    }
    return { kind: "space", spaceKey };
  }

  if (head === "spaces") {
    if (rest.length === 1) return { kind: "instance" };
    if (rest[1].toLowerCase() === "viewspace.action") {
      const k = params.get("key");
      return k ? { kind: "space", spaceKey: dec(k) } : { kind: "instance" };
    }
    const spaceKey = dec(rest[1]);
    // /spaces/<KEY>/pages/<id>/<Title?>
    const pIdx = rest.findIndex((s) => s.toLowerCase() === "pages");
    if (pIdx !== -1 && rest[pIdx + 1] && /^\d+$/.test(rest[pIdx + 1])) {
      return { kind: "page", spaceKey, pageId: rest[pIdx + 1] };
    }
    // /spaces/<KEY>/overview, /spaces/<KEY>/blog, … → the space itself.
    return { kind: "space", spaceKey };
  }

  if (head === "pages") {
    // /pages/viewpage.action?pageId=… [&spaceKey=…]
    if (rest[1]?.toLowerCase() === "viewpage.action") {
      const id = params.get("pageId") ?? undefined;
      const sk = params.get("spaceKey") ?? undefined;
      if (id) return { kind: "page", pageId: id, ...(sk ? { spaceKey: dec(sk) } : {}) };
      return { kind: "instance" };
    }
    // /pages/<id>
    if (rest[1] && /^\d+$/.test(rest[1])) return { kind: "page", pageId: rest[1] };
    return { kind: "instance" };
  }

  // x/<tiny> (opaque), rest/…, label/…, dashboard.action → no manageable scope.
  return { kind: "instance" };
}

/** Parse any Confluence URL into the instance base (for global reads) and the
 *  scope it points at. Returns undefined only when the input isn't a URL. */
export function parseConfluenceUrl(input: string): ParsedConfluenceUrl | undefined {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return undefined;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
  const { base, rest } = splitInstance(u);
  return {
    baseUrl: base.replace(/\/+$/, ""),
    scope: scopeFromRest(rest, u.searchParams),
  };
}

/** Build the persisted write scope for a managed connector from a parsed URL.
 *  A page we only know by title (a /display page URL) falls back to its
 *  SPACE — still a precise, enforceable boundary, and the page id can be
 *  resolved later from the title. Pure. */
export function writeScopeFromParsed(parsed: ParsedConfluenceUrl, url: string): ConfluenceWriteScope {
  const s = parsed.scope;
  if (s.kind === "page" && s.pageId) {
    return { kind: "page", pageId: s.pageId, ...(s.spaceKey ? { spaceKey: s.spaceKey } : {}), url };
  }
  if ((s.kind === "page" || s.kind === "space") && s.spaceKey) {
    return { kind: "space", spaceKey: s.spaceKey, url };
  }
  return { kind: "instance", url };
}

/** Human-readable description of a write boundary, for tooltips and the
 *  refusal message. Pure. */
export function describeWriteScope(scope: ConfluenceWriteScope | undefined): string {
  if (!scope || scope.kind === "instance") return "the entire Confluence instance";
  if (scope.kind === "space") {
    const personal = isPersonalSpaceKey(scope.spaceKey) ? " (personal)" : "";
    return `the "${scope.spaceKey}"${personal} space`;
  }
  return `page ${scope.pageId}${scope.spaceKey ? ` in "${scope.spaceKey}"` : ""}`;
}

/** A mutating operation the write-scope guard evaluates. For updates the
 *  caller resolves the target page's space first (reads are global, so this
 *  lookup is always allowed). */
export interface WriteTarget {
  action: "create" | "update" | "delete" | "archive" | "blank";
  /** Space of the target — creates carry it directly; updates supply the
   *  resolved space of the page being changed. */
  spaceKey?: string;
  pageId?: string;
  /** Parent for creates: a page scope permits creating direct children. */
  parentId?: string;
}

function sameKey(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

/**
 * Pure write-scope check. An "instance" scope (or no scope at all — an
 * unscoped/legacy managed connector) permits any write; a space scope permits
 * writes whose target resolves to that space; a page scope permits writing
 * that page (and creating direct children under it). Reads, ownership lookup
 * and owner notifications never reach this guard.
 */
export function checkWriteScope(
  scope: ConfluenceWriteScope | undefined,
  target: WriteTarget,
): { allowed: boolean; reason?: string } {
  if (!scope || scope.kind === "instance") return { allowed: true };

  if (scope.kind === "space") {
    if (sameKey(target.spaceKey, scope.spaceKey)) return { allowed: true };
    return {
      allowed: false,
      reason: `target ${target.spaceKey ? `space "${target.spaceKey}"` : "page"} is outside the managed "${scope.spaceKey}" space`,
    };
  }

  // page scope
  if (target.pageId && scope.pageId && target.pageId === scope.pageId) return { allowed: true };
  if (target.action === "create" && target.parentId && scope.pageId && target.parentId === scope.pageId) {
    return { allowed: true };
  }
  return {
    allowed: false,
    reason: `target ${target.pageId ? `page ${target.pageId}` : "page"} is outside the managed page ${scope.pageId}`,
  };
}
