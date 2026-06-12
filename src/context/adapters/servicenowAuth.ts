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
