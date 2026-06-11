import { ICachePlugin, TokenCacheContext } from "@azure/msal-node";
import { SecretStore } from "../secrets/secretStore";

/**
 * Persists the MSAL token cache into the OS keychain via SecretStore (§6).
 * The cache blob is secret material and never touches disk or the repo.
 * Shared by the interactive and device-code providers so one sign-in per
 * tenant serves every connection in that tenant (REVIEW C9).
 */
export class KeychainCachePlugin implements ICachePlugin {
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

/** Keychain handle for a tenant-scoped MSAL cache (one sign-in per tenant). */
export function tenantCacheHandle(tenantHost: string): string {
  return `msal-cache:tenant:${tenantHost.toLowerCase()}`;
}
