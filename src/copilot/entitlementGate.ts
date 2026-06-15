/**
 * Copilot entitlement circuit breaker (pilot). GitHub answers
 * 403 "unauthorized: not authorized to use this Copilot feature" when the
 * subscription lapsed or an organization policy disables a feature — and a
 * naive client (chat turns, indexing batches, model pickers) keeps hitting
 * the same refusal over and over. Once an entitlement-shaped failure is
 * seen, Copilot calls are short-circuited LOCALLY for a cooldown window
 * with an actionable message; any success — or the user's explicit
 * "Check Copilot Status" — closes the gate. Pure and clock-injected.
 */

export const ENTITLEMENT_COOLDOWN_MS = 5 * 60_000;

/** Entitlement-shaped failures: HTTP 403 / "unauthorized"/"not authorized"
 *  texts and the LM API's NoPermissions code. Everything else (network,
 *  cancellation, model errors) is NOT gated — those may succeed on retry. */
export function isEntitlementFailure(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  if (typeof code === "string" && code.toLowerCase() === "nopermissions") return true;
  const message = err instanceof Error ? err.message : String(err ?? "");
  return /\b403\b|unauthori[sz]ed|not authorized|no permission/i.test(message);
}

export interface GateBlock {
  reason: string;
  remainingMs: number;
}

export class EntitlementGate {
  private state?: { reason: string; untilMs: number };

  constructor(private readonly cooldownMs = ENTITLEMENT_COOLDOWN_MS) {}

  open(reason: string, nowMs: number): void {
    this.state = { reason: reason.slice(0, 300), untilMs: nowMs + this.cooldownMs };
  }

  /** undefined when closed or expired; otherwise why + how long remains. */
  check(nowMs: number): GateBlock | undefined {
    if (!this.state) return undefined;
    if (nowMs >= this.state.untilMs) {
      this.state = undefined;
      return undefined;
    }
    return { reason: this.state.reason, remainingMs: this.state.untilMs - nowMs };
  }

  /** Close early — a success anywhere, or the user explicitly retrying. */
  reset(): void {
    this.state = undefined;
  }
}
