import { test } from "node:test";
import * as assert from "node:assert/strict";
import { msCorrelationSuffix } from "../src/core/msCorrelation";
import { redactText } from "../src/core/redaction";

const bag = (h: Record<string, string>) => ({ get: (n: string) => h[n] ?? null });
const GUID_A = "0fae33d1-1c2a-4b33-9a55-cafe00112233";
const GUID_B = "11112222-3333-4444-5555-666677778888";

test("msCorrelationSuffix captures request-id and a distinct client-request-id", () => {
  assert.equal(
    msCorrelationSuffix(bag({ "request-id": GUID_A, "client-request-id": GUID_B })),
    ` [request-id=${GUID_A} client-request-id=${GUID_B}]`,
  );
});

test("msCorrelationSuffix collapses an echoed client-request-id and skips non-GUIDs", () => {
  assert.equal(msCorrelationSuffix(bag({ "request-id": GUID_A, "client-request-id": GUID_A })), ` [request-id=${GUID_A}]`);
  assert.equal(msCorrelationSuffix(bag({ "request-id": "not-a-guid" })), "");
  assert.equal(msCorrelationSuffix(bag({})), "");
});

test("redaction preserves labeled MS correlation IDs but still redacts bare/other GUIDs", () => {
  const suffix = msCorrelationSuffix(bag({ "request-id": GUID_A, "client-request-id": GUID_B }));
  const redacted = redactText(`Graph request failed (403 Forbidden)${suffix}`);
  assert.match(redacted, new RegExp(`request-id=${GUID_A}`));
  assert.match(redacted, new RegExp(`client-request-id=${GUID_B}`));
  // A GUID that is NOT a correlation id (e.g. a site id) is still redacted.
  assert.match(redactText(`siteId=${GUID_A}`), /\[redacted:guid\]/);
});
