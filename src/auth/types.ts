/** A resolved access token plus the account it was issued for. */
export interface AccessToken {
  token: string;
  expiresOn: Date | null;
  account: string;
}

/**
 * Pluggable SharePoint authentication provider (PLAN §5).
 *
 * Shipped: MSAL public-client interactive (default) and device-code. Other
 * methods (certificate/secret app-only, custom AAD app) implement the same
 * contract so they can be added without touching callers.
 */
export interface SharePointAuthProvider {
  readonly id: string;
  readonly displayName: string;
  readonly supportsSilentRefresh: boolean;
  /** May start an interactive flow (browser / device code). */
  acquireToken(scopes: string[]): Promise<AccessToken>;
  /**
   * Cache-only acquisition: resolves null instead of prompting. Used by chat
   * and agent tools so background context reads never pop a browser window.
   * `forceRefresh` bypasses the cached access token and re-mints from the
   * refresh token — used to recover from a Graph 401 (token expired/revoked
   * mid-request) without an interactive prompt.
   */
  acquireTokenSilent?(
    scopes: string[],
    opts?: { forceRefresh?: boolean },
  ): Promise<AccessToken | null>;
}
