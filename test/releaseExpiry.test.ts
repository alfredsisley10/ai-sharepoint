import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  computeExpiry,
  evaluateExpiry,
  MS_PER_DAY,
  ReleaseManifest,
} from "../src/branding/releaseExpiry";
import { setReleaseManifest } from "../src/branding/rebrand";

const NOW = Date.parse("2026-06-29T00:00:00.000Z");

test("computeExpiry adds whole days to the build time", () => {
  assert.equal(computeExpiry(NOW, 90), new Date(NOW + 90 * MS_PER_DAY).toISOString());
});

test("evaluateExpiry: no manifest / no expiresAt → ok (never expires)", () => {
  assert.equal(evaluateExpiry(undefined, NOW).state, "ok");
  assert.equal(evaluateExpiry({ channel: "standard" }, NOW).state, "ok");
});

test("evaluateExpiry: far-off → ok, within window → warn, past → expired", () => {
  const far = { expiresAt: new Date(NOW + 60 * MS_PER_DAY).toISOString(), productName: "Contoso Docs" };
  assert.equal(evaluateExpiry(far, NOW).state, "ok");

  const soon = { expiresAt: new Date(NOW + 5 * MS_PER_DAY).toISOString(), productName: "Contoso Docs", upgradeUrl: "https://example/dl" };
  const warn = evaluateExpiry(soon, NOW);
  assert.equal(warn.state, "warn");
  assert.equal(warn.daysLeft, 5);
  assert.match(warn.message ?? "", /Contoso Docs expires in 5 days/);
  assert.match(warn.message ?? "", /https:\/\/example\/dl/);

  const past = { expiresAt: new Date(NOW - 1 * MS_PER_DAY).toISOString(), productName: "Contoso Docs" };
  const exp = evaluateExpiry(past, NOW);
  assert.equal(exp.state, "expired");
  assert.ok((exp.daysLeft ?? 0) < 0);
  assert.match(exp.message ?? "", /Contoso Docs expired on 2026-06-28/);
});

test("evaluateExpiry: warn window boundary is inclusive, fails open on bad dates", () => {
  const atBoundary = { expiresAt: new Date(NOW + 14 * MS_PER_DAY).toISOString() };
  assert.equal(evaluateExpiry(atBoundary, NOW).state, "warn");
  const justOutside = { expiresAt: new Date(NOW + 15 * MS_PER_DAY).toISOString() };
  assert.equal(evaluateExpiry(justOutside, NOW).state, "ok");
  // malformed date must never brick the extension
  assert.equal(evaluateExpiry({ expiresAt: "not-a-date" }, NOW).state, "ok");
});

test("setReleaseManifest replaces the single-line release value, preserving the rest", () => {
  const pkg = ['{', '  "name": "x",', '  "version": "0.68.0",', '  "release": { "channel": "standard" },', '  "publisher": "y"', "}", ""].join("\n");
  const manifest: ReleaseManifest = { channel: "whitelabel", expiresAt: "2026-09-27T00:00:00.000Z", validityDays: 90 };
  const out = setReleaseManifest(pkg, manifest);
  const parsed = JSON.parse(out);
  assert.deepEqual(parsed.release, manifest);
  assert.equal(parsed.version, "0.68.0"); // untouched
  assert.equal(parsed.publisher, "y");
});

test("setReleaseManifest replaces a MULTI-LINE release block (canonical JSON), no duplicate key", () => {
  // The shipped package.json formats `release` across lines; the replace must
  // hit it (not fall through to insert a second "release", which JSON last-wins
  // would resolve back to the original channel — silently dropping whitelabel).
  const pkg = [
    "{",
    '  "name": "x",',
    '  "version": "0.72.0",',
    '  "release": {',
    '    "channel": "standard"',
    "  },",
    '  "publisher": "y"',
    "}",
    "",
  ].join("\n");
  const manifest: ReleaseManifest = { channel: "whitelabel", productName: "Contoso", validityDays: 90 };
  const out = setReleaseManifest(pkg, manifest);
  const parsed = JSON.parse(out);
  assert.deepEqual(parsed.release, manifest);
  assert.equal((out.match(/"release":/g) ?? []).length, 1, "exactly one release key");
  assert.equal(parsed.publisher, "y");
});

test("setReleaseManifest inserts a release key after version when none exists", () => {
  const pkg = ['{', '  "name": "x",', '  "version": "0.68.0",', '  "publisher": "y"', "}", ""].join("\n");
  const out = setReleaseManifest(pkg, { channel: "whitelabel" });
  const parsed = JSON.parse(out);
  assert.deepEqual(parsed.release, { channel: "whitelabel" });
  assert.equal(parsed.publisher, "y");
});
