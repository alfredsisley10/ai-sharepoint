import * as vscode from "vscode";
import { ContextSource } from "../types";
import { CopilotService } from "../../copilot/copilotService";
import { AppError } from "../../core/errors";
import { SchemaStore } from "../schemaStore";
import { TelemetryService } from "../../diagnostics/telemetry";
import { Logger } from "../../core/log";
import {
  SourceSchema,
  SemanticTable,
  TableDef,
  TableSample,
  buildIndexPrompt,
  buildContentPrompt,
  parseSemanticResponse,
  mergeSemantic,
  mergeContentIntoSemantic,
  qualifiedName,
  CONTENT_MAX_TABLES,
} from "./schemaIndex";
import {
  takeBatch,
  batchUnits,
  nextColumnBudget,
  shrinkAfterFailure,
  estimateBatchCount,
  describeBudgetChange,
  START_COLUMN_BUDGET,
} from "./indexBatching";

export type TableSampler = (table: TableDef) => Promise<Record<string, string[]>>;

/**
 * Consent-gated Copilot indexing of a database schema (ADR-0024).
 *
 * What leaves the machine: table/column NAMES and TYPES — by construction
 * (prompts are built from the catalog, which never contains row values).
 * Every request goes through CopilotService.ask → request counting (task
 * "schemaIndex"), batched so huge schemas stay bounded.
 */
export class SchemaIndexer {
  constructor(
    private readonly copilot: CopilotService,
    private readonly schemas: SchemaStore,
    private readonly telemetry: TelemetryService,
    private readonly log: Logger,
    private readonly now: () => string,
  ) {}

  /** Copilot requests made by the most recent indexing run — surfaced in
   *  the completion toast (pilot: cost wasn't visible at point of use). */
  lastRunRequests = 0;

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
    const batches = estimateBatchCount(schema.catalog.tables);
    const pick = await vscode.window.showInformationMessage(
      `Index the "${source.displayName}" schema with Copilot? Table and column NAMES only — no data rows — are sent (${tables} tables, ${columns} columns ≈ ${batches} Copilot request${batches === 1 ? "" : "s"}). The semantic index lets free-form questions find the right columns (e.g. group_cio → "owned by …").`,
      { modal: true },
      "Index with Copilot",
      "Not Now",
      "Don't Ask Again for This Source",
    );
    if (pick === "Index with Copilot") return "index";
    if (pick === "Don't Ask Again for This Source") return "declined";
    return "later";
  }

  /**
   * Run the batched indexing and persist the result. Per-batch failures
   * degrade to a PARTIAL index, never data loss.
   *
   * Batches are sized ADAPTIVELY by column budget rather than a fixed 40
   * tables (indexBatching.ts): latency tracks how much JSON the model has to
   * write, so a flat table count produced 460s+ batches on wide schemas. The
   * run starts small for a fast first result and grows the budget whenever the
   * model proves quick — larger batches are cheaper, since each batch is one
   * metered request.
   */
  async runIndexing(
    source: ContextSource,
    schema: SourceSchema,
    progress?: vscode.Progress<{ message?: string; increment?: number }>,
    token?: vscode.CancellationToken,
  ): Promise<SourceSchema> {
    const totalUnits = Math.max(1, batchUnits(schema.catalog.tables));
    const estimated = Math.max(1, estimateBatchCount(schema.catalog.tables));
    let remaining: TableDef[] = schema.catalog.tables;
    let budget = START_COLUMN_BUDGET;
    const results: SemanticTable[][] = [];
    let modelId = "";
    let partial = false;
    let index = 0;
    this.lastRunRequests = 0;
    while (remaining.length > 0) {
      if (token?.isCancellationRequested) {
        partial = true;
        break;
      }
      const { batch, rest } = takeBatch(remaining, budget);
      const units = batchUnits(batch);
      index += 1;
      // Live feedback (pilot): a batch is one long streaming model request —
      // tick elapsed seconds until the first token, then stream-throttled
      // byte counts, then a per-batch completion line with bar movement. The
      // column count is shown because it, not the table count, is what makes a
      // batch slow.
      const batchLabel = `Batch ${index}/~${estimated} (${batch.length} tables, ${units} columns)`;
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
            prompt: buildIndexPrompt(schema.catalog, batch),
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
        this.lastRunRequests += 1;
        const parsed = parseSemanticResponse(res.text, schema.catalog);
        results.push(parsed);
        remaining = rest;
        const elapsed = Date.now() - startedAt;
        const adjusted = nextColumnBudget(budget, units, elapsed);
        const note = describeBudgetChange(budget, adjusted);
        budget = adjusted;
        progress?.report({
          // Progress by COLUMNS completed, not batches — with adaptive sizing
          // the batch count isn't known up front, and columns are the real work.
          increment: (units / totalUnits) * 100,
          message: `${batchLabel} done — ${parsed.length} tables tagged in ${Math.round(elapsed / 1000)}s${note}${rest.length ? `; ${rest.length} table(s) to go` : ""}`,
        });
      } catch (err) {
        clearInterval(ticker);
        if (err instanceof AppError && err.code === "copilot.entitlement") {
          // "Not authorized for this Copilot feature" — every remaining
          // batch would hit the same refusal. Stop the run (pilot).
          partial = true;
          this.log.warn(`Schema indexing stopped at batch ${index}: ${err.message}`);
          break;
        }
        // One bad batch (unparseable JSON, transient model error) shouldn't
        // void the others — keep going, mark partial. A failure is usually an
        // over-long response, so halve the budget before the next batch and
        // RETRY these tables at the smaller size rather than dropping them.
        partial = true;
        const smaller = shrinkAfterFailure(budget);
        // Retry only when a smaller budget could actually produce a SMALLER
        // batch. A single table already over budget can't be split, so retrying
        // it would just re-spend metered requests on the identical prompt.
        const canRetrySmaller = smaller < budget && batch.length > 1;
        this.log.warn(
          `Schema indexing batch ${index} (${batch.length} tables, ${units} columns) failed: ${String(err)}${
            canRetrySmaller ? ` — retrying the remainder at ${smaller} columns/batch` : ""
          }`,
        );
        budget = smaller;
        if (!canRetrySmaller) {
          // Either already at the floor, or a lone table too wide to split —
          // retrying would re-send an identical prompt. Skip it so the run can
          // never loop on the same tables, and let `partial` report the gap.
          remaining = rest;
          progress?.report({ increment: (units / totalUnits) * 100 });
        }
        // Otherwise `remaining` is unchanged: the same tables are retried at
        // the smaller budget, which will take fewer of them per batch.
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
        this.lastRunRequests = 0;
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
        // Phase 2: Copilot description, batched + streamed like the schema pass
        // — and sized the same adaptive way. A content batch's cost also tracks
        // the number of COLUMNS being described, not the table count, so the
        // sampled column names are the work unit here.
        const withUnits = samples.map((sample) => ({
          sample,
          columns: Object.keys(sample.values),
        }));
        const totalUnits = Math.max(1, batchUnits(withUnits));
        const estimated = Math.max(1, estimateBatchCount(withUnits));
        let remaining = withUnits;
        let budget = START_COLUMN_BUDGET;
        const results: SemanticTable[][] = [];
        let partial = tables.length < schema.catalog.tables.length;
        let i = 0;
        while (remaining.length > 0) {
          if (token.isCancellationRequested) {
            partial = true;
            break;
          }
          const { batch: taken, rest } = takeBatch(remaining, budget);
          const batchSamples: TableSample[] = taken.map((x) => x.sample);
          const units = batchUnits(taken);
          i += 1;
          const label = `Describing batch ${i}/~${estimated} (${batchSamples.length} tables, ${units} columns)`;
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
                prompt: buildContentPrompt(schema.catalog, batchSamples),
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
            this.lastRunRequests += 1;
            results.push(parseSemanticResponse(res.text, schema.catalog));
            remaining = rest;
            const elapsed = Date.now() - startedAt;
            const adjusted = nextColumnBudget(budget, units, elapsed);
            const note = describeBudgetChange(budget, adjusted);
            budget = adjusted;
            // 60% of the bar belongs to this phase (sampling took the first 40).
            progress.report({
              increment: (units / totalUnits) * 60,
              message: `${label} done (${Math.round(elapsed / 1000)}s)${note}`,
            });
          } catch (err) {
            clearInterval(ticker);
            partial = true;
            if (err instanceof AppError && err.code === "copilot.entitlement") {
              this.log.warn(`Content indexing stopped at batch ${i}: ${err.message}`);
              break;
            }
            // Usually an over-long response — halve and retry these tables
            // smaller; at the floor, skip them so the run can't loop forever.
            const smaller = shrinkAfterFailure(budget);
            const canRetrySmaller = smaller < budget && batchSamples.length > 1;
            this.log.warn(
              `Content batch ${i} (${batchSamples.length} tables, ${units} columns) failed: ${String(err)}${
                canRetrySmaller ? ` — retrying the remainder at ${smaller} columns/batch` : ""
              }`,
            );
            budget = smaller;
            if (!canRetrySmaller) {
              // Floor reached, or a lone table too wide to split — skip it
              // rather than re-sending an identical prompt.
              remaining = rest;
              progress.report({ increment: (units / totalUnits) * 60 });
            }
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
      `Content types indexed for "${source.displayName}" — only Copilot's descriptive summaries were stored (no database content persists). ${this.lastRunRequests} Copilot request(s) used (Copilot Activity view → By task → contentIndex).`,
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
      (indexed.semantic?.partial
        ? `Schema index for "${source.displayName}" is partial (${n} tables) — re-run "Index Database Schema" to complete it.`
        : `Schema indexed: ${n} tables of "${source.displayName}" now answer free-form questions.`) +
        ` ${this.lastRunRequests} Copilot request(s) used (Copilot Activity view → By task → schemaIndex).`,
    );
    return indexed;
  }
}
