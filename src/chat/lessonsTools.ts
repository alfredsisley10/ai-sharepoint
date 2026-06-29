import * as vscode from "vscode";
import { LessonsStore } from "../diagnostics/lessonsStore";
import { TelemetryService } from "../diagnostics/telemetry";
import { ErrorReportStore } from "../diagnostics/errorReports";
import { redactError } from "../core/redaction";
import { LessonCategory } from "../diagnostics/lessons";
import { releaseExpired, expiredNotice } from "../branding/releaseExpiry";

/**
 * The capture_lesson tool (ADR-0041): when @sharepoint self-corrects or finds a
 * reusable interaction pattern, it records a GENERALIZED, anonymized heuristic
 * (e.g. "user said 'my Confluence space' → scope to their personal ~space, not
 * global"). Unlike remember_project_context (which writes to the user's own
 * project context and is approval-gated), this writes to a local, anonymized,
 * reviewable ledger — so it is NOT modal: the opt-in setting is the consent
 * gate, and everything is reviewable + removable before any export. Capture is
 * a no-op (reported honestly) while the opt-in setting is off.
 */
export function registerLessonsTools(
  lessons: LessonsStore,
  telemetry: TelemetryService,
  errors: ErrorReportStore,
): vscode.Disposable[] {
  const text = (s: string) =>
    new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(s)]);

  return [
    vscode.lm.registerTool<{
      category?: string;
      trigger: string;
      lesson: string;
      tags?: string[];
    }>("aisharepoint_capture_lesson", {
      prepareInvocation() {
        // Non-modal: shows in the chat activity, no confirmation interrupt.
        return {
          invocationMessage: "📓 Noting a lesson learned (anonymized, local)",
        };
      },
      async invoke(options) {
        if (releaseExpired()) return text(expiredNotice());
        telemetry.record("tool.invoke", { tool: "aisharepoint_capture_lesson" });
        try {
          if (!lessons.enabled()) {
            return text(
              "Lessons capture is OFF (the user hasn't opted in via aiSharePoint.lessons.capture), so nothing was stored. Do not claim a lesson was saved; simply continue helping.",
            );
          }
          const res = await lessons.capture({
            category: options.input.category as LessonCategory | undefined,
            trigger: options.input.trigger,
            lesson: options.input.lesson,
            tags: options.input.tags,
          });
          if (!res.stored) {
            return text(
              res.reason === "empty"
                ? "Nothing was stored — a lesson needs both a 'trigger' (when it applies) and a 'lesson' (the generalized heuristic)."
                : "Lessons capture is off — nothing was stored.",
            );
          }
          telemetry.record("lesson.capture", { merged: res.merged });
          return text(
            res.merged
              ? "Recognized this as a recurring lesson — incremented its count in the local anonymized ledger."
              : "Noted a new anonymized lesson in the local ledger (reviewable + exportable by the user; nothing is transmitted).",
          );
        } catch (err) {
          errors.capture("tool:aisharepoint_capture_lesson", err);
          return text(`Could not note the lesson: ${redactError(err).message}`);
        }
      },
    }),
  ];
}
