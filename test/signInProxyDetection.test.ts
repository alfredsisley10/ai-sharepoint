import { test } from "node:test";
import * as assert from "node:assert/strict";
import { mapDbError } from "../src/context/db/dbAdapters";
import { toAppError } from "../src/context/ldap/ldapClient";
import { describeSignInFailure } from "../src/auth/signInDiagnostics";
import { AppError } from "../src/core/errors";

// #67 — extend the corporate proxy / SSL-inspection / content-filter detector
// (already covered for the HTTP + Graph layers) into the database, LDAP, and
// MSAL sign-in failure paths. DB/LDAP run on raw sockets, so only the
// TLS-interception case is surfaced there (with the appliance named); MSAL is
// HTTPS, so the full guidance applies.

// --- database -------------------------------------------------------------

test("mapDbError names the SSL-inspection appliance and keeps the DB CA remedy", () => {
  // A Zscaler fingerprint surfaced through a wrapped cause — the shape Node
  // drivers throw when an inspection appliance re-signs the TLS handshake.
  const wrapped = new Error("connection terminated", {
    cause: Object.assign(new Error("zscaler root ca"), { code: "SELF_SIGNED_CERT_IN_CHAIN" }),
  });
  const mapped = mapDbError(wrapped, "PostgreSQL");
  assert.equal(mapped.code, "config");
  assert.match(mapped.userSummary!, /looks like Zscaler/);
  assert.match(mapped.userSummary!, /corporate CA|trustServerCertificate/);
});

test("mapDbError still classifies an auth rejection as auth.failed (not proxy)", () => {
  const err = Object.assign(new Error("password authentication failed for user"), { code: "28P01" });
  const mapped = mapDbError(err, "PostgreSQL");
  assert.equal(mapped.code, "auth.failed");
});

test("mapDbError catches a broader TLS variant the old regex missed, without a vendor", () => {
  const err = Object.assign(new Error("unable to verify the first certificate"), { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" });
  const mapped = mapDbError(err, "MySQL");
  assert.equal(mapped.code, "config");
  assert.doesNotMatch(mapped.userSummary!, /looks like/);
});

test("mapDbError leaves an unrelated error as unknown", () => {
  const mapped = mapDbError(new Error("totally unexpected driver state"), "MongoDB");
  assert.equal(mapped.code, "unknown");
});

test("mapDbError passes an existing AppError through unchanged", () => {
  const original = new AppError("already classified", "config", "summary");
  assert.equal(mapDbError(original, "SQL Server"), original);
});

// --- LDAP -----------------------------------------------------------------

test("toAppError names the appliance for an intercepted LDAPS handshake", () => {
  const err = new Error("self-signed certificate in certificate chain — netskope inspection");
  const mapped = toAppError(err);
  assert.equal(mapped.code, "config");
  assert.match(mapped.userSummary!, /looks like Netskope/);
  assert.match(mapped.userSummary!, /aiSharePoint\.ldap\.caCertificatesFile/);
});

test("toAppError still treats invalid credentials as auth.failed", () => {
  const err = Object.assign(new Error("bind failed"), { code: 49 });
  assert.equal(toAppError(err).code, "auth.failed");
});

test("toAppError keeps a plain unreachable-DC error on the network path", () => {
  const err = Object.assign(new Error("connect ETIMEDOUT 10.0.0.5:636"), { code: "ETIMEDOUT" });
  assert.equal(toAppError(err).code, "network");
});

// --- MSAL sign-in ---------------------------------------------------------

const AUTHORITY = "https://login.microsoftonline.com/common";

test("describeSignInFailure converts a TLS-inspection sign-in failure to actionable config guidance", () => {
  const err = new TypeError("fetch failed", {
    cause: Object.assign(new Error("self signed certificate in certificate chain"), { code: "SELF_SIGNED_CERT_IN_CHAIN" }),
  });
  const out = describeSignInFailure(err, AUTHORITY);
  assert.ok(out instanceof AppError);
  assert.equal((out as AppError).code, "config");
  assert.match((out as AppError).message, /Sign-in couldn't reach Microsoft/);
  assert.match((out as AppError).message, /NODE_EXTRA_CA_CERTS/);
});

test("describeSignInFailure flags a blocked/DNS-filtered authority as a network issue", () => {
  const err = Object.assign(new Error("getaddrinfo ENOTFOUND login.microsoftonline.com"), { code: "ENOTFOUND" });
  const out = describeSignInFailure(err, AUTHORITY);
  assert.ok(out instanceof AppError);
  assert.equal((out as AppError).code, "network");
  assert.match((out as AppError).message, /login\.microsoftonline\.com/);
});

test("describeSignInFailure leaves a genuine auth error (no proxy fingerprint) untouched", () => {
  const err = new Error("AADSTS50058: a silent sign-in request was sent but no user is signed in");
  const out = describeSignInFailure(err, AUTHORITY);
  assert.equal(out, err); // returned as-is, not wrapped
  assert.ok(!(out instanceof AppError));
});

test("describeSignInFailure passes an already-classified AppError through", () => {
  const original = new AppError("Sign-in state mismatch — possible forged redirect.", "auth.failed");
  assert.equal(describeSignInFailure(original, AUTHORITY), original);
});

test("a failed statement names the statement", async () => {
  const { mapDbError } = await import("../src/context/db/dbAdapters");
  const sql = "SELECT MAX([lst_upd_dt]) AS last_updated FROM [dbo].[Orders]";
  const mapped = mapDbError(new Error("Invalid object name 'dbo.Orders'."), "SQL Server", sql);
  // "SQL Server error: Invalid object name" names neither the object nor which
  // of a run's many statements produced it.
  assert.match(mapped.message, /Invalid object name/);
  assert.match(mapped.message, /statement: SELECT MAX\(\[lst_upd_dt\]\)/);

  // A timeout is the case where knowing WHICH query ran is the whole question.
  const slow = mapDbError(new Error("Timeout: Request failed to complete in 30000ms"), "SQL Server", sql);
  assert.match(slow.message, /statement:/);
  assert.equal(slow.code, "config");

  // Auth and connection failures are about the SESSION, not a statement —
  // attaching SQL there would be noise pointing at the wrong thing.
  const auth = mapDbError(new Error("Login failed for user 'svc'. ELOGIN"), "SQL Server", sql);
  assert.equal(auth.code, "auth.failed");
  assert.ok(!auth.message.includes("statement:"), auth.message);
});

test("an error with an EMPTY message still reports the reason", async () => {
  const { mapDbError } = await import("../src/context/db/dbAdapters");
  // The reported defect: `e.message ?? String(err)` does not fall back on an
  // empty string, so a driver that leaves `message` blank produced
  // "MySQL error: " — a message that reports nothing while looking reported.
  const err = Object.assign(new Error(""), {
    sqlMessage: "Unknown column 'lst_upd_dt' in 'field list'",
    code: "ER_BAD_FIELD_ERROR",
  });
  const mapped = mapDbError(err, "MySQL", "SELECT MAX(`lst_upd_dt`) FROM `t`");
  assert.match(mapped.message, /Unknown column/);
  assert.ok(!/MySQL error:\s*(—|$)/.test(mapped.message), `still empty: ${mapped.message}`);
});

test("statementForError keeps an error to one readable line", async () => {
  const { statementForError } = await import("../src/context/db/dbAdapters");
  // A multi-line statement must not break the single log line it rides in.
  assert.equal(statementForError("SELECT a,\n  b\nFROM t"), "SELECT a, b FROM t");
  assert.equal(statementForError(undefined), "");
  assert.equal(statementForError("   "), "");
  // And a huge generated query must not bury the reason it accompanies.
  const long = statementForError(`SELECT ${"x".repeat(2000)} FROM t`, 100);
  assert.ok(long.length < 140, String(long.length));
  assert.match(long, /\+\d+ chars/);
});
