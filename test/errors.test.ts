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

test("describeError never returns an empty string", async () => {
  const { describeError } = await import("../src/core/errors");
  // The reported bug: a log line that ends at the colon looks like the error
  // was reported when it wasn't, so the reader stops looking.
  for (const v of [undefined, null, "", {}, new Error(""), 0, false, [], Symbol("x")]) {
    assert.notEqual(describeError(v), "", `empty for ${String(v)}`);
  }
});

test("describeError reads the fields drivers actually use", async () => {
  const { describeError } = await import("../src/core/errors");
  // mysql2: the server's text is on sqlMessage, not message.
  const mysql = Object.assign(new Error(""), {
    sqlMessage: "Unknown column 'lst_upd_dt' in 'field list'",
    code: "ER_BAD_FIELD_ERROR",
    errno: 1054,
  });
  const my = describeError(mysql);
  assert.match(my, /Unknown column/);
  assert.match(my, /ER_BAD_FIELD_ERROR/);
  assert.match(my, /errno=1054/);

  // node-postgres splits the reason across detail/hint, and carries a SQLSTATE.
  const pg = Object.assign(new Error('relation "dbo.orders" does not exist'), {
    detail: "Perhaps you meant public.orders",
    code: "42P01",
    severity: "ERROR",
  });
  const p = describeError(pg);
  assert.match(p, /does not exist/);
  assert.match(p, /Perhaps you meant/);
  assert.match(p, /code=42P01/);

  // MongoDB puts it on errmsg with a codeName.
  const mongo = { errmsg: "not authorized on admin to execute command", codeName: "Unauthorized", code: 13 };
  assert.match(describeError(mongo), /not authorized/);
  assert.match(describeError(mongo), /Unauthorized/);

  // tedious wraps the real failure in originalError.
  const tds = Object.assign(new Error("Connection lost"), {
    originalError: Object.assign(new Error("Invalid object name 'dbo.Missing'."), { number: 208 }),
  });
  assert.match(describeError(tds), /Invalid object name/);
  assert.match(describeError(tds), /number=208/);
});

test("describeError survives the shapes that could hang or say nothing", async () => {
  const { describeError } = await import("../src/core/errors");
  // Self-referential cause: must terminate.
  const loop = new Error("outer") as Error & { cause?: unknown };
  loop.cause = loop;
  assert.match(describeError(loop), /outer/);

  // A mutual cycle two levels deep.
  const a = new Error("a") as Error & { cause?: unknown };
  const b = new Error("b") as Error & { cause?: unknown };
  a.cause = b;
  b.cause = a;
  assert.match(describeError(a), /a/);
  assert.match(describeError(a), /b/);

  // AggregateError: the members carry the reasons, the wrapper carries none.
  const agg = new AggregateError([new Error("ECONNREFUSED 10.0.0.1"), new Error("ECONNREFUSED 10.0.0.2")], "");
  assert.match(describeError(agg), /10\.0\.0\.1/);

  // A bare object with no known fields still yields something readable
  // rather than "[object Object]".
  const opaque = describeError({ weird: "shape", n: 1 });
  assert.notEqual(opaque, "");
  assert.ok(!opaque.includes("[object Object]"), opaque);
});

test("describeError does not repeat itself", async () => {
  const { describeError } = await import("../src/core/errors");
  // Drivers commonly set message === sqlMessage; saying it twice buries the code.
  const dup = Object.assign(new Error("Table 'x' doesn't exist"), {
    sqlMessage: "Table 'x' doesn't exist",
  });
  assert.equal((describeError(dup).match(/doesn't exist/g) ?? []).length, 1);
});
