import type { SitesStore, SiteConnection } from "./sitesStore";
import type { AuthProviderRegistry } from "./providerRegistry";
import { SharePointClient } from "./sharePointClient";

/** The slices of the store/registry this layer actually uses — keeps the
 *  module vscode-free at runtime (type-only imports) and unit-testable. */
type ConnectionSource = Pick<SitesStore, "list">;
type ProviderFactory = Pick<AuthProviderRegistry, "create">;

/**
 * Shared resolution layer used by commands, chat, and agent tools: turns a
 * connection descriptor into an authenticated client, and resolves loose user
 * references ("my marketing site", a URL, nothing at all) to a connection.
 */
export class SiteAccess {
  constructor(
    private readonly sites: ConnectionSource,
    private readonly registry: ProviderFactory,
  ) {}

  clientFor(conn: SiteConnection, opts?: { silent?: boolean }): SharePointClient {
    const provider = this.registry.create(conn.authProviderId, conn.cacheHandle);
    return new SharePointClient(provider, opts?.silent ?? false, conn.account);
  }

  /**
   * Resolve a reference to a configured connection:
   *  - exact site URL (or URL prefix) match
   *  - case-insensitive display-name match
   *  - undefined reference + exactly one connection → that connection
   */
  resolve(reference?: string): SiteConnection | undefined {
    const all = this.sites.list();
    if (!reference || !reference.trim()) {
      return all.length === 1 ? all[0] : undefined;
    }
    const ref = reference.trim().toLowerCase().replace(/\/+$/, "");
    return (
      all.find((c) => c.siteUrl.toLowerCase().replace(/\/+$/, "") === ref) ??
      all.find((c) => ref.startsWith(c.siteUrl.toLowerCase().replace(/\/+$/, ""))) ??
      all.find((c) => c.displayName.toLowerCase() === ref) ??
      all.find((c) => c.displayName.toLowerCase().includes(ref))
    );
  }

  /** First SharePoint URL found in free text, if any. */
  extractSiteUrl(text: string): string | undefined {
    const m = text.match(
      /https:\/\/[a-z0-9-]+\.sharepoint(?:-df)?\.(?:com|us|cn|de)[^\s"'<>)\]]*/i,
    );
    // Trailing sentence punctuation is almost never part of the URL.
    return m?.[0].replace(/[.,;:!?]+$/, "");
  }
}
