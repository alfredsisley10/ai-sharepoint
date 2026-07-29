import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  FETCHER_KEYS,
  currentFetcherMode,
  nodeFetcherSettings,
  revertFetcherSettings,
  adviseFetcher,
  ResetTracker,
  RESET_THRESHOLD,
} from "../src/copilot/fetcherStrategy";

test("currentFetcherMode reads the effective transport", () => {
  assert.equal(currentFetcherMode(undefined), "unset", "no config = Copilot's Electron-first default");
  assert.equal(currentFetcherMode({}), "unset");
  assert.equal(currentFetcherMode({ [FETCHER_KEYS.electron]: false }), "node");
  assert.equal(currentFetcherMode({ [FETCHER_KEYS.electron]: true }), "electron");
});

test("switching to Node PRESERVES unrelated Copilot debug settings", () => {
  // The advanced object holds other Copilot debug keys; clobbering it would
  // silently discard settings we don't own.
  const before = { "debug.overrideEngine": "someEngine", "authProvider": "github" };
  const after = nodeFetcherSettings(before);
  assert.equal(after["debug.overrideEngine"], "someEngine");
  assert.equal(after.authProvider, "github");
  assert.equal(after[FETCHER_KEYS.electron], false);
  assert.equal(after[FETCHER_KEYS.node], true);
  assert.equal(after[FETCHER_KEYS.nodeFetch], true);
  // Works from nothing too.
  assert.equal(nodeFetcherSettings(undefined)[FETCHER_KEYS.electron], false);
});

test("reverting REMOVES our keys rather than pinning them to true", () => {
  const reverted = revertFetcherSettings(nodeFetcherSettings({ "debug.overrideEngine": "x" }));
  assert.equal(reverted["debug.overrideEngine"], "x", "unrelated settings survive");
  for (const k of Object.values(FETCHER_KEYS)) {
    assert.ok(!(k in reverted), `${k} should be removed, not set to a value we invented`);
  }
});

test("advice needs a PATTERN, not one blip", () => {
  // One reset is normal internet weather and our own retry usually absorbs it.
  for (let n = 0; n < RESET_THRESHOLD; n++) {
    assert.equal(adviseFetcher(n, "unset").offer, false, `${n} reset(s)`);
  }
  const advice = adviseFetcher(RESET_THRESHOLD, "unset");
  assert.equal(advice.offer, true);
  assert.equal(advice.action, "switch-to-node");
  assert.match(advice.reason, /HTTP\/2|SSL-inspecting/);
});

test("already on Node: don't re-offer the same switch — say what it actually means", () => {
  const advice = adviseFetcher(10, "node");
  assert.equal(advice.offer, false);
  assert.equal(advice.action, "already-node");
  // The useful message is "this isn't Electron, talk to your network team".
  assert.match(advice.reason, /not Electron/i);
  assert.match(advice.reason, /network team/i);
});

test("ResetTracker offers at most once per session, so a long run can't nag", () => {
  const t = new ResetTracker();
  t.record();
  assert.equal(t.shouldOffer("unset"), false, "below threshold");
  t.record();
  assert.equal(t.resets, RESET_THRESHOLD);
  assert.equal(t.shouldOffer("unset"), true, "pattern established");
  assert.equal(t.shouldOffer("unset"), false, "never a second time");
  for (let i = 0; i < 20; i++) t.record();
  assert.equal(t.shouldOffer("unset"), false, "still silent after many more resets");
  // Clearing (the user acted) re-arms it.
  t.clear();
  assert.equal(t.resets, 0);
  t.record();
  t.record();
  assert.equal(t.shouldOffer("unset"), true);
});

test("ResetTracker never offers when the remedy is already applied", () => {
  const t = new ResetTracker();
  for (let i = 0; i < 5; i++) t.record();
  assert.equal(t.shouldOffer("node"), false);
});
