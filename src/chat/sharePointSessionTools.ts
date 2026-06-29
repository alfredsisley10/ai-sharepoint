import * as vscode from "vscode";
import { releaseExpired, expiredNotice } from "../branding/releaseExpiry";
import { SharePointSessionStore } from "../auth/sharePointSessionStore";
import {
  getFormDigest,
  getListItems,
  createListItem,
  updateListItem,
  getLibraryRootFolder,
  listFolder,
  readFileText,
  uploadTextFile,
  deleteFile,
  listSitePages,
  getSitePage,
  createTextPage,
} from "../auth/sharePointRestSession";
import { TelemetryService } from "../diagnostics/telemetry";
import { ErrorReportStore } from "../diagnostics/errorReports";
import { redactError } from "../core/redaction";

/**
 * SharePoint WRITE tools over the user's browser session (ADR-0046) — the
 * no-admin path. Reads are open; create/update are approval-gated. Field names
 * are INTERNAL SharePoint names: the read tool reveals them so writes use the
 * right keys.
 */
export function registerSharePointSessionTools(
  sessions: SharePointSessionStore,
  telemetry: TelemetryService,
  errors: ErrorReportStore,
  timeoutMs: () => number = () => 30_000,
): vscode.Disposable[] {
  const text = (s: string) => new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(s)]);

  const resolve = (ref?: string) => {
    const s = sessions.resolve(ref);
    if (!s) {
      const all = sessions.list();
      throw new Error(
        all.length === 0
          ? 'No SharePoint browser-session connection. The user runs "AI SharePoint: Connect Site (browser session)" and pastes their signed-in cookies first.'
          : `Could not match "${ref ?? ""}" to a session site. Connected: ${all.map((x) => `${x.webTitle} (${x.siteUrl})`).join("; ")}.`,
      );
    }
    return s;
  };
  const cookiesFor = async (siteUrl: string) => {
    const c = await sessions.cookies(siteUrl);
    if (!c) throw new Error("The stored session cookies are missing — reconnect the site's browser session.");
    return c;
  };

  return [
    // READ list items — also the way to discover INTERNAL field names for writes.
    vscode.lm.registerTool<{ site?: string; list?: string; select?: string; filter?: string; top?: number }>(
      "aisharepoint_sp_list_items",
      {
        prepareInvocation(o) {
          return { invocationMessage: `Reading SharePoint list “${o.input.list ?? "?"}” (browser session)` };
        },
        async invoke(o) {
          if (releaseExpired()) return text(expiredNotice());
          telemetry.record("tool.invoke", { tool: "aisharepoint_sp_list_items" });
          try {
            const i = o.input;
            if (!i.list?.trim()) return text("A list title is required.");
            const site = resolve(i.site);
            const items = await getListItems(
              site.siteUrl,
              i.list.trim(),
              await cookiesFor(site.siteUrl),
              { ...(i.select ? { select: i.select } : {}), ...(i.filter ? { filter: i.filter } : {}), ...(i.top ? { top: i.top } : {}) },
              timeoutMs(),
            );
            telemetry.record("sp.session.read");
            return text(
              `${items.length} item(s) from “${i.list}” on ${site.webTitle}. Field keys are INTERNAL names — use them for writes.\n\n${JSON.stringify(items, null, 1).slice(0, 6000)}`,
            );
          } catch (err) {
            errors.capture("tool:aisharepoint_sp_list_items", err);
            return text(`Could not read the list: ${redactError(err).message}`);
          }
        },
      },
    ),
    // WRITE a list item (create or update) — approval-gated.
    vscode.lm.registerTool<{ site?: string; list?: string; action?: "create" | "update"; itemId?: number; fields?: Record<string, unknown> }>(
      "aisharepoint_sp_write_item",
      {
        prepareInvocation(o) {
          const i = o.input;
          const verb = i.action === "update" ? "Update" : "Create";
          return {
            invocationMessage: `${verb} a SharePoint list item (browser session)`,
            confirmationMessages: {
              title: `${verb} an item in “${i.list ?? "?"}”${i.action === "update" ? ` (id ${i.itemId ?? "?"})` : ""}?`,
              message: new vscode.MarkdownString(
                [
                  `Writes to **${i.list ?? "the list"}** via your own SharePoint browser session — a real change.`,
                  "",
                  "```json",
                  JSON.stringify(i.fields ?? {}, null, 1).slice(0, 1500),
                  "```",
                  "_Field names must be the INTERNAL SharePoint names (read the list first to see them)._",
                ].join("\n"),
              ),
            },
          };
        },
        async invoke(o) {
          if (releaseExpired()) return text(expiredNotice());
          telemetry.record("tool.invoke", { tool: "aisharepoint_sp_write_item" });
          try {
            const i = o.input;
            if (!i.list?.trim()) return text("A list title is required.");
            if (!i.fields || Object.keys(i.fields).length === 0) return text("At least one field is required.");
            const action = i.action === "update" ? "update" : "create";
            if (action === "update" && (i.itemId === undefined || i.itemId === null)) {
              return text("Updating an item needs its itemId (read the list to find it).");
            }
            const site = resolve(i.site);
            const cookies = await cookiesFor(site.siteUrl);
            const digest = await getFormDigest(site.siteUrl, cookies, timeoutMs());
            if (action === "update") {
              await updateListItem(site.siteUrl, i.list.trim(), Number(i.itemId), i.fields, cookies, digest, timeoutMs());
              telemetry.record("sp.session.write", { action });
              return text(`Updated item ${i.itemId} in “${i.list}” on ${site.webTitle}.`);
            }
            const created = await createListItem(site.siteUrl, i.list.trim(), i.fields, cookies, digest, timeoutMs());
            telemetry.record("sp.session.write", { action });
            return text(`Created item ${created.Id} in “${i.list}” on ${site.webTitle}.`);
          } catch (err) {
            errors.capture("tool:aisharepoint_sp_write_item", err);
            return text(`Could not write the list item: ${redactError(err).message}`);
          }
        },
      },
    ),
    // DOCUMENT LIBRARIES — list/read are open; upload/delete are approval-gated.
    vscode.lm.registerTool<{ site?: string; action?: "list" | "read" | "upload" | "delete"; folder?: string; file?: string; fileName?: string; content?: string }>(
      "aisharepoint_sp_library_files",
      {
        prepareInvocation(o) {
          const i = o.input;
          const write = i.action === "upload" || i.action === "delete";
          return {
            invocationMessage:
              i.action === "upload"
                ? `Uploading “${i.fileName ?? "file"}” to SharePoint (browser session)`
                : i.action === "delete"
                  ? `Deleting a SharePoint file (browser session)`
                  : `Browsing SharePoint files (browser session)`,
            ...(write
              ? {
                  confirmationMessages: {
                    title:
                      i.action === "upload"
                        ? `Upload “${i.fileName ?? "file"}” to ${i.folder ?? "the library"}?`
                        : `Delete ${i.file ?? "this file"}?`,
                    message: new vscode.MarkdownString(
                      i.action === "upload"
                        ? `Writes a file to **${i.folder ?? "the library"}** via your SharePoint browser session (overwrites any file of the same name).`
                        : `Permanently deletes **${i.file ?? "the file"}** via your SharePoint browser session.`,
                    ),
                  },
                }
              : {}),
          };
        },
        async invoke(o) {
          if (releaseExpired()) return text(expiredNotice());
          telemetry.record("tool.invoke", { tool: "aisharepoint_sp_library_files" });
          try {
            const i = o.input;
            const action = i.action ?? "list";
            const site = resolve(i.site);
            const cookies = await cookiesFor(site.siteUrl);
            // "folder" may be a server-relative path (/sites/…/Shared Documents)
            // or a library display title we resolve to its root folder.
            const folderPath = async (f: string) =>
              f.startsWith("/") ? f : getLibraryRootFolder(site.siteUrl, f, cookies, timeoutMs());
            if (action === "list") {
              if (!i.folder?.trim()) return text("A folder (server-relative path or library title) is required.");
              const { files, folders } = await listFolder(site.siteUrl, await folderPath(i.folder.trim()), cookies, timeoutMs());
              telemetry.record("sp.session.read");
              return text(
                `${folders.length} folder(s), ${files.length} file(s) on ${site.webTitle}:\n\n${JSON.stringify({ folders, files }, null, 1).slice(0, 6000)}`,
              );
            }
            if (action === "read") {
              if (!i.file?.trim()) return text("A file server-relative URL is required (from a list result).");
              const body = await readFileText(site.siteUrl, i.file.trim(), cookies, timeoutMs());
              telemetry.record("sp.session.read");
              return text(`Content of ${i.file} (${body.length} chars):\n\n${body.slice(0, 8000)}`);
            }
            const digest = await getFormDigest(site.siteUrl, cookies, timeoutMs());
            if (action === "delete") {
              if (!i.file?.trim()) return text("A file server-relative URL is required.");
              await deleteFile(site.siteUrl, i.file.trim(), cookies, digest, timeoutMs());
              telemetry.record("sp.session.write", { action: "delete-file" });
              return text(`Deleted ${i.file} on ${site.webTitle}.`);
            }
            // upload
            if (!i.folder?.trim() || !i.fileName?.trim() || i.content === undefined) {
              return text("Uploading needs folder, fileName, and content.");
            }
            const created = await uploadTextFile(site.siteUrl, await folderPath(i.folder.trim()), i.fileName.trim(), i.content, cookies, digest, timeoutMs());
            telemetry.record("sp.session.write", { action: "upload-file" });
            return text(`Uploaded ${created.Name} → ${created.ServerRelativeUrl} on ${site.webTitle}.`);
          } catch (err) {
            errors.capture("tool:aisharepoint_sp_library_files", err);
            return text(`Could not complete the file operation: ${redactError(err).message}`);
          }
        },
      },
    ),
    // MODERN PAGES — list/read are open; create is approval-gated.
    vscode.lm.registerTool<{ site?: string; action?: "list" | "read" | "create"; pageId?: number; title?: string; body?: string }>(
      "aisharepoint_sp_manage_page",
      {
        prepareInvocation(o) {
          const i = o.input;
          return {
            invocationMessage: i.action === "create" ? `Creating a SharePoint page (browser session)` : `Reading SharePoint pages (browser session)`,
            ...(i.action === "create"
              ? {
                  confirmationMessages: {
                    title: `Create & publish the page “${i.title ?? "?"}”?`,
                    message: new vscode.MarkdownString(
                      `Creates and **publishes** a modern page on ${resolve(i.site)?.webTitle ?? "the site"} via your browser session. Page authoring through the REST canvas is version-sensitive — if it fails it'll say so.`,
                    ),
                  },
                }
              : {}),
          };
        },
        async invoke(o) {
          if (releaseExpired()) return text(expiredNotice());
          telemetry.record("tool.invoke", { tool: "aisharepoint_sp_manage_page" });
          try {
            const i = o.input;
            const action = i.action ?? "list";
            const site = resolve(i.site);
            const cookies = await cookiesFor(site.siteUrl);
            if (action === "list") {
              const pages = await listSitePages(site.siteUrl, cookies, timeoutMs());
              telemetry.record("sp.session.read");
              return text(`${pages.length} page(s) on ${site.webTitle}:\n\n${JSON.stringify(pages, null, 1).slice(0, 5000)}`);
            }
            if (action === "read") {
              if (i.pageId === undefined) return text("A pageId is required (from the list action).");
              const page = await getSitePage(site.siteUrl, Number(i.pageId), cookies, timeoutMs());
              telemetry.record("sp.session.read");
              return text(`“${page.Title ?? page.Url ?? page.Id}” (${page.text.length} chars):\n\n${page.text.slice(0, 8000)}`);
            }
            // create
            if (!i.title?.trim() || !i.body?.trim()) return text("Creating a page needs a title and body.");
            const digest = await getFormDigest(site.siteUrl, cookies, timeoutMs());
            const created = await createTextPage(site.siteUrl, i.title.trim(), htmlBody(i.body), cookies, digest, timeoutMs());
            telemetry.record("sp.session.write", { action: "create-page" });
            return text(`Created & published page ${created.Id}${created.Url ? ` (${created.Url})` : ""} on ${site.webTitle}.`);
          } catch (err) {
            errors.capture("tool:aisharepoint_sp_manage_page", err);
            return text(`Could not complete the page operation: ${redactError(err).message}`);
          }
        },
      },
    ),
  ];
}

/** Plain text → minimal HTML for a text web part (paragraphs + line breaks);
 *  leaves already-HTML bodies untouched. */
function htmlBody(body: string): string {
  if (/<\w+[^>]*>/.test(body)) return body;
  return body
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
    .join("");
}
