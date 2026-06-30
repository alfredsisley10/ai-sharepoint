/**
 * Make a chat turn DURABLE and RESTARTABLE. Two enterprise failure modes silently
 * lose a conversation: (1) a corporate content proxy blocks the request/response,
 * and (2) the prompt unknowingly exceeds the context limit GitHub Copilot grants
 * for the selected model (which varies by org). This pure module decides how to
 * react — auto-retry under a tighter budget, retry a transient drop once, or stop
 * and suggest a reword — and the chat participant + interaction cache act on it.
 *
 * Pure + unit-tested; nothing here touches vscode or the network.
 */

import { looksLikeOverflow } from "./contextBudget";
import { ProxyMode, normalizeTerms } from "./proxyShield";

export type SendFailureKind = "overflow" | "blocked" | "transient" | "other";

// A content filter / proxy refused the message (vs. a transient connectivity
// blip). Kept distinct from "transient" because re-sending the SAME text won't
// help a content block — the fix is a reword / defang, not a retry.
const BLOCKED = /content (?:filter|block)|blocked by|request blocked|policy prohibits|web filter|forbidden by proxy|denied by policy/i;
// Transient transport problems where an immediate retry is reasonable.
const TRANSIENT =
  /econnreset|etimedout|esockettimedout|socket hang ?up|network|fetch failed|err_http2|err_connection_reset|protocol error|stream (?:closed|reset|error)|temporar|\b50[234]\b|\b429\b|aborted|timeout/i;

/**
 * Classify a send failure. Overflow takes priority (it's the one we can fix by
 * trimming); then an explicit content block; then a transient transport error.
 * Entitlement refusals are handled by the caller's circuit breaker before this.
 */
export function classifySendFailure(message: string | undefined): SendFailureKind {
  const m = message ?? "";
  if (looksLikeOverflow(m)) return "overflow";
  if (BLOCKED.test(m)) return "blocked";
  if (TRANSIENT.test(m)) return "transient";
  return "other";
}

export interface RetryDecision {
  retry: boolean;
  /** Re-budget the prompt under a tighter cap before retrying (overflow only). */
  tightenBudget: boolean;
  /** A short progress line to show before retrying. */
  note: string;
}

/**
 * Decide whether to auto-retry, given the failure kind and how many retries of
 * each class we've already spent this turn. We:
 *  - retry an OVERFLOW under a tighter budget (bounded), so a conversation that
 *    unknowingly blew the context limit recovers instead of dying;
 *  - retry a TRANSIENT drop once, but ONLY if nothing has streamed yet (re-sending
 *    after partial output would duplicate text);
 *  - never auto-retry a content BLOCK (re-sending identical text just re-blocks —
 *    the caller suggests a reword instead) or an unknown error.
 */
export function planSendRetry(input: {
  kind: SendFailureKind;
  sawText: boolean;
  overflowRetriesUsed: number;
  transientRetriesUsed: number;
  maxOverflow?: number;
  maxTransient?: number;
}): RetryDecision {
  const maxOverflow = input.maxOverflow ?? 2;
  const maxTransient = input.maxTransient ?? 1;
  if (input.kind === "overflow" && input.overflowRetriesUsed < maxOverflow) {
    return { retry: true, tightenBudget: true, note: "Reached the model's context limit — retrying with a tighter context budget…" };
  }
  if (input.kind === "transient" && !input.sawText && input.transientRetriesUsed < maxTransient) {
    return { retry: true, tightenBudget: false, note: "The connection dropped before any reply — retrying once…" };
  }
  return { retry: false, tightenBudget: false, note: "" };
}

/** A tighter input-token cap after an overflow: budget under the smaller of the
 *  current cap and what we actually tried, shaved by `factor`, with a floor so we
 *  never collapse to nothing. */
export function tightenCap(currentCap: number, attemptedTokens: number, factor = 0.7): number {
  const base = attemptedTokens > 0 ? Math.min(currentCap, attemptedTokens) : currentCap;
  return Math.max(512, Math.floor(base * factor));
}

/**
 * When a turn fails at the network layer, suggest a concrete reword if a content
 * proxy is the likely culprit: name the avoid-list word(s) actually present in
 * the user's text, and point at defang. Returns undefined when there's nothing
 * specific to suggest (the caller can still show generic proxy advice).
 */
export function suggestReword(input: {
  termsInPrompt: string[];
  mode: ProxyMode;
}): string | undefined {
  const terms = normalizeTerms(input.termsInPrompt);
  if (terms.length === 0) return undefined;
  const list = terms.map((t) => `“${t}”`).join(", ");
  if (input.mode === "defang") {
    return `Your message contains avoid-list word(s) — ${list} — and defang is already on, so they were sent obfuscated. If it still failed, the proxy may block the *topic* rather than the exact word: try rephrasing around ${list}, or add the real trigger word(s) via “Manage Proxy Avoid-List”.`;
  }
  return `This may be a corporate content proxy blocking specific words. Your message contains ${list}, which the avoid-list flags — rephrase around them, or set \`aiSharePoint.proxy.mode\` to \`defang\` to send them obfuscated automatically (the model still reads the original).`;
}
