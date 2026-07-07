import * as vscode from "vscode";
import { TokenRates } from "./tokenCost";

/** Read the user's configured token rates from settings (vscode wrapper around
 *  the pure tokenCost helpers). Defaults to all-zero → cost display stays off. */
export function readTokenRates(): TokenRates {
  const c = vscode.workspace.getConfiguration("aiSharePoint");
  return {
    inputPerMillion: Math.max(0, c.get<number>("usage.tokenCostInputPerMillion", 0) || 0),
    outputPerMillion: Math.max(0, c.get<number>("usage.tokenCostOutputPerMillion", 0) || 0),
    currency: c.get<string>("usage.currencySymbol", "$") || "$",
  };
}
