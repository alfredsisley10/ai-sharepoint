import * as crypto from "node:crypto";
import { fetchJson } from "../http";

/**
 * GitHub App authentication: mint a short-lived **installation access token**
 * from the app's credentials, for both github.com and GitHub Enterprise Server.
 * The flow is (1) sign a 10-minute RS256 **app JWT** with the app's private key,
 * then (2) exchange it for an installation token at
 * `POST {api}/app/installations/{id}/access_tokens`. The resulting token is a
 * normal Bearer credential, so the rest of the GitHub adapter treats it exactly
 * like a PAT. Kept separate + pure so the JWT signing is unit-tested.
 */

export interface GithubAppCredential {
  appId: string;
  installationId: string;
  /** PEM private key (PKCS#1 "BEGIN RSA PRIVATE KEY" or PKCS#8). */
  privateKey: string;
}

/** Parse and validate the stored github-app secret JSON. */
export function parseGithubAppSecret(secret: string): GithubAppCredential {
  let o: Partial<GithubAppCredential>;
  try {
    o = JSON.parse(secret) as Partial<GithubAppCredential>;
  } catch {
    throw new Error("GitHub App credential is not valid JSON.");
  }
  if (!o.appId || !o.installationId || !o.privateKey) {
    throw new Error("GitHub App credential is missing appId, installationId, or privateKey.");
  }
  return {
    appId: String(o.appId),
    installationId: String(o.installationId),
    privateKey: String(o.privateKey),
  };
}

function base64Url(input: crypto.BinaryLike | string): string {
  return Buffer.from(input as Buffer | string)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Build a GitHub App JWT (RS256). GitHub requires `iss`=app id, `iat` backdated
 * 60s for clock drift, and `exp` ≤ 10 minutes out. `nowSec` is injected so the
 * builder is deterministic and testable.
 */
export function buildGithubAppJwt(appId: string, privateKey: string, nowSec: number): string {
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({ iat: nowSec - 60, exp: nowSec + 9 * 60, iss: appId }));
  const signingInput = `${header}.${payload}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = base64Url(signer.sign(privateKey));
  return `${signingInput}.${signature}`;
}

export interface InstallationToken {
  token: string;
  /** Epoch ms when the token expires (for caching). */
  expiresAtMs: number;
}

/**
 * Exchange the app JWT for an installation access token. `apiBase` is the REST
 * root (api.github.com or `<ghes-host>/api/v3`); `nowSec` is injected for the
 * JWT. The JWT is itself a Bearer token, so we reuse the shared fetchJson with a
 * synthesized pat credential.
 */
export async function mintInstallationToken(
  apiBase: string,
  app: GithubAppCredential,
  nowSec: number,
  timeoutMs: number,
): Promise<InstallationToken> {
  const jwt = buildGithubAppJwt(app.appId, app.privateKey, nowSec);
  const res = await fetchJson<{ token?: string; expires_at?: string }>(
    `${apiBase}/app/installations/${encodeURIComponent(app.installationId)}/access_tokens`,
    { method: "pat", secret: jwt },
    timeoutMs,
    { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    { method: "POST" },
  );
  if (!res?.token) {
    throw new Error("GitHub App installation-token exchange returned no token.");
  }
  const expiresAtMs = res.expires_at ? Date.parse(res.expires_at) : nowSec * 1000 + 3_600_000;
  return { token: res.token, expiresAtMs };
}
