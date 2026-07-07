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
  // No userSummary → the generic per-code advice still applies. It leads with
  // the connector-agnostic action (re-enter the credential) and scopes the
  // Entra/tenant guidance to Microsoft sign-in only.
  const authAdvice = adviceForError(new AppError("x", "auth.failed"), "auth.failed") ?? "";
  assert.match(authAdvice, /re-enter the credential/i);
  assert.match(authAdvice, /Microsoft\/Entra sign-in only.*tenant/i);
  assert.match(adviceForError(new Error("AADSTS50126"), "auth.failed") ?? "", /tenant/);
});

test("generic network advice is provider-neutral — never names Microsoft hosts for a non-Microsoft connector", () => {
  // Regression: a Jira basic-auth refresh hit an un-fingerprinted network
  // failure and the fallback advice told the user to allowlist
  // login.microsoftonline.com / graph.microsoft.com (nonsense for Jira). The
  // un-fingerprinted network fallback is host-agnostic and must stay neutral.
  const advice = adviceForError(new AppError("Context request failed: fetch failed", "network"), "network") ?? "";
  assert.doesNotMatch(advice, /microsoftonline|graph\.microsoft/i);
  assert.match(advice, /this connector's host is allowlisted/i);
});
