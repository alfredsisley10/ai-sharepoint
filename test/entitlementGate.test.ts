import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  EntitlementGate,
  isEntitlementFailure,
  ENTITLEMENT_COOLDOWN_MS,
} from "../src/copilot/entitlementGate";

test("isEntitlementFailure matches the pilot 403 and LM NoPermissions shapes", () => {
  // The exact text seen in the GitHub Copilot Chat output (pilot).
  assert.ok(
    isEntitlementFailure(
      new Error('403 "unauthorized: not authorized to use this Copilot feature/"'),
    ),
  );
  assert.ok(isEntitlementFailure(new Error("Request Failed: 403 forbidden")));
  assert.ok(isEntitlementFailure(new Error("Unauthorised access")));
  assert.ok(isEntitlementFailure({ code: "NoPermissions", message: "consent denied" }));
});

test("isEntitlementFailure leaves transient/cancelled/network errors ungated", () => {
  assert.ok(!isEntitlementFailure(new Error("Canceled")));
  assert.ok(!isEntitlementFailure(new Error("net::ERR_CONNECTION_RESET")));
  assert.ok(!isEntitlementFailure(new Error("Request Failed: 429 too many requests")));
  assert.ok(!isEntitlementFailure(new Error("model_not_supported")));
  assert.ok(!isEntitlementFailure(undefined));
});

test("the gate opens for the cooldown, reports remaining time, then expires", () => {
  const gate = new EntitlementGate();
  const t0 = 1_000_000;
  assert.equal(gate.check(t0), undefined);
  gate.open("403 not authorized to use this Copilot feature", t0);
  const block = gate.check(t0 + 60_000);
  assert.ok(block);
  assert.match(block.reason, /not authorized/);
  assert.equal(block.remainingMs, ENTITLEMENT_COOLDOWN_MS - 60_000);
  // Expiry closes it without an explicit reset.
  assert.equal(gate.check(t0 + ENTITLEMENT_COOLDOWN_MS), undefined);
  // …and stays closed afterwards.
  assert.equal(gate.check(t0 + ENTITLEMENT_COOLDOWN_MS + 1), undefined);
});

test("reset closes the gate early (success or explicit user retry)", () => {
  const gate = new EntitlementGate();
  gate.open("403", 0);
  assert.ok(gate.check(1));
  gate.reset();
  assert.equal(gate.check(2), undefined);
});

test("long upstream messages are capped in the stored reason", () => {
  const gate = new EntitlementGate();
  gate.open(`403 ${"x".repeat(1000)}`, 0);
  assert.ok((gate.check(1)?.reason.length ?? 0) <= 300);
});
