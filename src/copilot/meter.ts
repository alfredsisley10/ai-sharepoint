import * as vscode from "vscode";
import { ModelCostTable } from "./modelCosts";

/** One metered Copilot request. */
export interface UsageRecord {
  /** ISO timestamp (filled by the caller / host clock). */
  at: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  /** multiplier × 1 request = premium-request units charged. */
  premiumUnits: number;
  /** Optional label, e.g. the objective that drove the request. */
  label?: string;
}

interface Ledger {
  records: UsageRecord[];
}

const LEDGER_KEY = "aiSharePoint.usageLedger";

/**
 * Records and aggregates this extension's Copilot usage (PLAN §4 / ADR-0003).
 *
 * The meter is always-on and local; it is the fallback numerator for the usage
 * gauge when the GitHub billing API isn't available. Premium-request units are
 * derived from the maintained multiplier table, not from a live bill.
 */
export class UsageMeter {
  private readonly costs = new ModelCostTable();
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly state: vscode.Memento) {}

  private load(): Ledger {
    return this.state.get<Ledger>(LEDGER_KEY) ?? { records: [] };
  }

  private async save(ledger: Ledger): Promise<void> {
    await this.state.update(LEDGER_KEY, ledger);
    this.emitter.fire();
  }

  /** Record a completed request and return the units it cost. */
  async record(
    modelId: string,
    inputTokens: number,
    outputTokens: number,
    at: string,
    label?: string,
  ): Promise<number> {
    const premiumUnits = this.costs.multiplierFor(modelId);
    const ledger = this.load();
    ledger.records.push({
      at,
      modelId,
      inputTokens,
      outputTokens,
      premiumUnits,
      label,
    });
    await this.save(ledger);
    return premiumUnits;
  }

  /** Total premium-request units spent in the current calendar month (UTC). */
  premiumUnitsThisMonth(nowIso: string): number {
    const month = nowIso.slice(0, 7); // YYYY-MM
    return this.load()
      .records.filter((r) => r.at.slice(0, 7) === month)
      .reduce((sum, r) => sum + r.premiumUnits, 0);
  }

  /** Count of requests recorded today (UTC). */
  requestsToday(nowIso: string): number {
    const day = nowIso.slice(0, 10); // YYYY-MM-DD
    return this.load().records.filter((r) => r.at.slice(0, 10) === day).length;
  }

  async reset(): Promise<void> {
    await this.save({ records: [] });
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
