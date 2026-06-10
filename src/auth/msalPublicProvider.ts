import * as vscode from "vscode";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import {
  PublicClientApplication,
  CryptoProvider,
  Configuration,
  ICachePlugin,
  TokenCacheContext,
} from "@azure/msal-node";
import { SecretStore } from "../secrets/secretStore";
import { AccessToken, SharePointAuthProvider } from "./types";

/** Microsoft Graph PowerShell first-party app — public client, broad pre-consented
 *  delegated scopes, no app registration required (PLAN §5, ADR validated). */
const GRAPH_POWERSHELL_CLIENT_ID = "14d82eec-204b-4c2f-b7e8-296a70dab67e";

/**
 * Persists the MSAL token cache into the OS keychain via SecretStore (§6).
 * The cache blob is secret material and never touches disk or the repo.
 */
class KeychainCachePlugin implements ICachePlugin {
  constructor(
    private readonly secrets: SecretStore,
    private readonly handle: string,
  ) {}

  async beforeCacheAccess(ctx: TokenCacheContext): Promise<void> {
    const cached = await this.secrets.get(this.handle);
    if (cached) {
      ctx.tokenCache.deserialize(cached);
    }
  }

  async afterCacheAccess(ctx: TokenCacheContext): Promise<void> {
    if (ctx.cacheHasChanged) {
      await this.secrets.set(this.handle, ctx.tokenCache.serialize());
    }
  }
}

/**
 * MSAL public-client interactive provider (PLAN §5 default).
 *
 * Uses the authorization-code + PKCE flow with a loopback redirect: the system
 * browser is opened via VS Code, and a short-lived localhost server captures the
 * authorization code. Tokens are cached in the keychain and refreshed silently
 * when possible. Cross-platform — no native modules, no shell calls.
 */
export class MsalPublicClientProvider implements SharePointAuthProvider {
  readonly id = "msal-public-interactive";
  readonly displayName = "Microsoft sign-in (interactive browser)";
  readonly supportsSilentRefresh = true;

  private readonly pca: PublicClientApplication;
  private readonly crypto = new CryptoProvider();

  constructor(
    secrets: SecretStore,
    cacheHandle: string,
    authority: string,
  ) {
    const config: Configuration = {
      auth: {
        clientId: GRAPH_POWERSHELL_CLIENT_ID,
        authority,
      },
      cache: {
        cachePlugin: new KeychainCachePlugin(secrets, cacheHandle),
      },
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

  private async trySilent(scopes: string[]): Promise<AccessToken | null> {
    const accounts = await this.pca.getTokenCache().getAllAccounts();
    if (accounts.length === 0) {
      return null;
    }
    try {
      const result = await this.pca.acquireTokenSilent({
        account: accounts[0],
        scopes,
      });
      return this.toAccessToken(result);
    } catch {
      // Silent refresh failed (expired/revoked) — fall back to interactive.
      return null;
    }
  }

  private async interactive(scopes: string[]): Promise<AccessToken> {
    const { verifier, challenge } = await this.crypto.generatePkceCodes();

    return new Promise<AccessToken>((resolve, reject) => {
      const server = http.createServer(async (req, res) => {
        try {
          const url = new URL(req.url ?? "/", "http://localhost");
          const code = url.searchParams.get("code");
          const error = url.searchParams.get("error");
          if (error) {
            res.end(`Sign-in failed: ${error}. You can close this tab.`);
            cleanup();
            reject(new Error(`Authorization failed: ${error}`));
            return;
          }
          if (!code) {
            // Ignore favicon and other stray requests.
            res.end("Waiting for sign-in...");
            return;
          }

          const redirectUri = `http://localhost:${port}`;
          const result = await this.pca.acquireTokenByCode({
            code,
            scopes,
            redirectUri,
            codeVerifier: verifier,
          });
          res.end("Signed in. You can close this tab and return to VS Code.");
          cleanup();
          if (result) {
            resolve(this.toAccessToken(result));
          } else {
            reject(new Error("No token returned from authorization code."));
          }
        } catch (err) {
          cleanup();
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });

      let port = 0;
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Sign-in timed out after 5 minutes."));
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
      // public-client native redirects).
      server.listen(0, "127.0.0.1", async () => {
        port = (server.address() as AddressInfo).port;
        const redirectUri = `http://localhost:${port}`;
        try {
          const authUrl = await this.pca.getAuthCodeUrl({
            scopes,
            redirectUri,
            codeChallenge: challenge,
            codeChallengeMethod: "S256",
          });
          await vscode.env.openExternal(vscode.Uri.parse(authUrl));
        } catch (err) {
          cleanup();
          reject(err instanceof Error ? err : new Error(String(err)));
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
