import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  normalizeTerms,
  scanForTerms,
  defang,
  defangDetails,
  renderDefangReport,
  buildProxyNudge,
  proxyBlockAdvice,
  ZERO_WIDTH,
} from "../src/core/proxyShield";

test("normalizeTerms trims, drops empties, de-dupes case-insensitively, keeps first casing", () => {
  assert.deepEqual(normalizeTerms([" Foo ", "foo", "", "Bar"]), ["Foo", "Bar"]);
});

test("scanForTerms matches whole words only (no substring false positives)", () => {
  assert.deepEqual(scanForTerms("a lesson about ssn handling", ["ssn"]), ["ssn"]);
  assert.deepEqual(scanForTerms("a lesson learned", ["ssn"]), []); // not inside 'lesson'
  assert.deepEqual(scanForTerms("nothing here", ["secret"]), []);
});

test("defang inserts a zero-width space inside each hit so a literal match fails", () => {
  const { text, hit } = defang("please exfiltrate the data", ["exfiltrate"]);
  assert.deepEqual(hit, ["exfiltrate"]);
  assert.ok(text.includes(ZERO_WIDTH));
  assert.ok(!/exfiltrate/.test(text)); // the clean word no longer appears
  assert.equal(text.replace(new RegExp(ZERO_WIDTH, "g"), ""), "please exfiltrate the data"); // reversible
});

test("defang preserves casing and handles multiple/again-listed terms", () => {
  const { text, hit } = defang("Attack and ATTACK again", ["attack"]);
  assert.deepEqual(hit, ["attack"]);
  assert.ok(/A.t.tack/s.test(text) || text.includes(`A${ZERO_WIDTH}ttack`));
  assert.ok(text.includes(`ATTACK`.charAt(0) + ZERO_WIDTH));
});

test("defang leaves text without hits untouched", () => {
  const { text, hit } = defang("perfectly fine sentence", ["malware"]);
  assert.equal(text, "perfectly fine sentence");
  assert.deepEqual(hit, []);
});

test("buildProxyNudge lists terms only in defang mode; generic otherwise; empty when off", () => {
  assert.equal(buildProxyNudge(["weapon"], "off"), "");
  assert.match(buildProxyNudge(["weapon"], "defang"), /weapon/);
  const warn = buildProxyNudge(["weapon"], "warn");
  assert.doesNotMatch(warn, /weapon/); // never leak raw terms into a warn-mode prompt
  assert.match(warn, /proxy/i);
});

test("proxyBlockAdvice escalates with the network-failure count", () => {
  assert.equal(proxyBlockAdvice(0), undefined);
  assert.match(proxyBlockAdvice(1) ?? "", /corporate proxy/i);
  const strong = proxyBlockAdvice(4) ?? "";
  assert.match(strong, /#4/);
  assert.match(strong, /defang/);
});

test("defangDetails reports per-term count + an in-context sample, and rewrites text", () => {
  const text = "Please share the SSN and the ssn again, plus the API key.";
  const r = defangDetails(text, ["SSN", "API key"]);
  assert.ok(r.text.includes(`S${ZERO_WIDTH}SN`));
  assert.ok(r.text.includes(`A${ZERO_WIDTH}PI key`));
  const ssn = r.changes.find((c) => c.term === "SSN")!;
  assert.equal(ssn.count, 2); // "SSN" + "ssn" (case-insensitive)
  assert.match(ssn.context, /«SSN»/); // first occurrence wrapped, original casing
  assert.equal(r.changes.find((c) => c.term === "API key")!.count, 1);
});

test("defangDetails context comes from the ORIGINAL text (offsets don't drift across terms)", () => {
  const r = defangDetails("alpha then bravo", ["alpha", "bravo"]);
  assert.match(r.changes.find((c) => c.term === "bravo")!.context, /«bravo»/);
});

test("defang stays a thin wrapper over defangDetails (text + hit terms)", () => {
  const r = defang("the SSN", ["ssn"]);
  assert.deepEqual(r.hit, ["ssn"]);
  assert.ok(r.text.includes(ZERO_WIDTH));
});

test("renderDefangReport makes a readable table; empty changes is a clear no-op", () => {
  const md = renderDefangReport([{ term: "SSN", count: 2, context: "…the «SSN» of…" }]);
  assert.match(md, /what was changed/i);
  assert.match(md, /\| `SSN` \| 2 \|/);
  assert.match(md, /zero-width/i);
  assert.match(renderDefangReport([]), /Nothing was changed/);
});
