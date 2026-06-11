import * as vscode from "vscode";
import { ContextSourcesStore } from "../context/sourcesStore";
import { ContextService } from "../context/contextService";
import { BookmarksStore } from "../context/bookmarksStore";
import { TelemetryService } from "../diagnostics/telemetry";
import { ErrorReportStore } from "../diagnostics/errorReports";
import { redactError } from "../core/redaction";
import { sourceChatLabel } from "../context/sourceRef";

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
              .map(sourceChatLabel)
              .join("; ")}. Aliases, display names, and types all work as the source argument.`,
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
              ...(s.alias ? { alias: s.alias } : {}),
              ...(s.description ? { description: s.description } : {}),
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
    // Agent-proposed bookmarks: persistence is gated by VS Code's tool
    // confirmation UI — the user sees name/locator/source and must approve
    // in chat before anything is saved (human-in-the-loop by construction).
    vscode.lm.registerTool<{
      source?: string;
      name: string;
      locator: string;
      kind?: "query" | "item";
      reason?: string;
    }>("aisharepoint_suggest_bookmark", {
      prepareInvocation(options) {
        const sourceName =
          store.resolve(options.input.source)?.displayName ?? options.input.source ?? "?";
        return {
          invocationMessage: "Proposing a bookmark",
          confirmationMessages: {
            title: `Save bookmark "${options.input.name}"?`,
            message: new vscode.MarkdownString(
              [
                `**Source:** ${sourceName}`,
                `**Kind:** ${options.input.kind ?? "query"}`,
                `**Locator:**`,
                "```",
                options.input.locator,
                "```",
                ...(options.input.reason ? [`_${options.input.reason}_`] : []),
                "",
                "Saved bookmarks appear in the Reference Sources view and run by name.",
              ].join("\n"),
            ),
          },
        };
      },
      async invoke(options) {
        telemetry.record("tool.invoke", { tool: "aisharepoint_suggest_bookmark" });
        try {
          const input = options.input;
          const source = resolveOrExplain(input.source);
          if (!input.name?.trim() || !input.locator?.trim()) {
            return text("A bookmark needs both a name and a locator (query or item id).");
          }
          await bookmarks.add({
            id: crypto.randomUUID(),
            sourceId: source.id,
            name: input.name.trim().slice(0, 80),
            locator: input.locator.trim(),
            kind: input.kind === "item" ? "item" : "query",
          });
          telemetry.record("bookmark.add", { type: source.type, via: "agent" });
          return text(
            `Bookmark "${input.name.trim()}" saved under ${source.displayName}. It can now be run by name with the run-bookmark tool or from the Reference Sources view.`,
          );
        } catch (err) {
          errors.capture("tool:aisharepoint_suggest_bookmark", err);
          return text(`Could not save the bookmark: ${redactError(err).message}`);
        }
      },
    }),
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
