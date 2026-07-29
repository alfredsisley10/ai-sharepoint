/**
 * Adaptive batching for Copilot-backed database indexing (pure).
 *
 * The original scheme cut batches by TABLE COUNT (40 per request), which is the
 * wrong unit: indexing latency is dominated by how much JSON the model has to
 * WRITE, and the model emits a line per column. Forty narrow lookup tables is a
 * trivial request; forty wide fact tables at the 80-column cap is ~3,200 columns
 * of output in one call — the reported 460s+ batch, and close enough to the
 * output ceiling that a truncated, unparseable response loses the whole batch.
 *
 * So batches are sized by a COLUMN BUDGET, and the budget adapts: start small
 * (fast first result, quick feedback), measure each batch's observed
 * columns-per-second, and retarget toward a wall-clock goal — growing when the
 * model is quick, shrinking hard when it is slow or fails.
 *
 * Larger batches are CHEAPER (each batch is one metered premium request), so the
 * controller deliberately grows back up whenever throughput allows rather than
 * staying small; the floor and ceiling bound both cost and latency.
 *
 * Pure and unit-tested: no clock, no I/O — the caller passes measured durations.
 */

/** Columns in the first batch. Small on purpose: the user sees a result in
 *  seconds instead of minutes, and one slow model can't burn 8 minutes before
 *  the first sign of progress. */
export const START_COLUMN_BUDGET = 120;
/** Never go below this — sub-batches would multiply metered requests. */
export const MIN_COLUMN_BUDGET = 40;
/** Never exceed this — beyond it responses risk truncation regardless of speed. */
export const MAX_COLUMN_BUDGET = 900;
/** Wall-clock we aim each batch at. */
export const TARGET_BATCH_MS = 45_000;
/** Hard cap on tables per batch, so hundreds of tiny tables don't produce one
 *  enormous prompt just because the column count is low. */
export const MAX_TABLES_PER_BATCH = 40;
/** Growth/shrink damping: one observation may not change the budget by more
 *  than this factor, so a single slow network blip can't collapse the budget
 *  (or a single fast batch overshoot into truncation territory). */
export const MAX_ADJUST_FACTOR = 2;

/** Anything with columns — TableDef, or a content-sample row. */
export interface Batchable {
  columns: unknown[];
}

/** Work units in one item: the number of columns the model must describe. */
export function unitsOf(item: Batchable): number {
  return Math.max(1, item.columns.length);
}

/** Work units in a batch. */
export function batchUnits(items: readonly Batchable[]): number {
  return items.reduce((n, t) => n + unitsOf(t), 0);
}

/**
 * Take the next batch from the front of `remaining` under a column budget.
 *
 * Always returns at least one item — a single table wider than the whole budget
 * must still be processed, or indexing would stall forever on it. Otherwise it
 * accumulates until adding the next item would exceed the budget, or the table
 * cap is hit.
 */
export function takeBatch<T extends Batchable>(
  remaining: readonly T[],
  columnBudget: number,
  maxTables: number = MAX_TABLES_PER_BATCH,
): { batch: T[]; rest: T[] } {
  if (remaining.length === 0) return { batch: [], rest: [] };
  const budget = Math.max(1, columnBudget);
  const batch: T[] = [remaining[0]];
  let used = unitsOf(remaining[0]);
  let i = 1;
  while (i < remaining.length && batch.length < Math.max(1, maxTables)) {
    const next = unitsOf(remaining[i]);
    if (used + next > budget) break;
    batch.push(remaining[i]);
    used += next;
    i += 1;
  }
  return { batch, rest: remaining.slice(i) };
}

/**
 * The next column budget, from what the last batch actually cost.
 *
 * Measured throughput (`units / seconds`) projected onto the target duration
 * gives the ideal budget; it is then damped (no more than MAX_ADJUST_FACTOR in
 * either direction) and clamped. A non-positive or missing duration leaves the
 * budget alone rather than producing a divide-by-zero excursion.
 */
export function nextColumnBudget(
  current: number,
  lastBatchUnits: number,
  lastDurationMs: number,
  targetMs: number = TARGET_BATCH_MS,
): number {
  if (!Number.isFinite(lastDurationMs) || lastDurationMs <= 0 || lastBatchUnits <= 0) {
    return clampBudget(current);
  }
  const unitsPerMs = lastBatchUnits / lastDurationMs;
  const ideal = unitsPerMs * targetMs;
  const lo = current / MAX_ADJUST_FACTOR;
  const hi = current * MAX_ADJUST_FACTOR;
  return clampBudget(Math.round(Math.min(hi, Math.max(lo, ideal))));
}

/**
 * The budget after a FAILED batch. Failure here usually means the response was
 * too long to finish or parse, so halving is the right reflex — and it is
 * applied immediately rather than waiting for a duration measurement that a
 * failed batch never produces.
 */
export function shrinkAfterFailure(current: number): number {
  return clampBudget(Math.floor(current / 2));
}

function clampBudget(n: number): number {
  if (!Number.isFinite(n)) return START_COLUMN_BUDGET;
  return Math.min(MAX_COLUMN_BUDGET, Math.max(MIN_COLUMN_BUDGET, Math.round(n)));
}

/**
 * Approximate batch count for the consent prompt ("≈ N Copilot requests").
 * Uses the STARTING budget without adaptation, so it is an upper-ish estimate:
 * if the model turns out fast the budget grows and the real count comes in
 * lower, which is the pleasant direction to be wrong in.
 */
export function estimateBatchCount(
  items: readonly Batchable[],
  columnBudget: number = START_COLUMN_BUDGET,
  maxTables: number = MAX_TABLES_PER_BATCH,
): number {
  let rest: readonly Batchable[] = items;
  let n = 0;
  while (rest.length > 0) {
    const { batch, rest: next } = takeBatch(rest, columnBudget, maxTables);
    if (batch.length === 0) break; // defensive: cannot happen for a non-empty list
    rest = next;
    n += 1;
  }
  return n;
}

/** Human note for the progress line, so an adapting batch size is visible
 *  rather than looking like erratic behavior. */
export function describeBudgetChange(before: number, after: number): string {
  if (after === before) return "";
  return after > before ? ` — speeding up (batch size ↑)` : ` — easing off (batch size ↓)`;
}
