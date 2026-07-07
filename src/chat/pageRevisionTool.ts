import * as vscode from "vscode";
import { ProjectsStore } from "../context/projectsStore";
import { ChatWorkspaceStore } from "../context/chatWorkspaceStore";
import { TelemetryService } from "../diagnostics/telemetry";
import { ErrorReportStore } from "../diagnostics/errorReports";
import { redactError } from "../core/redaction";
import { releaseExpired, expiredNotice } from "../branding/releaseExpiry";

/**
 * Chat tool: save a RECOMMENDED page revision into the active project's
 * workspace (ADR-0048 space-dossier follow-up). Lets the assistant propose a
 * concrete revised version for a flagged Confluence page during a chat; it is
 * written to `space/<KEY>/pages/<id>/recommended.md` (alongside the cached
 * current content) so it can be shown to the owner during outreach. Local
 * operational state — no external side effect, so it is not approval-gated.
 */
export function registerPageRevisionTool(
  projects: ProjectsStore,
  chatWorkspace: ChatWorkspaceStore,
  telemetry: TelemetryService,
  errors: ErrorReportStore,
): vscode.Disposable {
  const text = (s: string) => new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(s)]);
  return vscode.lm.registerTool<{
    spaceKey: string;
    pageId: string;
    title: string;
    url?: string;
    recommendation: string;
    current?: string;
  }>("aisharepoint_recommend_page_revision", {
    async invoke(options) {
      if (releaseExpired()) return text(expiredNotice());
      try {
        const i = options.input;
        const project = projects.active();
        if (!project) return text("No active project — activate one in the Projects view first, then retry.");
        if (!i.pageId?.trim() || !i.recommendation?.trim()) {
          return text("pageId and recommendation are required.");
        }
        const uri = await chatWorkspace.saveRecommendedRevision(project, (i.spaceKey || "space").trim(), {
          id: i.pageId.trim(),
          title: i.title?.trim() || i.pageId.trim(),
          url: i.url?.trim() || "",
          ...(i.current !== undefined ? { current: i.current } : {}),
          recommendation: i.recommendation,
        });
        telemetry.record("project.recommendation");
        return text(
          `Saved a recommended revision for "${i.title || i.pageId}" to the "${project.name}" workspace (${uri.fsPath}). It's linked from the owner outreach draft so you can include it when reaching out.`,
        );
      } catch (e) {
        errors.capture("aisharepoint_recommend_page_revision", e);
        return text(`Error: ${redactError(e instanceof Error ? e : new Error(String(e))).message}`);
      }
    },
  });
}
