/** A resolved access token plus the account it was issued for. */
export interface AccessToken {
  token: string;
  expiresOn: Date | null;
  account: string;
}

/**
 * Pluggable SharePoint authentication provider (PLAN §5).
 *
 * The MSAL public-client interactive provider is the tested default; other
 * methods (device-code, certificate/secret app-only, custom AAD app) implement
 * the same contract so they can be added without touching callers.
 */
export interface SharePointAuthProvider {
  readonly id: string;
  readonly displayName: string;
  readonly supportsSilentRefresh: boolean;
  acquireToken(scopes: string[]): Promise<AccessToken>;
}
