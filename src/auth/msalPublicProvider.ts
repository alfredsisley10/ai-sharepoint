import * as vscode from "vscode";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import {
  PublicClientApplication,
  CryptoProvider,
  Configuration,
} from "@azure/msal-node";
import { SecretStore } from "../secrets/secretStore";
import { AccessToken, SharePointAuthProvider } from "./types";
import { KeychainCachePlugin } from "./msalCache";
import { FetchNetworkClient } from "./msalNetwork";
import { AppError } from "../core/errors";
import { describeSignInFailure } from "./signInDiagnostics";

/** Static, parameter-free response pages (REVIEW S5 — never reflect query
 *  values into HTML). Styling is inline; no external resources are loaded. */
const PAGE_STYLE =
  "<style>body{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#1f2933;color:#e4e7eb}main{text-align:center;max-width:28rem;padding:2rem}h1{font-size:1.25rem;font-weight:600}p{color:#9aa5b1}</style>";

const SUCCESS_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Signed in</title>${PAGE_STYLE}</head><body><main><h1>✓ Signed in</h1><p>You can close this tab and return to Visual Studio Code.</p></main></body></html>`;

const FAILURE_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Sign-in failed</title>${PAGE_STYLE}</head><body><main><h1>Sign-in did not complete</h1><p>Return to Visual Studio Code for details, then try again.</p></main></body></html>`;

const PENDING_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Waiting</title>${PAGE_STYLE}</head><body><main><h1>Waiting for sign-in…</h1><p>Complete the Microsoft sign-in in this browser.</p></main></body></html>`;

/**
 * MSAL public-client interactive provider (PLAN §5 default).
 *
 * Authorization-code + PKCE with a loopback redirect: the system browser is
 * opened via VS Code, and a short-lived 127.0.0.1 server captures the
 * authorization code. Tokens are cached in the OS keychain (per tenant) and
 * refreshed silently when possible. Cross-platform — no native modules, no
 * shell calls (ADR-0016).
 */
export class MsalPublicClientProvider implements SharePointAuthProvider {
  readonly id = "msal-public-interactive";
  readonly displayName = "Microsoft sign-in (system browser)";
  readonly supportsSilentRefresh = true;

  private readonly pca: PublicClientApplication;
  private readonly crypto = new CryptoProvider();
  /** Coalesces concurrent silent acquisitions for the same scopes so a burst of
   *  background reads redeems the rotating refresh token once, not N times in
   *  parallel (the second-layer stampede guard alongside provider reuse). */
  private readonly inFlightSilent = new Map<string, Promise<AccessToken | null>>();

  constructor(
    secrets: SecretStore,
    cacheHandle: string,
    private readonly authority: string,
    clientId: string,
  ) {
    const config: Configuration = {
      auth: { clientId, authority },
      cache: { cachePlugin: new KeychainCachePlugin(secrets, cacheHandle) },
      // VS Code-aware networking: corporate proxy + OS truststore support.
      system: { networkClient: new FetchNetworkClient() },
    };
    this.pca = new PublicClientApplication(config);
  }

  async acquireToken(scopes: string[]): Promise<AccessToken> {
    const silent = await this.trySilent(scopes);
    if (silent) {
      return silent;
    }
    return this.interactive(scopes);
  }

  /** Cache-only acquisition for background reads (chat/tool context). */
  acquireTokenSilent(
    scopes: string[],
    opts?: { forceRefresh?: boolean; account?: string },
  ): Promise<AccessToken | null> {
    return this.trySilent(scopes, opts ?? {});
  }

  private trySilent(
    scopes: string[],
    opts: { forceRefresh?: boolean; account?: string } = {},
  ): Promise<AccessToken | null> {
    // Coalesce per (account, force, scopes): a forced refresh or a different
    // identity must not be served by another request's in-flight read.
    const key = `${opts.account ?? ""}::${opts.forceRefresh ? "force:" : ""}${[...scopes].sort().join(" ")}`;
    const pending = this.inFlightSilent.get(key);
    if (pending) return pending;
    const run = this.trySilentUncoalesced(scopes, opts).finally(() => {
      this.inFlightSilent.delete(key);
    });
    this.inFlightSilent.set(key, run);
    return run;
  }

  private async trySilentUncoalesced(
    scopes: string[],
    opts: { forceRefresh?: boolean; account?: string },
  ): Promise<AccessToken | null> {
    const accounts = await this.pca.getTokenCache().getAllAccounts();
    if (accounts.length === 0) {
      return null;
    }
    // Prefer the requested identity (by UPN) when the cache holds several;
    // fall back to the first account if there's no exact match.
    const wanted = opts.account?.toLowerCase();
    const account =
      (wanted && accounts.find((a) => a.username.toLowerCase() === wanted)) || accounts[0];
    try {
      const result = await this.pca.acquireTokenSilent({
        account,
        scopes,
        forceRefresh: opts.forceRefresh ?? false,
      });
      return this.toAccessToken(result);
    } catch {
      // Silent refresh failed (expired/revoked) — fall back to interactive.
      return null;
    }
  }

  private async interactive(scopes: string[]): Promise<AccessToken> {
    const { verifier, challenge } = await this.crypto.generatePkceCodes();
    // CSRF defense for the loopback redirect: a random state travels in the
    // auth URL and must come back unchanged before we redeem the code. Without
    // it, a malicious page could POST a forged code to the local port.
    const state = this.crypto.createNewGuid();

    return new Promise<AccessToken>((resolve, reject) => {
      // The async handler wraps its whole body in try/catch and settles this
      // promise via resolve()/reject() + cleanup(), so it never rejects to the
      // (void-returning) http listener — the structural warning is a non-issue.
      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      const server = http.createServer(async (req, res) => {
        try {
          const url = new URL(req.url ?? "/", "http://localhost");
          const code = url.searchParams.get("code");
          const error = url.searchParams.get("error");
          if (error) {
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(FAILURE_PAGE);
            cleanup();
            reject(
              new AppError(`Authorization failed: ${error}`, "auth.failed"),
            );
            return;
          }
          if (!code) {
            // Ignore favicon and other stray requests.
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(PENDING_PAGE);
            return;
          }
          // Reject a callback whose state doesn't match the one we issued
          // (forged/replayed redirect) before the code is ever redeemed.
          if (url.searchParams.get("state") !== state) {
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(FAILURE_PAGE);
            cleanup();
            reject(
              new AppError("Sign-in state mismatch — possible forged redirect.", "auth.failed"),
            );
            return;
          }

          const redirectUri = `http://localhost:${port}`;
          const result = await this.pca.acquireTokenByCode({
            code,
            scopes,
            redirectUri,
            codeVerifier: verifier,
          });
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(SUCCESS_PAGE);
          cleanup();
          if (result) {
            resolve(this.toAccessToken(result));
          } else {
            reject(
              new AppError("No token returned from authorization code.", "auth.failed"),
            );
          }
        } catch (err) {
          try {
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(FAILURE_PAGE);
          } catch {
            // Response may already be closed; the rejection below carries the error.
          }
          cleanup();
          // Redeeming the code is an HTTPS call to the token endpoint — name a
          // proxy/TLS-inspection/content-filter cause when one is detectable.
          reject(describeSignInFailure(err, this.authority));
        }
      });

      let port = 0;
      const timeout = setTimeout(() => {
        cleanup();
        reject(
          new AppError("Sign-in timed out after 5 minutes.", "auth.timeout"),
        );
      }, 5 * 60 * 1000);

      const cleanup = () => {
        clearTimeout(timeout);
        server.close();
      };

      server.on("error", (err) => {
        cleanup();
        reject(err);
      });

      // Bind to an ephemeral loopback port (AAD permits any localhost port for
      // public-client native redirects). The async listener self-handles via
      // try/catch + reject()/cleanup(), so it never rejects to the void caller.
      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      server.listen(0, "127.0.0.1", async () => {
        port = (server.address() as AddressInfo).port;
        const redirectUri = `http://localhost:${port}`;
        try {
          const authUrl = await this.pca.getAuthCodeUrl({
            scopes,
            redirectUri,
            codeChallenge: challenge,
            codeChallengeMethod: "S256",
            state,
          });
          await vscode.env.openExternal(vscode.Uri.parse(authUrl));
        } catch (err) {
          cleanup();
          // getAuthCodeUrl fetches the authority's OIDC metadata over HTTPS —
          // a proxy/filter blocking that is a common first-failure on sign-in.
          reject(describeSignInFailure(err, this.authority));
        }
      });
    });
  }

  private toAccessToken(result: {
    accessToken: string;
    expiresOn: Date | null;
    account: { username: string } | null;
  }): AccessToken {
    return {
      token: result.accessToken,
      expiresOn: result.expiresOn,
      account: result.account?.username ?? "unknown",
    };
  }
}
