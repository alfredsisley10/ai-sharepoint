import { SharePointAuthProvider } from "./types";

/** Microsoft Graph delegated scope to read sites. */
const SITES_READ_SCOPE = "https://graph.microsoft.com/Sites.Read.All";

export interface SiteInfo {
  id: string;
  displayName: string;
  webUrl: string;
}

/**
 * Minimal read-only SharePoint client for the Phase 0 spike: resolves a site by
 * URL via Microsoft Graph and returns its display name (the "root web title"
 * smoke test). Uses fetch (built into the Node 20+ extension host) — no native
 * deps, cross-platform.
 */
export class SharePointClient {
  constructor(private readonly auth: SharePointAuthProvider) {}

  /** Resolve a SharePoint site by its browser URL, e.g.
   *  https://contoso.sharepoint.com/sites/Marketing */
  async getSite(siteUrl: string): Promise<SiteInfo> {
    const { hostname, pathname } = new URL(siteUrl);
    const path = pathname.replace(/\/$/, "");
    const graphPath = path
      ? `${hostname}:${path}`
      : hostname; // root site has no server-relative path

    const { token } = await this.auth.acquireToken([SITES_READ_SCOPE]);
    const res = await fetch(
      `https://graph.microsoft.com/v1.0/sites/${graphPath}?$select=id,displayName,webUrl`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `Graph request failed (${res.status} ${res.statusText}): ${body}`,
      );
    }

    const site = (await res.json()) as {
      id: string;
      displayName?: string;
      webUrl: string;
    };
    return {
      id: site.id,
      displayName: site.displayName ?? "(untitled site)",
      webUrl: site.webUrl,
    };
  }
}
