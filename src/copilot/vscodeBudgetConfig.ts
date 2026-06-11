import * as vscode from "vscode";
import { BudgetConfig, BudgetMode } from "./budget";

/** Settings-backed budget configuration reader (the production wiring for
 *  BudgetGuard; tests inject plain objects instead). */
export function readBudgetConfigFromSettings(): BudgetConfig {
  const cfg = vscode.workspace.getConfiguration("aiSharePoint");
  return {
    allowance: cfg.get<number>("copilot.monthlyPremiumRequestAllowance", 300),
    mode: cfg.get<BudgetMode>("budget.mode", "block"),
    softPct: cfg.get<number>("budget.softLimitPercent", 80),
    hardPct: cfg.get<number>("budget.hardLimitPercent", 100),
  };
}
