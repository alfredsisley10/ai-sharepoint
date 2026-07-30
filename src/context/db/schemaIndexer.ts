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
  CONTENT_DISTINCT_PER_COLUMN,
  CONTENT_VALUE_MAX_CHARS,
  TableValueSample,
} from "./schemaIndex";
import { WIRE_DETAIL_CAP } from "../../core/wireLog";
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
  planIndexWork,
  tableFingerprint,
  summarizeIndexState,
  describeIndexChoices,
  START_COLUMN_BUDGET,
  TARGET_BATCH_MS,
} from "./indexBatching";
import {
  ConcurrencyGovernor,
  runWithConcurrency,
  describeLimitChange,
  LimitChange,
  resolveConcurrency,
  DEFAULT_MODEL_CONCURRENCY,
  MAX_MODEL_CONCURRENCY,
  DEFAULT_QUERY_CONCURRENCY,
  MAX_QUERY_CONCURRENCY,
} from "./concurrency";

/**
 * How a run treats what is already indexed.
 *
 * "resume" finishes what is missing or changed and keeps everything else —
 * the right default, and the recovery path for an interrupted run.
 * "restart" throws the index away and rebuilds it, which is the only way to
 * fix an index that is present but wrong.
 */
export type IndexRunMode = "resume" | "restart";

export type TableSampler = (table: TableDef) => Promise<TableValueSample>;

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
    /** Told once when the governor backs the batch concurrency off, so the
     *  extension can explain a run that quietly slowed down. */
    private readonly onConcurrencyReduced?: (message: string) => void,
  ) {}

  /** Ceiling on database queries in flight (content sampling). */
  private queryConcurrency(): number {
    return resolveConcurrency(
      vscode.workspace.getConfiguration("aiSharePoint").get<number>("db.maxConcurrency"),
      DEFAULT_QUERY_CONCURRENCY,
      MAX_QUERY_CONCURRENCY,
    );
  }

  /** Ceiling on Copilot requests in flight. Read per run, so changing the
   *  setting takes effect on the next run without a reload. */
  private modelConcurrency(): number {
    return resolveConcurrency(
      vscode.workspace.getConfiguration("aiSharePoint").get<number>("db.maxModelConcurrency"),
      DEFAULT_MODEL_CONCURRENCY,
      MAX_MODEL_CONCURRENCY,
    );
  }

  /** Copilot requests made by the most recent indexing run — surfaced in
   *  the completion toast (pilot: cost wasn't visible at point of use). */
  lastRunRequests = 0;

  static enabledByPolicy(): boolean {
    return vscode.workspace
      .getConfiguration("aiSharePoint")
      .get<boolean>("context.allowSchemaIndexing", true);
  }

  /**
   * Resume, or start over?
   *
   * Only asked when there IS an index to resume — a first run has no choice to
   * make and shouldn't be interrupted by a dialog pretending otherwise.
   *
   * The distinction is the whole point of asking. Re-running has always
   * resumed, which is right when a proxy cut a run short, but resume can only
   * skip what it can DETECT as done: an index built by an older prompt, or one
   * a model filled with nonsense, looks complete and is silently kept forever.
   * Returns undefined when the user backs out.
   */
  async chooseRunMode(
    source: ContextSource,
    schema: SourceSchema,
    opts: { requireContent?: boolean } = {},
  ): Promise<IndexRunMode | undefined> {
    const state = summarizeIndexState(schema.catalog.tables, schema.semantic?.tables ?? [], {
      requireContent: opts.requireContent,
      partial: schema.semantic?.partial,
    });
    if (!state.hasIndex) return "resume"; // nothing to resume; nothing to ask
    const choices = describeIndexChoices(state);
    const items: Array<vscode.QuickPickItem & { mode: IndexRunMode }> = [];
    if (choices.resume.enabled) {
      items.push({
        label: `$(debug-continue) ${choices.resume.label}`,
        detail: choices.resume.detail,
        mode: "resume",
      });
    }
    items.push({
      label: `$(debug-restart) ${choices.restart.label}`,
      detail: choices.restart.detail,
      mode: "restart",
    });
    const pick = await vscode.window.showQuickPick(items, {
      title: `Index "${source.displayName}" — ${choices.headline}`,
      placeHolder: choices.resume.enabled
        ? "Continue where the last run stopped, or discard it and start over"
        : "Everything is indexed — the only thing left to do is start over",
      ignoreFocusOut: true,
    });
    if (!pick) return undefined;
    if (pick.mode === "restart") {
      // Modal, because it spends money and destroys work: the resume path is
      // recoverable by re-running, this one is not.
      const confirm = await vscode.window.showWarningMessage(
        `Discard the existing index for "${source.displayName}" and re-index all ${state.total} table(s)? The ${state.done + state.changed} description(s) already generated will be lost, and the whole catalog will be sent to Copilot again.`,
        { modal: true },
        "Re-index Everything",
      );
      if (confirm !== "Re-index Everything") return undefined;
    }
    return pick.mode;
  }

  /** The first-use question. Returns "index" | "later" | "declined". */
  async askConsent(
    source: ContextSource,
    schema: SourceSchema,
    mode: IndexRunMode = "resume",
  ): Promise<"index" | "later" | "declined"> {
    // Quote the cost of THIS run, not of the catalog: after a resume the
    // difference is most of the bill, and a number that ignores it is the kind
    // of accurate-but-useless figure people learn to stop reading.
    const work = planIndexWork(schema.catalog.tables, schema.semantic?.tables ?? [], {
      force: mode === "restart",
    }).todo;
    const tables = work.length;
    const columns = work.reduce((n, t) => n + t.columns.length, 0);
    const batches = estimateBatchCount(work);
    const scope =
      mode === "restart"
        ? `ALL ${tables} table(s) — existing descriptions are discarded`
        : `${tables} table(s) still to index`;
    const pick = await vscode.window.showInformationMessage(
      `Index the "${source.displayName}" schema with Copilot? Table and column NAMES and TYPES only — no data rows — are sent (${scope}, ${columns} columns ≈ ${batches} Copilot request${batches === 1 ? "" : "s"}). The semantic index lets free-form questions find the right columns (e.g. group_cio → "owned by …").`,
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
    mode: IndexRunMode = "resume",
  ): Promise<SourceSchema> {
    // RESUME: a previous run that a proxy reset (or the user) cut short leaves a
    // PARTIAL index. Re-running must not redo tables already paid for, so those
    // are carried forward and skipped — re-running is the documented recovery.
    // Carry the WHOLE stored index, not just a partial one: a table can need
    // reprocessing even when the last run finished, because its SCHEMA changed.
    //
    // RESTART discards all of that and re-indexes the catalog. Both are
    // legitimate; which one is running is the user's explicit choice, never
    // inferred.
    const stored: SemanticTable[] = schema.semantic?.tables ?? [];
    const carriedAll: SemanticTable[] = mode === "restart" ? [] : stored;
    const plan = planIndexWork(schema.catalog.tables, stored, { force: mode === "restart" });
    const { todo, skipped } = plan;
    if (mode === "restart") {
      this.log.info(
        `Schema indexing for "${source.displayName}": RESTART — discarding ${stored.length} existing description(s) and re-indexing all ${todo.length} table(s).`,
      );
    }
    // Entries whose table no longer exists are dropped rather than described
    // forever; without this the index accumulates ghosts across every resume.
    const carried = plan.orphaned.length
      ? carriedAll.filter((t) => !plan.orphaned.some((o) => o.toLowerCase() === t.table.toLowerCase()))
      : carriedAll;
    if (plan.orphaned.length) {
      this.log.info(`Schema indexing: dropped ${plan.orphaned.length} index entr(ies) for table(s) no longer in the catalog (${plan.orphaned.slice(0, 5).join(", ")}).`);
    }
    if (skipped > 0 || plan.changed > 0) {
      const changedNote = plan.changed
        ? `, ${plan.changed} changed and queued for reprocessing`
        : "";
      progress?.report({
        message: `${skipped} table(s) already indexed${changedNote} — ${todo.length} to process`,
      });
      this.log.info(
        `Schema indexing for "${source.displayName}": skipping ${skipped} unchanged table(s)${
          plan.changed ? `; SCHEMA CHANGED for ${plan.changedNames.slice(0, 10).join(", ")} — reprocessing` : ""
        }.`,
      );
    }
    const totalUnits = Math.max(1, batchUnits(todo));
    const estimated = Math.max(1, estimateBatchCount(todo));
    let remaining: TableDef[] = todo;
    let budget = START_COLUMN_BUDGET;
    const results: SemanticTable[][] = carried.length ? [carried] : [];
    let modelId = schema.semantic?.modelId ?? "";
    let partial = false;
    let index = 0;
    this.lastRunRequests = 0;
    // Batches run several at a time under a user-set ceiling. The governor
    // moves the running value down when the model or the proxy in front of it
    // starts refusing the load, and back up as requests succeed.
    const governor = new ConcurrencyGovernor(this.modelConcurrency(), "Copilot indexing");
    let inFlight = 0;
    const inFlightNote = (): string =>
      inFlight > 1 ? ` · ${inFlight} batches in flight` : "";
    const noteLimit = (change: LimitChange | undefined): void => {
      if (!change) return;
      const text = describeLimitChange(change, "Copilot indexing");
      this.log.info(`Schema indexing: ${text}`);
      if (change.direction === "down") this.onConcurrencyReduced?.(text);
    };
    /**
     * Persist what is indexed SO FAR. Called after every batch, so a proxy
     * reset, a crash, or a closed window can never throw away completed work —
     * the next run resumes from here instead of restarting.
     */
    /** Live fingerprint per qualified name, stamped onto whatever the model
     *  returns so the NEXT run can detect a schema change. */
     const fingerprints = new Map(
      schema.catalog.tables.map((t) => [qualifiedName(t).toLowerCase(), tableFingerprint(t)]),
    );
    const checkpoint = async (stillPartial: boolean): Promise<SourceSchema> => {
      const merged = mergeSemantic(results).map((t) => ({
        ...t,
        ...(fingerprints.get(t.table.toLowerCase())
          ? { fingerprint: fingerprints.get(t.table.toLowerCase()) }
          : {}),
      }));
      const snapshot: SourceSchema = {
        ...schema,
        catalog: schema.catalog,
        semantic: {
          // Preserve everything the content pass wrote (contentIndexedAt) —
          // rebuilding this object from scratch used to discard it.
          ...(schema.semantic ?? {}),
          indexedAt: this.now(),
          modelId,
          tables: merged,
          ...(stillPartial ? { partial: true } : { partial: undefined }),
        },
        semanticState: merged.length > 0 ? "indexed" : schema.semanticState,
      };
      if (!stillPartial) delete snapshot.semantic!.partial;
      await this.schemas.set(source.id, snapshot);
      return snapshot;
    };
    /**
     * One batch, including its own transient retries.
     *
     * Retries live INSIDE this function rather than as a `continue` in the
     * driver, because batches now run several at a time: a `continue` can only
     * re-run "the current batch" when there is exactly one.
     */
    const runBatch = async (
      batch: TableDef[],
      batchNo: number,
    ): Promise<
      | { kind: "ok"; parsed: SemanticTable[]; units: number; modelId: string }
      | { kind: "entitlement"; err: AppError }
      | { kind: "failed"; err: unknown; units: number }
    > => {
      const units = batchUnits(batch);
      const batchLabel = `Batch ${batchNo}/~${estimated} (${batch.length} tables, ${units} columns)`;
      for (let tries = 0; ; ) {
        const startedAt = Date.now();
        let received = 0;
        let lastPaint = 0;
        // Live feedback (pilot): a batch is one long streaming model request —
        // tick elapsed seconds until the first token, then stream-throttled
        // byte counts. The column count is shown because it, not the table
        // count, is what makes a batch slow.
        const paint = (msg: string) => progress?.report({ message: `${msg}${inFlightNote()}` });
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
          this.lastRunRequests += 1;
          const parsed = parseSemanticResponse(res.text, schema.catalog);
          noteLimit(governor.recordSuccess());
          progress?.report({
            // Progress by COLUMNS completed, not batches — with adaptive sizing
            // the batch count isn't known up front, and columns are the real work.
            increment: (units / totalUnits) * 100,
            message: `${batchLabel} done — ${parsed.length} tables tagged in ${Math.round((Date.now() - startedAt) / 1000)}s${inFlightNote()}`,
          });
          return { kind: "ok", parsed, units, modelId: res.modelId };
        } catch (err) {
          clearInterval(ticker);
          if (err instanceof AppError && err.code === "copilot.entitlement") {
            // "Not authorized for this Copilot feature" — every remaining batch
            // would hit the same refusal. The driver stops the run (pilot).
            return { kind: "entitlement", err };
          }
          // A TRANSIENT transport failure — the corporate-proxy HTTP/2 reset
          // that kills long streaming replies — is not a sizing problem: the
          // identical request usually succeeds next try. Retry unchanged with a
          // short backoff before the driver falls back to shrinking.
          if (isTransportReset(err)) this.onTransportReset?.();
          noteLimit(governor.recordFailure(err));
          if (isTransientLlmError(err) && tries < MAX_TRANSIENT_RETRIES && !token?.isCancellationRequested) {
            tries += 1;
            const delay = retryDelayMs(tries);
            const note = describeRetry(err, tries, MAX_TRANSIENT_RETRIES, delay);
            this.log.warn(`Schema indexing batch ${batchNo}: ${note} — ${errorText(err)}`);
            paint(`${batchLabel} — ${note}`);
            await sleep(delay, token);
            continue;
          }
          if (isTransientLlmError(err)) {
            this.log.warn(`Schema indexing batch ${batchNo} gave up after ${tries} retries: ${errorText(err)}. ${PROXY_GUIDANCE}`);
          }
          return { kind: "failed", err, units };
        }
      }
    };

    while (remaining.length > 0) {
      if (token?.isCancellationRequested) {
        partial = true;
        break;
      }
      // A WAVE of batches, sized by the governor. Waves rather than a
      // free-running pool because the wave boundary is where the budget is
      // re-tuned and the index is checkpointed — both of which need a
      // consistent view of what finished.
      const waveSize = Math.max(1, governor.limit);
      const batches: TableDef[][] = [];
      let rest: TableDef[] = remaining;
      while (batches.length < waveSize && rest.length > 0) {
        const taken = takeBatch(rest, budget);
        batches.push(taken.batch);
        rest = taken.rest;
      }
      inFlight = batches.length;
      const firstNo = index + 1;
      index += batches.length;
      const waveStarted = Date.now();
      const outcomes = await runWithConcurrency(
        batches,
        (batch, k) => runBatch(batch, firstNo + k),
        { limit: () => governor.limit, isCancelled: () => token?.isCancellationRequested === true },
      );
      const waveElapsed = Date.now() - waveStarted;
      inFlight = 0;

      // An entitlement refusal answers the same way for every batch — stop.
      if (outcomes.some((o) => o?.kind === "entitlement")) {
        partial = true;
        const e = outcomes.find((o) => o?.kind === "entitlement") as { err: AppError };
        this.log.warn(`Schema indexing stopped: ${e.err.message}`);
        break;
      }

      let okUnits = 0;
      const retryTables: TableDef[] = [];
      let anyFailure = false;
      outcomes.forEach((o, k) => {
        if (o?.kind === "ok") {
          results.push(o.parsed);
          modelId = o.modelId;
          okUnits += o.units;
          return;
        }
        anyFailure = true;
        partial = true;
        const batch = batches[k];
        const smaller = shrinkAfterFailure(budget);
        // Retry only when a smaller budget could actually produce a SMALLER
        // batch. A single table already over budget can't be split, so retrying
        // it would just re-spend metered requests on the identical prompt.
        const canRetrySmaller = smaller < budget && batch.length > 1;
        this.log.warn(
          `Schema indexing batch ${firstNo + k} (${batch.length} tables, ${o?.kind === "failed" ? o.units : 0} columns) failed: ${
            o?.kind === "failed" ? errorText(o.err) : "cancelled"
          }${canRetrySmaller ? ` — retrying the remainder at ${smaller} columns/batch` : ""}`,
        );
        if (canRetrySmaller) retryTables.push(...batch);
        else if (o?.kind === "failed") progress?.report({ increment: (o.units / totalUnits) * 100 });
      });

      if (anyFailure) budget = shrinkAfterFailure(budget);
      else if (okUnits > 0) {
        // Adapt from the WAVE, and scale the target by how many ran together:
        // with N in flight each batch's wall-clock is inflated by contention,
        // so measuring one against the single-batch target would shrink the
        // budget for a run that is in fact keeping up.
        const adjusted = nextColumnBudget(
          budget,
          okUnits,
          waveElapsed,
          TARGET_BATCH_MS * batches.length,
        );
        const note = describeBudgetChange(budget, adjusted);
        if (note) this.log.info(`Schema indexing: ${okUnits} columns in ${Math.round(waveElapsed / 1000)}s${note}`);
        budget = adjusted;
      }

      // Tables that failed but can be split go back to the FRONT, so the run
      // makes progress on them at the smaller budget rather than deferring
      // them behind everything else.
      remaining = [...retryTables, ...rest];
      // CHECKPOINT: persist everything indexed so far. A proxy reset, crash, or
      // closed window after this point costs nothing already paid for.
      await checkpoint(remaining.length > 0 || partial);
    }

    const govSummary = governor.summary();
    if (govSummary) this.log.info(`Schema indexing finished: ${govSummary}.`);
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

  /** "Index Database Content Types": take a bounded row sample per table,
   *  reduce it locally to the first-seen distinct values plus measured
   *  per-column statistics, then have Copilot describe the VALUES.
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
    // Same resume-or-restart question as the schema pass, with the content
    // pass's own notion of "done" (a table can be schema-indexed but never
    // content-described).
    const mode = await this.chooseRunMode(source, schema, { requireContent: true });
    if (!mode) return schema;
    // RESUME, mirroring the schema pass: only tables not yet described, plus
    // any whose SCHEMA CHANGED. Previously every re-run re-sampled (real DB
    // queries) and re-described (metered requests) all 50 tables.
    const contentPlan = planIndexWork(schema.catalog.tables, schema.semantic?.tables ?? [], {
      requireContent: true,
      force: mode === "restart",
    });
    const tables = contentPlan.todo.slice(0, CONTENT_MAX_TABLES);
    if (contentPlan.skipped > 0 || contentPlan.changed > 0) {
      this.log.info(
        `Content indexing for "${source.displayName}": skipping ${contentPlan.skipped} already-described table(s)${
          contentPlan.changed ? `; SCHEMA CHANGED for ${contentPlan.changedNames.slice(0, 10).join(", ")} — reprocessing` : ""
        }.`,
      );
    }
    if (tables.length === 0) {
      void vscode.window.showInformationMessage(
        `Content types are already described for every table in "${source.displayName}" — nothing to do. If the database changed, re-index the schema first so the change is detected.`,
      );
      return schema;
    }
    const pick = await vscode.window.showWarningMessage(
      `Index "${source.displayName}" content types with Copilot? Unlike schema indexing, this sends SAMPLED DATA VALUES — up to ${CONTENT_DISTINCT_PER_COLUMN} distinct values per column (truncated to ${CONTENT_VALUE_MAX_CHARS} chars), from a bounded row sample of ${tables.length} table(s) — to your Copilot model so it can describe what each column contains. Sampled values are NOT stored in the index: they exist only for the request, and only Copilot's descriptive summaries (e.g. "ISO country codes") plus measured statistics (null rate, distinct count) are saved. One exception: if you have turned on "aiSharePoint.logging.verboseWire", the first ${WIRE_DETAIL_CAP.toLocaleString()} characters of each prompt — sampled values included — are written to this extension's local VS Code log. Don't proceed if these tables hold regulated data.`,
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
        // Phase 1: sampling — one independent query per table, so these run
        // several at a time under the DATABASE ceiling (a different resource
        // from the Copilot ceiling that phase 2 answers to).
        const sampleGovernor = new ConcurrencyGovernor(this.queryConcurrency(), "Database");
        let sampled = 0;
        const collected = await runWithConcurrency(
          tables,
          async (table) => {
            const name = qualifiedName(table);
            try {
              const sample = await sampler(table);
              const up = sampleGovernor.recordSuccess();
              if (up) this.log.info(`Content sampling: ${describeLimitChange(up, "Database")}`);
              // Keep the table even when every sampled column was null: the
              // profile still says "always NULL", which is exactly the
              // sparsely-populated signal an analyst wants. Previously an
              // all-null table produced no entry and vanished silently.
              return Object.keys(sample.values).length > 0 || Object.keys(sample.profile).length > 0
                ? { table: name, values: sample.values, profile: sample.profile }
                : undefined;
            } catch (err) {
              this.log.warn(`Content sample for ${name} failed: ${errorText(err)}`);
              const down = sampleGovernor.recordFailure(err);
              if (down) {
                const text = describeLimitChange(down, "Database");
                this.log.info(`Content sampling: ${text}`);
                this.onConcurrencyReduced?.(text);
              }
              return undefined;
            } finally {
              sampled += 1;
              progress.report({
                increment: 40 / tables.length,
                message: `Sampling ${name} (${sampled}/${tables.length}${
                  sampleGovernor.ceiling > 1 ? `, ${sampleGovernor.limit}×` : ""
                })…`,
              });
            }
          },
          { limit: () => sampleGovernor.limit, isCancelled: () => token.isCancellationRequested },
        );
        // Input order is preserved by the pool, so the batches stay in catalog
        // order regardless of which query finished first.
        const samples: TableSample[] = collected.filter((s) => s !== undefined) as TableSample[];
        // Phase 2: Copilot description, batched + streamed like the schema pass
        // — and sized the same adaptive way. A content batch's cost also tracks
        // the number of COLUMNS being described, not the table count, so the
        // sampled column names are the work unit here.
        const withUnits = samples.map((sample) => ({
          sample,
          columns: [...new Set([...Object.keys(sample.values), ...Object.keys(sample.profile ?? {})])],
        }));
        const totalUnits = Math.max(1, batchUnits(withUnits));
        const estimated = Math.max(1, estimateBatchCount(withUnits));
        let remaining = withUnits;
        let budget = START_COLUMN_BUDGET;
        const results: SemanticTable[][] = [];
        // `partial` means WORK REMAINS, not "the catalog was capped": a run that
        // describes everything it set out to is complete even when the catalog
        // exceeds CONTENT_MAX_TABLES. Setting it from the cap used to mislabel a
        // clean run and — via the old destructive write — clear the schema
        // pass's genuine partial flag.
        let partial = contentPlan.todo.length > CONTENT_MAX_TABLES;
        let i = 0;
        let cAttempt = 0;
        const stamp = this.now();
        const contentFingerprints = new Map(
          schema.catalog.tables.map((t) => [qualifiedName(t).toLowerCase(), tableFingerprint(t)]),
        );
        /**
         * Persist the descriptions so far. Called after EVERY batch, so an
         * interruption costs one batch instead of the whole run — and it SPREADS
         * the existing schema so it can never discard the ER model, the schema
         * pass's partial flag, or anything else it doesn't own.
         */
        const contentCheckpoint = async (stillPartial: boolean): Promise<SourceSchema> => {
          const described = results.flat().map((t) => ({
            ...t,
            contentIndexedAt: stamp,
            ...(contentFingerprints.get(t.table.toLowerCase())
              ? { fingerprint: contentFingerprints.get(t.table.toLowerCase()) }
              : {}),
          }));
          const merged = mergeContentIntoSemantic(schema.semantic?.tables ?? [], described);
          const snapshot: SourceSchema = {
            ...schema,
            catalog: schema.catalog,
            semantic: {
              ...(schema.semantic ?? {}),
              indexedAt: schema.semantic?.indexedAt ?? this.now(),
              modelId: schema.semantic?.modelId ?? "",
              tables: merged,
              // Only ever ADD partial here; never clear a schema-pass partial.
              ...(stillPartial || schema.semantic?.partial ? { partial: true } : {}),
              contentIndexedAt: stamp,
            },
            semanticState: merged.length > 0 ? "indexed" : schema.semanticState,
            // Only claim "indexed" once something was actually described — a
            // cancel during sampling used to stamp it with zero work done.
            ...(described.length > 0 ? { contentState: "indexed" as const } : {}),
          };
          await this.schemas.set(source.id, snapshot);
          return snapshot;
        };
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
            // Attach the MEASURED profile to whatever the model returned, so
            // the stored index carries fact (null rate, cardinality, lengths)
            // alongside the model's prose rather than only the prose.
            const profiles = new Map(batchSamples.map((b) => [b.table.toLowerCase(), b.profile ?? {}]));
            results.push(
              parseSemanticResponse(res.text, schema.catalog).map((t) => {
                const p = profiles.get(t.table.toLowerCase()) ?? {};
                return {
                  ...t,
                  columns: t.columns.map((c) => (p[c.name] ? { ...c, profile: p[c.name] } : c)),
                };
              }),
            );
            remaining = rest;
            cAttempt = 0;
            const elapsed = Date.now() - startedAt;
            const adjusted = nextColumnBudget(budget, units, elapsed);
            const note = describeBudgetChange(budget, adjusted);
            budget = adjusted;
            await contentCheckpoint(remaining.length > 0 || partial);
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
        if (remaining.length > 0) partial = true;
        const next = await contentCheckpoint(partial);
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
    // Which RUN is this? Asked before consent, because the answer changes what
    // consent is being given to: finishing an interrupted run costs a fraction
    // of re-indexing the catalog, and the two must never be confused.
    const mode = await this.chooseRunMode(source, schema);
    if (!mode) return schema;
    const consent = await this.askConsent(source, schema, mode);
    if (consent === "declined") {
      const declined: SourceSchema = { ...schema, semanticState: "declined" };
      await this.schemas.set(source.id, declined);
      return declined;
    }
    if (consent === "later") return schema;
    const indexed = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `${mode === "restart" ? "Re-indexing" : "Indexing"} "${source.displayName}" schema…`,
        cancellable: true,
      },
      (progress, token) => this.runIndexing(source, schema, progress, token, mode),
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
