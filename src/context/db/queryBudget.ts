/**
 * Cost-aware timeout scaling for database probes (#1). The ER builder and the
 * test-join tool issue join probes whose cost is dominated by whether the
 * to-side join column can be SEEKED (indexed → ~constant) or must be SCANNED
 * (unindexed → O(rows) once, as the optimizer hash/merge-joins the whole
 * table). The pilot saw large unindexed joins regularly blow past the flat 30s
 * request timeout and die.
 *
 * Rather than a single fixed timeout, we estimate the rows a probe may scan
 * (from catalog row-count estimates the ER model already collects) and grant a
 * proportional budget — clamped to a sane ceiling — so a legitimately large
 * scan gets the time it needs while small probes stay tight. Everything here is
 * pure and unit-tested; with no size estimate it returns the base timeout
 * (fail-open: behaviour is exactly as before).
 */

/** Conservative scan throughput for the budget estimate: ~200k rows/s. Filtered
 *  catalog/join scans over a network connection comfortably exceed this, so a
 *  budget sized at this rate errs toward "enough time", not "too little". */
export const PROBE_SCAN_ROWS_PER_MS = 200;

/** Fixed setup allowance added on top of the scan estimate (connection, plan,
 *  round-trip) before clamping. */
export const PROBE_SETUP_MS = 2_000;

/** A probe touching at or under this many rows is treated as cheap — no scaling
 *  (mirrors the ER builder's complete-join threshold). */
export const PROBE_CHEAP_ROWS = 50_000;

/** Default ceiling for an auto-scaled probe so a runaway estimate can't block a
 *  chat turn indefinitely. The effective ceiling is max(this, base) so a user
 *  who raises the base timeout is honoured. */
export const PROBE_MAX_TIMEOUT_MS = 120_000;

export interface ProbeBudget {
  timeoutMs: number;
  /** Estimated rows the probe may scan (after the index/size shortcuts). */
  estimatedScanRows: number;
  rationale: string;
}

/**
 * Budget for a single join probe.
 * - `scanRows`: the larger participating table's estimated row count (the side
 *   the optimizer may scan); 0/undefined = unknown.
 * - `indexed`: true when the to-side join column is known to be indexed (a
 *   seek, not a scan) — keeps the timeout at base. Optional; unknown = assume a
 *   scan and size by `scanRows` (the safe, pilot-fixing default).
 */
export function planProbeBudget(args: {
  scanRows: number;
  indexed?: boolean;
  baseTimeoutMs: number;
  maxTimeoutMs?: number;
}): ProbeBudget {
  const base = Math.max(1, Math.floor(args.baseTimeoutMs));
  const ceiling = Math.max(base, args.maxTimeoutMs ?? PROBE_MAX_TIMEOUT_MS);
  const rows = Math.max(0, Math.floor(args.scanRows || 0));
  if (args.indexed) {
    return { timeoutMs: base, estimatedScanRows: 0, rationale: "indexed join column (seek) — base timeout" };
  }
  if (rows <= PROBE_CHEAP_ROWS) {
    return {
      timeoutMs: base,
      estimatedScanRows: rows,
      rationale: rows > 0 ? `≈${rows.toLocaleString("en-US")} rows (small) — base timeout` : "no size estimate — base timeout",
    };
  }
  const need = Math.ceil(rows / PROBE_SCAN_ROWS_PER_MS) + PROBE_SETUP_MS;
  const timeoutMs = Math.min(ceiling, Math.max(base, need));
  return {
    timeoutMs,
    estimatedScanRows: rows,
    rationale: `≈${rows.toLocaleString("en-US")} rows may be scanned → ${Math.round(timeoutMs / 1000)}s budget (base ${Math.round(base / 1000)}s, cap ${Math.round(ceiling / 1000)}s)`,
  };
}
