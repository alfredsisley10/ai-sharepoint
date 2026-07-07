/**
 * Premium-request → money estimation for the Copilot Activity view (pure).
 *
 * Unlike token pricing (tokenCost.ts, which the user enters), GitHub Copilot's
 * OWN public pricing is premium-request based: each request to a premium model
 * consumes `multiplier` premium requests, and premium requests beyond the plan's
 * monthly allowance are billed at a published per-request overage rate
 * (DEFAULT_PRICE_PER_REQUEST). Multiplied by the maintained model multipliers
 * (model-costs.json) this yields a dollar estimate that works out of the box —
 * clearly an ESTIMATE at the published overage rate (your plan allowance may make
 * the real charge lower), never a live read of the GitHub bill.
 */

/** GitHub's published overage rate: $0.04 per premium request. */
export const DEFAULT_PRICE_PER_REQUEST = 0.04;

export interface PremiumPricing {
  /** Currency per premium request. 0 hides the estimate. */
  pricePerRequest: number;
  currency: string;
}

export function premiumCostEnabled(p: PremiumPricing): boolean {
  return p.pricePerRequest > 0;
}

/** Premium requests consumed by a per-model request tally (requests × multiplier). */
export function premiumRequests(
  rows: Array<{ key: string; requests: number }>,
  multiplierFor: (key: string) => number,
): number {
  let total = 0;
  for (const r of rows) {
    const req = Number.isFinite(r.requests) ? Math.max(0, r.requests) : 0;
    const mult = Math.max(0, multiplierFor(r.key));
    total += req * mult;
  }
  return total;
}

/** Estimated dollar cost = premium requests × the per-request price. */
export function estimatePremiumCost(
  rows: Array<{ key: string; requests: number }>,
  multiplierFor: (key: string) => number,
  p: PremiumPricing,
): number {
  const price = Number.isFinite(p.pricePerRequest) ? Math.max(0, p.pricePerRequest) : 0;
  return premiumRequests(rows, multiplierFor) * price;
}

export interface ProbeCostEstimate {
  /** Upper-bound premium requests the probe may consume (steps × multiplier). */
  premiumRequests: number;
  /** Upper-bound dollar cost at the configured per-request price. */
  cost: number;
}

/** Estimate the (upper-bound) cost of a context-limit probe: it sends up to
 *  `steps` test requests, each consuming `multiplier` premium requests. */
export function estimateProbeCost(multiplier: number, steps: number, pricePerRequest: number): ProbeCostEstimate {
  const pr = Math.max(0, steps) * Math.max(0, multiplier);
  const price = Number.isFinite(pricePerRequest) ? Math.max(0, pricePerRequest) : 0;
  return { premiumRequests: pr, cost: pr * price };
}
