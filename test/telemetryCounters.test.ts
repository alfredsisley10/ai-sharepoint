import { test } from "node:test";
import * as assert from "node:assert/strict";
import { sanitizeDimensions } from "../src/diagnostics/telemetrySink";
import { classifySendFailure } from "../src/core/interactionResilience";
import { detectProxyInterference } from "../src/core/networkDiagnostics";

// #69 — anonymized resilience counters (overflow / retry / proxy / probe). The
// values must survive the external-telemetry anonymizer: if a category token
// ever gains a space, slash, or other non-categorical character it is silently
// DROPPED before send, leaving a blind spot. These guards fail loudly if that
// happens, and they tie the emitted tokens to the live classifiers.

/** A dimension value is "kept" iff sanitizeDimensions round-trips it unchanged. */
function survives(value: string): boolean {
  return sanitizeDimensions({ kind: value }).kind === value;
}

test("chat.sendFailure / chat.autoRetry tokens survive anonymization", () => {
  // Mirror of SendFailureKind (interactionResilience.ts); autoRetry `mode` is a
  // subset (overflow | transient).
  for (const k of ["overflow", "blocked", "transient", "other"]) {
    assert.ok(survives(k), `sendFailure kind "${k}" must survive`);
  }
});

test("classifySendFailure only ever yields that safe token set", () => {
  const safe = new Set(["overflow", "blocked", "transient", "other"]);
  for (const msg of ["content was blocked by policy", "ECONNRESET socket hang up", "boom", "", undefined]) {
    const kind = classifySendFailure(msg);
    assert.ok(safe.has(kind), `unexpected kind "${kind}"`);
    assert.ok(survives(kind));
  }
});

test("network.check diagnosis kinds are all anonymization-safe (tied to the live detector)", () => {
  const samples: Array<Parameters<typeof detectProxyInterference>[0]> = [
    { errorText: "unable_to_verify_leaf_signature" }, // tls-inspection
    { status: 407 }, // proxy-auth
    { errorText: "this site has been blocked by your administrator" }, // blocked
    { errorText: "getaddrinfo enotfound host" }, // dns-filtered
    { errorText: "tunneling socket could not be established" }, // proxy-unreachable
  ];
  const seen = new Set<string>();
  for (const s of samples) {
    const kind = detectProxyInterference(s)?.kind;
    assert.ok(kind, `expected a diagnosis for ${JSON.stringify(s)}`);
    seen.add(kind!);
    assert.ok(survives(kind!), `network kind "${kind}" must survive anonymization`);
  }
  // Every documented kind exercised — so a renamed kind can't slip past unseen.
  assert.deepEqual(
    [...seen].sort(),
    ["blocked", "dns-filtered", "proxy-auth", "proxy-unreachable", "tls-inspection"],
  );
});

test("static probe / proxy-suspected counter tokens survive anonymization", () => {
  // context.probe outcome, network.check result, chat.proxySuspected hint.
  for (const v of ["reword", "heuristic", "completed", "cancelled", "clean", "blocked"]) {
    assert.ok(survives(v), `"${v}" must survive`);
  }
});
