import { AppError } from "../core/errors";
import { redactText } from "../core/redaction";
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

/**
 * Recognize the transport-reset error class — an SSL-inspecting proxy or an
 * HTTP/2 intermediary resetting the stream (net::ERR_HTTP2_PROTOCOL_ERROR and
 * friends) — and return targeted guidance. These overwhelmingly hit WRITES:
 * POST/PUT/DELETE carry a request body that the inspecting proxy must forward
 * over HTTP/2, and many such proxies mishandle (or DLP-reset) HTTP/2 uploads
 * while GETs — no upload body — pass cleanly. That is exactly the "reads work,
 * publishing throws a protocol error" shape. The reset also MASKS the real HTTP
 * status (e.g. a 403), so the raw message names a protocol error rather than a
 * code. Pure + unit-tested.
 *
 * The fix must NOT bypass VS Code's networking: reads succeed, so the OS trust
 * store and proxy are already correct — forcing HTTP/1.1 via a hand-rolled
 * client would drop the system CA and break the SSL-inspection handshake. The
 * supported lever is the `http.electronFetch` setting (HTTP/1.1 via Node's
 * fetch) WITH `http.systemCertificates`/proxy left on, which is what the
 * guidance points at.
 */
export function diagnoseTransportError(
  method: string,
  rawMessage: string,
): { message: string; summary: string } | undefined {
  const m = rawMessage.toLowerCase();
  const reset =
    /err_http2_protocol_error|err_spdy_protocol_error|err_quic_protocol_error|err_connection_reset|econnreset|\beproto\b/.test(
      m,
    );
  if (!reset) return undefined;
  const isWrite = method.toUpperCase() !== "GET";
  return {
    message: `The connection was reset before the source replied (${rawMessage.trim()}).`,
    summary: isWrite
      ? "An SSL-inspecting proxy or HTTP/2 intermediary reset this WRITE. Reads (GET, no upload body) get through, which is why search works but publishing fails — and the reset usually MASKS the real status (often a 403). Try in order: (1) set \"http.electronFetch\": false in VS Code Settings so requests go over HTTP/1.1 — VS Code still uses the OS trust store (\"http.systemCertificates\": true) and your proxy, so SSL inspection keeps working; (2) confirm the proxy/WAF allows POST/PUT to the Confluence host and isn't DLP-blocking page uploads; (3) enable \"aiSharePoint.logging.verboseWire\" and retry to capture the masked status in the log; (4) check you can edit the page in the browser."
      : "An SSL-inspecting proxy or HTTP/2 intermediary reset the connection. This is often transient — retry. If it persists, set \"http.electronFetch\": false (HTTP/1.1) while leaving \"http.systemCertificates\" and your proxy on so SSL inspection still works, and confirm the host is allowlisted on the proxy.",
  };
}

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
    const raw = err instanceof Error ? err.message : String(err);
    emitWire("http", "✗", `${method} ${safeUrl(url)} — ${raw} (${Date.now() - started}ms)`);
    const diag = diagnoseTransportError(method, raw);
    if (diag) throw new AppError(diag.message, "network", diag.summary);
    throw new AppError(`Context request failed: ${raw}`, "network");
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
    // Surface the server's OWN reason (redacted, capped) — a 403 on a WRITE is
    // almost never "bad credentials" (reads work with the same token); it's a
    // permission/policy refusal whose body says exactly why.
    const reason = redactText(await res.text().catch(() => ""))
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 300);
    if (res.status === 401) {
      throw new AppError(
        `Authentication rejected (401)${reason ? `: ${reason}` : ""}.`,
        "auth.failed",
        "The source rejected these credentials — re-check the username/token and that it hasn't expired.",
      );
    }
    // 403: authenticated, but not allowed to do THIS. Classified as
    // graph.forbidden (not auth.failed) so a write-permission denial never
    // trips the auth lockout that guards a perfectly good read credential.
    throw new AppError(
      `Forbidden (403)${reason ? `: ${reason}` : ""}.`,
      "graph.forbidden",
      `Authenticated, but the server refused this operation. For a WRITE this usually means your account lacks create/edit permission in this space, the space or instance is read-only, a personal space hasn't been created yet, or a proxy/WAF blocked the request.${reason ? ` The server said: “${reason}”.` : ""}`,
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
