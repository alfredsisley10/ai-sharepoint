import { SharePointAuthProvider } from "./types";
import { AppError } from "../core/errors";

/** Microsoft Graph delegated scope to read sites. */
const SITES_READ_SCOPE = "https://graph.microsoft.com/Sites.Read.All";

/** Graph base URL (commercial cloud; sovereign clouds documented in the
 *  admin guide — configurable in a future release if demanded). */
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

const REQUEST_TIMEOUT_MS = 30_000;

export interface SiteInfo {
  id: string;
  displayName: string;
  webUrl: string;
  description?: string;
}

export interface ListInfo {
  id: string;
  displayName: string;
  webUrl: string;
  template?: string;
  itemCount?: number;
}

export interface PageInfo {
  id: string;
  title: string;
  webUrl: string;
  lastModified?: string;
}

export interface SiteOverview {
  site: SiteInfo;
  lists: ListInfo[];
  /** Undefined when the tenant blocks the Pages API for this account. */
  pages?: PageInfo[];
}

export interface ConnectionTestResult {
  ok: true;
  site: SiteInfo;
  account: string;
  latencyMs: number;
}

/** Accepts commercial + sovereign SharePoint Online hosts (REVIEW S6). */
export function isSupportedSiteUrl(url: string): boolean {
  try {
    const u = new URL(url.trim());
    return (
      u.protocol === "https:" &&
      /(^|\.)sharepoint(?:-df)?\.(com|us|cn|de)$/i.test(u.hostname)
    );
  } catch {
    return false;
  }
}

/**
 * Read-only SharePoint client over Microsoft Graph. Uses the extension host's
 * built-in fetch — no native deps, cross-platform (ADR-0016). All requests
 * carry a timeout; 429/503 responses are retried once honoring Retry-After.
 */
export class SharePointClient {
  constructor(
    private readonly auth: SharePointAuthProvider,
    /** When true, never start an interactive flow — fail fast instead.
     *  Used by chat/tool context reads so a question never pops a browser. */
    private readonly silentOnly = false,
  ) {}

  /** Resolve a SharePoint site by its browser URL. */
  async getSite(siteUrl: string): Promise<SiteInfo> {
    const { hostname, pathname } = new URL(siteUrl);
    const path = pathname.replace(/\/$/, "");
    const graphPath = path ? `${hostname}:${path}` : hostname;
    const site = await this.get<{
      id: string;
      displayName?: string;
      webUrl: string;
      description?: string;
    }>(`/sites/${graphPath}?$select=id,displayName,webUrl,description`);
    return {
      id: site.id,
      displayName: site.displayName ?? "(untitled site)",
      webUrl: site.webUrl,
      description: site.description,
    };
  }

  /** Non-hidden lists and libraries of a site (top 50). */
  async getLists(siteId: string): Promise<ListInfo[]> {
    const res = await this.get<{
      value: Array<{
        id: string;
        displayName: string;
        webUrl: string;
        list?: { template?: string; hidden?: boolean };
      }>;
    }>(`/sites/${siteId}/lists?$select=id,displayName,webUrl,list&$top=50`);
    return res.value
      .filter((l) => !l.list?.hidden)
      .map((l) => ({
        id: l.id,
        displayName: l.displayName,
        webUrl: l.webUrl,
        template: l.list?.template,
      }));
  }

  /** Modern site pages (top 50). Some tenants restrict this API — callers
   *  should tolerate `graph.forbidden`. */
  async getPages(siteId: string): Promise<PageInfo[]> {
    const res = await this.get<{
      value: Array<{
        id: string;
        title?: string;
        name?: string;
        webUrl: string;
        lastModifiedDateTime?: string;
      }>;
    }>(
      `/sites/${siteId}/pages/microsoft.graph.sitePage?$select=id,title,name,webUrl,lastModifiedDateTime&$top=50`,
    );
    return res.value.map((p) => ({
      id: p.id,
      title: p.title || p.name || "(untitled page)",
      webUrl: p.webUrl,
      lastModified: p.lastModifiedDateTime,
    }));
  }

  /** Site + lists (+ pages when permitted) for chat/tools. Lists and pages
   *  are fetched in parallel; a blocked Pages API degrades gracefully. */
  async getSiteOverview(siteUrl: string): Promise<SiteOverview> {
    const site = await this.getSite(siteUrl);
    const [lists, pages] = await Promise.all([
      this.getLists(site.id),
      this.getPages(site.id).catch(() => undefined),
    ]);
    return { site, lists, pages };
  }

  /** Resolve the site and report latency + the signed-in account. */
  async testConnection(siteUrl: string): Promise<ConnectionTestResult> {
    const started = Date.now();
    const { account } = await this.auth.acquireToken([SITES_READ_SCOPE]);
    const site = await this.getSite(siteUrl);
    return { ok: true, site, account, latencyMs: Date.now() - started };
  }

  private async acquire(): Promise<string> {
    if (this.silentOnly) {
      const silent = this.auth.acquireTokenSilent
        ? await this.auth.acquireTokenSilent([SITES_READ_SCOPE])
        : null;
      if (!silent) {
        throw new AppError(
          "Sign-in required for this site. Run 'AI SharePoint: Test Site Connection' to sign in, then retry.",
          "auth.failed",
        );
      }
      return silent.token;
    }
    return (await this.auth.acquireToken([SITES_READ_SCOPE])).token;
  }

  private async get<T>(path: string, retried = false): Promise<T> {
    const token = await this.acquire();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${GRAPH_BASE}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
    } catch (err) {
      throw new AppError(
        `Graph request failed: ${err instanceof Error ? err.message : String(err)}`,
        "network",
      );
    } finally {
      clearTimeout(timer);
    }

    if ((res.status === 429 || res.status === 503) && !retried) {
      const retryAfter = Math.min(
        5,
        Number(res.headers.get("Retry-After")) || 2,
      );
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      return this.get<T>(path, true);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const code =
        res.status === 403 || res.status === 401
          ? "graph.forbidden"
          : res.status === 404
            ? "graph.notFound"
            : res.status === 429 || res.status === 503
              ? "graph.throttled"
              : "graph.error";
      throw new AppError(
        `Graph request failed (${res.status} ${res.statusText}): ${body.slice(0, 500)}`,
        code,
      );
    }
    return (await res.json()) as T;
  }
}
