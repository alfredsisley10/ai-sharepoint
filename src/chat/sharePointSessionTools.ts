import * as vscode from "vscode";
import { SharePointSessionStore } from "../auth/sharePointSessionStore";
import {
  getFormDigest,
  getListItems,
  createListItem,
  updateListItem,
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
  ];
}
