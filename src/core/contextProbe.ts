/**
 * ACTIVELY test a model's real input-token ceiling. The limit a model advertises
 * (`maxInputTokens`) is frequently NOT what GitHub Copilot actually delivers for
 * a given org — the backend may clamp lower. Rather than only learning passively
 * from real chat overflows (see contextBudget.ts), this drives a bounded binary
 * search: send progressively sized filler prompts and watch for the overflow
 * boundary, converging on the largest input the model truly accepts.
 *
 * Pure planning/helpers here (unit-tested); the command in extension.ts does the
 * actual sends and records the result into the ModelLimitsStore.
 */

/** The next size to try in a binary search for the accept/reject boundary, given
 *  the largest known-accepted (`low`) and smallest known-rejected (`high`).
 *  Returns undefined once the window is within `tolerance` (converged). */
export function nextProbeSize(low: number, high: number, tolerance: number): number | undefined {
  if (high - low <= tolerance) return undefined;
  return Math.floor((low + high) / 2);
}

/** Whether the search has converged to within `tolerance` tokens. */
export function probeConverged(low: number, high: number, tolerance: number): boolean {
  return high - low <= tolerance;
}

/**
 * Build filler text of approximately `approxTokens` tokens. Uses distinct short
 * tokens (a counter per word) so a tokenizer can't collapse repeats, and so the
 * caller's exact `countTokens` lands close to the target. The caller should still
 * MEASURE the built prompt (advertised tokenizers vary) and record the measured
 * size, not the requested one.
 */
export function probeFiller(approxTokens: number): string {
  const n = Math.max(1, Math.floor(approxTokens));
  const words: string[] = new Array(n);
  for (let i = 0; i < n; i++) words[i] = `w${i % 1000}`;
  return words.join(" ");
}

/** Clamp the probe's starting window to sane bounds. `advertised` seeds the upper
 *  bound; `knownGood` (if any) seeds the lower so we never re-test below a proven
 *  size. The window is [low, high] where high is the first size to PROBE down from. */
export function initialProbeWindow(
  advertised: number | undefined,
  knownGood: number | undefined,
): { low: number; high: number } {
  const ceiling = advertised && advertised > 0 ? advertised : 128_000;
  const low = Math.max(1_000, knownGood && knownGood > 0 ? Math.min(knownGood, ceiling) : 1_000);
  // Probe a bit ABOVE the advertised ceiling too — the real limit is sometimes
  // higher than advertised, but usually lower; cap the exploration generously.
  const high = Math.max(low + 1, ceiling);
  return { low, high };
}

export const PROBE_TOLERANCE = 2_000;
export const PROBE_MAX_STEPS = 8;

/**
 * The size for a single first-use CALIBRATION send (vs. the full binary search):
 * just under the advertised ceiling, so one request reveals whether the org
 * actually delivers the advertised limit. A success records a high known-good; an
 * overflow records that the real cap is lower. Undefined when nothing's advertised
 * (we won't burn quota guessing a target with no anchor). */
export function calibrationSize(advertised: number | undefined): number | undefined {
  if (!advertised || advertised <= 0) return undefined;
  return Math.max(1_000, Math.floor(advertised * 0.95));
}
