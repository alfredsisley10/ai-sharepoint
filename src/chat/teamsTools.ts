import * as vscode from "vscode";
import { SitesStore, SiteConnection } from "../auth/sitesStore";
import { CommsClient } from "../comms/commsClient";
import { TeamsScopeStore } from "../comms/teamsScopeStore";
import { TeamsScopeEntry, renderTeamsDigest, clampTeamsTop } from "../comms/teamsScope";
import { TelemetryService } from "../diagnostics/telemetry";
import { ErrorReportStore } from "../diagnostics/errorReports";
import { redactError } from "../core/redaction";
import { releaseExpired, expiredNotice } from "../branding/releaseExpiry";

/**
 * Read-only, scoped Teams tool: lets @sharepoint pull messages from a chat or
 * channel the user has explicitly registered as a scope. It NEVER reads all of
 * Teams — only registered scopes — and is release-expiry gated. With none
 * registered it tells the assistant to ask the user to add one rather than
 * guessing conversation contents.
 */
export function registerTeamsTools(
  scopes: TeamsScopeStore,
  sites: SitesStore,
  makeClient: (conn: SiteConnection) => CommsClient,
  telemetry: TelemetryService,
  errors: ErrorReportStore,
): vscode.Disposable[] {
  const text = (s: string) => new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(s)]);

  return [
    vscode.lm.registerTool<{ scope?: string; count?: number }>("aisharepoint_read_teams", {
      prepareInvocation(options) {
        return { invocationMessage: options.input.scope ? `💬 Reading Teams scope “${options.input.scope}”` : "💬 Reading a registered Teams scope" };
      },
      async invoke(options) {
        if (releaseExpired()) return text(expiredNotice());
        telemetry.record("tool.invoke", { tool: "aisharepoint_read_teams" });
        try {
          const all = scopes.list();
          if (all.length === 0) {
            return text(
              "No Teams scope is registered, so there is nothing to read. Ask the user to run “Teams: Add Readable Scope (chat or channel)” first — do not guess conversation contents.",
            );
          }
          let entry: TeamsScopeEntry | undefined;
          if (options.input.scope) {
            const q = options.input.scope.trim().toLowerCase();
            entry = all.find((s) => s.label.toLowerCase() === q) ?? all.find((s) => s.label.toLowerCase().includes(q));
          } else if (all.length === 1) {
            entry = all[0];
          }
          if (!entry) {
            return text(`Which Teams scope? Registered: ${all.map((s) => `"${s.label}"`).join(", ")}. Pass one as 'scope'.`);
          }
          const conn = sites.list().find((c) => c.cacheHandle === entry!.connectionHandle);
          if (!conn) {
            return text("The Teams scope's Microsoft 365 sign-in is no longer connected. Ask the user to reconnect the site or re-add the scope.");
          }
          const client = makeClient(conn);
          const top = clampTeamsTop(options.input.count);
          const messages =
            entry.scope.kind === "chat"
              ? await client.readChatMessages(entry.scope.chatId, top)
              : await client.readChannelMessages(entry.scope.teamId, entry.scope.channelId, top);
          telemetry.record("comms.readTeams", { kind: entry.scope.kind, count: messages.length, via: "tool" });
          return text(renderTeamsDigest(entry.label, messages));
        } catch (err) {
          errors.capture("tool:aisharepoint_read_teams", err);
          return text(`Could not read Teams: ${redactError(err).message}`);
        }
      },
    }),
  ];
}
