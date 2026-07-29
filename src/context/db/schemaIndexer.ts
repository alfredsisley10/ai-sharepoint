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
  isTransientLlmError,
  isTransportReset,
  retryDelayMs,
  describeRetry,
  errorText,
  MAX_TRANSIENT_RETRIES,
  PROXY_GUIDANCE,
} from "./llmRetry";
import {
  takeBatch,
  batchUnits,
  nextColumnBudget,
  shrinkAfterFailure,
  estimateBatchCount,
  describeBudgetChange,
  planResume,
  START_COLUMN_BUDGET,
} from "./indexBatching";

export type TableSampler = (table: TableDef) => Promise<Record<string, string[]>>;

/** Wait `ms`, returning early if the run is cancelled — so a backoff can never
 *  hold a cancelled indexing run open. */
function sleep(ms: number, token?: vscode.CancellationToken): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      sub?.dispose();
      resolve();
    }, ms);
    const sub = token?.onCancellationRequested(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

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
    /** Reported when a batch fails with a TRANSPORT RESET (a proxy cutting the
     *  streaming reply), so the extension can offer the Copilot-transport
     *  remedy once a pattern emerges rather than on the first blip. */
    private readonly onTransportReset?: () => void,
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
   *
   * The run is also RECOVERABLE, which matters on corporate networks where an
   * SSL-inspecting proxy resets long streaming replies
   * (`net::ERR_HTTP2_PROTOCOL_ERROR`):
   *  - a transient transport failure retries the same request after a short
   *    backoff before the batch is treated as too big (llmRetry.ts);
   *  - the index is CHECKPOINTED after every batch, so a reset, crash, or
   *    closed window never discards completed work; and
   *  - re-running RESUMES — tables already indexed are skipped, so recovery
   *    costs only the tables that never made it.
   */
  async runIndexing(
    source: ContextSource,
    schema: SourceSchema,
    progress?: vscode.Progress<{ message?: string; increment?: number }>,
    token?: vscode.CancellationToken,
  ): Promise<SourceSchema> {
    // RESUME: a previous run that a proxy reset (or the user) cut short leaves a
    // PARTIAL index. Re-running must not redo tables already paid for, so those
    // are carried forward and skipped — re-running is the documented recovery.
    const carried: SemanticTable[] = schema.semantic?.partial ? (schema.semantic.tables ?? []) : [];
    const { todo, skipped } = planResume(
      schema.catalog.tables,
      (t) => qualifiedName(t),
      carried.map((t) => t.table),
    );
    if (skipped > 0) {
      progress?.report({
        message: `Resuming — ${skipped} table(s) already indexed, ${todo.length} to go`,
      });
      this.log.info(`Schema indexing resumed for "${source.displayName}": skipping ${skipped} already-indexed table(s).`);
    }
    const totalUnits = Math.max(1, batchUnits(todo));
    const estimated = Math.max(1, estimateBatchCount(todo));
    let remaining: TableDef[] = todo;
    let budget = START_COLUMN_BUDGET;
    const results: SemanticTable[][] = carried.length ? [carried] : [];
    let modelId = schema.semantic?.modelId ?? "";
    let partial = false;
    let index = 0;
    /** Retries used on the batch currently in flight; reset when we move on. */
    let attempt = 0;
    this.lastRunRequests = 0;
    /**
     * Persist what is indexed SO FAR. Called after every batch, so a proxy
     * reset, a crash, or a closed window can never throw away completed work —
     * the next run resumes from here instead of restarting.
     */
    const checkpoint = async (stillPartial: boolean): Promise<SourceSchema> => {
      const merged = mergeSemantic(results);
      const snapshot: SourceSchema = {
        ...schema,
        catalog: schema.catalog,
        semantic: {
          indexedAt: this.now(),
          modelId,
          tables: merged,
          ...(stillPartial ? { partial: true } : {}),
        },
        semanticState: merged.length > 0 ? "indexed" : schema.semanticState,
      };
      await this.schemas.set(source.id, snapshot);
      return snapshot;
    };
    while (remaining.length > 0) {
      if (token?.isCancellationRequested) {
        partial = true;
        break;
      }
      const { batch, rest } = takeBatch(remaining, budget);
      const units = batchUnits(batch);
      if (attempt === 0) index += 1; // a retry is the SAME batch, not the next one
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
        attempt = 0;
        const elapsed = Date.now() - startedAt;
        const adjusted = nextColumnBudget(budget, units, elapsed);
        const note = describeBudgetChange(budget, adjusted);
        budget = adjusted;
        // CHECKPOINT: persist everything indexed so far. A proxy reset, crash,
        // or closed window after this point costs nothing already paid for.
        await checkpoint(remaining.length > 0 || partial);
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
        // A TRANSIENT transport failure — the corporate-proxy HTTP/2 reset that
        // kills long streaming replies — is not a sizing problem: the identical
        // request usually succeeds on the next try. Retry it unchanged, with a
        // short backoff, before falling back to shrinking.
        if (isTransportReset(err)) this.onTransportReset?.();
        if (isTransientLlmError(err) && attempt < MAX_TRANSIENT_RETRIES && !token?.isCancellationRequested) {
          attempt += 1;
          const delay = retryDelayMs(attempt);
          const note = describeRetry(err, attempt, MAX_TRANSIENT_RETRIES, delay);
          this.log.warn(`Schema indexing batch ${index}: ${note} — ${errorText(err)}`);
          paint(`${batchLabel} — ${note}`);
          await sleep(delay, token);
          continue; // `remaining` untouched: the same batch goes again
        }
        // Out of retries, or not transient at all.
        partial = true;
        if (isTransientLlmError(err)) {
          this.log.warn(`Schema indexing batch ${index} gave up after ${attempt} retries: ${errorText(err)}. ${PROXY_GUIDANCE}`);
        }
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
          attempt = 0;
          progress?.report({ increment: (units / totalUnits) * 100 });
        }
        // Otherwise `remaining` is unchanged: the same tables are retried at
        // the smaller budget, which will take fewer of them per batch.
      }
    }
    // Anything still queued (an entitlement stop, or cancellation) means the
    // index does not cover the whole catalog — record that so a re-run resumes.
    if (remaining.length > 0) partial = true;
    const indexed = await checkpoint(partial);
    const tables = indexed.semantic?.tables ?? [];
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
        let cAttempt = 0;
        while (remaining.length > 0) {
          if (token.isCancellationRequested) {
            partial = true;
            break;
          }
          const { batch: taken, rest } = takeBatch(remaining, budget);
          const batchSamples: TableSample[] = taken.map((x) => x.sample);
          const units = batchUnits(taken);
          if (cAttempt === 0) i += 1; // a retry is the SAME batch
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
            cAttempt = 0;
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
            if (err instanceof AppError && err.code === "copilot.entitlement") {
              partial = true;
              this.log.warn(`Content indexing stopped at batch ${i}: ${err.message}`);
              break;
            }
            // Same corporate-proxy reset case as the schema pass: retry the
            // identical request before treating it as a sizing problem.
            if (isTransportReset(err)) this.onTransportReset?.();
            if (isTransientLlmError(err) && cAttempt < MAX_TRANSIENT_RETRIES && !token.isCancellationRequested) {
              cAttempt += 1;
              const delay = retryDelayMs(cAttempt);
              const retryNote = describeRetry(err, cAttempt, MAX_TRANSIENT_RETRIES, delay);
              this.log.warn(`Content batch ${i}: ${retryNote} — ${errorText(err)}`);
              progress.report({ message: `${label} — ${retryNote}` });
              await sleep(delay, token);
              continue;
            }
            partial = true;
            if (isTransientLlmError(err)) {
              this.log.warn(`Content batch ${i} gave up after ${cAttempt} retries: ${errorText(err)}. ${PROXY_GUIDANCE}`);
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
              cAttempt = 0;
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
