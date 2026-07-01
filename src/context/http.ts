import { AppError } from "../core/errors";
import { redactText } from "../core/redaction";
import { detectProxyInterference, detectProxyFromError, hostOf } from "../core/networkDiagnostics";
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
  // A pasted OAuth token (pat) and a third-party OIDC/JWT ID token (snow-oidc)
  // both travel as a Bearer token; ServiceNow validates the OIDC one against a
  // registered provider, but on the wire it is an ordinary Authorization.
  if (credential.method === "pat" || credential.method === "snow-oidc") {
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
  // ServiceNow Inbound REST API Key (Washington+): an opaque key tied to a
  // ServiceNow user, sent in its own header — no Authorization, no cookies.
  if (credential.method === "snow-apikey") {
    return { "x-sn-apikey": credential.secret };
  }
  return { Authorization: authHeader(credential) };
}

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** Same-origin Referer for a request URL. Atlassian's CSRF filter (and others)
 *  reject a state-changing REST call when BOTH Origin and Referer are null —
 *  the default for a bare programmatic fetch — so writes present a first-party
 *  Referer. It must be set via the `referrer` init, not the headers object:
 *  `Referer` is a Fetch "forbidden header name" and is dropped from headers. */
function sameOriginReferrer(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

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
      ? "An SSL-inspecting proxy or HTTP/2 intermediary reset this WRITE. Reads (GET, no upload body) get through, which is why search works but publishing fails — and the reset usually MASKS the real status (often a 403). Try: (1) enable \"aiSharePoint.logging.verboseWire\" and retry to capture the masked status; (2) confirm the proxy/WAF allows POST/PUT to the Confluence host and isn't DLP-blocking page uploads; (3) check you can edit the page in the browser. NOTE: \"http.electronFetch\": false forces HTTP/1.1 but in an SSL-inspecting environment it often breaks TLS entirely (Node's fetch may not use the OS trust store), so if reads then fail, turn it back ON."
      : "An SSL-inspecting proxy or HTTP/2 intermediary reset the connection. This is often transient — retry. If it persists, confirm the host is allowlisted on the proxy. (\"http.electronFetch\": false forces HTTP/1.1 but can break TLS where the proxy does SSL inspection — only use it if reads still succeed afterward.)",
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
  // Present a first-party Referer on state-changing calls so CSRF filters that
  // reject "Origin and Referer both null" let the write through (see above).
  const referrer = method !== "GET" ? sameOriginReferrer(url) : undefined;
  const referrerInit: RequestInit = referrer ? { referrer, referrerPolicy: "unsafe-url" } : {};
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
      ...referrerInit,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    emitWire("http", "✗", `${method} ${safeUrl(url)} — ${raw} (${Date.now() - started}ms)`);
    const diag = diagnoseTransportError(method, raw);
    if (diag) throw new AppError(diag.message, "network", diag.summary);
    // Auto-detect a corporate proxy / TLS-inspection / content filter as the
    // likely cause (the TLS errno hides in err.cause, not err.message) and give
    // targeted guidance instead of a bare "fetch failed".
    const proxy = detectProxyFromError(err, url);
    if (proxy) throw new AppError(`${proxy.message}\n\n${proxy.summary}`, "network", proxy.summary);
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
    // A content filter can answer 401/403 with its OWN block page — diagnose
    // that as a proxy/filter issue (the real fix), not "bad credentials".
    const rawBody = await res.text().catch(() => "");
    const filtered = detectProxyInterference({ status: res.status, bodyText: rawBody, headers: res.headers, host: hostOf(url) });
    if (filtered && filtered.kind === "blocked") {
      throw new AppError(`${filtered.message}\n\n${filtered.summary}`, "network", filtered.summary);
    }
    // Surface the server's OWN reason (redacted, capped) — a 403 on a WRITE is
    // almost never "bad credentials" (reads work with the same token); it's a
    // permission/policy refusal whose body says exactly why.
    const reason = redactText(rawBody)
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 300);
    if (res.status === 401) {
      const summary =
        credential.method === "snow-oidc"
          ? "ServiceNow rejected the third-party OIDC/JWT token. Most often: (1) the token's `aud` (audience) doesn't match the Client ID registered on the instance's OIDC provider (System OAuth → Application Registry → the OIDC entity); (2) the instance can't reach your IdP's JWKS to verify the signature (\"Key ID not found in JWKS\"); (3) the user claim (e.g. `email`/`upn`) doesn't map to a ServiceNow `user_name`; or (4) the token expired — paste a fresh one. Ask your admin to confirm the OIDC provider registration and the User Claim → User Field mapping."
          : credential.method === "snow-apikey"
            ? "ServiceNow rejected the API key. Check that: the key is active and copied in full (System Web Services → API Access Policies → REST API Key); an Inbound Authentication Profile sends it via the `x-sn-apikey` header; and the associated user has read access to this table. Keys tie to a user, so the user's ACLs still apply."
            : "The source rejected these credentials — re-check the username/token and that it hasn't expired.";
      throw new AppError(`Authentication rejected (401)${reason ? `: ${reason}` : ""}.`, "auth.failed", summary);
    }
    // 403: authenticated, but not allowed to do THIS. Classified as
    // graph.forbidden (not auth.failed) so a write-permission denial never
    // trips the auth lockout that guards a perfectly good read credential.
    const xsrf = /xsrf|csrf/i.test(reason);
    throw new AppError(
      `Forbidden (403)${reason ? `: ${reason}` : ""}.`,
      "graph.forbidden",
      xsrf
        ? `Confluence rejected this write's CSRF/XSRF check. The connector now mirrors the Atlassian Python client: a NON-browser User-Agent, "X-Atlassian-Token: no-check", and a same-origin Referer (a BROWSER User-Agent — which Electron fetch sends — is what triggers Confluence's strict CSRF path). Keep "http.electronFetch" ENABLED — your SSL-inspecting proxy needs Electron's OS trust store; turning it off breaks TLS for reads too. If it STILL fails: (1) turn on "aiSharePoint.logging.verboseWire" and retry to confirm User-Agent / X-Atlassian-Token / Referer actually leave the client; (2) if they do, an SSL-inspecting proxy is rewriting them — ask the proxy team to pass them through, or raw-tunnel the Confluence host for writes; (3) check the Confluence Server Base URL (Admin → General Configuration) matches the URL you connect through.`
        : `Authenticated, but the server refused this operation. For a WRITE this usually means your account lacks create/edit permission in this space, the space or instance is read-only, a personal space hasn't been created yet, or a proxy/WAF blocked the request.${reason ? ` The server said: “${reason}”.` : ""}`,
    );
  }
  if (res.status === 407) {
    const p = detectProxyInterference({ status: 407, host: hostOf(url) })!;
    throw new AppError(`${p.message}\n\n${p.summary}`, "network", p.summary);
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
    // Non-JSON where JSON was expected is the classic shape of a filter's block
    // page or a captive-portal/login redirect — name the filter when we can.
    const filtered = detectProxyInterference({ status: res.status, bodyText: text, headers: res.headers, host: hostOf(url) });
    if (filtered) throw new AppError(`${filtered.message}\n\n${filtered.summary}`, "network", filtered.summary);
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
