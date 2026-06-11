import { test } from "node:test";
import * as assert from "node:assert/strict";
import { anonToken, anonHost, anonUrlHost } from "../src/core/anonymize";

test("anonToken is deterministic per salt and never echoes input", () => {
  const a = anonToken("contoso", "salt-1");
  const b = anonToken("contoso", "salt-1");
  const c = anonToken("contoso", "salt-2");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^anon-[0-9a-f]{10}$/);
  assert.ok(!a.includes("contoso"));
});

test("anonHost keeps the structural sharepoint suffix", () => {
  const out = anonHost("Contoso.sharepoint.com", "s");
  assert.match(out, /^anon-[0-9a-f]{10}\.sharepoint\.com$/);
  const us = anonHost("agency.sharepoint.us", "s");
  assert.match(us, /\.sharepoint\.us$/);
});

test("anonHost fully hashes non-sharepoint hosts", () => {
  const out = anonHost("intranet.corp.example", "s");
  assert.match(out, /^anon-[0-9a-f]{10}$/);
});

test("anonUrlHost extracts and anonymizes the host", () => {
  const out = anonUrlHost("https://contoso.sharepoint.com/sites/HR", "s");
  assert.match(out, /^anon-[0-9a-f]{10}\.sharepoint\.com$/);
});
