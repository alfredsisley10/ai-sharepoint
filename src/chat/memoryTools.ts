import * as vscode from "vscode";
import { MemoryStore } from "../context/memoryStore";
import { normalizeMemoryInput, resolveMemoryTarget } from "../context/memory";
import { ContextSourcesStore } from "../context/sourcesStore";
import { SitesStore } from "../auth/sitesStore";
import { TelemetryService } from "../diagnostics/telemetry";
import { ErrorReportStore } from "../diagnostics/errorReports";
import { redactError } from "../core/redaction";
import { releaseExpired, expiredNotice } from "../branding/releaseExpiry";

/**
 * The remember_about tool: when @sharepoint learns a durable, reusable fact about
 * a specific reference source or managed site (a convention, a key table, a
 * gotcha), it proposes a memory note attached to that entity. Stored with
 * origin `ai` (badged "AI-proposed") so it is reviewable/editable/removable by
 * the user under "Manage Memory" — non-modal, like capture_lesson. Unlike
 * remember_project_context (project-wide AI memory), this is scoped to one
 * source/site and travels with it on export.
 */

export function registerMemoryTools(
  memory: MemoryStore,
  sources: ContextSourcesStore,
  sites: SitesStore,
  telemetry: TelemetryService,
  errors: ErrorReportStore,
  newId: () => string,
  now: () => string,
): vscode.Disposable[] {
  const text = (s: string) => new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(s)]);

  return [
    vscode.lm.registerTool<{ target: string; title: string; note: string; tags?: string[] }>("aisharepoint_remember_about", {
      prepareInvocation(options) {
        // Non-modal: shows in chat activity. The user reviews under Manage Memory.
        return { invocationMessage: `📝 Proposing a memory note about “${options.input.target}”` };
      },
      async invoke(options) {
        if (releaseExpired()) return text(expiredNotice());
        telemetry.record("tool.invoke", { tool: "aisharepoint_remember_about" });
        try {
          const resolved = resolveMemoryTarget(options.input.target, sources.list(), sites.list());
          if (!resolved) {
            const names = [
              ...sources.list().map((s) => s.alias ?? s.displayName),
              ...sites.list().map((c) => c.displayName),
            ];
            return text(
              `No site or source matches "${options.input.target}". Available: ${names.slice(0, 20).join(", ") || "(none configured)"}. Pass the exact name or alias; do not invent one.`,
            );
          }
          const norm = normalizeMemoryInput(options.input.title, options.input.note, options.input.tags);
          if (!norm.title || !norm.text) {
            return text("A memory note needs both a short 'title' and a 'note'. Nothing was stored.");
          }
          const at = now();
          await memory.add({
            id: newId(),
            scope: resolved.scope,
            title: norm.title,
            text: norm.text,
            ...(norm.tags ? { tags: norm.tags } : {}),
            origin: "ai",
            createdAt: at,
            updatedAt: at,
          });
          telemetry.record("memory.capture", { scope: resolved.scope.kind });
          return text(
            `Saved an AI-proposed memory note "${norm.title}" for ${resolved.label}. Tell the user it is saved (badged "AI-proposed") and they can review, edit, or remove it via "Manage Memory"; it will be used as context whenever ${resolved.label} is in scope.`,
          );
        } catch (err) {
          errors.capture("tool:aisharepoint_remember_about", err);
          return text(`Could not save the memory note: ${redactError(err).message}`);
        }
      },
    }),
  ];
}
