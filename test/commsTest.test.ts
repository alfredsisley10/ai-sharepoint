import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  verificationKey,
  generateVerificationCode,
  codeMatches,
  buildTestMessage,
  verifiedLabel,
} from "../src/comms/commsTest";

test("verificationKey: shared per channel, per-name for webhooks", () => {
  assert.equal(verificationKey("outlook"), "outlook");
  assert.equal(verificationKey("teams-graph"), "teams-graph");
  assert.equal(verificationKey("teams-webhook", "IT Ops"), "teams-webhook:it ops");
  assert.notEqual(verificationKey("teams-webhook", "A"), verificationKey("teams-webhook", "B"));
});

test("generateVerificationCode: grouped, look-alike-free, reasonably unique", () => {
  const code = generateVerificationCode(() => 0.5);
  assert.match(code, /^[A-Z2-9]{3}-[A-Z2-9]{3}$/);
  assert.ok(!/[01ISO5]/.test(code.replace(/-/g, "")), "no ambiguous glyphs");
  const seen = new Set(Array.from({ length: 200 }, () => generateVerificationCode()));
  assert.ok(seen.size > 150, "codes vary");
});

test("codeMatches: case/space/dash-insensitive and forgives look-alike mistypes", () => {
  assert.ok(codeMatches("ABC-D29", "ABC-D29"));
  assert.ok(codeMatches("abcd29", "ABC-D29"));
  assert.ok(codeMatches("ABC D29", "ABC-D29"));
  // A reader who typed O for the (absent) 0, l for I, etc. still matches.
  assert.ok(codeMatches("ABCDZ9", "ABCDZ9"));
  assert.ok(codeMatches("0BC-D29", "OBC-D29"));
  assert.ok(!codeMatches("", "ABC-D29"));
  assert.ok(!codeMatches("XYZ-999", "ABC-D29"));
});

test("buildTestMessage puts the code in subject and body with a clear instruction", () => {
  const m = buildTestMessage("ABC-D29", "Outlook email");
  assert.match(m.subject, /code ABC-D29/);
  assert.match(m.body, /Verification code: ABC-D29/);
  assert.match(m.body, /Outlook email delivery works/);
});

test("verifiedLabel reflects state", () => {
  assert.equal(verifiedLabel(undefined), "not verified yet");
  assert.match(verifiedLabel("2026-06-12T10:00:00.000Z"), /^verified 2026-06-12$/);
});
