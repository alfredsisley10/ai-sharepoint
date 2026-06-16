import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  isAccountActive,
  parseLdapUser,
  parseGraphUser,
  activeFromDirectory,
  contactOf,
  ldapUserFilter,
  ldapUserDirectory,
  m365UserDirectory,
  UserRecord,
} from "../src/context/userDirectory";
import { DEFAULT_CAPS } from "../src/context/types";

async function withFetch<T>(
  handler: (url: string) => { status?: number; body: unknown },
  run: () => Promise<T>,
): Promise<{ result: T; calls: string[] }> {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: unknown) => {
    calls.push(String(url));
    const r = handler(String(url));
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    return { result: await run(), calls };
  } finally {
    globalThis.fetch = original;
  }
}

test("isAccountActive reads the ACCOUNTDISABLE bit; unknown → active", () => {
  assert.equal(isAccountActive(512), true); // normal account
  assert.equal(isAccountActive(514), false); // 512 + 0x2 disabled
  assert.equal(isAccountActive("514"), false);
  assert.equal(isAccountActive(undefined), true);
  assert.equal(isAccountActive("not-a-number"), true);
});

test("parseLdapUser normalizes attrs (arrays, casing) → UserRecord", () => {
  assert.deepEqual(
    parseLdapUser({ sAMAccountName: ["JDoe"], userAccountControl: ["514"], mail: ["jdoe@x.com"], displayName: ["J Doe"] }),
    { sam: "jdoe", active: false, displayName: "J Doe", email: "jdoe@x.com" },
  );
  assert.equal(parseLdapUser({ mail: ["x@y"] }), undefined); // no sam
});

test("parseGraphUser maps a Graph user (accountEnabled, onPremisesSamAccountName)", () => {
  assert.deepEqual(
    parseGraphUser({ onPremisesSamAccountName: "ASmith", accountEnabled: false, mail: "a@x.com", userPrincipalName: "a@x.com" }),
    { sam: "asmith", active: false, email: "a@x.com", upn: "a@x.com" },
  );
});

test("activeFromDirectory: unknown user → inactive; contactOf prefers email", async () => {
  const dir = async (sam: string): Promise<UserRecord | undefined> =>
    sam === "jdoe" ? { sam: "jdoe", active: true, email: "jdoe@x", upn: "jdoe@upn" } : undefined;
  const isActive = activeFromDirectory(dir);
  assert.equal(await isActive("jdoe"), true);
  assert.equal(await isActive("ghost"), false);
  assert.equal(contactOf({ sam: "x", active: true, email: "e@x", upn: "u@x" }), "e@x");
  assert.equal(contactOf({ sam: "x", active: true, upn: "u@x" }), "u@x");
  assert.equal(contactOf(undefined), undefined);
});

test("ldapUserFilter targets the sam and escapes injection chars", () => {
  assert.equal(ldapUserFilter("jdoe"), "(&(objectClass=user)(sAMAccountName=jdoe))");
  assert.match(ldapUserFilter("a*b"), /sAMAccountName=a\\2ab/);
});

test("ldapUserDirectory looks up via the injected search", async () => {
  const dir = ldapUserDirectory(async (filter) => {
    assert.match(filter, /sAMAccountName=jdoe/);
    return [{ sAMAccountName: "jdoe", userAccountControl: "512", mail: "jdoe@x" }];
  });
  assert.deepEqual(await dir("jdoe"), { sam: "jdoe", active: true, email: "jdoe@x" });
});

test("m365UserDirectory filters by onPremisesSamAccountName and parses the user", async () => {
  const { result, calls } = await withFetch(
    () => ({ body: { value: [{ onPremisesSamAccountName: "JDoe", accountEnabled: true, mail: "jdoe@x.com", displayName: "J Doe" }] } }),
    () => m365UserDirectory("https://graph.microsoft.com/v1.0", () => Promise.resolve("tok"), DEFAULT_CAPS)("jdoe"),
  );
  assert.match(decodeURIComponent(calls[0]), /onPremisesSamAccountName eq 'jdoe'/);
  assert.deepEqual(result, { sam: "jdoe", active: true, displayName: "J Doe", email: "jdoe@x.com" });
});
