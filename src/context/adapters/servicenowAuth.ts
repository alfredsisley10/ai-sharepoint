import { AppError } from "../../core/errors";
import { emitWire, safeUrl } from "../../core/wireLog";

/**
 * ServiceNow browser sign-in (ADR-0028 amendment): OAuth authorization-code
 * with PKCE over a loopback redirect — the user signs in IN THE BROWSER
 * (their existing SSO session is what authenticates), ServiceNow returns a
 * code to localhost, and we exchange it for access+refresh tokens. Requires
 * a one-time OAuth client on the instance (System OAuth → Application
 * Registry) with redirect URL http://localhost:51725/callback. Token bodies
 * are never wire-logged (msal discipline).
 */

export const SNOW_LOOPBACK_PORT = 51725;
export const SNOW_REDIRECT_URI = `http://localhost:${SNOW_LOOPBACK_PORT}/callback`;

export interface SnowOAuthTokens {
  clientId: string;
  clientSecret?: string;
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms. */
  expiresAt: number;
}

export function buildSnowAuthUrl(
  instanceUrl: string,
  clientId: string,
  state: string,
  codeChallenge: string,
): string {
  const base = new URL(instanceUrl).origin;
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: SNOW_REDIRECT_URI,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  return `${base}/oauth_auth.do?${q.toString()}`;
}

export function parseSnowTokenResponse(
  body: { access_token?: string; refresh_token?: string; expires_in?: number },
  clientId: string,
  clientSecret: string | undefined,
  nowMs: number,
): SnowOAuthTokens {
  if (!body.access_token) {
    throw new AppError("ServiceNow returned no access token.", "auth.failed");
  }
  return {
    clientId,
    ...(clientSecret ? { clientSecret } : {}),
    accessToken: body.access_token,
    ...(body.refresh_token ? { refreshToken: body.refresh_token } : {}),
    expiresAt: nowMs + Math.max(60, body.expires_in ?? 1800) * 1000,
  };
}

export function snowTokensFromSecret(secret: string): SnowOAuthTokens {
  try {
    const t = JSON.parse(secret) as SnowOAuthTokens;
    if (!t.accessToken || !t.clientId) throw new Error("incomplete");
    return t;
  } catch {
    throw new AppError(
      "Stored ServiceNow OAuth session is unreadable — sign in again via Test Context Source.",
      "auth.failed",
    );
  }
}

export function snowTokenExpired(tokens: SnowOAuthTokens, nowMs: number): boolean {
  return nowMs >= tokens.expiresAt - 60_000;
}

async function postToken(
  instanceUrl: string,
  form: Record<string, string>,
  timeoutMs: number,
): Promise<{ access_token?: string; refresh_token?: string; expires_in?: number }> {
  const url = `${new URL(instanceUrl).origin}/oauth_token.do`;
  emitWire("servicenow", "→", `POST ${safeUrl(url)} (token request/response withheld — token material)`);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    emitWire("servicenow", "✗", `POST ${safeUrl(url)} — ${err instanceof Error ? err.message : String(err)}`);
    throw new AppError(
      `ServiceNow token endpoint unreachable: ${err instanceof Error ? err.message : String(err)}`,
      "network",
    );
  }
  emitWire("servicenow", "←", `POST ${safeUrl(url)} ${res.status}`);
  if (!res.ok) {
    throw new AppError(
      `ServiceNow token exchange failed (${res.status}).`,
      "auth.failed",
      "Check the OAuth client ID/secret and that the Application Registry entry lists redirect URL http://localhost:51725/callback.",
    );
  }
  return (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
}

export async function exchangeSnowCode(
  instanceUrl: string,
  args: { code: string; clientId: string; clientSecret?: string; codeVerifier: string },
  nowMs: number,
  timeoutMs = 30_000,
): Promise<SnowOAuthTokens> {
  const body = await postToken(
    instanceUrl,
    {
      grant_type: "authorization_code",
      code: args.code,
      redirect_uri: SNOW_REDIRECT_URI,
      client_id: args.clientId,
      code_verifier: args.codeVerifier,
      ...(args.clientSecret ? { client_secret: args.clientSecret } : {}),
    },
    timeoutMs,
  );
  return parseSnowTokenResponse(body, args.clientId, args.clientSecret, nowMs);
}

export async function refreshSnowTokens(
  instanceUrl: string,
  tokens: SnowOAuthTokens,
  nowMs: number,
  timeoutMs = 30_000,
): Promise<SnowOAuthTokens> {
  if (!tokens.refreshToken) {
    throw new AppError(
      "ServiceNow session expired and no refresh token was issued — sign in again via Test Context Source.",
      "auth.failed",
    );
  }
  const body = await postToken(
    instanceUrl,
    {
      grant_type: "refresh_token",
      refresh_token: tokens.refreshToken,
      client_id: tokens.clientId,
      ...(tokens.clientSecret ? { client_secret: tokens.clientSecret } : {}),
    },
    timeoutMs,
  );
  const next = parseSnowTokenResponse(body, tokens.clientId, tokens.clientSecret, nowMs);
  // Instances configured without rotating refresh tokens reuse the old one.
  if (!next.refreshToken && tokens.refreshToken) next.refreshToken = tokens.refreshToken;
  return next;
}

/** Cookie ATTRIBUTE names (from Set-Cookie text or DevTools table columns)
 *  that are not session cookies — dropped during normalization so a paste
 *  of richer material never sends `Path=/` as a cookie. */
const COOKIE_ATTRIBUTES = new Set([
  "path",
  "domain",
  "expires",
  "max-age",
  "samesite",
  "secure",
  "httponly",
  "priority",
  "partitioned",
  "size",
  "sourceport",
  "sourcescheme",
]);

/** RFC 6265 cookie-name token. */
const COOKIE_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

interface ParsedCookie {
  name: string;
  value: string;
}

/** "a=1; b=2" (header form) or a single "a=1" → pairs. */
function lineToPairs(line: string): ParsedCookie[] {
  return line
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const i = part.indexOf("=");
      return i <= 0 ? { name: "", value: "" } : { name: part.slice(0, i), value: part.slice(i + 1) };
    })
    .filter((p) => p.name);
}

/** Firefox Storage → Cookies "Copy All" pastes JSON: an array of
 *  {name, value, …} objects, or an object keyed by cookie name. */
function pairsFromJson(parsed: unknown): ParsedCookie[] | undefined {
  if (Array.isArray(parsed)) {
    const out = parsed
      .filter((c): c is { name?: unknown; value?: unknown } => Boolean(c) && typeof c === "object")
      .map((c) => ({ name: String(c.name ?? ""), value: String(c.value ?? "") }))
      .filter((c) => c.name);
    return out.length > 0 ? out : undefined;
  }
  if (parsed && typeof parsed === "object") {
    const out: ParsedCookie[] = [];
    for (const [name, v] of Object.entries(parsed)) {
      if (typeof v === "string") out.push({ name, value: v });
      else if (v && typeof v === "object" && typeof (v as { value?: unknown }).value === "string") {
        out.push({ name, value: (v as { value: string }).value });
      }
    }
    return out.length > 0 ? out : undefined;
  }
  return undefined;
}

/**
 * Normalize a pasted ServiceNow cookie capture into a proper Cookie header
 * value ("name=value; name=value"). Pilot: users paste "the full set of
 * session cookies" in whatever shape their browser hands them, and anything
 * but a clean header string used to reach the wire raw — newlines/tabs in a
 * header value make fetch throw, surfacing as a baffling network error.
 * Accepted shapes:
 *  - a Cookie request header, with or without the leading "Cookie:" label;
 *  - the DevTools cookie TABLE (Edge/Chrome Application → Cookies select-all:
 *    one `name<TAB>value<TAB>domain…` row per line, header row dropped);
 *  - Firefox "Copy All" JSON (array of {name, value} or name-keyed object);
 *  - one name=value per line (cookie-manager exports);
 *  - Set-Cookie style text (attributes like Path/Secure/HttpOnly dropped).
 * Idempotent on already-clean strings; called again at send time so stored
 * captures self-heal. */
export function cleanCookieString(raw: string): string {
  const text = raw.replace(/^\uFEFF/, "").trim().replace(/^cookie:\s*/i, "").trim();
  if (!text) return "";
  let pairs: ParsedCookie[] | undefined;
  if (text.startsWith("[") || text.startsWith("{")) {
    try {
      pairs = pairsFromJson(JSON.parse(text));
    } catch {
      // not JSON — fall through to line parsing
    }
  }
  if (!pairs) {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    pairs = lines.flatMap((line) => {
      if (line.includes("\t")) {
        // DevTools table row: first two columns are name and value.
        const [name = "", value = ""] = line.split("\t");
        if (name && !name.includes("=")) return [{ name: name.trim(), value: value.trim() }];
      }
      return lineToPairs(line);
    });
  }
  const seen = new Set<string>();
  const out: ParsedCookie[] = [];
  for (const p of pairs) {
    const name = p.name.trim();
    if (!name || !COOKIE_NAME_RE.test(name)) continue;
    if (COOKIE_ATTRIBUTES.has(name.toLowerCase())) continue;
    // The copied table's header row ("Name  Value  Domain …").
    if (name.toLowerCase() === "name" && p.value.trim().toLowerCase() === "value") continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, value: p.value.trim().replace(/^"(.*)"$/, "$1") });
  }
  return out.map((p) => `${p.name}=${p.value}`).join("; ");
}

/** Cookie NAMES in a stored capture — safe to show/log (never values).
 *  The diagnostic for "why was my session rejected". */
export function cookieNames(raw: string): string[] {
  return cleanCookieString(raw)
    .split(";")
    .map((p) => p.trim().split("=")[0])
    .filter(Boolean);
}

export function cookieStringIssue(raw: string): string | undefined {
  const c = cleanCookieString(raw);
  if (!c.includes("=")) {
    return "That doesn't look like a cookie string — paste the Cookie request header (Network tab), the DevTools cookie table rows, or Firefox's Copy-All JSON.";
  }
  return undefined;
}

/** Stored snow-session secret. Plain string = cookie capture only (the
 *  original format, still written when no token is supplied). The JSON
 *  object form adds the page CSRF token: some instances refuse cookie-
 *  authenticated /api/now calls without the `X-UserToken` header — the
 *  value of the page global `g_ck` in a signed-in tab. */
export interface SnowSessionSecret {
  cookies: string;
  userToken?: string;
}

export function parseSnowSessionSecret(secret: string): SnowSessionSecret {
  // Only the structured {cookies: "..."} object is the JSON form; Firefox
  // Copy-All pastes (arrays / name-keyed objects) are cookie captures and
  // fall through to be normalized as such.
  try {
    const p = JSON.parse(secret) as { cookies?: unknown; userToken?: unknown };
    if (p && typeof p === "object" && !Array.isArray(p) && typeof p.cookies === "string") {
      return {
        cookies: p.cookies,
        ...(typeof p.userToken === "string" && p.userToken.trim()
          ? { userToken: p.userToken.trim() }
          : {}),
      };
    }
  } catch {
    // not JSON — a raw cookie capture
  }
  return { cookies: secret };
}

/** Compose the stored secret: plain cookie string when there is no token
 *  (backward compatible), the JSON form when there is. */
export function buildSnowSessionSecret(cookies: string, userToken?: string): string {
  const token = userToken?.trim();
  return token ? JSON.stringify({ cookies, userToken: token }) : cookies;
}

/** ServiceNow Inbound REST API Key (`x-sn-apikey`, Washington+). The key is an
 *  opaque string tied to a ServiceNow user, so the account's ACLs still apply —
 *  no OAuth client, no password, no expiry. Sent as a request header. */
export function snowApiKeyIssue(raw: string): string | undefined {
  const t = raw.trim();
  if (!t) return "Paste the REST API Key value (System Web Services → API Access Policies → REST API Key → reveal with the lock icon).";
  if (/\s/.test(t)) return "An API key has no spaces — copy just the key value.";
  if (t.length < 16) return "That looks too short for a ServiceNow API key — reveal and copy the full value.";
  return undefined;
}

/** Decode the `exp` (epoch seconds) claim from a JWT WITHOUT verifying its
 *  signature — purely to warn the user when a pasted OIDC token is already
 *  expired (signature verification is ServiceNow's job, against the registered
 *  OIDC provider's JWKS). Returns epoch ms, or undefined if the token isn't a
 *  decodable JWT. Pure. */
export function jwtExpiryMs(token: string): number | undefined {
  const parts = token.trim().split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(payload, "base64").toString("utf8");
    const exp = (JSON.parse(json) as { exp?: unknown }).exp;
    return typeof exp === "number" && isFinite(exp) ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/** Validate a pasted third-party OIDC/JWT ID token for the snow-oidc method: it
 *  must look like a JWT (three dot-separated segments) and, if its `exp` is
 *  readable, not already be expired. */
export function snowOidcTokenIssue(raw: string, nowMs: number): string | undefined {
  const t = raw.trim();
  if (!t) return "Paste an ID/access token from your identity provider (Entra ID, Okta, …).";
  if (t.split(".").length !== 3) {
    return "That doesn't look like a JWT (expected three dot-separated segments: header.payload.signature). Copy the raw ID token / access token your IdP issues.";
  }
  const exp = jwtExpiryMs(t);
  if (exp !== undefined && nowMs >= exp) {
    return "This token has already expired — get a fresh one from your identity provider and paste it again.";
  }
  return undefined;
}

/** Quick sanity check for a pasted g_ck value (long opaque token). */
export function userTokenIssue(raw: string): string | undefined {
  const t = raw.trim().replace(/^["']|["']$/g, "");
  if (!t) return undefined; // optional — empty is fine
  if (/\s/.test(t) || t.length < 16) {
    return "That doesn't look like a g_ck token (a long opaque string, no spaces). In the signed-in tab: DevTools → Console → type g_ck → Enter → copy the printed value.";
  }
  return undefined;
}

/** Browser-compatibility User-Agent for cookie-session replay. Some SSO/WAF
 *  front-ends reject requests with non-browser user agents even when the
 *  session cookies are valid — the pilot saw freshly captured cookies fail
 *  within seconds. Mozilla/5.0-prefixed for gateway compatibility while
 *  still naming the extension (the user's own authorized session is what
 *  authenticates; this is interoperability, not disguise). */
export const SNOW_SESSION_USER_AGENT =
  "Mozilla/5.0 (compatible; AI-SharePoint-VSCode; ServiceNow session replay)";

export interface SnowRejection {
  message: string;
  summary: string;
  /** auth = sign-in problem (counts toward lockout, offers refresh);
   *  other = infrastructure page (hibernating instance, proxy error). */
  kind: "auth" | "other";
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/**
 * Evidence-based diagnosis of a rejected cookie-session request, built from
 * what the server ACTUALLY returned — never a blanket "session expired"
 * (pilot: cookies captured 15 seconds earlier were rejected and the error
 * still claimed expiry). Pure.
 */
export function describeSnowRejection(args: {
  /** HTTP status for 401/403 rejections; undefined for a 200 non-JSON page. */
  status?: number;
  bodyText: string;
  requestUrl: string;
  /** Final URL after redirects (fetch's res.url) when available. */
  finalUrl?: string;
  storedCookies: string;
  /** Whether an X-UserToken (g_ck) accompanied the cookies. */
  userTokenSent?: boolean;
}): SnowRejection {
  const names = cookieNames(args.storedCookies);
  const lower = names.map((n) => n.toLowerCase());
  const missing: string[] = [];
  if (!lower.includes("jsessionid")) missing.push("JSESSIONID (the session cookie)");
  if (!lower.some((n) => n.startsWith("glide"))) missing.push("the glide_* cookies");

  // What the server actually said: ServiceNow's JSON error envelope, or the
  // <title> of an HTML page (reveals login pages, SSO gateways, hibernating
  // developer instances, proxy block pages).
  let serverSaid = "";
  let htmlTitle = "";
  try {
    const parsed = JSON.parse(args.bodyText) as { error?: { message?: string; detail?: string | null } };
    serverSaid = [parsed.error?.message, parsed.error?.detail].filter(Boolean).join(" — ");
  } catch {
    htmlTitle = args.bodyText.match(/<title[^>]*>([^<]{1,120})/i)?.[1]?.trim() ?? "";
    if (htmlTitle) serverSaid = `an HTML page titled "${htmlTitle}"`;
  }

  // A redirect off the instance host is the signature of an SSO front-end
  // intercepting the API call — the classic reason FRESH cookies fail.
  let redirectedTo = "";
  try {
    if (args.finalUrl && new URL(args.finalUrl).host !== new URL(args.requestUrl).host) {
      redirectedTo = new URL(args.finalUrl).host;
    }
  } catch {
    // unparseable final URL — no redirect evidence
  }

  const loginish = /log\s?-?in|sign\s?-?in|sso|saml|authenticat/i.test(`${htmlTitle} ${redirectedTo}`);
  const kind: SnowRejection["kind"] = args.status !== undefined || redirectedTo !== "" || loginish ? "auth" : "other";

  const message =
    (args.status !== undefined
      ? `ServiceNow rejected the session cookies (${args.status})`
      : `ServiceNow answered the API call with a page instead of JSON`) +
    (serverSaid ? ` — server returned ${serverSaid}` : "") +
    (redirectedTo ? `; the request was redirected to ${redirectedTo}` : "") +
    `. Cookies replayed: ${names.length > 0 ? names.join(", ") : "none parseable from the stored capture"}.`;

  const recapture =
    `Re-capture via Test Context Source: sign in to ServiceNow in the browser, open DevTools → Network, click any request to ${hostOf(args.requestUrl)}, and copy the WHOLE Cookie header (the raw "Cookie: …" line or just its value — both work).`;
  let cause: string;
  if (missing.length > 0) {
    cause = `The capture is missing ${missing.join(" and ")} — the session cannot authenticate without them.`;
  } else if (!args.userTokenSent && /not ?authenticated/i.test(serverSaid)) {
    // Cookies present and fresh, yet "User Not Authenticated": the classic
    // remaining cause — the instance requires the page CSRF token for
    // cookie-authenticated API calls. No cookie capture can fix this; only
    // g_ck can.
    cause =
      "Complete, fresh cookies that still get \"User Not Authenticated\" almost always mean this instance requires the page CSRF token (X-UserToken) for API calls. Get it from the signed-in tab: DevTools → Console → type g_ck → Enter → copy the printed value, then re-capture and paste it when the wizard asks for the optional X-UserToken.";
  } else if (redirectedTo) {
    cause = `An SSO/login front-end (${redirectedTo}) intercepted the call. Fresh cookies fail too when the gateway's own cookies are missing or it only accepts browser traffic — copying the full Cookie header (which includes the gateway's cookies) usually satisfies it.`;
  } else {
    cause =
      "If these cookies were captured just now, the session is NOT expired — most often the paste missed some of the host's cookies (every cookie matters, including load-balancer/SSO ones like BIGipServer*), the instance requires the page CSRF token (re-capture and supply the optional X-UserToken: DevTools Console → g_ck), or a security gateway in front of the instance accepts only browser requests. If they were captured a while ago, the browser session has timed out.";
  }
  return { message, summary: `${cause} ${recapture}`, kind };
}
