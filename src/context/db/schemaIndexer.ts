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
  chunkTables,
  buildIndexPrompt,
  parseSemanticResponse,
  mergeSemantic,
} from "./schemaIndex";

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
    progress?: vscode.Progress<{ message?: string }>,
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
      progress?.report({
        message: `Copilot is indexing tables ${i * batches[i].length + 1}–${i * batches[i].length + batches[i].length} of ${schema.catalog.tables.length}…`,
      });
      try {
        const res = await this.copilot.ask(
          {
            prompt: buildIndexPrompt(schema.catalog, batches[i]),
            label: "schemaIndex",
            token,
          },
          this.now,
        );
        modelId = res.modelId;
        results.push(parseSemanticResponse(res.text, schema.catalog));
      } catch (err) {
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
