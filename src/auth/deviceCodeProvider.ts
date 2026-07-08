import {
  PublicClientApplication,
  Configuration,
  DeviceCodeRequest,
} from "@azure/msal-node";
import { SecretStore } from "../secrets/secretStore";
import { AccessToken, SharePointAuthProvider } from "./types";
import { KeychainCachePlugin } from "./msalCache";
import { FetchNetworkClient } from "./msalNetwork";
import { AppError } from "../core/errors";
import { describeSignInFailure } from "./signInDiagnostics";

/** What the UI needs to show the user during device-code sign-in. */
export interface DeviceCodePrompt {
  userCode: string;
  verificationUri: string;
  message: string;
  expiresInSeconds: number;
  /** Abandon the sign-in: stops MSAL's ~15-minute polling of the token
   *  endpoint. Wired to a "Cancel sign-in" affordance so a user who can't (or
   *  decides not to) complete the flow isn't left with a request polling in the
   *  background until the code expires. Idempotent. */
  cancel: () => void;
}

/**
 * MSAL device-code provider (PLAN §5 "future-enabled" — promoted to shipped).
 *
 * The enterprise-reality flow: works in VDI/thin clients, remote dev hosts,
 * and anywhere the loopback-browser dance is blocked by policy. The user gets
 * a short code to enter at https://microsoft.com/devicelogin on any device.
 * Shares the tenant keychain cache with the interactive provider, so either
 * method's sign-in serves both.
 */
export class DeviceCodeProvider implements SharePointAuthProvider {
  readonly id = "msal-device-code";
  readonly displayName = "Microsoft sign-in (device code)";
  readonly supportsSilentRefresh = true;

  private readonly pca: PublicClientApplication;

  constructor(
    secrets: SecretStore,
    cacheHandle: string,
    private readonly authority: string,
    clientId: string,
    /** UI callback — injected so this module stays headless/testable. */
    private readonly onPrompt: (info: DeviceCodePrompt) => void,
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
    const silent = await this.acquireTokenSilent(scopes);
    if (silent) {
      return silent;
    }

    // MSAL polls the token endpoint until the user authenticates OR the code
    // expires (~15 min). Setting `request.cancel = true` stops that loop on its
    // next tick; we expose it as a `cancel()` on the prompt so the UI can offer
    // an explicit "Cancel sign-in" instead of leaving a poll running in the
    // background. A cancelled poll resolves to `null`, so we distinguish it
    // from a genuine no-token result to give the user the right message.
    let cancelled = false;
    const request: DeviceCodeRequest = {
      scopes,
      deviceCodeCallback: (info) =>
        this.onPrompt({
          userCode: info.userCode,
          verificationUri: info.verificationUri,
          message: info.message,
          expiresInSeconds: info.expiresIn,
          cancel: () => {
            cancelled = true;
            request.cancel = true;
          },
        }),
    };
    let result;
    try {
      result = await this.pca.acquireTokenByDeviceCode(request);
    } catch (err) {
      // The code-poll loop is HTTPS to the token endpoint — name a proxy/
      // TLS-inspection/content-filter cause when the failure carries one.
      throw describeSignInFailure(err, this.authority);
    }
    if (cancelled) {
      throw new AppError(
        "Device-code sign-in was cancelled.",
        "auth.failed",
        "You cancelled the sign-in before it completed.",
      );
    }
    if (!result) {
      throw new AppError("Device-code sign-in returned no token.", "auth.failed");
    }
    return this.toAccessToken(result);
  }

  /** Cache-only acquisition for background reads (chat/tool context). */
  async acquireTokenSilent(
    scopes: string[],
    opts?: { forceRefresh?: boolean; account?: string },
  ): Promise<AccessToken | null> {
    const accounts = await this.pca.getTokenCache().getAllAccounts();
    if (accounts.length === 0) {
      return null;
    }
    const wanted = opts?.account?.toLowerCase();
    const account =
      (wanted && accounts.find((a) => a.username.toLowerCase() === wanted)) || accounts[0];
    try {
      const silent = await this.pca.acquireTokenSilent({
        account,
        scopes,
        forceRefresh: opts?.forceRefresh ?? false,
      });
      return this.toAccessToken(silent);
    } catch {
      return null;
    }
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
