import * as vscode from "vscode";
import { ContextSourcesStore } from "../context/sourcesStore";
import { ContextService } from "../context/contextService";
import { BookmarksStore } from "../context/bookmarksStore";
import { TelemetryService } from "../diagnostics/telemetry";
import { ErrorReportStore } from "../diagnostics/errorReports";
import { redactError } from "../core/redaction";

/**
 * LM tools over the read-only context-source framework (PLAN §9 + ADR-0017).
 * Strictly read-only, stored-credential only (a tool call can never prompt),
 * lockout-gated, cached, and result-capped.
 */

function text(s: string): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(s)]);
}

export function registerContextTools(
  store: ContextSourcesStore,
  service: ContextService,
  bookmarks: BookmarksStore,
  telemetry: TelemetryService,
  errors: ErrorReportStore,
): vscode.Disposable[] {
  const guarded = <T>(
    name: string,
    invocationMessage: string,
    run: (input: T) => Promise<string>,
  ): vscode.LanguageModelTool<T> => ({
    prepareInvocation() {
      return { invocationMessage };
    },
    async invoke(options) {
      telemetry.record("tool.invoke", { tool: name });
      try {
        return text(await run(options.input));
      } catch (err) {
        errors.capture(`tool:${name}`, err);
        return text(`The ${name} tool failed: ${redactError(err).message}`);
      }
    },
  });

  const resolveOrExplain = (ref?: string) => {
    const source = store.resolve(ref);
    if (!source) {
      const all = store.list();
      throw new Error(
        all.length === 0
          ? 'No reference sources configured. The user can add Confluence/Jira via "AI SharePoint: Add Context Source".'
          : `Could not match "${ref ?? ""}" to a source. Available: ${all
              .map((s) => `${s.displayName} (${s.type})`)
              .join("; ")}.`,
      );
    }
    return source;
  };

  return [
    vscode.lm.registerTool(
      "aisharepoint_list_sources",
      guarded<Record<string, never>>(
        "aisharepoint_list_sources",
        "Listing reference sources",
        async () => {
          const all = store.list();
          if (all.length === 0) {
            return 'No reference sources configured. The user can add Confluence or Jira via "AI SharePoint: Add Context Source". Reference-role SharePoint sites are available through the SharePoint tools instead.';
          }
          return JSON.stringify(
            all.map((s) => ({
              name: s.displayName,
              type: s.type,
              deployment: s.deployment,
              verified: Boolean(s.lastVerifiedAt),
            })),
            null,
            2,
          );
        },
      ),
    ),
    vscode.lm.registerTool(
      "aisharepoint_search_context",
      guarded<{ source?: string; query: string }>(
        "aisharepoint_search_context",
        "Searching reference sources",
        async (input) => {
          const source = resolveOrExplain(input.source);
          const hits = await service.search(source, input.query);
          if (hits.length === 0) {
            return `No results in "${source.displayName}" for that query. (Confluence accepts raw CQL, Jira raw JQL, or plain text.)`;
          }
          return JSON.stringify(hits, null, 2);
        },
      ),
    ),
    vscode.lm.registerTool(
      "aisharepoint_get_context_item",
      guarded<{ source?: string; id: string }>(
        "aisharepoint_get_context_item",
        "Reading a reference item",
        async (input) => {
          const source = resolveOrExplain(input.source);
          const item = await service.getItem(source, input.id);
          return JSON.stringify(item, null, 2);
        },
      ),
    ),
    vscode.lm.registerTool(
      "aisharepoint_run_bookmark",
      guarded<{ name: string }>(
        "aisharepoint_run_bookmark",
        "Running a saved bookmark",
        async (input) => {
          const all = bookmarks.list();
          if (all.length === 0) {
            return 'No bookmarks saved. The user can save reusable queries via "AI SharePoint: Add Bookmark".';
          }
          const bookmark = bookmarks.resolve(input.name);
          if (!bookmark) {
            return `No bookmark named "${input.name}". Available: ${all
              .map((b) => b.name)
              .join("; ")}.`;
          }
          const source = store.get(bookmark.sourceId);
          if (!source) {
            return `The source for bookmark "${bookmark.name}" no longer exists.`;
          }
          const result =
            bookmark.kind === "item"
              ? await service.getItem(source, bookmark.locator)
              : await service.search(source, bookmark.locator);
          return JSON.stringify(
            { bookmark: bookmark.name, source: source.displayName, kind: bookmark.kind, result },
            null,
            2,
          );
        },
      ),
    ),
    vscode.lm.registerTool(
      "aisharepoint_list_bookmarks",
      guarded<Record<string, never>>(
        "aisharepoint_list_bookmarks",
        "Listing bookmarks",
        async () => {
          const all = bookmarks.list();
          if (all.length === 0) return "No bookmarks saved.";
          return JSON.stringify(
            all.map((b) => ({
              name: b.name,
              source: store.get(b.sourceId)?.displayName ?? "(missing)",
              kind: b.kind,
            })),
            null,
            2,
          );
        },
      ),
    ),
  ];
}
