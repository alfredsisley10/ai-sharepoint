import * as vscode from "vscode";
import { ModelCostTable } from "./modelCosts";
import {
  LedgerV2,
  UsageRecord,
  migrateLedger,
  recordInto,
  monthUnits,
  monthRequests,
  monthFailures,
  todayRequests,
  todayUnits,
  monthByModel,
  monthByLabel,
  dailySeries,
  emptyLedger,
} from "./ledgerMath";

const LEDGER_KEY = "aiSharePoint.usageLedger";

/**
 * Records and aggregates this extension's Copilot usage (PLAN §4 / ADR-0003).
 *
 * Always-on and local; the fallback numerator for the usage gauge when the
 * GitHub billing API isn't wired in. Premium-request units come from the
 * maintained multiplier table — an estimate, never the live bill. Storage is
 * the compacted v2 ledger (per-day aggregates + capped recent tail); the
 * Phase 0 unbounded array migrates transparently on first load.
 */
export class UsageMeter {
  private readonly costs: ModelCostTable;
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private ledger: LedgerV2;

  constructor(
    private readonly state: vscode.Memento,
    costs?: ModelCostTable,
  ) {
    this.costs = costs ?? new ModelCostTable();
    this.ledger = migrateLedger(this.state.get(LEDGER_KEY));
  }

  private async save(): Promise<void> {
    await this.state.update(LEDGER_KEY, this.ledger);
    this.emitter.fire();
  }

  /** Premium-request multiplier for a model (exposed for pre-flight estimates). */
  multiplierFor(modelId: string): number {
    return this.costs.multiplierFor(modelId);
  }

  /** Record a completed/failed request and return the units it cost. */
  async record(
    modelId: string,
    inputTokens: number,
    outputTokens: number,
    at: string,
    label?: string,
    ok = true,
  ): Promise<number> {
    const premiumUnits = this.costs.multiplierFor(modelId);
    const rec: UsageRecord = {
      at,
      modelId,
      inputTokens,
      outputTokens,
      premiumUnits,
      label,
      ok,
    };
    recordInto(this.ledger, rec);
    await this.save();
    return premiumUnits;
  }

  premiumUnitsThisMonth(nowIso: string): number {
    return monthUnits(this.ledger, nowIso);
  }

  requestsThisMonth(nowIso: string): number {
    return monthRequests(this.ledger, nowIso);
  }

  failuresThisMonth(nowIso: string): number {
    return monthFailures(this.ledger, nowIso);
  }

  requestsToday(nowIso: string): number {
    return todayRequests(this.ledger, nowIso);
  }

  premiumUnitsToday(nowIso: string): number {
    return todayUnits(this.ledger, nowIso);
  }

  byModelThisMonth(nowIso: string) {
    return monthByModel(this.ledger, nowIso);
  }

  byLabelThisMonth(nowIso: string) {
    return monthByLabel(this.ledger, nowIso);
  }

  dailySeries(nowIso: string, days: number) {
    return dailySeries(this.ledger, nowIso, days);
  }

  /** Snapshot for the diagnostics bundle (aggregates only, no text). */
  snapshot(nowIso: string) {
    return {
      monthPremiumUnits: this.premiumUnitsThisMonth(nowIso),
      monthRequests: this.requestsThisMonth(nowIso),
      monthFailures: this.failuresThisMonth(nowIso),
      todayRequests: this.requestsToday(nowIso),
      byModel: this.byModelThisMonth(nowIso),
      byLabel: this.byLabelThisMonth(nowIso),
      daily: this.dailySeries(nowIso, 30),
    };
  }

  async reset(): Promise<void> {
    this.ledger = emptyLedger();
    await this.save();
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
