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
  /** Map a POST to an UPDATE (X-HTTP-Method: MERGE + IF-MATCH: *). */
  merge?: boolean;
  timeoutMs: number;
}

/** One SharePoint REST call with session cookies, with SharePoint-shaped error
 *  diagnosis. Tolerates 204 (writes) and non-JSON. */
export async function spFetch<T>(url: string, init: SpFetchInit): Promise<T> {
  const method = init.method ?? "GET";
  const headers = sessionHeaders(init.cookies, {
    ...(init.body !== undefined ? { "Content-Type": "application/json;odata=nometadata" } : {}),
    ...(init.digest ? { "X-RequestDigest": init.digest } : {}),
    ...(init.merge ? { "X-HTTP-Method": "MERGE", "IF-MATCH": "*" } : {}),
  });
  if (wireEnabled()) emitWire("sharepoint", "→", `${method} ${safeUrl(url)}`, safeHeaders(headers));
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
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
