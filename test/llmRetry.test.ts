import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  isTransientLlmError,
  isTransportReset,
  errorText,
  retryDelayMs,
  describeRetry,
  MAX_TRANSIENT_RETRIES,
} from "../src/context/db/llmRetry";
import { AppError } from "../src/core/errors";

test("the reported corporate-proxy failure is retryable", () => {
  // The exact shape from the field report.
  const err = new Error("Request failed. Code: net::ERR_HTTP2_PROTOCOL_ERROR");
  assert.equal(isTransientLlmError(err), true);
  assert.equal(isTransportReset(err), true);
});

test("the whole transport-reset family is recognized", () => {
  for (const m of [
    "net::ERR_HTTP2_PROTOCOL_ERROR",
    "net::ERR_SPDY_PROTOCOL_ERROR",
    "net::ERR_QUIC_PROTOCOL_ERROR",
    "net::ERR_CONNECTION_RESET",
    "net::ERR_CONNECTION_CLOSED",
    "read ECONNRESET",
    "write EPIPE",
    "socket hang up",
    "The stream was reset",
    "Premature close",
    "terminated",
  ]) {
    assert.equal(isTransientLlmError(new Error(m)), true, m);
    assert.equal(isTransportReset(new Error(m)), true, m);
  }
});

test("other transient network/service conditions are retryable but not resets", () => {
  for (const m of ["ETIMEDOUT", "fetch failed", "429 Too Many Requests", "503 Service Unavailable", "Gateway Timeout"]) {
    assert.equal(isTransientLlmError(new Error(m)), true, m);
    assert.equal(isTransportReset(new Error(m)), false, m);
  }
});

test("permanent failures are NEVER retried — retries cost metered requests", () => {
  // An org-policy refusal answers the same way every time; the run stops.
  assert.equal(isTransientLlmError(new AppError("not authorized", "copilot.entitlement")), false);
  // The user asked us to stop.
  assert.equal(isTransientLlmError(new AppError("cancelled", "auth.cancelled")), false);
  const aborted = new Error("The operation was aborted");
  aborted.name = "AbortError";
  assert.equal(isTransientLlmError(aborted), false);
  assert.equal(isTransientLlmError(new Error("Request cancelled by user")), false);
  // An unparseable/over-long response is a SIZING problem — the caller shrinks
  // the batch rather than re-sending an identical prompt.
  assert.equal(isTransientLlmError(new Error("Unexpected end of JSON input")), false);
  assert.equal(isTransientLlmError(new Error("model produced no tables")), false);
  assert.equal(isTransientLlmError(undefined), false);
  assert.equal(isTransientLlmError(null), false);
});

test("an AppError classified as network is retryable", () => {
  assert.equal(isTransientLlmError(new AppError("connection failed", "network")), true);
});

test("a reset hidden in the cause chain is still found", () => {
  // fetch surfaces "fetch failed" and hides the real reason on `cause`.
  const inner = new Error("read ECONNRESET");
  const outer = new Error("Failed to send request");
  (outer as unknown as { cause: unknown }).cause = inner;
  assert.match(errorText(outer), /ECONNRESET/);
  assert.equal(isTransientLlmError(outer), true);
  assert.equal(isTransportReset(outer), true);
});

test("errorText flattens messages, codes and cause chains without looping", () => {
  const e = new Error("outer") as Error & { code?: string; cause?: unknown };
  e.code = "ERR_X";
  e.cause = e; // self-referential: must not hang
  const text = errorText(e);
  assert.match(text, /outer/);
  assert.match(text, /ERR_X/);
  assert.equal(errorText("plain string"), "plain string");
  assert.equal(errorText(undefined), "");
});

test("a cancellation that ALSO mentions a reset is treated as a reset", () => {
  // Chromium sometimes reports a reset as an aborted request; the reset
  // signature is the more specific signal and wins.
  assert.equal(isTransientLlmError(new Error("request aborted: net::ERR_HTTP2_PROTOCOL_ERROR")), true);
});

test("backoff is short and bounded — a user is watching a progress bar", () => {
  assert.equal(retryDelayMs(1), 2_000);
  assert.equal(retryDelayMs(2), 6_000);
  assert.ok(retryDelayMs(99) <= 10_000, "capped");
  assert.equal(retryDelayMs(0), 2_000, "attempt numbers are 1-based, defensively");
  // Total added wait across the allowed retries stays modest.
  let total = 0;
  for (let i = 1; i <= MAX_TRANSIENT_RETRIES; i++) total += retryDelayMs(i);
  assert.ok(total <= 15_000, `total backoff ${total}ms`);
});

test("describeRetry names the proxy cause so a pause isn't a mystery", () => {
  const reset = describeRetry(new Error("net::ERR_HTTP2_PROTOCOL_ERROR"), 1, 2, 2_000);
  assert.match(reset, /SSL-inspecting proxy|HTTP\/2/);
  assert.match(reset, /attempt 1 of 2/);
  assert.match(reset, /in 2s/);
  assert.match(describeRetry(new Error("ETIMEDOUT"), 2, 2, 6_000), /temporary network/);
});
