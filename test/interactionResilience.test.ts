import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  classifySendFailure,
  planSendRetry,
  tightenCap,
  suggestReword,
} from "../src/core/interactionResilience";
import {
  nextProbeSize,
  probeConverged,
  probeFiller,
  initialProbeWindow,
  calibrationSize,
} from "../src/core/contextProbe";

// --- failure classification ----------------------------------------------

test("classifySendFailure distinguishes overflow / blocked / transient / other", () => {
  assert.equal(classifySendFailure("This model's maximum context length is 8192 tokens"), "overflow");
  assert.equal(classifySendFailure("prompt is too long"), "overflow");
  assert.equal(classifySendFailure("Your request was blocked by your organization's policy"), "blocked");
  assert.equal(classifySendFailure("content filter triggered"), "blocked");
  assert.equal(classifySendFailure("read ECONNRESET"), "transient");
  assert.equal(classifySendFailure("fetch failed"), "transient");
  assert.equal(classifySendFailure("HTTP 503 service unavailable"), "transient");
  assert.equal(classifySendFailure("I'm a teapot"), "other");
  assert.equal(classifySendFailure(undefined), "other");
});

// --- retry planning -------------------------------------------------------

test("planSendRetry retries overflow under a tighter budget, bounded", () => {
  const first = planSendRetry({ kind: "overflow", sawText: false, overflowRetriesUsed: 0, transientRetriesUsed: 0 });
  assert.deepEqual([first.retry, first.tightenBudget], [true, true]);
  // exhausted
  assert.equal(planSendRetry({ kind: "overflow", sawText: false, overflowRetriesUsed: 2, transientRetriesUsed: 0 }).retry, false);
});

test("planSendRetry retries a transient drop once, only when nothing streamed", () => {
  assert.equal(planSendRetry({ kind: "transient", sawText: false, overflowRetriesUsed: 0, transientRetriesUsed: 0 }).retry, true);
  // already streamed text → don't re-send (would duplicate)
  assert.equal(planSendRetry({ kind: "transient", sawText: true, overflowRetriesUsed: 0, transientRetriesUsed: 0 }).retry, false);
  // already retried
  assert.equal(planSendRetry({ kind: "transient", sawText: false, overflowRetriesUsed: 0, transientRetriesUsed: 1 }).retry, false);
});

test("planSendRetry never auto-retries a content block or an unknown error", () => {
  assert.equal(planSendRetry({ kind: "blocked", sawText: false, overflowRetriesUsed: 0, transientRetriesUsed: 0 }).retry, false);
  assert.equal(planSendRetry({ kind: "other", sawText: false, overflowRetriesUsed: 0, transientRetriesUsed: 0 }).retry, false);
});

test("tightenCap shaves under the smaller of cap/attempted, with a floor", () => {
  assert.equal(tightenCap(10000, 8000), 5600); // min(10000,8000)*0.7
  assert.equal(tightenCap(1000, 0), 700); // no attempted → shave the cap
  assert.equal(tightenCap(500, 400), 512); // floor protects against collapse
});

// --- reword suggestion ----------------------------------------------------

test("suggestReword names the avoid-terms present and adapts to the proxy mode", () => {
  const off = suggestReword({ termsInPrompt: ["merger", "layoff"], mode: "off" });
  assert.match(off ?? "", /“merger”, “layoff”/);
  assert.match(off ?? "", /defang/);
  const defang = suggestReword({ termsInPrompt: ["merger"], mode: "defang" });
  assert.match(defang ?? "", /already on/);
  assert.equal(suggestReword({ termsInPrompt: [], mode: "warn" }), undefined);
});

// --- active context-limit probe ------------------------------------------

test("nextProbeSize bisects until converged within tolerance", () => {
  assert.equal(nextProbeSize(1000, 9000, 2000), 5000);
  assert.equal(nextProbeSize(4000, 5000, 2000), undefined); // window <= tolerance
  assert.equal(probeConverged(4000, 5000, 2000), true);
  assert.equal(probeConverged(1000, 9000, 2000), false);
});

test("initialProbeWindow seeds from advertised + known-good with sane floors", () => {
  assert.deepEqual(initialProbeWindow(64000, 12000), { low: 12000, high: 64000 });
  // no advertised → generous ceiling; no known-good → 1000 floor
  const w = initialProbeWindow(undefined, undefined);
  assert.equal(w.low, 1000);
  assert.ok(w.high > w.low);
  // known-good above advertised is clamped to the ceiling (low==high → high+1)
  assert.deepEqual(initialProbeWindow(8000, 20000), { low: 8000, high: 8001 });
});

test("probeFiller produces roughly the requested token count in distinct words", () => {
  const f = probeFiller(50);
  assert.equal(f.split(" ").length, 50);
  assert.match(f, /\bw0\b/);
});

test("calibrationSize targets just under the advertised ceiling (or undefined)", () => {
  assert.equal(calibrationSize(64000), 60800); // floor(64000 * 0.95)
  assert.equal(calibrationSize(500), 1000); // small models floored to 1000
  assert.equal(calibrationSize(undefined), undefined);
  assert.equal(calibrationSize(0), undefined);
});
