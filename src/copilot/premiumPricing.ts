import * as vscode from "vscode";
import { PremiumPricing, DEFAULT_PRICE_PER_REQUEST } from "./premiumCost";

/** Read the Copilot premium-request pricing from settings. Defaults to GitHub's
 *  published $0.04/premium-request overage rate so dollars show out of the box;
 *  set the price to 0 to hide the estimate. Shares the currency symbol setting. */
export function readPremiumPricing(): PremiumPricing {
  const c = vscode.workspace.getConfiguration("aiSharePoint");
  const raw = c.get<number>("usage.pricePerPremiumRequest", DEFAULT_PRICE_PER_REQUEST);
  return {
    pricePerRequest: typeof raw === "number" && raw >= 0 ? raw : DEFAULT_PRICE_PER_REQUEST,
    currency: c.get<string>("usage.currencySymbol", "$") || "$",
  };
}
