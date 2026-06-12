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
