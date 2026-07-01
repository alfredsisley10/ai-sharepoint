import * as vscode from "vscode";
import { SitesStore, SiteConnection } from "../auth/sitesStore";
import { CommsClient } from "../comms/commsClient";
import { OutlookWorkspaceStore } from "../comms/outlookWorkspaceStore";
import { calendarWindow, renderMailDigest, renderCalendarDigest } from "../comms/outlookWorkspace";
import { TelemetryService } from "../diagnostics/telemetry";
import { ErrorReportStore } from "../diagnostics/errorReports";
import { redactError } from "../core/redaction";
import { releaseExpired, expiredNotice } from "../branding/releaseExpiry";

/**
 * Read-only Outlook tool: lets @sharepoint pull mail/calendar context into a
 * chat itself, within the workspace's configured access scope. Strictly
 * read-only (no send/move/delete) and release-expiry gated. It never picks a
 * mailbox on its own — it reads only a workspace the user has already set up;
 * with none, it tells the assistant to ask the user to configure one rather
 * than guessing mailbox contents.
 */
export function registerOutlookTools(
  workspaces: OutlookWorkspaceStore,
  sites: SitesStore,
  makeClient: (conn: SiteConnection) => CommsClient,
  rememberedHandle: () => string | undefined,
  telemetry: TelemetryService,
  errors: ErrorReportStore,
  now: () => string,
): vscode.Disposable[] {
  const text = (s: string) => new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(s)]);

  return [
    vscode.lm.registerTool<{ kind: "mail" | "calendar"; days?: number }>("aisharepoint_read_outlook", {
      prepareInvocation(options) {
        return {
          invocationMessage:
            options.input.kind === "calendar"
              ? "📅 Reading your Outlook calendar (read-only)"
              : "📬 Reading Outlook mail (read-only)",
        };
      },
      async invoke(options) {
        if (releaseExpired()) return text(expiredNotice());
        telemetry.record("tool.invoke", { tool: "aisharepoint_read_outlook" });
        try {
          const all = workspaces.list();
          if (all.length === 0) {
            return text(
              "No Outlook workspace is configured, so there is nothing to read. Ask the user to run “Outlook: Configure Read-Only Workspace” first — do not guess mailbox contents.",
            );
          }
          const remembered = rememberedHandle();
          const ws = all.find((w) => w.connectionHandle === remembered) ?? all[0];
          const conn = sites.list().find((c) => c.cacheHandle === ws.connectionHandle);
          if (!conn) {
            return text("The Outlook workspace's Microsoft 365 sign-in is no longer connected. Ask the user to reconnect the site or reconfigure the workspace.");
          }
          const client = makeClient(conn);
          if (options.input.kind === "calendar") {
            const days = Math.min(Math.max(1, Math.floor(options.input.days ?? 7)), 31);
            const { startIso, endIso } = calendarWindow(now(), days);
            const events = await client.readCalendar(startIso, endIso, 50);
            telemetry.record("comms.readCalendar", { count: events.length, via: "tool" });
            return text(renderCalendarDigest(`next ${days} days`, events));
          }
          const messages = await client.readMessages(ws.readScope, ws.folderId, 25);
          telemetry.record("comms.readMail", { scope: ws.readScope, count: messages.length, via: "tool" });
          const label = ws.readScope === "workspace" ? `${ws.folderName} (workspace)` : "whole mailbox";
          return text(renderMailDigest(label, messages));
        } catch (err) {
          errors.capture("tool:aisharepoint_read_outlook", err);
          return text(`Could not read Outlook: ${redactError(err).message}`);
        }
      },
    }),
  ];
}
