import * as vscode from "vscode";
import { ContextSourcesStore } from "../context/sourcesStore";
import { ContextService } from "../context/contextService";
import { BookmarksStore } from "../context/bookmarksStore";
import { SchemaStore } from "../context/schemaStore";
import { SchemaIndexer } from "../context/db/schemaIndexer";
import { SourceSchema, renderSchemaForModel, ProbedRelationship, qualifiedName } from "../context/db/schemaIndex";
import {
  renderErForModel,
  parseJoinSpec,
  pairKey,
  classifyJoin,
  initialSampleSize,
  upsertRelationship,
} from "../context/db/erDiagram";
import { ContextSource } from "../context/types";
import { TelemetryService } from "../diagnostics/telemetry";
import { ErrorReportStore } from "../diagnostics/errorReports";
import { redactError } from "../core/redaction";
import { sourceChatLabel, resolveSourceRef } from "../context/sourceRef";

const DB_TYPES = new Set(["mssql", "postgres", "mysql", "mongodb"]);

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
  schemas: SchemaStore,
  indexer: SchemaIndexer,
  telemetry: TelemetryService,
  errors: ErrorReportStore,
  nowIso: () => string,
  scopedSources: () => ContextSource[] = () => store.list(),
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
    const all = scopedSources();
    const source = resolveSourceRef(all, ref);
    if (!source) {
      throw new Error(
        all.length === 0
          ? 'No reference sources configured. The user can add Confluence/Jira via "AI SharePoint: Add Context Source".'
          : `Could not match "${ref ?? ""}" to a source in the active project scope. Available: ${all
              .map(sourceChatLabel)
              .join("; ")}. Aliases, display names, and types all work as the source argument.`,
      );
    }
    return source;
  };

  const resolveDbOrExplain = (ref?: string): ContextSource => {
    const source = resolveOrExplain(ref);
    if (!DB_TYPES.has(source.type)) {
      throw new Error(
        `"${source.displayName}" is a ${source.type} source — schema catalogs apply to database sources (SQL Server, PostgreSQL, MySQL, MongoDB).`,
      );
    }
    return source;
  };

  /** Catalog on demand: cached on disk; first touch loads it live (stored
   *  credential only — a tool call never prompts). */
  const schemaFor = async (source: ContextSource): Promise<SourceSchema> => {
    const cached = schemas.getSync(source.id);
    if (cached) return cached;
    const catalog = await service.loadSchemaCatalog(source, nowIso());
    const fresh: SourceSchema = { catalog, semanticState: "none" };
    await schemas.set(source.id, fresh);
    return fresh;
  };

  return [
    vscode.lm.registerTool(
      "aisharepoint_db_schema",
      guarded<{ source?: string; topic?: string }>(
        "aisharepoint_db_schema",
        "Reading the database schema",
        async (input) => {
          const source = resolveDbOrExplain(input.source);
          const schema = await schemaFor(source);
          const rendered = renderSchemaForModel(schema, input.topic);
          // Probed JOIN paths (ADR-0030) ride along so multi-table questions
          // get correct joins even though the schema declares no foreign keys.
          const er = schema.er ? `\n${renderErForModel(schema.er).join("\n")}` : "";
          const hint =
            schema.semanticState === "none"
              ? '\n\nNote: this schema has no semantic index yet — column meanings are raw names. Offer to build one with the index_db_schema tool (the user approves in chat; only table/column names are sent to Copilot). With an index, questions like "records owned by X" map to ownership columns automatically.'
              : schema.semantic?.partial
                ? "\n\nNote: the semantic index is partial — re-running index_db_schema can complete it."
                : "";
          return rendered + er + hint;
        },
      ),
    ),
    vscode.lm.registerTool(
      "aisharepoint_vertex_answer",
      guarded<{ source?: string; query: string }>(
        "aisharepoint_vertex_answer",
        "Asking Vertex AI Search",
        async (input) => {
          const source = resolveOrExplain(input.source);
          if (source.type !== "vertexai") {
            throw new Error(
              `"${source.displayName}" is a ${source.type} source — grounded answers need a Vertex AI Search source.`,
            );
          }
          const result = await service.vertexAnswer(source, input.query);
          if (!result.answer) {
            return `Vertex AI Search produced no grounded answer for that query — try the search tool for raw results.`;
          }
          return JSON.stringify(result, null, 2);
        },
      ),
    ),
    // User-defined joins from chat (ADR-0030 amendment): validate against
    // the persisted ER model, probe the live join rate when unknown, and —
    // with the user's confirmation via the tool-approval UI — extend the
    // model. save=true is the only state-changing path and is gated.
    vscode.lm.registerTool<{ source?: string; join: string; save?: boolean }>(
      "aisharepoint_test_join",
      {
        prepareInvocation(options) {
          if (!options.input.save) {
            return { invocationMessage: "Testing a user-defined join" };
          }
          return {
            invocationMessage: "Saving a join to the ER model",
            confirmationMessages: {
              title: "Extend the ER model with this join?",
              message: new vscode.MarkdownString(
                [
                  `Adds \`${options.input.join.slice(0, 160)}\` to the persisted ER model of **${store.resolve(options.input.source)?.displayName ?? options.input.source ?? "the database"}**.`,
                  "",
                  "The join rate is re-probed first (counts only — no row data). The model is used by chat for multi-table JOINs and travels with reference-config exports.",
                ].join("\n"),
              ),
            },
          };
        },
        async invoke(options, token) {
          void token;
          telemetry.record("tool.invoke", { tool: "aisharepoint_test_join" });
          try {
            const input = options.input;
            const source = resolveDbOrExplain(input.source);
            const schema = await schemaFor(source);
            const parsed = parseJoinSpec(input.join, schema);
            if ("issue" in parsed) return text(parsed.issue);
            const key = pairKey(parsed);
            const existing = schema.er?.relationships.find((r) => pairKey(r) === key);
            if (existing && !input.save) {
              return text(
                JSON.stringify(
                  {
                    status: "already-in-er-model",
                    relationship: existing,
                    hint: "This join is already part of the ER diagram — no probe needed.",
                  },
                  null,
                  2,
                ),
              );
            }
            // Probe fresh (adaptive sample from the model's row estimates).
            const endFor = (qualified: string, column: string) => {
              const t = schema.catalog.tables.find(
                (x) => qualifiedName(x).toLowerCase() === qualified.toLowerCase(),
              )!;
              return { ...(t.schema ? { schema: t.schema } : {}), table: t.name, column };
            };
            const sample = initialSampleSize(
              schema.er?.rowEstimates?.[parsed.fromTable.toLowerCase()] ?? 0,
              schema.er?.rowEstimates?.[parsed.toTable.toLowerCase()] ?? 0,
            );
            const forward = await service.probeJoin(
              source,
              endFor(parsed.fromTable, parsed.fromColumn),
              endFor(parsed.toTable, parsed.toColumn),
              sample,
            );
            const backward = await service.probeJoin(
              source,
              endFor(parsed.toTable, parsed.toColumn),
              endFor(parsed.fromTable, parsed.fromColumn),
              sample,
            );
            const graded = classifyJoin(forward, backward);
            const prior = schema.er?.report?.tested.find((t) => pairKey(t) === key);
            const rel: ProbedRelationship = {
              fromTable: parsed.fromTable,
              fromColumn: parsed.fromColumn,
              toTable: parsed.toTable,
              toColumn: parsed.toColumn,
              forwardRate: graded.forwardRate,
              backwardRate: graded.backwardRate,
              sampledForward: forward.sampled,
              sampledBackward: backward.sampled,
              ...(sample === "full" ? { complete: true } : {}),
              // A user-DEFINED join is kept even below the automatic
              // thresholds — the user asserted it; the measured rates stay
              // visible so a data-quality story is still tellable.
              verdict: graded.verdict ?? "defined",
              ...(graded.note ? { note: graded.note } : {}),
              reason: "user-defined join (chat)",
            };
            let saved = false;
            if (input.save) {
              const er = upsertRelationship(schema.er, rel, nowIso());
              await schemas.set(source.id, { ...(schemas.getSync(source.id) ?? schema), er });
              saved = true;
            }
            return text(
              JSON.stringify(
                {
                  status: saved
                    ? "saved-to-er-model"
                    : graded.verdict
                      ? "confirmed-by-probe"
                      : "below-thresholds",
                  join: `${parsed.fromTable}.${parsed.fromColumn} = ${parsed.toTable}.${parsed.toColumn}`,
                  measured: {
                    forwardRate: graded.forwardRate,
                    backwardRate: graded.backwardRate,
                    sample: sample === "full" ? "complete join" : sample,
                  },
                  verdict: rel.verdict,
                  note: rel.note ?? null,
                  typeWarning: parsed.warning ?? null,
                  priorProbe: prior
                    ? { forwardRate: prior.forwardRate, backwardRate: prior.backwardRate, outcome: prior.outcome }
                    : null,
                  hint: saved
                    ? "Persisted — the ER diagram and chat's JOIN paths now include this join."
                    : "To add it to the ER diagram, call this tool again with save=true (the user approves in chat).",
                },
                null,
                2,
              ),
            );
          } catch (err) {
            errors.capture("tool:aisharepoint_test_join", err);
            return text(`The test_join tool failed: ${redactError(err).message}`);
          }
        },
      },
    ),
    // In-chat indexing: VS Code's tool-confirmation UI is the consent gate —
    // the user sees exactly what will be sent (names only) and must approve.
    vscode.lm.registerTool<{ source?: string }>("aisharepoint_index_db_schema", {
      prepareInvocation(options) {
        const source = store.resolve(options.input.source);
        const schema = source ? schemas.getSync(source.id) : undefined;
        const tables = schema?.catalog.tables.length;
        return {
          invocationMessage: "Indexing database schema with Copilot",
          confirmationMessages: {
            title: `Index "${source?.displayName ?? options.input.source ?? "database"}" schema with Copilot?`,
            message: new vscode.MarkdownString(
              [
                `Sends **table and column names only** — no data rows — to your Copilot model${tables !== undefined ? ` (${tables} tables)` : ""}, using your Copilot subscription.`,
                "",
                "The resulting semantic index lets free-form questions find the right columns (e.g. `group_cio` → _owned by …_).",
              ].join("\n"),
            ),
          },
        };
      },
      async invoke(options, token) {
        telemetry.record("tool.invoke", { tool: "aisharepoint_index_db_schema" });
        try {
          if (!SchemaIndexer.enabledByPolicy()) {
            return text(
              "Schema indexing with Copilot is disabled by policy (aiSharePoint.context.allowSchemaIndexing).",
            );
          }
          const source = resolveDbOrExplain(options.input.source);
          const schema = await schemaFor(source);
          const indexed = await indexer.runIndexing(source, schema, undefined, token);
          const n = indexed.semantic?.tables.length ?? 0;
          return text(
            `Schema indexed: ${n} of ${indexed.catalog.tables.length} tables now carry semantic tags${indexed.semantic?.partial ? " (partial — can be re-run to complete)" : ""}. Use the db_schema tool with a topic to find columns, then search with a SELECT.`,
          );
        } catch (err) {
          errors.capture("tool:aisharepoint_index_db_schema", err);
          return text(`Schema indexing failed: ${redactError(err).message}`);
        }
      },
    }),
    vscode.lm.registerTool(
      "aisharepoint_list_sources",
      guarded<Record<string, never>>(
        "aisharepoint_list_sources",
        "Listing reference sources",
        async () => {
          const all = scopedSources();
          if (all.length === 0) {
            return 'No reference sources in the active project scope. The user can add sources via "AI SharePoint: Add Context Source" or switch projects ("Projects: Switch").';
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
          const visibleIds = new Set(scopedSources().map((s) => s.id));
          const all = bookmarks.list().filter((b) => visibleIds.has(b.sourceId));
          if (all.length === 0) return "No bookmarks saved in the active project scope.";
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
