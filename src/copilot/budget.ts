import { AppError } from "../core/errors";

export type BudgetMode = "off" | "warn" | "block";

/** Resolved budget configuration (see vscodeBudgetConfig.ts for the
 *  settings-backed reader; tests inject plain objects). */
export interface BudgetConfig {
  allowance: number;
  mode: BudgetMode;
  softPct: number;
  hardPct: number;
}

/** The slice of the usage meter the guard needs (keeps this module pure). */
export interface UsageSource {
  premiumUnitsThisMonth(nowIso: string): number;
}

export interface BudgetVerdict {
  /** False when no allowance has been entered — usage-only mode: no
   *  percentages, no caps (an invented denominator would mislead). */
  configured: boolean;
  state: "ok" | "soft" | "hard";
  mode: BudgetMode;
  allowance: number;
  usedUnits: number;
  usedPct: number;
  /** Percentage after the request being evaluated would complete. */
  projectedPct: number;
  softPct: number;
  hardPct: number;
}

/** Thrown when a request is blocked by the hard cap (PLAN §4 guardrails). */
export class BudgetBlockedError extends AppError {
  constructor(readonly verdict: BudgetVerdict) {
    super(
      `Budget cap reached: ~${verdict.usedPct.toFixed(0)}% of the monthly allowance used (hard cap ${verdict.hardPct}%).`,
      "budget.blocked",
      "Copilot budget cap reached.",
    );
  }
}

/**
 * Budget guardrails (PLAN §4): a soft cap that warns and a hard cap that
 * blocks, both expressed as a percentage of the configured monthly
 * premium-request allowance. Pure policy — callers decide how to surface
 * verdicts (notification, chat message, modal override).
 */
export class BudgetGuard {
  constructor(
    private readonly usage: UsageSource,
    private readonly readConfig: () => BudgetConfig,
  ) {}

  private config(): BudgetConfig & { configured: boolean } {
    const raw = this.readConfig();
    // 0/negative = "not configured": the default ships unset because a
    // made-up allowance (the old 300) misled users (pilot).
    const configured = raw.allowance > 0;
    const allowance = configured ? raw.allowance : 0;
    const softPct = Math.max(0, raw.softPct);
    const hardPct = Math.max(softPct, raw.hardPct);
    return { allowance, mode: raw.mode, softPct, hardPct, configured };
  }

  /**
   * Evaluate spending `nextUnits` more premium units right now.
   * Never throws — returns a verdict for the caller to act on.
   */
  evaluate(nextUnits: number, nowIso: string): BudgetVerdict {
    const { allowance, mode, softPct, hardPct, configured } = this.config();
    const usedUnits = this.usage.premiumUnitsThisMonth(nowIso);
    const usedPct = configured ? (usedUnits / allowance) * 100 : 0;
    const projectedPct = configured ? ((usedUnits + nextUnits) / allowance) * 100 : 0;

    let state: BudgetVerdict["state"] = "ok";
    if (configured && mode !== "off") {
      if (projectedPct > hardPct) state = "hard";
      else if (projectedPct > softPct) state = "soft";
    }
    return { configured, state, mode, allowance, usedUnits, usedPct, projectedPct, softPct, hardPct };
  }

  /**
   * Enforce the policy for a request costing `nextUnits`.
   * - hard + mode "block" → throws BudgetBlockedError (caller may offer a
   *   one-time override and retry with `override = true`).
   * - anything else → returns the verdict (caller surfaces soft warnings).
   */
  enforce(nextUnits: number, nowIso: string, override = false): BudgetVerdict {
    const verdict = this.evaluate(nextUnits, nowIso);
    if (verdict.state === "hard" && verdict.mode === "block" && !override) {
      throw new BudgetBlockedError(verdict);
    }
    return verdict;
  }
}
