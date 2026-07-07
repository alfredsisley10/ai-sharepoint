/**
 * Optional token → money estimation for the Copilot Activity view (pure).
 *
 * The activity view is deliberately factual — locally-measured token counts, no
 * invented premium-unit estimates (those misled users; see meter.ts). But raw
 * token totals are hard to relate to. So this is strictly OPT-IN: the user
 * enters their OWN per-million-token rate in settings, and only then do we
 * multiply it against the locally-measured tokens to show a dollar figure — an
 * estimate from a rate they chose, clearly labelled, never presented as GitHub
 * billing. When no rate is set, cost is hidden and the view is unchanged.
 */

export interface TokenRates {
  /** Currency per 1,000,000 input tokens. 0 = unset. */
  inputPerMillion: number;
  /** Currency per 1,000,000 output tokens. 0 = unset. */
  outputPerMillion: number;
  /** Currency symbol to prefix (e.g. "$", "£", "€"). */
  currency: string;
}

/** True once the user has entered any non-zero rate — the gate for showing cost. */
export function costEnabled(r: TokenRates): boolean {
  return r.inputPerMillion > 0 || r.outputPerMillion > 0;
}

/** Estimated cost of a token bundle at the configured rates. Negative/NaN inputs
 *  are floored to 0 so a bad setting can't produce a negative bill. */
export function estimateCost(inputTokens: number, outputTokens: number, r: TokenRates): number {
  const inTok = Number.isFinite(inputTokens) ? Math.max(0, inputTokens) : 0;
  const outTok = Number.isFinite(outputTokens) ? Math.max(0, outputTokens) : 0;
  const inRate = Number.isFinite(r.inputPerMillion) ? Math.max(0, r.inputPerMillion) : 0;
  const outRate = Number.isFinite(r.outputPerMillion) ? Math.max(0, r.outputPerMillion) : 0;
  return (inTok / 1_000_000) * inRate + (outTok / 1_000_000) * outRate;
}

/** Format an amount as "$1,234.56" — locale-independent (deterministic for
 *  tests and consistent across machines). Tiny non-zero amounts show "<$0.01"
 *  rather than rounding to zero, so real activity never reads as free. */
export function formatCost(amount: number, currency: string): string {
  const sym = currency || "$";
  const value = Number.isFinite(amount) ? Math.max(0, amount) : 0;
  if (value > 0 && value < 0.01) return `<${sym}0.01`;
  const [int, frac] = value.toFixed(2).split(".");
  const grouped = int!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sym}${grouped}.${frac}`;
}
