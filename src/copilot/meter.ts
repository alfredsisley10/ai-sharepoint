import * as vscode from "vscode";
import {
  LedgerV3,
  UsageRecord,
  migrateLedger,
  recordInto,
  monthRequests,
  monthFailures,
  todayRequests,
  monthByModel,
  monthByLabel,
  dailySeries,
  emptyLedger,
} from "./ledgerMath";

const LEDGER_KEY = "aiSharePoint.usageLedger";

/**
 * Records and aggregates this extension's Copilot activity (PLAN §4 /
 * ADR-0003, amended): factual request/failure/token counts only — measured
 * locally, so they are accurate for what THIS extension did. Premium-request
 * units and the monthly-allowance gauge were removed: there is no automated,
 * authoritative way to read the real allowance/bill, and estimates misled
 * users. Storage is the compacted v3 ledger (per-day aggregates + capped
 * recent tail); earlier shapes migrate transparently on first load.
 */
export class UsageMeter {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private ledger: LedgerV3;
  /** Serializes Memento writes so concurrent record()/reset() calls cannot
   *  interleave their async updates and clobber each other (lost-update guard).
   *  recordInto() mutates the shared in-memory ledger synchronously, so each
   *  queued write persists the latest merged state. */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly state: vscode.Memento) {
    this.ledger = migrateLedger(this.state.get(LEDGER_KEY));
  }

  private save(): Promise<void> {
    this.writeChain = this.writeChain
      .catch(() => undefined)
      .then(() => this.state.update(LEDGER_KEY, this.ledger))
      .then(() => {
        this.emitter.fire();
      });
    return this.writeChain;
  }

  /** Record a completed/failed request. */
  async record(
    modelId: string,
    inputTokens: number,
    outputTokens: number,
    at: string,
    label?: string,
    ok = true,
  ): Promise<void> {
    const rec: UsageRecord = {
      at,
      modelId,
      inputTokens,
      outputTokens,
      label,
      ok,
    };
    recordInto(this.ledger, rec);
    await this.save();
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
