import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  ownershipKey,
  isFresh,
  pruneEntries,
  buildOwnershipCacheExport,
  isOwnershipCacheExport,
  mergeOwnershipCache,
  OwnershipCacheEntry,
  CachedOwnership,
} from "../src/context/ownershipCache";

const DAY = 86_400_000;
const val = (owner: string): CachedOwnership => ({
  resolution: { owners: [owner], basis: "page-contributor" },
  labels: [],
  directoryWired: true,
});

test("ownershipKey composes source:page", () => {
  assert.equal(ownershipKey("s1", "42"), "s1:42");
});

test("isFresh / pruneEntries respect TTL", () => {
  const now = 1_000_000_000_000;
  const fresh: OwnershipCacheEntry = { key: "a", value: val("jdoe"), at: now - 2 * DAY };
  const stale: OwnershipCacheEntry = { key: "b", value: val("asmith"), at: now - 10 * DAY };
  assert.equal(isFresh(fresh, now, 7 * DAY), true);
  assert.equal(isFresh(stale, now, 7 * DAY), false);
  assert.deepEqual(pruneEntries([fresh, stale], now, 7 * DAY), [fresh]);
});

test("export round-trips; merge keeps the fresher entry per key", () => {
  const now = 1_000_000_000_000;
  const exp = buildOwnershipCacheExport([{ key: "s1:1", value: val("jdoe"), at: now }], "2026-07-02T00:00:00Z");
  assert.ok(isOwnershipCacheExport(exp));
  assert.equal(isOwnershipCacheExport({ schema: "x", entries: [] }), false);

  const merged = mergeOwnershipCache(
    [{ key: "s1:1", value: val("old"), at: now - DAY }],
    [{ key: "s1:1", value: val("new"), at: now }],
  );
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].value.resolution.owners, ["new"]);
});
