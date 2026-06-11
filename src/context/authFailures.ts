/**
 * Lockout-safe auth-failure tracking (ADR-0009 — security-critical).
 *
 * Invariants enforced here, against the user's *real* accounts:
 *  - a credential that failed authentication is NEVER retried automatically —
 *    the caller must obtain a fresh secret from the user first;
 *  - consecutive auth failures trip a circuit breaker BELOW typical org
 *    lockout thresholds (hard stop at 3) until explicitly reset;
 *  - retries the user *does* initiate are spaced by exponential backoff;
 *  - network errors are not auth failures and never count toward lockout.
 *
 * Pure module: persistence is a plain serializable record the caller stores.
 */

export interface FailureRecord {
  consecutiveFailures: number;
  lastFailureAt: string; // ISO
  /** Set when the last failure was an authentication rejection. */
  credentialBad: boolean;
}

export type FailureState = Record<string, FailureRecord>;

export const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_CAP_MS = 5 * 60_000;

export type AttemptVerdict =
  | { allowed: true }
  | { allowed: false; reason: "circuit-open" | "credential-bad" | "backoff"; waitMs?: number };

/** May an authentication attempt proceed for this credential key right now? */
export function canAttempt(
  state: FailureState,
  key: string,
  nowIso: string,
  /** True when the user just supplied a fresh secret. */
  freshCredential = false,
): AttemptVerdict {
  const rec = state[key];
  if (!rec || rec.consecutiveFailures === 0) {
    return { allowed: true };
  }
  // Hard stop: at this point the ACCOUNT may be one failure from an org
  // lockout, so even a freshly supplied secret is refused until the user
  // explicitly resets (resetFailures) — an informed decision, not a retry.
  if (rec.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    return { allowed: false, reason: "circuit-open" };
  }
  if (rec.credentialBad && !freshCredential) {
    return { allowed: false, reason: "credential-bad" };
  }
  const wait =
    Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (rec.consecutiveFailures - 1)) -
    (Date.parse(nowIso) - Date.parse(rec.lastFailureAt));
  if (wait > 0 && !freshCredential) {
    return { allowed: false, reason: "backoff", waitMs: wait };
  }
  return { allowed: true };
}

/** Record an authentication rejection (counts toward the circuit breaker). */
export function recordAuthFailure(
  state: FailureState,
  key: string,
  nowIso: string,
): FailureState {
  const rec = state[key];
  return {
    ...state,
    [key]: {
      consecutiveFailures: (rec?.consecutiveFailures ?? 0) + 1,
      lastFailureAt: nowIso,
      credentialBad: true,
    },
  };
}

/** Record success — clears failures and the bad-credential flag. */
export function recordSuccess(state: FailureState, key: string): FailureState {
  if (!state[key]) return state;
  const { [key]: _gone, ...rest } = state;
  return rest;
}

/** Explicit user reset (e.g. after talking to their admin). */
export const resetFailures = recordSuccess;
