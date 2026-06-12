import * as vscode from "vscode";
import { ProjectsStore } from "../context/projectsStore";
import { TelemetryService } from "../diagnostics/telemetry";
import { ErrorReportStore } from "../diagnostics/errorReports";
import { redactError } from "../core/redaction";

/**
 * AI-managed project context (pilot): @sharepoint can persist learnings —
 * "the user prefers X", "always cite the CMDB for app ownership" — into the
 * active project's AI context so they carry across sessions. This is kept
 * strictly separate from the user-defined goals/instructions, and is
 * confirmation-gated (the user sees and approves each note before it sticks).
 */
export function registerProjectTools(
  projects: ProjectsStore,
  telemetry: TelemetryService,
  errors: ErrorReportStore,
): vscode.Disposable[] {
  const text = (s: string) =>
    new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(s)]);

  return [
    vscode.lm.registerTool<{ note: string }>("aisharepoint_remember_project_context", {
      prepareInvocation(options) {
        const active = projects.active();
        return {
          invocationMessage: "Saving a learning to the project's AI context",
          confirmationMessages: {
            title: active
              ? `Remember this for project "${active.name}"?`
              : "Remember this (no active project)?",
            message: new vscode.MarkdownString(
              [
                active
                  ? "Saves to the project's **AI-managed context** — separate from your own goals/instructions — so it carries across sessions:"
                  : "There is no active project, so this can't be saved. Activate a project first (Projects view).",
                "",
                "```",
                (options.input.note ?? "").slice(0, 400),
                "```",
              ].join("\n"),
            ),
          },
        };
      },
      async invoke(options) {
        telemetry.record("tool.invoke", { tool: "aisharepoint_remember_project_context" });
        try {
          const active = projects.active();
          if (!active) {
            return text(
              "No active project — nothing was saved. Ask the user to activate a project (Projects view → click one) before teaching project-specific behavior.",
            );
          }
          const note = (options.input.note ?? "").trim();
          if (!note) return text("Empty note — nothing to remember.");
          await projects.appendAiContext(active.id, note);
          telemetry.record("project.remember");
          return text(
            `Saved to "${active.name}" AI context. It will be included (clearly labeled as AI-managed) in future @sharepoint turns for this project.`,
          );
        } catch (err) {
          errors.capture("tool:aisharepoint_remember_project_context", err);
          return text(`Could not save the note: ${redactError(err).message}`);
        }
      },
    }),
  ];
}
