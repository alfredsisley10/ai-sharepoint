/**
 * Recommend the best Copilot model for a given prompt size, from the models
 * actually available to the user and each one's USABLE context budget (the
 * tested/reported ceiling minus the safety margin — see contextBudget). The
 * policy is economy-first: the cheapest model whose usable budget comfortably
 * fits the need; if none fits, the one with the largest usable budget (so the
 * caller can advise narrowing the request). Pure + unit-tested.
 */

export interface ModelChoice {
  /** Stable key (family or id) used for limits/costs. */
  key: string;
  /** Display name. */
  name: string;
  /** Advertised maxInputTokens, when known. */
  advertised?: number;
  /** The real per-turn usable budget (effectiveInputCap of the resolved ceiling). */
  usable: number;
  /** Premium-request multiplier (cost proxy; lower is cheaper). */
  multiplier: number;
  /** Whether the usable figure is backed by an actual measurement. */
  tested: boolean;
}

export interface ModelRecommendation {
  best?: ModelChoice;
  /** True when `best`'s usable budget comfortably fits `neededTokens`. */
  fits: boolean;
  /** One-line rationale for the UI. */
  reason: string;
}

const n = (v: number) => v.toLocaleString();

/**
 * Recommend a model for a prompt of `neededTokens`. Economy-first among the
 * models that fit; otherwise the largest-budget model with a "won't fit" signal.
 */
export function recommendModel(models: ModelChoice[], neededTokens: number): ModelRecommendation {
  if (models.length === 0) return { fits: false, reason: "No Copilot models are available." };

  const fitting = models
    .filter((m) => m.usable >= neededTokens)
    .sort((a, b) => a.multiplier - b.multiplier || b.usable - a.usable);
  if (fitting.length) {
    const best = fitting[0]!; // cheapest that fits (sorted by multiplier asc)
    const cheapest = fitting.length > 1 ? " (cheapest that fits)" : "";
    return {
      best,
      fits: true,
      reason: `${best.name} fits ~${n(neededTokens)} tokens within its ${n(best.usable)}-token usable budget${cheapest}.`,
    };
  }

  const largest = [...models].sort((a, b) => b.usable - a.usable || a.multiplier - b.multiplier)[0]!;
  return {
    best: largest,
    fits: false,
    reason: `No available model comfortably fits ~${n(neededTokens)} tokens; ${largest.name} has the largest usable budget (${n(largest.usable)}). Consider narrowing the request or splitting the task.`,
  };
}

/**
 * When the ACTIVE model can't fit the prompt, is there a BETTER available model
 * to switch to? Returns the cheapest available model whose usable budget fits
 * (and beats the active one's), or undefined if none is meaningfully better.
 */
export function betterModelFor(
  activeKey: string,
  activeUsable: number,
  models: ModelChoice[],
  neededTokens: number,
): ModelChoice | undefined {
  if (neededTokens <= activeUsable) return undefined; // active is fine
  const candidates = models
    .filter((m) => m.key !== activeKey && m.usable >= neededTokens && m.usable > activeUsable)
    .sort((a, b) => a.multiplier - b.multiplier || b.usable - a.usable);
  return candidates[0];
}
