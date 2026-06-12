import * as vscode from "vscode";
import { ContextSource } from "../types";
import { CopilotService } from "../../copilot/copilotService";
import { BudgetBlockedError } from "../../copilot/budget";
import { SchemaStore } from "../schemaStore";
import { TelemetryService } from "../../diagnostics/telemetry";
import { Logger } from "../../core/log";
import {
  SourceSchema,
  SemanticTable,
  TableDef,
  TableSample,
  chunkTables,
  buildIndexPrompt,
  buildContentPrompt,
  parseSemanticResponse,
  mergeSemantic,
  mergeContentIntoSemantic,
  qualifiedName,
  CONTENT_TABLES_PER_BATCH,
  CONTENT_MAX_TABLES,
} from "./schemaIndex";

export type TableSampler = (table: TableDef) => Promise<Record<string, string[]>>;

/**
 * Consent-gated Copilot indexing of a database schema (ADR-0024).
 *
 * What leaves the machine: table/column NAMES and TYPES — by construction
 * (prompts are built from the catalog, which never contains row values).
 * Every request goes through CopilotService.ask → budget guardrails +
 * metering (task "schemaIndex"), batched so huge schemas stay bounded.
 */
export class SchemaIndexer {
  constructor(
    private readonly copilot: CopilotService,
    private readonly schemas: SchemaStore,
    private readonly telemetry: TelemetryService,
    private readonly log: Logger,
    private readonly now: () => string,
  ) {}

  static enabledByPolicy(): boolean {
    return vscode.workspace
      .getConfiguration("aiSharePoint")
      .get<boolean>("context.allowSchemaIndexing", true);
  }

  /** The first-use question. Returns "index" | "later" | "declined". */
  async askConsent(
    source: ContextSource,
    schema: SourceSchema,
  ): Promise<"index" | "later" | "declined"> {
    const tables = schema.catalog.tables.length;
    const columns = schema.catalog.tables.reduce((n, t) => n + t.columns.length, 0);
    const batches = chunkTables(schema.catalog.tables).length;
    const pick = await vscode.window.showInformationMessage(
      `Index the "${source.displayName}" schema with Copilot? Table and column NAMES only — no data rows — are sent (${tables} tables, ${columns} columns ≈ ${batches} metered request${batches === 1 ? "" : "s"}). The semantic index lets free-form questions find the right columns (e.g. group_cio → "owned by …").`,
      { modal: true },
      "Index with Copilot",
      "Not Now",
      "Don't Ask Again for This Source",
    );
    if (pick === "Index with Copilot") return "index";
    if (pick === "Don't Ask Again for This Source") return "declined";
    return "later";
  }

  /** Run the batched indexing and persist the result. Budget hard-caps and
   *  per-batch parse failures degrade to a PARTIAL index, never data loss. */
  async runIndexing(
    source: ContextSource,
    schema: SourceSchema,
    progress?: vscode.Progress<{ message?: string; increment?: number }>,
    token?: vscode.CancellationToken,
  ): Promise<SourceSchema> {
    const batches = chunkTables(schema.catalog.tables);
    const results: SemanticTable[][] = [];
    let modelId = "";
    let partial = false;
    for (let i = 0; i < batches.length; i++) {
      if (token?.isCancellationRequested) {
        partial = true;
        break;
      }
      // Live feedback (pilot): a batch is one long streaming model request —
      // tick elapsed seconds until the first token, then stream-throttled
      // byte counts, then a per-batch completion line with bar movement.
      const batchLabel = `Batch ${i + 1}/${batches.length} (${batches[i].length} tables)`;
      const startedAt = Date.now();
      let received = 0;
      let lastPaint = 0;
      const paint = (msg: string) => progress?.report({ message: msg });
      paint(`${batchLabel} — sending to Copilot…`);
      const ticker = setInterval(() => {
        if (received === 0) {
          paint(`${batchLabel} — waiting for the model… ${Math.round((Date.now() - startedAt) / 1000)}s`);
        }
      }, 1000);
      try {
        const res = await this.copilot.ask(
          {
            prompt: buildIndexPrompt(schema.catalog, batches[i]),
            label: "schemaIndex",
            token,
            onChunk: (text) => {
              received += text.length;
              if (Date.now() - lastPaint > 400) {
                lastPaint = Date.now();
                paint(
                  `${batchLabel} — model is writing… ${(received / 1024).toFixed(1)} KB, ${Math.round((Date.now() - startedAt) / 1000)}s`,
                );
              }
            },
          },
          this.now,
        );
        clearInterval(ticker);
        modelId = res.modelId;
        const parsed = parseSemanticResponse(res.text, schema.catalog);
        results.push(parsed);
        progress?.report({
          increment: 100 / batches.length,
          message: `${batchLabel} done — ${parsed.length} tables tagged in ${Math.round((Date.now() - startedAt) / 1000)}s${i + 1 < batches.length ? `; starting batch ${i + 2}/${batches.length}` : ""}`,
        });
      } catch (err) {
        clearInterval(ticker);
        if (err instanceof BudgetBlockedError) {
          partial = true;
          this.log.warn(
            `Schema indexing stopped at batch ${i + 1}/${batches.length}: Copilot budget cap.`,
          );
          break;
        }
        // One bad batch (unparseable JSON, transient model error) shouldn't
        // void the others — keep going, mark partial.
        partial = true;
        this.log.warn(`Schema indexing batch ${i + 1}/${batches.length} failed: ${String(err)}`);
      }
    }
    const tables = mergeSemantic(results);
    const indexed: SourceSchema = {
      catalog: schema.catalog,
      semantic: {
        indexedAt: this.now(),
        modelId,
        tables,
        ...(partial ? { partial: true } : {}),
      },
      semanticState: tables.length > 0 ? "indexed" : schema.semanticState,
    };
    await this.schemas.set(source.id, indexed);
    this.telemetry.record("schema.index", {
      type: source.type,
      tables: String(schema.catalog.tables.length),
      indexed: String(tables.length),
      partial: String(partial),
    });
    return indexed;
  }

  /** "Index Database Content Types": sample top distinct values per column
   *  (one bounded query per table), then have Copilot describe the VALUES.
   *  Consent is explicit that real data samples leave for Copilot. */
  async indexContentInteractively(
    source: ContextSource,
    schema: SourceSchema,
    sampler: TableSampler,
  ): Promise<SourceSchema> {
    if (!SchemaIndexer.enabledByPolicy()) {
      void vscode.window.showWarningMessage(
        "Indexing with Copilot is disabled by policy (aiSharePoint.context.allowSchemaIndexing).",
      );
      return schema;
    }
    const tables = schema.catalog.tables.slice(0, CONTENT_MAX_TABLES);
    const pick = await vscode.window.showWarningMessage(
      `Index "${source.displayName}" content types with Copilot? Unlike schema indexing, this sends SAMPLED DATA VALUES — the top distinct values per column (truncated), from a bounded row sample of ${tables.length} table(s) — to your Copilot model so it can describe what each column contains. NOTHING from the database is persisted: the samples exist only for the request, and only Copilot's descriptive summaries (e.g. "ISO country codes") are stored to aid search. Don't proceed if these tables hold regulated data.`,
      { modal: true },
      "Sample & Index Content",
      "Don't Ask Again for This Source",
    );
    if (pick === "Don't Ask Again for This Source") {
      const declined: SourceSchema = { ...schema, contentState: "declined" };
      await this.schemas.set(source.id, declined);
      return declined;
    }
    if (pick !== "Sample & Index Content") return schema;

    const indexed = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Indexing "${source.displayName}" content types…`,
        cancellable: true,
      },
      async (progress, token) => {
        // Phase 1: sampling — one query per table, live per-table feedback.
        const samples: TableSample[] = [];
        for (let i = 0; i < tables.length; i++) {
          if (token.isCancellationRequested) break;
          const name = qualifiedName(tables[i]);
          progress.report({
            increment: 40 / tables.length,
            message: `Sampling ${name} (${i + 1}/${tables.length})…`,
          });
          try {
            const values = await sampler(tables[i]);
            if (Object.keys(values).length > 0) samples.push({ table: name, values });
          } catch (err) {
            this.log.warn(`Content sample for ${name} failed: ${String(err)}`);
          }
        }
        // Phase 2: Copilot description, batched + streamed like schema pass.
        const batches: TableSample[][] = [];
        for (let i = 0; i < samples.length; i += CONTENT_TABLES_PER_BATCH) {
          batches.push(samples.slice(i, i + CONTENT_TABLES_PER_BATCH));
        }
        const results: SemanticTable[][] = [];
        let partial = tables.length < schema.catalog.tables.length;
        for (let i = 0; i < batches.length; i++) {
          if (token.isCancellationRequested) {
            partial = true;
            break;
          }
          const label = `Describing batch ${i + 1}/${batches.length}`;
          const startedAt = Date.now();
          let received = 0;
          let lastPaint = 0;
          const ticker = setInterval(() => {
            if (received === 0) {
              progress.report({ message: `${label} — waiting for the model… ${Math.round((Date.now() - startedAt) / 1000)}s` });
            }
          }, 1000);
          try {
            const res = await this.copilot.ask(
              {
                prompt: buildContentPrompt(schema.catalog, batches[i]),
                label: "contentIndex",
                token,
                onChunk: (t) => {
                  received += t.length;
                  if (Date.now() - lastPaint > 400) {
                    lastPaint = Date.now();
                    progress.report({ message: `${label} — model is writing… ${(received / 1024).toFixed(1)} KB` });
                  }
                },
              },
              this.now,
            );
            clearInterval(ticker);
            results.push(parseSemanticResponse(res.text, schema.catalog));
            progress.report({ increment: 60 / batches.length, message: `${label} done (${Math.round((Date.now() - startedAt) / 1000)}s)` });
          } catch (err) {
            clearInterval(ticker);
            partial = true;
            if (err instanceof BudgetBlockedError) break;
            this.log.warn(`Content batch ${i + 1} failed: ${String(err)}`);
          }
        }
        const merged = mergeContentIntoSemantic(
          schema.semantic?.tables ?? [],
          results.flat(),
        );
        const next: SourceSchema = {
          catalog: schema.catalog,
          semantic: {
            indexedAt: schema.semantic?.indexedAt ?? this.now(),
            modelId: schema.semantic?.modelId ?? "",
            tables: merged,
            ...(partial ? { partial: true } : {}),
            contentIndexedAt: this.now(),
          },
          semanticState: merged.length > 0 ? "indexed" : schema.semanticState,
          contentState: "indexed",
        };
        await this.schemas.set(source.id, next);
        this.telemetry.record("schema.contentIndex", {
          type: source.type,
          tables: String(samples.length),
          partial: String(partial),
        });
        return next;
      },
    );
    void vscode.window.showInformationMessage(
      `Content types indexed for "${source.displayName}" — only Copilot's descriptive summaries were stored (no database content persists); they now feed search. View them via "View Database Schema & Semantic Index".`,
    );
    return indexed;
  }

  /** First-use flow: consent → run with progress → outcome toast. */
  async indexInteractively(source: ContextSource, schema: SourceSchema): Promise<SourceSchema> {
    if (!SchemaIndexer.enabledByPolicy()) {
      void vscode.window.showWarningMessage(
        "Schema indexing with Copilot is disabled by policy (aiSharePoint.context.allowSchemaIndexing).",
      );
      return schema;
    }
    const consent = await this.askConsent(source, schema);
    if (consent === "declined") {
      const declined: SourceSchema = { ...schema, semanticState: "declined" };
      await this.schemas.set(source.id, declined);
      return declined;
    }
    if (consent === "later") return schema;
    const indexed = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Indexing "${source.displayName}" schema…`,
        cancellable: true,
      },
      (progress, token) => this.runIndexing(source, schema, progress, token),
    );
    const n = indexed.semantic?.tables.length ?? 0;
    void vscode.window.showInformationMessage(
      indexed.semantic?.partial
        ? `Schema index for "${source.displayName}" is partial (${n} tables) — re-run "Index Database Schema with Copilot" to complete it.`
        : `Schema indexed: ${n} tables of "${source.displayName}" now answer free-form questions (try: @sharepoint what's owned by …).`,
    );
    return indexed;
  }
}
