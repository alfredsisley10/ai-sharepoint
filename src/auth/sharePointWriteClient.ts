import { SharePointClient } from "./sharePointClient";
import { SharePointAuthProvider } from "./types";
import { AppError } from "../core/errors";
import { DesiredColumn } from "../sync/desiredState";

/**
 * Graph write client for write-back (ADR-0021). Write scopes are requested only
 * here — never by read paths — so consent is incremental and deliberate. Never
 * constructed silent-only: writes are explicit commands.
 *
 * The requested scope is configurable (ADR-0037) because the tenant-wide
 * scopes are routinely refused by admins:
 *  - "selected" (default, least privilege): `Sites.Selected` — the app gets NO
 *    site access until an admin grants it the SPECIFIC site (write/manage role).
 *    Far more likely to be approved; needs a one-time per-site grant.
 *  - "all": `Sites.ReadWrite.All` (pages) + `Sites.Manage.All` (lists/columns) —
 *    tenant-wide delegated write across every site the user can access.
 */

export type WritePermissionMode = "selected" | "all";

/** Delegated Graph write scopes for a permission mode (pure, testable). */
export function writeScopesFor(mode: WritePermissionMode): string[] {
  if (mode === "all") {
    return [
      "https://graph.microsoft.com/Sites.ReadWrite.All",
      "https://graph.microsoft.com/Sites.Manage.All",
    ];
  }
  return ["https://graph.microsoft.com/Sites.Selected"];
}

export class SharePointWriteClient extends SharePointClient {
  private readonly writeScopes: string[];

  constructor(
    auth: SharePointAuthProvider,
    private readonly mode: WritePermissionMode = "selected",
    silentOnly = false,
  ) {
    super(auth, silentOnly);
    this.writeScopes = writeScopesFor(mode);
  }

  /** Every write goes through here so the configured scopes are applied and a
   *  Sites.Selected 403 (app not yet granted this site) explains the fix. */
  private async writeRequest<T>(
    method: "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> {
    try {
      return await this.request<T>(method, path, body, this.writeScopes);
    } catch (err) {
      if (this.mode === "selected" && err instanceof AppError && err.code === "graph.forbidden") {
        throw new AppError(
          err.message,
          "graph.forbidden",
          "Sites.Selected is in effect: an admin must grant this app write/manage access to THIS specific site (one-time) — e.g. `Grant-PnPAzureADAppSitePermission -Site <url> -Permissions Manage -AppId <id>`, or `POST /sites/{id}/permissions`. See the Admin Guide “Sites.Selected” runbook. To request tenant-wide scopes instead, set aiSharePoint.sync.writePermissionMode to \"all\".",
        );
      }
      throw err;
    }
  }

  createList(
    siteId: string,
    list: { displayName: string; description: string; template: string },
  ): Promise<{ id: string }> {
    return this.writeRequest("POST", `/sites/${siteId}/lists`, {
      displayName: list.displayName,
      description: list.description,
      list: { template: list.template },
    });
  }

  updateList(siteId: string, listId: string, patch: { description: string }): Promise<void> {
    return this.writeRequest("PATCH", `/sites/${siteId}/lists/${listId}`, patch);
  }

  createColumn(siteId: string, listId: string, column: DesiredColumn): Promise<void> {
    return this.writeRequest("POST", `/sites/${siteId}/lists/${listId}/columns`, column);
  }

  updateColumn(
    siteId: string,
    listId: string,
    columnId: string,
    column: DesiredColumn,
  ): Promise<void> {
    // `name` is immutable — send only the patchable metadata.
    const { name: _immutable, ...patch } = column;
    return this.writeRequest(
      "PATCH",
      `/sites/${siteId}/lists/${listId}/columns/${encodeURIComponent(columnId)}`,
      patch,
    );
  }

  createPage(
    siteId: string,
    page: { name: string; title: string; pageLayout: string; canvasLayout: unknown | null },
  ): Promise<{ id: string }> {
    return this.writeRequest("POST", `/sites/${siteId}/pages`, {
      "@odata.type": "#microsoft.graph.sitePage",
      name: page.name,
      title: page.title,
      pageLayout: page.pageLayout,
      ...(page.canvasLayout ? { canvasLayout: page.canvasLayout } : {}),
    });
  }

  updatePage(
    siteId: string,
    pageId: string,
    patch: { title?: string; canvasLayout?: unknown },
  ): Promise<void> {
    return this.writeRequest(
      "PATCH",
      `/sites/${siteId}/pages/${pageId}/microsoft.graph.sitePage`,
      { "@odata.type": "#microsoft.graph.sitePage", ...patch },
    );
  }

  publishPage(siteId: string, pageId: string): Promise<void> {
    return this.writeRequest(
      "POST",
      `/sites/${siteId}/pages/${pageId}/microsoft.graph.sitePage/publish`,
    );
  }

  deleteList(siteId: string, listId: string): Promise<void> {
    return this.writeRequest("DELETE", `/sites/${siteId}/lists/${listId}`);
  }

  deletePage(siteId: string, pageId: string): Promise<void> {
    return this.writeRequest("DELETE", `/sites/${siteId}/pages/${pageId}`);
  }
}
