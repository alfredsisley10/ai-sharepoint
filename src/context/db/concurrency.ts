/**
 * Adaptive concurrency for long database work (pure).
 *
 * Indexing and ER probing were strictly sequential: one query, wait, next
 * query. On a large schema that is hours of mostly-idle time, because the
 * bottleneck is round-trip latency, not the client. Running several at once is
 * the fix — but a fixed parallelism is the wrong shape, because the safe number
 * is a property of the SERVER, not of us. Four readers are nothing to a
 * warehouse and too many for a contended OLTP box behind a connection pool.
 *
 * So: the user sets a CEILING, and the running limit adapts underneath it.
 * Sustained failures halve it; sustained success walks it back up, one at a
 * time. Multiplicative decrease and additive increase, for the usual reason —
 * backing off must be faster than pushing forward, or the system oscillates
 * against whatever is actually saturated.
 *
 * Two things this deliberately does NOT do:
 *
 *  - It never reduces on a failure that isn't about LOAD. A missing table or a
 *    permission denial does not get better with less parallelism, and reacting
 *    to one would be superstition — the limit would collapse on a schema whose
 *    only problem is that some tables aren't readable.
 *  - It never exceeds the user's ceiling. Automatic control moves within
 *    [1, ceiling]; it does not get to decide it knows better than the setting.
 *
 * Pure: no clock, no I/O. Outcomes go in, limit changes come out, and the
 * caller decides how to tell the user.
 */

import { AppError, describeError } from "../../core/errors";

/** Outcomes considered when deciding to back off. Small, because the decision
 *  should follow recent behavior rather than the whole run's history — a run
 *  that struggled at the start and recovered should be allowed to speed up. */
export const FAILURE_WINDOW = 8;
/** Failures within the window that trigger a reduction. Two, not one: a single
 *  timeout is normal on any busy database, and collapsing on it would make the
 *  feature feel broken. */
export const FAILURE_THRESHOLD = 2;
/** Consecutive successes before the limit steps back up. Deliberately much
 *  larger than the failure threshold — recovering fast just re-triggers the
 *  overload that caused the reduction. */
export const RECOVERY_STREAK = 10;

/** Failure signatures that mean "we are pushing too hard". */
const LOAD_FAILURE =
  /timeout|timed out|etimedout|esockettimedout|econnreset|epipe|socket hang up|too many connections|connection limit|max_connections|er_con_count_error|pool|deadlock|lock request|resource pool|\b(429|503|504)\b|too many requests|rate.?limit|throttl|server is busy|temporarily unavailable|err_http2_protocol_error|err_connection_reset/i;

/** Failure signatures that are about THIS request and will not improve with
 *  less parallelism — reacting to them would collapse the limit for reasons
 *  that have nothing to do with load. */
const NOT_LOAD_FAILURE =
  /invalid object name|does not exist|unknown column|unknown table|syntax|permission|denied|not authorized|forbidden|login failed|authentication|certificate|cancell?ed|abort/i;

/**
 * Is this failure evidence of overload?
 *
 * Order matters: a "permission denied" that happens to mention a pool name must
 * not read as a pool exhaustion, so the not-load signatures are checked first.
 * Anything unrecognized is NOT counted — the default has to be "don't react",
 * because a limit that drops for unknown reasons is worse than one that never
 * drops at all.
 */
export function isLoadFailure(err: unknown): boolean {
  if (err instanceof AppError) {
    if (err.code === "auth.failed" || err.code === "auth.cancelled" || err.code === "copilot.entitlement") {
      return false;
    }
    if (err.code === "graph.throttled") return true;
  }
  const text = describeError(err);
  if (NOT_LOAD_FAILURE.test(text)) return false;
  return LOAD_FAILURE.test(text);
}

export interface LimitChange {
  from: number;
  to: number;
  direction: "down" | "up";
  /** Plain-language cause, for the log line and the notification. */
  reason: string;
}

export interface GovernorSnapshot {
  limit: number;
  ceiling: number;
  /** Failures seen in the current window. */
  recentFailures: number;
  /** Total load failures this run — the number worth reporting at the end. */
  loadFailures: number;
  /** Failures ignored because they weren't about load. */
  ignoredFailures: number;
  /** True once the limit has been automatically reduced at least once. */
  reduced: boolean;
}

/**
 * Tracks outcomes and answers "how many at once, right now".
 *
 * `limit` is read at every dispatch rather than once per run, so a reduction
 * takes effect on work that is still queued instead of only on the next run.
 */
export class ConcurrencyGovernor {
  private current: number;
  private window: boolean[] = [];
  private successStreak = 0;
  private loadFailureCount = 0;
  private ignoredCount = 0;
  private everReduced = false;

  constructor(
    private ceilingValue: number,
    private readonly label = "database",
    private readonly floor = 1,
  ) {
    this.current = Math.max(floor, Math.floor(ceilingValue) || 1);
    this.ceilingValue = this.current;
  }

  get limit(): number {
    return this.current;
  }

  get ceiling(): number {
    return this.ceilingValue;
  }

  /** The user changed the setting mid-run. The ceiling is authoritative: a
   *  lowered ceiling pulls the running limit down with it immediately. */
  setCeiling(n: number): void {
    this.ceilingValue = Math.max(this.floor, Math.floor(n) || 1);
    if (this.current > this.ceilingValue) this.current = this.ceilingValue;
  }

  recordSuccess(): LimitChange | undefined {
    this.push(true);
    this.successStreak += 1;
    if (this.successStreak < RECOVERY_STREAK || this.current >= this.ceilingValue) return undefined;
    this.successStreak = 0;
    const from = this.current;
    // ADDITIVE increase: one step at a time, so recovery probes the limit
    // rather than jumping back to whatever just failed.
    this.current = Math.min(this.ceilingValue, this.current + 1);
    return {
      from,
      to: this.current,
      direction: "up",
      reason: `${RECOVERY_STREAK} consecutive successes — easing back up`,
    };
  }

  /**
   * Record a failure. Returns a change only when the limit actually moved, so
   * the caller can inform the user ONCE per reduction instead of once per
   * failure — the difference between a useful notice and a stream of noise.
   */
  recordFailure(err: unknown): LimitChange | undefined {
    if (!isLoadFailure(err)) {
      // Still an error, still logged by the caller — just not evidence that we
      // are running too many at once.
      this.ignoredCount += 1;
      return undefined;
    }
    this.loadFailureCount += 1;
    this.successStreak = 0;
    this.push(false);
    const failures = this.window.filter((ok) => !ok).length;
    const observed = this.window.length;
    if (failures < FAILURE_THRESHOLD || this.current <= this.floor) return undefined;
    const from = this.current;
    // MULTIPLICATIVE decrease: backing off has to outrun the overload.
    this.current = Math.max(this.floor, Math.floor(this.current / 2));
    // Clear the window so the same failures can't trigger a second reduction
    // on the very next error — the new limit deserves a fresh observation.
    this.window = [];
    this.everReduced = true;
    return {
      from,
      to: this.current,
      direction: "down",
      reason: `${failures} load-related failure(s) in the last ${observed} operation(s)`,
    };
  }

  snapshot(): GovernorSnapshot {
    return {
      limit: this.current,
      ceiling: this.ceilingValue,
      recentFailures: this.window.filter((ok) => !ok).length,
      loadFailures: this.loadFailureCount,
      ignoredFailures: this.ignoredCount,
      reduced: this.everReduced,
    };
  }

  /** End-of-run line, when anything worth reporting happened. */
  summary(): string | undefined {
    if (!this.everReduced && this.loadFailureCount === 0) return undefined;
    const bits = [`${this.loadFailureCount} load-related failure(s)`];
    if (this.everReduced) {
      bits.push(`${this.label} concurrency was reduced to ${this.current} (ceiling ${this.ceilingValue})`);
    }
    if (this.ignoredCount > 0) {
      bits.push(`${this.ignoredCount} other error(s) were not treated as overload`);
    }
    return bits.join("; ");
  }

  private push(ok: boolean): void {
    this.window.push(ok);
    if (this.window.length > FAILURE_WINDOW) this.window.shift();
  }
}

/** Human sentence for a limit change — shown in the progress line and once as
 *  a notification, so a run that quietly slows down is explainable. */
export function describeLimitChange(change: LimitChange, label = "Database"): string {
  return change.direction === "down"
    ? `${label} concurrency reduced ${change.from} → ${change.to} (${change.reason}). It will recover automatically as operations succeed.`
    : `${label} concurrency raised ${change.from} → ${change.to} (${change.reason}).`;
}

/**
 * Run `worker` over `items` with a limit that is re-read at every dispatch.
 *
 * Re-reading matters: a governor reduction mid-run has to apply to work still
 * queued, not only to the next run. Results keep INPUT order regardless of
 * completion order, because a caller that indexed into the input would
 * otherwise silently mis-associate results.
 *
 * The worker owns its errors. A worker that throws resolves to `undefined` in
 * the results rather than aborting the batch — one unreadable table must never
 * void a run over a thousand of them, which is the behavior the sequential
 * loops already had and must keep.
 */
export async function runWithConcurrency<T, R>(
  items: readonly T[],
  worker: (item: T, index: number) => Promise<R>,
  opts: {
    limit: () => number;
    /** Checked before each dispatch; stops starting new work (in-flight work
     *  is left to finish, since cancelling mid-query gains nothing). */
    isCancelled?: () => boolean;
  },
): Promise<Array<R | undefined>> {
  const results: Array<R | undefined> = new Array(items.length).fill(undefined);
  let next = 0;
  let active = 0;
  return new Promise<Array<R | undefined>>((resolve) => {
    let settled = false;
    const finish = () => {
      if (!settled && active === 0) {
        settled = true;
        resolve(results);
      }
    };
    const pump = (): void => {
      if (settled) return;
      if (opts.isCancelled?.()) {
        finish();
        return;
      }
      if (next >= items.length) {
        finish();
        return;
      }
      const allowed = Math.max(1, Math.floor(opts.limit()) || 1);
      while (active < allowed && next < items.length && !opts.isCancelled?.()) {
        const index = next++;
        active += 1;
        void worker(items[index], index)
          .then((r) => {
            results[index] = r;
          })
          .catch(() => {
            // Swallowed on purpose: the worker is responsible for recording
            // its own failure, and one bad item must not abort the rest.
          })
          .finally(() => {
            active -= 1;
            pump();
          });
      }
      // Nothing dispatched and nothing running: the limit function returned
      // something unusable. `allowed` is clamped to >= 1 above, so this is
      // only reachable when the list is empty.
      if (active === 0) finish();
    };
    pump();
  });
}

/** Clamp a user-supplied concurrency setting. Zero or nonsense means "one",
 *  never "none" — a setting of 0 must not stall every database function. */
export function resolveConcurrency(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) return fallback;
  return Math.min(max, Math.floor(value));
}

/** Defaults and hard maxima, shared by the settings, the service and the UI so
 *  the three can't disagree about what a legal value is. */
export const DEFAULT_QUERY_CONCURRENCY = 4;
export const MAX_QUERY_CONCURRENCY = 16;
/** Lower than queries: model requests are metered, and several long streaming
 *  replies in flight together are exactly what an SSL-inspecting proxy resets. */
export const DEFAULT_MODEL_CONCURRENCY = 2;
export const MAX_MODEL_CONCURRENCY = 8;
