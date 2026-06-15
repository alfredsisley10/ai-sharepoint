import { AppError } from "../core/errors";
import { ContextCredential } from "./types";
import {
  cleanCookieString,
  describeSnowRejection,
  parseSnowSessionSecret,
  SNOW_SESSION_USER_AGENT,
} from "./adapters/servicenowAuth";
import { wireEnabled, emitWire, capDetail, safeHeaders, safeUrl } from "../core/wireLog";

/** Shared fetch wrapper for context adapters: auth header construction,
 *  timeouts, response-size caps, status→ErrorCode mapping. Pure. */

export function authHeader(credential: ContextCredential): string {
  if (credential.method === "pat") {
    return `Bearer ${credential.secret}`;
  }
  const user = credential.username ?? "";
  return `Basic ${Buffer.from(`${user}:${credential.secret}`).toString("base64")}`;
}

/** Build the auth header(s) for a credential. Cookie-session credentials
 *  (ServiceNow browser SSO — `snow-session`) authenticate the REST API by
 *  replaying the browser's session **cookies** for read requests, so they
 *  send a `Cookie` header and no `Authorization`. The stored capture is
 *  re-normalized here so a paste in a raw DevTools shape (table rows, JSON,
 *  stray newlines — illegal in a header value) self-heals instead of making
 *  fetch throw before anything is sent. Splunk Observability Cloud access
 *  tokens (`sfx-token`) travel in the `X-SF-TOKEN` header (masked in wire
 *  logs by the secret-key filter, like Authorization). */
export function authHeaders(credential: ContextCredential): Record<string, string> {
  if (credential.method === "snow-session") {
    // Browser-like UA: SSO/WAF front-ends commonly drop non-browser clients
    // even with valid session cookies (pilot: fresh captures rejected).
    // X-UserToken (g_ck) rides along when captured — some instances refuse
    // cookie-authenticated /api/now calls without the page CSRF token.
    const session = parseSnowSessionSecret(credential.secret);
    return {
      Cookie: cleanCookieString(session.cookies),
      "User-Agent": SNOW_SESSION_USER_AGENT,
      ...(session.userToken ? { "X-UserToken": session.userToken } : {}),
    };
  }
  if (credential.method === "sfx-token") {
    return { "X-SF-TOKEN": credential.secret };
  }
  return { Authorization: authHeader(credential) };
}

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export async function fetchJson<T>(
  url: string,
  credential: ContextCredential,
  timeoutMs: number,
  extraHeaders?: Record<string, string>,
  init?: { method?: "GET" | "POST" | "PUT" | "DELETE"; body?: unknown },
): Promise<T> {
  const started = Date.now();
  const method = init?.method ?? "GET";
  if (wireEnabled()) {
    emitWire(
      "http",
      "→",
      `${method} ${safeUrl(url)}`,
      safeHeaders({
        ...authHeaders(credential),
        Accept: "application/json",
        ...extraHeaders,
      }),
    );
  }
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        ...authHeaders(credential),
        Accept: "application/json",
        ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...extraHeaders,
      },
      ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    emitWire("http", "✗", `${method} ${safeUrl(url)} — ${err instanceof Error ? err.message : String(err)} (${Date.now() - started}ms)`);
    throw new AppError(
      `Context request failed: ${err instanceof Error ? err.message : String(err)}`,
      "network",
    );
  }
  if (!res.ok && wireEnabled()) {
    emitWire("http", "✗", `${method} ${safeUrl(url)} ${res.status} (${Date.now() - started}ms)`);
  }
  if (res.status === 401 || res.status === 403) {
    if (credential.method === "snow-session") {
      // Evidence-based diagnosis (never a blanket "session expired" — fresh
      // captures fail too): the server's own error body, any off-host
      // redirect, and the replayed cookie NAMES (values never appear).
      const body = await res.text().catch(() => "");
      const session = parseSnowSessionSecret(credential.secret);
      const d = describeSnowRejection({
        status: res.status,
        bodyText: body,
        requestUrl: url,
        finalUrl: res.url || undefined,
        storedCookies: session.cookies,
        userTokenSent: Boolean(session.userToken),
      });
      throw new AppError(d.message, "auth.failed", d.summary);
    }
    throw new AppError(
      `Authentication rejected by the source (${res.status}).`,
      "auth.failed",
      "The source rejected these credentials.",
    );
  }
  if (res.status === 404) {
    throw new AppError(`Not found (404) at the source.`, "graph.notFound");
  }
  if (res.status === 429 || res.status === 503) {
    throw new AppError(`Source is throttling requests (${res.status}).`, "graph.throttled");
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new AppError(
      `Source request failed (${res.status} ${res.statusText}): ${body.slice(0, 300)}`,
      "unknown",
    );
  }
  const text = await res.text();
  if (wireEnabled()) {
    emitWire(
      "http",
      "←",
      `${method} ${safeUrl(url)} ${res.status} · ${text.length} bytes (${Date.now() - started}ms)`,
      capDetail(text),
    );
  }
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new AppError(
      `Source response exceeded the ${MAX_RESPONSE_BYTES / 1024 / 1024} MB read cap (ADR-0012).`,
      "config",
    );
  }
  if (!text.trim()) {
    // Writes (DELETE, some PUT/POST) legitimately return 204 No Content.
    return undefined as unknown as T;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    // A rejected/intercepted cookie session is often answered with a 200
    // HTML page rather than a 401 — diagnose from the page itself (login
    // page? SSO gateway? hibernating instance?) instead of presuming expiry.
    if (credential.method === "snow-session") {
      const session = parseSnowSessionSecret(credential.secret);
      const d = describeSnowRejection({
        bodyText: text,
        requestUrl: url,
        finalUrl: res.url || undefined,
        storedCookies: session.cookies,
        userTokenSent: Boolean(session.userToken),
      });
      throw new AppError(d.message, d.kind === "auth" ? "auth.failed" : "network", d.summary);
    }
    throw new AppError(
      "Source returned non-JSON content (proxy page or HTML login redirect?).",
      "network",
    );
  }
}

/** Strip HTML to plain text for model-facing excerpts (rough but safe). */
export function htmlToText(html: string, maxChars: number): string {
  const text = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}
