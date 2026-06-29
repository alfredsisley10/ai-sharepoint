import { SharePointAuthProvider } from "./types";
import { AppError } from "../core/errors";
import { wireEnabled, emitWire, capDetail, safeJson, safeUrl } from "../core/wireLog";

/** Microsoft Graph delegated scope to read sites. */
const SITES_READ_SCOPE = "https://graph.microsoft.com/Sites.Read.All";

/** Graph base URL (commercial cloud; sovereign clouds documented in the
 *  admin guide — configurable in a future release if demanded). */
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

const REQUEST_TIMEOUT_MS = 30_000;

/** Max @odata pages to follow before declaring a collection truncated.
 *  200 pages × $top=100 ≈ 20k items — far beyond any real site, so normal
 *  sites are always complete and only a pathological collection trips the cap. */
const MAX_PAGES = 200;

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
    /** UPN of the connection's signed-in account, so silent acquisition picks
     *  the right identity when the keychain cache holds more than one. */
    private readonly accountHint?: string,
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

  /**
   * Follow `@odata.nextLink` across pages, accumulating `value`, until the
   * collection is exhausted or the page cap is hit. Returns the items plus
   * whether the cap truncated the result — callers that build a sync snapshot
   * MUST treat `truncated` as "this view is incomplete; do not delete".
   *
   * Without this, a site with >1 page of lists/pages/columns was silently cut
   * to the first page, so the push planner saw a partial live state and would
   * (a) re-create artifacts that already exist and (b) compute an untrustworthy
   * deletion set (ADR-0021 §4). nextLink is an absolute Graph URL; `request`
   * accepts absolute URLs so we can pass it straight through.
   */
  private async getAllPages<T>(
    firstPath: string,
  ): Promise<{ items: T[]; truncated: boolean }> {
    const items: T[] = [];
    let path: string | undefined = firstPath;
    let pages = 0;
    while (path) {
      const res: { value?: T[]; "@odata.nextLink"?: string } = await this.get(path);
      if (Array.isArray(res.value)) items.push(...res.value);
      pages++;
      const next: string | undefined = res["@odata.nextLink"];
      if (!next) return { items, truncated: false };
      if (pages >= MAX_PAGES) return { items, truncated: true };
      path = next;
    }
    return { items, truncated: false };
  }

  /** Non-hidden lists and libraries of a site (all pages). `onTruncated` fires
   *  if the page cap was hit before the collection was exhausted. */
  async getLists(siteId: string, onTruncated?: () => void): Promise<ListInfo[]> {
    const { items, truncated } = await this.getAllPages<{
      id: string;
      displayName: string;
      webUrl: string;
      list?: { template?: string; hidden?: boolean };
    }>(`/sites/${siteId}/lists?$select=id,displayName,webUrl,list&$top=100`);
    if (truncated) onTruncated?.();
    return items
      .filter((l) => !l.list?.hidden)
      .map((l) => ({
        id: l.id,
        displayName: l.displayName,
        webUrl: l.webUrl,
        template: l.list?.template,
      }));
  }

  /** Modern site pages (all pages). Some tenants restrict this API — callers
   *  should tolerate `graph.forbidden`. `onTruncated` fires if the cap was hit. */
  async getPages(siteId: string, onTruncated?: () => void): Promise<PageInfo[]> {
    const { items, truncated } = await this.getAllPages<{
      id: string;
      title?: string;
      name?: string;
      webUrl: string;
      lastModifiedDateTime?: string;
    }>(
      `/sites/${siteId}/pages/microsoft.graph.sitePage?$select=id,title,name,webUrl,lastModifiedDateTime&$top=100`,
    );
    if (truncated) onTruncated?.();
    return items.map((p) => ({
      id: p.id,
      title: p.title || p.name || "(untitled page)",
      webUrl: p.webUrl,
      lastModified: p.lastModifiedDateTime,
    }));
  }

  /** Visible columns of a list (all pages; lists can exceed 100 columns).
   *  `onTruncated` fires if the page cap was hit before exhaustion. */
  async getListColumns(
    siteId: string,
    listId: string,
    onTruncated?: () => void,
  ): Promise<unknown[]> {
    const { items, truncated } = await this.getAllPages<{ hidden?: boolean }>(
      `/sites/${siteId}/lists/${listId}/columns?$top=100`,
    );
    if (truncated) onTruncated?.();
    return items.filter((c) => c.hidden !== true);
  }

  /** Full page content including the web-part canvas (for the serializer).
   *  Throws graph.forbidden where the tenant restricts the Pages API. */
  async getPageContent(
    siteId: string,
    pageId: string,
  ): Promise<{
    id: string;
    title?: string;
    name?: string;
    pageLayout?: string;
    canvasLayout?: unknown;
  }> {
    return this.get(
      `/sites/${siteId}/pages/${pageId}/microsoft.graph.sitePage?$expand=canvasLayout`,
    );
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

  protected async acquire(
    scopes: string[] = [SITES_READ_SCOPE],
    forceRefresh = false,
  ): Promise<string> {
    // A 401 retry asks for a forced silent re-mint from the refresh token; this
    // recovers an expired/revoked access token without an interactive prompt.
    if (forceRefresh && this.auth.acquireTokenSilent) {
      const refreshed = await this.auth.acquireTokenSilent(scopes, {
        forceRefresh: true,
        account: this.accountHint,
      });
      if (refreshed) return refreshed.token;
      if (this.silentOnly) {
        throw new AppError(
          "Sign-in expired for this site. Run 'AI SharePoint: Test Site Connection' to sign in again.",
          "auth.failed",
        );
      }
      // Foreground: fall through to a (possibly interactive) re-acquire.
    }
    if (this.silentOnly) {
      const silent = this.auth.acquireTokenSilent
        ? await this.auth.acquireTokenSilent(scopes, { account: this.accountHint })
        : null;
      if (!silent) {
        throw new AppError(
          "Sign-in required for this site. Run 'AI SharePoint: Test Site Connection' to sign in, then retry.",
          "auth.failed",
        );
      }
      return silent.token;
    }
    return (await this.auth.acquireToken(scopes)).token;
  }

  private get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  /** Shared Graph request machinery: timeout, single 429/503 retry, one 401
   *  forced-refresh retry, error taxonomy. Write methods (SharePointWriteClient)
   *  pass write scopes. */
  protected async request<T>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
    scopes?: string[],
    retried = false,
    authRetried = false,
  ): Promise<T> {
    const token = await this.acquire(scopes, authRetried);
    const started = Date.now();
    if (wireEnabled() && !retried) {
      // The token itself never reaches the wire log — scheme only.
      emitWire(
        "graph",
        "→",
        `${method} ${safeUrl(path)}`,
        [
          "Authorization: Bearer ***",
          ...(scopes ? [`(scopes: ${scopes.join(" ")})`] : []),
          ...(body !== undefined ? [safeJson(body)] : []),
        ].join("\n"),
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    // `path` is normally a GRAPH_BASE-relative path, but pagination passes the
    // absolute @odata.nextLink straight through — use it as-is when absolute.
    const url = /^https?:\/\//i.test(path) ? path : `${GRAPH_BASE}${path}`;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      emitWire(
        "graph",
        "✗",
        `${method} ${safeUrl(path)} — ${err instanceof Error ? err.message : String(err)} (${Date.now() - started}ms)`,
      );
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
      return this.request<T>(method, path, body, scopes, true, authRetried);
    }

    // 401 (unauthorized) usually means the access token expired or was revoked
    // mid-flight — distinct from 403 (genuine permission denial). Retry once
    // with a forced token re-mint before surfacing an auth error.
    if (res.status === 401 && !authRetried) {
      return this.request<T>(method, path, body, scopes, retried, true);
    }

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      emitWire(
        "graph",
        "✗",
        `${method} ${safeUrl(path)} ${res.status} (${Date.now() - started}ms)`,
        wireEnabled() ? capDetail(errBody) : undefined,
      );
      const code =
        res.status === 401
          ? "auth.failed"
          : res.status === 403
            ? "graph.forbidden"
            : res.status === 404
              ? "graph.notFound"
              : res.status === 429 || res.status === 503
                ? "graph.throttled"
                : "graph.error";
      throw new AppError(
        `Graph request failed (${res.status} ${res.statusText}): ${errBody.slice(0, 500)}`,
        code,
      );
    }
    if (res.status === 204 || method === "DELETE") {
      emitWire("graph", "←", `${method} ${safeUrl(path)} ${res.status} (${Date.now() - started}ms)`);
      return undefined as T;
    }
    const parsed = (await res.json()) as T;
    if (wireEnabled()) {
      emitWire(
        "graph",
        "←",
        `${method} ${safeUrl(path)} ${res.status} (${Date.now() - started}ms)`,
        safeJson(parsed),
      );
    }
    return parsed;
  }
}
