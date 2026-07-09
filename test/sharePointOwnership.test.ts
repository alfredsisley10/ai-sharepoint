import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  extractPageEditors,
  resolveSharePointOwners,
  fetchSharePointPageEditors,
} from "../src/auth/sharePointOwnership";
import { ldapUserFilterByEmail, ldapUserDirectoryByEmail } from "../src/context/userDirectory";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 6, 1);

function versions(...rows: Array<{ email?: string; upn?: string; name?: string; when?: string }>) {
  return {
    value: rows.map((r) => ({
      lastModifiedDateTime: r.when,
      lastModifiedBy: { user: { email: r.email, userPrincipalName: r.upn, displayName: r.name } },
    })),
  };
}

test("extractPageEditors: pulls email/UPN + timestamp, lowercased; skips userless versions", () => {
  const eds = extractPageEditors(
    versions(
      { email: "JDoe@x.com", name: "J Doe", when: new Date(NOW).toISOString() },
      { upn: "asmith@x.com", when: new Date(NOW - DAY).toISOString() },
      { name: "system only" }, // no email/upn → skipped
    ),
  );
  assert.equal(eds.length, 2);
  assert.equal(eds[0].identity, "jdoe@x.com");
  assert.equal(eds[0].displayName, "J Doe");
  assert.equal(eds[1].identity, "asmith@x.com");
});

test("resolveSharePointOwners: most recently-active editor who is a current active employee", async () => {
  const eds = extractPageEditors(
    versions(
      ...Array.from({ length: 8 }, () => ({ email: "oldpro@x.com", when: new Date(NOW - 700 * DAY).toISOString() })),
      ...Array.from({ length: 2 }, () => ({ email: "recent@x.com", when: new Date(NOW - 3 * DAY).toISOString() })),
    ),
  );
  // recent@ ranks first by recency; both active → recent wins.
  const r1 = await resolveSharePointOwners(eds, async () => true, { nowMs: NOW });
  assert.deepEqual(r1.owners, ["recent@x.com"]);
  assert.equal(r1.basis, "page-contributor");

  // recent@ has left (inactive) → falls through to the active oldpro.
  const r2 = await resolveSharePointOwners(eds, async (id) => id !== "recent@x.com", { nowMs: NOW });
  assert.deepEqual(r2.owners, ["oldpro@x.com"]);

  // nobody active → none.
  const r3 = await resolveSharePointOwners(eds, async () => false, { nowMs: NOW });
  assert.equal(r3.basis, "none");
});

test("resolveSharePointOwners: no editors → none with a helpful note", async () => {
  const r = await resolveSharePointOwners([], async () => true, { nowMs: NOW });
  assert.equal(r.basis, "none");
  assert.match(r.note ?? "", /No version history/);
});

test("fetchSharePointPageEditors: parses the injected Graph payload; a failed read is CAPTURED, not silent", async () => {
  const read = await fetchSharePointPageEditors(
    async (path) => {
      assert.match(path, /\/sites\/S\/lists\/L\/items\/7\/versions/);
      return versions({ email: "a@x.com", when: new Date(NOW).toISOString() });
    },
    "S",
    "L",
    "7",
  );
  assert.equal(read.editors[0].identity, "a@x.com");
  assert.equal(read.readError, undefined);

  // A non-abort failure degrades to a captured readError — distinguishable
  // from a genuinely empty history — with the message redacted.
  const failed = await fetchSharePointPageEditors(async () => {
    throw new Error("403 restricted for dave@corp.example.com");
  }, "S", "L", "7");
  assert.deepEqual(failed.editors, []);
  assert.match(failed.readError?.message ?? "", /403 restricted/);
  assert.doesNotMatch(failed.readError?.message ?? "", /dave@corp\.example\.com/);
  assert.equal(failed.readError?.kind, "graph.forbidden");
});

test("fetchSharePointPageEditors: auth rejection and throttling RETHROW (breaker integrity)", async () => {
  const { AppError } = await import("../src/core/errors");
  await assert.rejects(
    fetchSharePointPageEditors(async () => {
      throw new AppError("Authentication rejected (401).", "auth.failed");
    }, "S", "L", "7"),
    /Authentication rejected/,
  );
  await assert.rejects(
    fetchSharePointPageEditors(async () => {
      throw new AppError("Source is throttling requests (429).", "graph.throttled");
    }, "S", "L", "7"),
    /throttling/,
  );
});

test("resolveSharePointOwners: a directory OUTAGE degrades to the deterministic unverified top pick", async () => {
  const eds = [
    { identity: "top@x.com", whenMs: NOW - 1 * 86_400_000 },
    { identity: "second@x.com", whenMs: NOW - 2 * 86_400_000 },
  ];
  const r = await resolveSharePointOwners(
    eds,
    async (id) => {
      if (id === "top@x.com") return false; // verified inactive…
      throw new Error("LDAP connect ECONNREFUSED"); // …then the directory dies
    },
    { nowMs: NOW, directoryWired: true },
  );
  assert.deepEqual(r.owners, ["top@x.com"], "deterministic top pick, not fault-timing dependent");
  assert.equal(r.verification, "unavailable");
  assert.match(r.directoryFault ?? "", /ECONNREFUSED/);
});

test("resolveSharePointOwners: a threaded readError changes the 'none' note from 'no history' to 'read failed'", async () => {
  const r = await resolveSharePointOwners([], async () => true, {
    nowMs: NOW,
    directoryWired: false,
    readError: { message: "GET /sites/... → Forbidden (403)", kind: "graph.forbidden" },
  });
  assert.equal(r.basis, "none");
  assert.match(r.note ?? "", /could not be READ/i);
  assert.doesNotMatch(r.note ?? "", /No version history \/ editors available/);
  assert.equal(r.readError?.kind, "graph.forbidden");
});

test("ldapUserFilterByEmail: matches mail/upn/proxyAddress and escapes injection", () => {
  const f = ldapUserFilterByEmail("a@x.com");
  assert.match(f, /\(mail=a@x\.com\)/);
  assert.match(f, /userPrincipalName=a@x\.com/);
  assert.match(f, /proxyAddresses=smtp:a@x\.com/);
  assert.ok(ldapUserFilterByEmail("a)(*b").includes("\\29")); // ) escaped
});

test("ldapUserDirectoryByEmail: resolves by email; ignores non-emails", async () => {
  const dir = ldapUserDirectoryByEmail(async (filter) => {
    assert.match(filter, /mail=jdoe@x\.com/);
    return [{ sAMAccountName: "jdoe", userAccountControl: "512", mail: "jdoe@x.com" }];
  });
  const rec = await dir("jdoe@x.com");
  assert.equal(rec?.sam, "jdoe");
  assert.equal(rec?.active, true);
  assert.equal(await dir("not-an-email"), undefined);
});
