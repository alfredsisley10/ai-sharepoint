/**
 * Retry policy for Copilot-backed indexing calls (pure).
 *
 * Reported from a corporate network: a schema-indexing batch died with
 * `net::ERR_HTTP2_PROTOCOL_ERROR`. That is an SSL-inspecting proxy or HTTP/2
 * intermediary **resetting the stream**, not a problem with the request — an
 * indexing batch is a long-lived streaming response, which is exactly what such
 * proxies are most likely to cut. The same shape shows up as `ECONNRESET`,
 * `ERR_QUIC_PROTOCOL_ERROR`, a bare `fetch failed`, or a gateway 5xx.
 *
 * These are worth retrying **unchanged** after a short pause: the identical
 * request usually succeeds on the next attempt. That is different from an
 * over-long response (where shrinking the batch is the fix) and different again
 * from a permanent refusal (entitlement, cancellation), where retrying only
 * burns metered requests.
 *
 * Pure and unit-tested — the caller supplies the sleep.
 */

import { AppError, describeError } from "../../core/errors";

/** How many EXTRA attempts a transient failure gets before the caller falls
 *  back to shrinking the batch. Kept small: each attempt is a metered request. */
export const MAX_TRANSIENT_RETRIES = 2;

/** The transport-reset family — the same signatures `diagnoseTransportError`
 *  recognizes for HTTP adapters, plus the generic stream/socket failures the
 *  language-model path surfaces. */
const TRANSPORT_RESET =
  /err_http2_protocol_error|err_spdy_protocol_error|err_quic_protocol_error|err_connection_(reset|closed|aborted)|econnreset|epipe|\beproto\b|socket hang up|stream (was )?(reset|closed)|premature close|terminated/i;

/** Transient server/network conditions that also deserve a second try. */
const TRANSIENT_OTHER =
  /etimedout|esockettimedout|enetreset|eai_again|fetch failed|network error|\b(429|502|503|504)\b|too many requests|rate.?limit|temporarily unavailable|service unavailable|gateway time-?out/i;

/**
 * Should this failure be retried with the SAME request?
 *
 * Fails closed on the things that must never be retried:
 *  - `copilot.entitlement` — an org policy refusal; every attempt gets the same
 *    answer and the caller stops the whole run;
 *  - user cancellation — the user asked us to stop;
 *  - anything unrecognized — a malformed/over-long response is a *sizing*
 *    problem, so the caller shrinks instead of re-sending the same prompt.
 */
export function isTransientLlmError(err: unknown): boolean {
  if (err instanceof AppError) {
    if (err.code === "copilot.entitlement") return false;
    if (err.code === "auth.cancelled") return false;
    if (err.code === "network") return true;
  }
  const name = err instanceof Error ? err.name : "";
  if (/abort/i.test(name)) return false; // cancellation, not a network fault
  const message = errorText(err);
  if (!message) return false;
  if (/cancel|abort/i.test(message) && !TRANSPORT_RESET.test(message)) return false;
  return TRANSPORT_RESET.test(message) || TRANSIENT_OTHER.test(message);
}

/** Whether a transport reset (rather than a generic transient) caused this —
 *  drives the proxy-specific advice, since the remedy differs. */
export function isTransportReset(err: unknown): boolean {
  return TRANSPORT_RESET.test(errorText(err));
}

/** Flatten an error (and its `cause` chain, where fetch hides the real reason)
 *  into searchable text. */
export function errorText(err: unknown): string {
  // One implementation, in core/errors: the classifier below and every log line
  // in the product need the same "what actually went wrong" text, and two
  // extractors would drift into disagreeing about the same error.
  return describeError(err);
}

/**
 * Backoff before attempt `n` (1-based): 2s, 6s — deliberately short, because a
 * user is watching a progress bar, and a proxy reset clears immediately far
 * more often than it needs a long wait.
 */
export function retryDelayMs(attempt: number): number {
  const n = Math.max(1, Math.floor(attempt));
  return Math.min(10_000, 2_000 * (n === 1 ? 1 : 3 * (n - 1)));
}

/** Progress/log line for a retry, naming the proxy cause when that's what it is
 *  so the user isn't left guessing why indexing paused. */
export function describeRetry(err: unknown, attempt: number, max: number, delayMs: number): string {
  const cause = isTransportReset(err)
    ? "the connection was reset (an SSL-inspecting proxy or HTTP/2 intermediary)"
    : "a temporary network/service error";
  return `retrying after ${cause} — attempt ${attempt} of ${max}, in ${Math.round(delayMs / 1000)}s`;
}

/** One-line guidance shown when a batch is finally given up on after retries. */
export const PROXY_GUIDANCE =
  "If this keeps happening, the corporate proxy is likely cutting the long streaming reply: indexing resumes where it left off, so re-running picks up the remaining tables. Enabling aiSharePoint.logging.verboseWire captures the masked status for your network team.";
