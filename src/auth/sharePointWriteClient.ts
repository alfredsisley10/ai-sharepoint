import { SharePointClient } from "./sharePointClient";
import { DesiredColumn } from "../sync/desiredState";

/**
 * Graph write client for write-back slice 1 (ADR-0021). Write scopes are
 * requested only here — never by read paths — so consent is incremental and
 * deliberate. Never constructed silent-only: writes are explicit commands.
 *
 *  - Sites.ReadWrite.All → pages (create/update/publish/delete)
 *  - Sites.Manage.All    → lists & columns (create/update/delete)
 */
const WRITE_SCOPES = [
  "https://graph.microsoft.com/Sites.ReadWrite.All",
  "https://graph.microsoft.com/Sites.Manage.All",
];

export class SharePointWriteClient extends SharePointClient {
  createList(
    siteId: string,
    list: { displayName: string; description: string; template: string },
  ): Promise<{ id: string }> {
    return this.request(
      "POST",
      `/sites/${siteId}/lists`,
      {
        displayName: list.displayName,
        description: list.description,
        list: { template: list.template },
      },
      WRITE_SCOPES,
    );
  }

  updateList(
    siteId: string,
    listId: string,
    patch: { description: string },
  ): Promise<void> {
    return this.request("PATCH", `/sites/${siteId}/lists/${listId}`, patch, WRITE_SCOPES);
  }

  createColumn(siteId: string, listId: string, column: DesiredColumn): Promise<void> {
    return this.request(
      "POST",
      `/sites/${siteId}/lists/${listId}/columns`,
      column,
      WRITE_SCOPES,
    );
  }

  updateColumn(
    siteId: string,
    listId: string,
    columnId: string,
    column: DesiredColumn,
  ): Promise<void> {
    // `name` is immutable — send only the patchable metadata.
    const { name: _immutable, ...patch } = column;
    return this.request(
      "PATCH",
      `/sites/${siteId}/lists/${listId}/columns/${encodeURIComponent(columnId)}`,
      patch,
      WRITE_SCOPES,
    );
  }

  createPage(
    siteId: string,
    page: { name: string; title: string; pageLayout: string; canvasLayout: unknown | null },
  ): Promise<{ id: string }> {
    return this.request(
      "POST",
      `/sites/${siteId}/pages`,
      {
        "@odata.type": "#microsoft.graph.sitePage",
        name: page.name,
        title: page.title,
        pageLayout: page.pageLayout,
        ...(page.canvasLayout ? { canvasLayout: page.canvasLayout } : {}),
      },
      WRITE_SCOPES,
    );
  }

  updatePage(
    siteId: string,
    pageId: string,
    patch: { title?: string; canvasLayout?: unknown },
  ): Promise<void> {
    return this.request(
      "PATCH",
      `/sites/${siteId}/pages/${pageId}/microsoft.graph.sitePage`,
      { "@odata.type": "#microsoft.graph.sitePage", ...patch },
      WRITE_SCOPES,
    );
  }

  publishPage(siteId: string, pageId: string): Promise<void> {
    return this.request(
      "POST",
      `/sites/${siteId}/pages/${pageId}/microsoft.graph.sitePage/publish`,
      undefined,
      WRITE_SCOPES,
    );
  }

  deleteList(siteId: string, listId: string): Promise<void> {
    return this.request("DELETE", `/sites/${siteId}/lists/${listId}`, undefined, WRITE_SCOPES);
  }

  deletePage(siteId: string, pageId: string): Promise<void> {
    return this.request("DELETE", `/sites/${siteId}/pages/${pageId}`, undefined, WRITE_SCOPES);
  }
}
