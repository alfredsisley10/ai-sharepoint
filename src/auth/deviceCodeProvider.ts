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

/** What the UI needs to show the user during device-code sign-in. */
export interface DeviceCodePrompt {
  userCode: string;
  verificationUri: string;
  message: string;
  expiresInSeconds: number;
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
    authority: string,
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

    const request: DeviceCodeRequest = {
      scopes,
      deviceCodeCallback: (info) =>
        this.onPrompt({
          userCode: info.userCode,
          verificationUri: info.verificationUri,
          message: info.message,
          expiresInSeconds: info.expiresIn,
        }),
    };
    const result = await this.pca.acquireTokenByDeviceCode(request);
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
