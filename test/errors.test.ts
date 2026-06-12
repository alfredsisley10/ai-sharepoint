import { test } from "node:test";
import * as assert from "node:assert/strict";
import { classifyError, AppError, adviceFor, adviceForError } from "../src/core/errors";

test("AppError carries its own code", () => {
  assert.equal(classifyError(new AppError("x", "graph.throttled")), "graph.throttled");
});

test("classification from message shapes", () => {
  assert.equal(classifyError(new Error("Sign-in timed out after 5 minutes.")), "auth.timeout");
  assert.equal(classifyError(new Error("AADSTS50126: bad creds")), "auth.failed");
  assert.equal(classifyError(new Error("Graph request failed (403 Forbidden): x")), "graph.forbidden");
  assert.equal(classifyError(new Error("Graph request failed (404 Not Found): x")), "graph.notFound");
  assert.equal(classifyError(new Error("429 TooManyRequests")), "graph.throttled");
  assert.equal(classifyError(new Error("fetch failed: ECONNREFUSED")), "network");
  assert.equal(classifyError(new Error("No Copilot chat models are available")), "copilot.unavailable");
  assert.equal(classifyError("mystery"), "unknown");
});

test("user cancellation is recognized and silent", () => {
  assert.equal(classifyError(new Error("user_cancelled: User cancelled the flow")), "auth.cancelled");
  assert.equal(adviceFor("auth.cancelled"), undefined);
});

test("advice exists for actionable codes", () => {
  for (const code of ["auth.failed", "graph.forbidden", "network", "copilot.unavailable"] as const) {
    assert.ok(adviceFor(code));
  }
});

test("an error with its own remediation suppresses generic advice (no Entra text on session expiry)", () => {
  const own = new AppError("Splunk rejected the sign-in (401).", "auth.failed", "Your Splunk browser session has expired — re-capture the cookie.");
  assert.equal(adviceForError(own, "auth.failed"), undefined);
  // No userSummary → the generic per-code advice still applies.
  assert.match(adviceForError(new AppError("x", "auth.failed"), "auth.failed") ?? "", /administrator/);
  assert.match(adviceForError(new Error("AADSTS50126"), "auth.failed") ?? "", /administrator/);
});
