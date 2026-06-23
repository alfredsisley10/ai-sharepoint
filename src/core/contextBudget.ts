/**
 * Effective-context probing & prompt budgeting (#3). Models exposed through the
 * VS Code LM / Copilot API advertise a `maxInputTokens`, but the EFFECTIVE
 * usable input is often lower — Copilot may clamp or compress below the native
 * max, and a prompt that nominally "fits" can still fail or silently lose
 * context. @sharepoint assembles large prompts (instructions + project memory +
 * connected data + history), so it needs to (a) budget the prompt to the real
 * limit, trimming the lowest-priority sections, and (b) LEARN each model's
 * effective ceiling over time from real successes and overflow failures.
 *
 * All pure and unit-tested; the Memento-backed store and chat wiring sit on top.
 */

// ---------------------------------------------------------------------------
// Prompt budgeting
// ---------------------------------------------------------------------------

export interface PromptSection {
  /** Human label for the "trimmed X to fit" note. */
  label: string;
  /** The section's formatted content. */
  text: string;
  /** Higher = kept longer. Dropped lowest-first when over budget. */
  priority: number;
  /** Never dropped (instructions, the user's actual request). */
  required?: boolean;
}

export interface BudgetResult {
  kept: PromptSection[];
  dropped: PromptSection[];
}

/**
 * Decide which sections to drop — lowest priority first — so the kept set fits
 * within `cap` tokens. Required sections are always kept (even if the result
 * still exceeds cap: we can't do better, and the send will surface/learn it).
 */
export function budgetSections(
  sections: PromptSection[],
  tokensOf: (s: PromptSection) => number,
  cap: number,
): BudgetResult {
  const total = sections.reduce((n, s) => n + tokensOf(s), 0);
  if (cap <= 0 || total <= cap) return { kept: [...sections], dropped: [] };
  const droppable = sections
    .filter((s) => !s.required)
    .sort((a, b) => a.priority - b.priority);
  const drop = new Set<PromptSection>();
  let running = total;
  for (const s of droppable) {
    if (running <= cap) break;
    drop.add(s);
    running -= tokensOf(s);
  }
  return {
    kept: sections.filter((s) => !drop.has(s)),
    dropped: sections.filter((s) => drop.has(s)),
  };
}

/** Sane fallback when a model doesn't report a limit. */
const FALLBACK_LIMIT = 8192;

/**
 * Usable input-token budget for the first prompt: clamp the advertised limit by
 * any learned (lower) effective limit, then keep a safety margin for tool
 * schemas, multi-round growth, and tokenizer drift.
 */
export function effectiveInputCap(
  advertised: number | undefined,
  learned: number | undefined,
  safety = 0.85,
): number {
  const adv = advertised && advertised > 0 ? advertised : FALLBACK_LIMIT;
  const eff = learned && learned > 0 ? Math.min(adv, learned) : adv;
  return Math.max(1, Math.floor(eff * safety));
}

/** Does an error message look like a context-length overflow (vs connectivity)? */
const OVERFLOW_PATTERNS: RegExp[] = [
  /context[ _-]?(?:length|window)/i,
  /maximum context/i,
  /too (?:long|large)/i,
  /too many tokens/i,
  /token.{0,24}(?:limit|exceed)/i,
  /(?:exceed|exceeded|exceeds).{0,24}(?:token|context|length|limit)/i,
  /prompt is too long/i,
  /reduce.{0,24}(?:length|tokens|context)/i,
  /input.{0,16}too (?:large|long)/i,
];

export function looksLikeOverflow(message: string | undefined): boolean {
  if (!message) return false;
  return OVERFLOW_PATTERNS.some((re) => re.test(message));
}

// ---------------------------------------------------------------------------
// Per-model learned limits (pure record math; the store is a thin Memento wrap)
// ---------------------------------------------------------------------------

export interface ModelLimit {
  /** Last-seen advertised maxInputTokens. */
  advertised?: number;
  /** Learned ceiling we must budget under (a prompt this big has overflowed). */
  effectiveCap?: number;
  /** Largest input that has actually succeeded. */
  knownGood?: number;
  updatedAt?: string;
}

/** The input ceiling to budget against: advertised clamped by a learned cap,
 *  but never below a proven known-good size. Returns undefined only when nothing
 *  is known (no record and no advertised value). */
export function resolveLimit(
  rec: ModelLimit | undefined,
  advertised: number | undefined,
): number | undefined {
  let eff = advertised && advertised > 0 ? advertised : undefined;
  if (rec?.effectiveCap && (eff === undefined || rec.effectiveCap < eff)) eff = rec.effectiveCap;
  if (rec?.knownGood && (eff === undefined || eff < rec.knownGood)) eff = rec.knownGood;
  return eff;
}

/** Fold a successful send into the record (raise the known-good high-water mark). */
export function onSuccess(
  rec: ModelLimit | undefined,
  advertised: number | undefined,
  inputTokens: number,
  now: string,
): ModelLimit {
  const next: ModelLimit = { ...rec };
  if (advertised && advertised > 0) next.advertised = advertised;
  if (inputTokens > 0) next.knownGood = Math.max(next.knownGood ?? 0, inputTokens);
  next.updatedAt = now;
  return next;
}

/**
 * Fold an overflow failure into the record: set the effective cap just below the
 * attempted size. Returns undefined (no change) when the signal is unreliable —
 * a non-positive size, a size at/below a proven known-good (so the failure
 * wasn't really about length), or when the existing cap is already tighter.
 */
export function onOverflow(
  rec: ModelLimit | undefined,
  advertised: number | undefined,
  attemptedTokens: number,
  now: string,
): ModelLimit | undefined {
  if (attemptedTokens <= 0) return undefined;
  if (rec?.knownGood && attemptedTokens <= rec.knownGood) return undefined;
  const cap = attemptedTokens - 1;
  if (rec?.effectiveCap && rec.effectiveCap <= cap) return undefined;
  const next: ModelLimit = { ...rec, effectiveCap: cap, updatedAt: now };
  if (advertised && advertised > 0) next.advertised = advertised;
  return next;
}
