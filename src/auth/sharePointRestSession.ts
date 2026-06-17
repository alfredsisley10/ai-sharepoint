import { AppError } from "../core/errors";
import { emitWire, safeUrl, safeHeaders, wireEnabled, capDetail } from "../core/wireLog";
import { cleanCookieString, cookieNames } from "../context/adapters/servicenowAuth";

/**
 * SharePoint Online WRITE via the user's own BROWSER SESSION (ADR-0046).
 *
 * Every OAuth path to a SharePoint write — Graph Sites.ReadWrite.All /
 * Sites.Manage.All, the per-site Sites.Selected, even SharePoint REST
 * AllSites.Write — needs TENANT-ADMIN consent, so a user's real Web-UI
 * permissions never reach the app's token. And the old site-owner-grantable
 * escape hatch (Azure ACS app-only via appregnew/appinv) was fully retired on
 * 2026-04-02. The remaining no-admin path is to REPLAY the user's existing
 * signed-in session: their `FedAuth`/`rtFa` cookies authenticate, and a form
 * digest from `/_api/contextinfo` authorizes the write — exactly the pattern
 * this codebase already uses for ServiceNow (`snow-session`), here against the
 * SharePoint REST API (`/_api/web/...`). The user's OWN authorized session is
 * what authenticates; this is interoperability, not privilege escalation.
 *
 * Reuses the ServiceNow cookie utilities (cleanCookieString / cookieNames),
 * which are generic. This module is mostly pure; the IO functions are
 * unit-tested with a fetch mock.
 */

/** Browser-compatibility UA — SSO/WAF front-ends in front of SharePoint drop
 *  non-browser clients even with valid cookies (same finding as ServiceNow). */
export const SHAREPOINT_SESSION_USER_AGENT =
  "Mozilla/5.0 (compatible; AI-SharePoint-VSCode; SharePoint session replay)";

/** The site's REST API base, e.g. https://contoso.sharepoint.com/sites/Eng/_api */
export function apiBase(siteUrl: string): string {
  return `${siteUrl.replace(/\/+$/, "")}/_api`;
}

/** Request headers for a session call (cookies + browser UA + JSON). Pure. */
export function sessionHeaders(cookies: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    Cookie: cleanCookieString(cookies),
    "User-Agent": SHAREPOINT_SESSION_USER_AGENT,
    Accept: "application/json;odata=nometadata",
    ...extra,
  };
}

/** Extract the form-digest value from a /_api/contextinfo response (handles
 *  nometadata and verbose shapes). Pure. */
export function parseFormDigest(body: unknown): string | undefined {
  const b = body as {
    FormDigestValue?: string;
    d?: { GetContextWebInformation?: { FormDigestValue?: string } };
  };
  return b?.FormDigestValue ?? b?.d?.GetContextWebInformation?.FormDigestValue ?? undefined;
}

/** Pull the human message out of a SharePoint REST error envelope (nometadata
 *  `odata.error` or verbose `error`). Pure. */
export function parseSpError(bodyText: string): string | undefined {
  try {
    const b = JSON.parse(bodyText) as {
      "odata.error"?: { message?: { value?: string } };
      error?: { message?: { value?: string } | string };
    };
    const v =
      b["odata.error"]?.message?.value ??
      (typeof b.error?.message === "string" ? b.error.message : b.error?.message?.value);
    return v?.trim() || undefined;
  } catch {
    const title = bodyText.match(/<title[^>]*>([^<]{1,120})/i)?.[1]?.trim();
    return title ? `an HTML page titled "${title}"` : undefined;
  }
}

interface SpFetchInit {
  method?: "GET" | "POST";
  cookies: string;
  /** Required for writes (POST). */
  digest?: string;
  body?: unknown;
  /** Raw (non-JSON) request body — file uploads send bytes/text as-is. */
  rawBody?: string;
  /** Map a POST to an UPDATE (X-HTTP-Method: MERGE + IF-MATCH: *). */
  merge?: boolean;
  /** Tunnel another verb through POST (DELETE/PUT) — also sends IF-MATCH: *. */
  xHttpMethod?: "DELETE" | "PUT";
  /** Override the Accept header (e.g. text/plain to read a file's $value). */
  accept?: string;
  /** Return the raw response text instead of JSON.parse (file content). */
  returnText?: boolean;
  timeoutMs: number;
}

/** One SharePoint REST call with session cookies, with SharePoint-shaped error
 *  diagnosis. Tolerates 204 (writes) and non-JSON. */
export async function spFetch<T>(url: string, init: SpFetchInit): Promise<T> {
  const method = init.method ?? "GET";
  const tunnel = init.merge ? "MERGE" : init.xHttpMethod;
  const headers = sessionHeaders(init.cookies, {
    ...(init.accept ? { Accept: init.accept } : {}),
    ...(init.body !== undefined ? { "Content-Type": "application/json;odata=nometadata" } : {}),
    ...(init.digest ? { "X-RequestDigest": init.digest } : {}),
    ...(tunnel ? { "X-HTTP-Method": tunnel, "IF-MATCH": "*" } : {}),
  });
  if (wireEnabled()) emitWire("sharepoint", "→", `${method} ${safeUrl(url)}`, safeHeaders(headers));
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      ...(init.rawBody !== undefined
        ? { body: init.rawBody }
        : init.body !== undefined
          ? { body: JSON.stringify(init.body) }
          : {}),
      // First-party Referer (same as the Confluence CSRF fix) — SharePoint's
      // own CSRF defenses also reject a state-changing call with a null origin.
      referrer: `${new URL(url).origin}`,
      referrerPolicy: "unsafe-url" as RequestInit["referrerPolicy"],
      signal: AbortSignal.timeout(init.timeoutMs),
    });
  } catch (err) {
    emitWire("sharepoint", "✗", `${method} ${safeUrl(url)} — ${err instanceof Error ? err.message : String(err)}`);
    throw new AppError(`SharePoint request failed: ${err instanceof Error ? err.message : String(err)}`, "network");
  }
  if (res.status === 401 || res.status === 403) {
    const reason = parseSpError(await res.text().catch(() => "")) ?? "";
    throw new AppError(
      `SharePoint rejected the session (${res.status})${reason ? `: ${reason}` : ""}. Cookies replayed: ${cookieNames(init.cookies).join(", ") || "none"}.`,
      "auth.failed",
      "The browser session was rejected. Re-capture the cookies from a signed-in SharePoint tab (sessions expire in hours), making sure to copy the WHOLE Cookie header (FedAuth, rtFa, and any load-balancer/SSO cookies). If a security gateway fronts the tenant, only the full browser Cookie header satisfies it.",
    );
  }
  const text = await res.text();
  if (wireEnabled()) emitWire("sharepoint", "←", `${method} ${safeUrl(url)} ${res.status} · ${text.length}b`, capDetail(text));
  if (!res.ok) {
    throw new AppError(`SharePoint request failed (${res.status}): ${parseSpError(text) ?? text.slice(0, 200)}`, "unknown");
  }
  if (init.returnText) return text as unknown as T; // raw file content
  if (!text.trim()) return undefined as unknown as T; // 204 (write MERGE/DELETE)
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new AppError(
      "SharePoint returned a non-JSON page (a login/SSO redirect?) — the session cookies were not accepted.",
      "auth.failed",
      "Re-capture the cookies from a signed-in tab; a gateway likely intercepted the call.",
    );
  }
}

/** POST /_api/contextinfo → the form digest needed for every write. */
export async function getFormDigest(siteUrl: string, cookies: string, timeoutMs: number): Promise<string> {
  const body = await spFetch<unknown>(`${apiBase(siteUrl)}/contextinfo`, { method: "POST", cookies, timeoutMs });
  const digest = parseFormDigest(body);
  if (!digest) throw new AppError("SharePoint did not return a form digest.", "unknown");
  return digest;
}

export interface SessionIdentity {
  webTitle: string;
  account: string;
  loginName?: string;
}

/** Verify the session works: read the web title + the current user. */
export async function verifySharePointSession(
  siteUrl: string,
  cookies: string,
  timeoutMs: number,
): Promise<SessionIdentity> {
  const web = await spFetch<{ Title?: string }>(`${apiBase(siteUrl)}/web?$select=Title`, { cookies, timeoutMs });
  const me = await spFetch<{ Title?: string; Email?: string; LoginName?: string }>(
    `${apiBase(siteUrl)}/web/currentuser?$select=Title,Email,LoginName`,
    { cookies, timeoutMs },
  );
  return {
    webTitle: web.Title ?? "(site)",
    account: me.Title ?? me.Email ?? me.LoginName ?? "verified",
    ...(me.LoginName ? { loginName: me.LoginName } : {}),
  };
}

const enc = encodeURIComponent;
const listPath = (siteUrl: string, listTitle: string) =>
  `${apiBase(siteUrl)}/web/lists/getbytitle('${listTitle.replace(/'/g, "''")}')`;

export interface ListItem {
  Id: number;
  [field: string]: unknown;
}

/** Read items from a list (read-only — proves access + reveals INTERNAL field
 *  names the writes must use). */
export async function getListItems(
  siteUrl: string,
  listTitle: string,
  cookies: string,
  opts: { select?: string; filter?: string; top?: number },
  timeoutMs: number,
): Promise<ListItem[]> {
  const q = new URLSearchParams();
  if (opts.select) q.set("$select", opts.select);
  if (opts.filter) q.set("$filter", opts.filter);
  q.set("$top", String(Math.min(opts.top ?? 50, 500)));
  const res = await spFetch<{ value?: ListItem[] }>(`${listPath(siteUrl, listTitle)}/items?${q.toString()}`, {
    cookies,
    timeoutMs,
  });
  return res.value ?? [];
}

/** Create a list item. `fields` uses INTERNAL field names (see getListItems). */
export async function createListItem(
  siteUrl: string,
  listTitle: string,
  fields: Record<string, unknown>,
  cookies: string,
  digest: string,
  timeoutMs: number,
): Promise<ListItem> {
  return spFetch<ListItem>(`${listPath(siteUrl, listTitle)}/items`, {
    method: "POST",
    cookies,
    digest,
    body: fields,
    timeoutMs,
  });
}

/** Update a list item by id (MERGE — only the given fields change). */
export async function updateListItem(
  siteUrl: string,
  listTitle: string,
  itemId: number,
  fields: Record<string, unknown>,
  cookies: string,
  digest: string,
  timeoutMs: number,
): Promise<void> {
  await spFetch<void>(`${listPath(siteUrl, listTitle)}/items(${enc(String(itemId))})`, {
    method: "POST",
    cookies,
    digest,
    body: fields,
    merge: true,
    timeoutMs,
  });
}

// ---------------------------------------------------------------------------
// Document libraries (files & folders)
// ---------------------------------------------------------------------------

/** A SharePoint method-call/query alias for a server-relative path: fully
 *  percent-encoded (spaces, unicode) with apostrophes doubled per OData. Using
 *  the alias form `(@f)?@f='…'` avoids the fragility of inlining a path with
 *  spaces into the URL. Pure. */
export function spAlias(name: string, value: string): string {
  return `${name}=${encodeURIComponent(`'${value.replace(/'/g, "''")}'`)}`;
}

export interface SpFile {
  Name: string;
  ServerRelativeUrl: string;
  /** Bytes (SharePoint returns this as a string). */
  Length?: string;
  TimeLastModified?: string;
  UniqueId?: string;
}
export interface SpFolder {
  Name: string;
  ServerRelativeUrl: string;
  ItemCount?: number;
}

/** Resolve a document library's display title to its root folder's
 *  server-relative URL, so callers can pass a friendly name OR a path. */
export async function getLibraryRootFolder(
  siteUrl: string,
  libraryTitle: string,
  cookies: string,
  timeoutMs: number,
): Promise<string> {
  const res = await spFetch<{ ServerRelativeUrl?: string }>(
    `${listPath(siteUrl, libraryTitle)}/RootFolder?$select=ServerRelativeUrl`,
    { cookies, timeoutMs },
  );
  if (!res.ServerRelativeUrl) throw new AppError(`Library “${libraryTitle}” has no resolvable folder.`, "unknown");
  return res.ServerRelativeUrl;
}

/** List the files and sub-folders directly under a server-relative folder. */
export async function listFolder(
  siteUrl: string,
  folderServerRelativeUrl: string,
  cookies: string,
  timeoutMs: number,
): Promise<{ files: SpFile[]; folders: SpFolder[] }> {
  const base = `${apiBase(siteUrl)}/web/GetFolderByServerRelativeUrl(@f)`;
  const f = spAlias("@f", folderServerRelativeUrl);
  const files = await spFetch<{ value?: SpFile[] }>(
    `${base}/Files?${f}&$select=Name,ServerRelativeUrl,Length,TimeLastModified,UniqueId`,
    { cookies, timeoutMs },
  );
  const folders = await spFetch<{ value?: SpFolder[] }>(
    `${base}/Folders?${f}&$select=Name,ServerRelativeUrl,ItemCount`,
    { cookies, timeoutMs },
  );
  return {
    files: files.value ?? [],
    // SharePoint surfaces the system "Forms" folder — hide it from navigation.
    folders: (folders.value ?? []).filter((x) => x.Name !== "Forms"),
  };
}

/** Read a file's content as text (for text/markdown/csv/json/xml documents). */
export async function readFileText(
  siteUrl: string,
  fileServerRelativeUrl: string,
  cookies: string,
  timeoutMs: number,
): Promise<string> {
  return spFetch<string>(
    `${apiBase(siteUrl)}/web/GetFileByServerRelativeUrl(@f)/$value?${spAlias("@f", fileServerRelativeUrl)}`,
    { cookies, accept: "text/plain", returnText: true, timeoutMs },
  );
}

/** Upload (create or overwrite) a text file into a folder. */
export async function uploadTextFile(
  siteUrl: string,
  folderServerRelativeUrl: string,
  fileName: string,
  content: string,
  cookies: string,
  digest: string,
  timeoutMs: number,
): Promise<SpFile> {
  const url =
    `${apiBase(siteUrl)}/web/GetFolderByServerRelativeUrl(@f)/Files/add(url='${encodeURIComponent(fileName.replace(/'/g, "''"))}',overwrite=true)` +
    `?${spAlias("@f", folderServerRelativeUrl)}`;
  return spFetch<SpFile>(url, { method: "POST", cookies, digest, rawBody: content, timeoutMs });
}

/** Delete a file by its server-relative URL. */
export async function deleteFile(
  siteUrl: string,
  fileServerRelativeUrl: string,
  cookies: string,
  digest: string,
  timeoutMs: number,
): Promise<void> {
  await spFetch<void>(
    `${apiBase(siteUrl)}/web/GetFileByServerRelativeUrl(@f)?${spAlias("@f", fileServerRelativeUrl)}`,
    { method: "POST", cookies, digest, xHttpMethod: "DELETE", timeoutMs },
  );
}

// ---------------------------------------------------------------------------
// Modern pages (Site Pages)
// ---------------------------------------------------------------------------

export interface SitePageSummary {
  Id: number;
  Title?: string;
  FileName?: string;
  Url?: string;
  PromotedState?: number;
}

/** Build the CanvasContent1 for a single rich-text web part. The trailing
 *  controlType-0 slice is the page-settings control SharePoint expects. Pure —
 *  the version-sensitive part of page authoring, isolated for testing. */
export function buildTextCanvas(html: string, id: string = randomId()): string {
  return JSON.stringify([
    {
      controlType: 4,
      id,
      position: { controlIndex: 1, sectionIndex: 1, sectionFactor: 12, zoneIndex: 1, layoutIndex: 1 },
      emphasis: {},
      innerHTML: html,
    },
    { controlType: 0, pageSettingsSlice: { isDefaultDescription: true, isDefaultThumbnail: true } },
  ]);
}

/** Extract readable text from a page's CanvasContent1 (strips the web-part
 *  HTML). Best-effort — unknown web parts contribute nothing. Pure. */
export function extractCanvasText(canvasContent1: string | null | undefined): string {
  if (!canvasContent1) return "";
  let controls: Array<{ controlType?: number; innerHTML?: string }>;
  try {
    controls = JSON.parse(canvasContent1) as typeof controls;
  } catch {
    return "";
  }
  return controls
    .filter((c) => c.controlType === 4 && typeof c.innerHTML === "string")
    .map((c) =>
      String(c.innerHTML)
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter(Boolean)
    .join("\n\n");
}

function randomId(): string {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

/** List the site's modern pages. */
export async function listSitePages(siteUrl: string, cookies: string, timeoutMs: number): Promise<SitePageSummary[]> {
  const res = await spFetch<{ value?: SitePageSummary[] }>(
    `${apiBase(siteUrl)}/sitepages/pages?$select=Id,Title,FileName,Url,PromotedState`,
    { cookies, timeoutMs },
  );
  return res.value ?? [];
}

/** Read a page's title + readable text content by id. */
export async function getSitePage(
  siteUrl: string,
  pageId: number,
  cookies: string,
  timeoutMs: number,
): Promise<{ Id: number; Title?: string; Url?: string; text: string }> {
  const p = await spFetch<{ Id: number; Title?: string; Url?: string; CanvasContent1?: string }>(
    `${apiBase(siteUrl)}/sitepages/pages(${pageId})`,
    { cookies, timeoutMs },
  );
  return { Id: p.Id, ...(p.Title ? { Title: p.Title } : {}), ...(p.Url ? { Url: p.Url } : {}), text: extractCanvasText(p.CanvasContent1) };
}

/**
 * Create a modern page with a single text web part and publish it. Best-effort:
 * the SitePages create→savepage→publish dance is SharePoint-version sensitive,
 * so failures here are reported plainly rather than presented as impossible.
 * `bodyHtml` is the rich-text HTML (callers pass <p>…</p> etc).
 */
export async function createTextPage(
  siteUrl: string,
  title: string,
  bodyHtml: string,
  cookies: string,
  digest: string,
  timeoutMs: number,
): Promise<{ Id: number; Url?: string }> {
  const created = await spFetch<{ Id: number; Url?: string }>(`${apiBase(siteUrl)}/sitepages/pages`, {
    method: "POST",
    cookies,
    digest,
    body: { Title: title, PageLayoutType: "Article" },
    timeoutMs,
  });
  await spFetch<unknown>(`${apiBase(siteUrl)}/sitepages/pages(${created.Id})/SavePage`, {
    method: "POST",
    cookies,
    digest,
    body: { Title: title, CanvasContent1: buildTextCanvas(bodyHtml) },
    timeoutMs,
  });
  await spFetch<unknown>(`${apiBase(siteUrl)}/sitepages/pages(${created.Id})/Publish`, {
    method: "POST",
    cookies,
    digest,
    timeoutMs,
  });
  return { Id: created.Id, ...(created.Url ? { Url: created.Url } : {}) };
}

/** Quick shape check for a pasted SharePoint cookie capture. */
export function sharePointCookieIssue(raw: string): string | undefined {
  const names = cookieNames(raw).map((n) => n.toLowerCase());
  if (!cleanCookieString(raw).includes("=")) {
    return "That doesn't look like a cookie string — in a signed-in SharePoint tab open DevTools → Network, click any request to the site, and copy the whole Cookie request header.";
  }
  if (!names.includes("fedauth") && !names.includes("rtfa")) {
    return "The capture has no FedAuth/rtFa cookie — those are the SharePoint session cookies. Copy the COMPLETE Cookie header (some are HttpOnly, so the Network tab's request header is the reliable source).";
  }
  return undefined;
}
