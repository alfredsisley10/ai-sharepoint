import * as vscode from "vscode";
import { UsageMeter } from "./meter";
import { AppError } from "../core/errors";

export type BudgetMode = "off" | "warn" | "block";

export interface BudgetVerdict {
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
  constructor(private readonly meter: UsageMeter) {}

  private config() {
    const cfg = vscode.workspace.getConfiguration("aiSharePoint");
    const allowance = Math.max(
      1,
      cfg.get<number>("copilot.monthlyPremiumRequestAllowance", 300),
    );
    const mode = cfg.get<BudgetMode>("budget.mode", "block");
    const softPct = Math.max(0, cfg.get<number>("budget.softLimitPercent", 80));
    const hardPct = Math.max(
      softPct,
      cfg.get<number>("budget.hardLimitPercent", 100),
    );
    return { allowance, mode, softPct, hardPct };
  }

  /**
   * Evaluate spending `nextUnits` more premium units right now.
   * Never throws — returns a verdict for the caller to act on.
   */
  evaluate(nextUnits: number, nowIso: string): BudgetVerdict {
    const { allowance, mode, softPct, hardPct } = this.config();
    const usedUnits = this.meter.premiumUnitsThisMonth(nowIso);
    const usedPct = (usedUnits / allowance) * 100;
    const projectedPct = ((usedUnits + nextUnits) / allowance) * 100;

    let state: BudgetVerdict["state"] = "ok";
    if (mode !== "off") {
      if (projectedPct > hardPct) state = "hard";
      else if (projectedPct > softPct) state = "soft";
    }
    return { state, mode, allowance, usedUnits, usedPct, projectedPct, softPct, hardPct };
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
