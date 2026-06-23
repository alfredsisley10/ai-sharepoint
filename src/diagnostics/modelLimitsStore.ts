import * as vscode from "vscode";
import { ModelLimit, onOverflow, onSuccess, resolveLimit } from "../core/contextBudget";

/**
 * The "memory" half of effective-context probing (#3): each model's learned
 * effective input ceiling, persisted in globalState and grown from real chat
 * traffic — known-good sizes from successes, a lower cap from overflow failures.
 * All the record math lives in core/contextBudget (pure, tested); this is a thin
 * Memento wrapper keyed by model family/id.
 */
const KEY = "aiSharePoint.modelLimits";

export class ModelLimitsStore {
  constructor(
    private readonly memento: vscode.Memento,
    private readonly now: () => string,
  ) {}

  private all(): Record<string, ModelLimit> {
    return this.memento.get<Record<string, ModelLimit>>(KEY, {});
  }

  get(key: string): ModelLimit | undefined {
    return this.all()[key];
  }

  /** The input ceiling to budget against for this model (advertised clamped by
   *  what we've learned). Undefined only when nothing is known. */
  effectiveLimit(key: string, advertised: number | undefined): number | undefined {
    return resolveLimit(this.all()[key], advertised);
  }

  async recordSuccess(key: string, advertised: number | undefined, inputTokens: number): Promise<void> {
    const all = this.all();
    all[key] = onSuccess(all[key], advertised, inputTokens, this.now());
    await this.memento.update(KEY, all);
  }

  /** Learn the effective ceiling down from an overflow. Returns true if the
   *  record changed (so callers can tell the user we'll budget tighter). */
  async recordOverflow(key: string, advertised: number | undefined, attemptedTokens: number): Promise<boolean> {
    const all = this.all();
    const next = onOverflow(all[key], advertised, attemptedTokens, this.now());
    if (!next) return false;
    all[key] = next;
    await this.memento.update(KEY, all);
    return true;
  }

  list(): Array<{ key: string } & ModelLimit> {
    return Object.entries(this.all()).map(([key, v]) => ({ key, ...v }));
  }
}
