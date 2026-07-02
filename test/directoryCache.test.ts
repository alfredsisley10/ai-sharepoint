import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  cachedUserDirectory,
  isFresh,
  pruneEntries,
  buildDirectoryCacheExport,
  isDirectoryCacheExport,
  mergeDirectoryCache,
  DirectoryCacheEntry,
} from "../src/context/directoryCache";
import { UserRecord } from "../src/context/userDirectory";

const DAY = 86_400_000;

function memCache() {
  const map = new Map<string, DirectoryCacheEntry>();
  return {
    map,
    get: (sam: string) => map.get(sam.toLowerCase()),
    put: (e: DirectoryCacheEntry) => {
      map.set(e.sam.toLowerCase(), e);
    },
  };
}

test("cachedUserDirectory: caches within TTL, refetches after expiry, caches negatives", async () => {
  let now = 1_000_000_000_000;
  let liveCalls = 0;
  const rec: UserRecord = { sam: "jdoe", active: true, email: "j@x.com" };
  const live = async (sam: string) => {
    liveCalls += 1;
    return sam === "jdoe" ? rec : undefined;
  };
  const cache = memCache();
  const dir = cachedUserDirectory(live, cache, { now: () => now, ttlMs: 5 * DAY });

  assert.deepEqual(await dir("JDoe"), rec); // miss → live
  assert.deepEqual(await dir("jdoe"), rec); // hit (case-insensitive) → no live call
  assert.equal(liveCalls, 1);

  // negative is cached too
  assert.equal(await dir("ghost"), undefined);
  assert.equal(await dir("ghost"), undefined);
  assert.equal(liveCalls, 2);

  now += 6 * DAY; // past TTL
  assert.deepEqual(await dir("jdoe"), rec);
  assert.equal(liveCalls, 3); // refetched
});

test("isFresh / pruneEntries respect the TTL window", () => {
  const now = 1_000_000_000_000;
  const fresh: DirectoryCacheEntry = { sam: "a", record: null, at: now - 1 * DAY };
  const stale: DirectoryCacheEntry = { sam: "b", record: null, at: now - 9 * DAY };
  assert.equal(isFresh(fresh, now, 5 * DAY), true);
  assert.equal(isFresh(stale, now, 5 * DAY), false);
  assert.equal(isFresh(undefined, now, 5 * DAY), false);
  assert.deepEqual(pruneEntries([fresh, stale], now, 5 * DAY), [fresh]);
});

test("export round-trips; merge keeps the fresher record per sam", () => {
  const now = 1_000_000_000_000;
  const exp = buildDirectoryCacheExport([{ sam: "jdoe", record: { sam: "jdoe", active: true }, at: now }], "2026-07-02T00:00:00Z");
  assert.ok(isDirectoryCacheExport(exp));
  assert.equal(isDirectoryCacheExport({ schema: "x", entries: [] }), false);

  const merged = mergeDirectoryCache(
    [{ sam: "jdoe", record: { sam: "jdoe", active: true }, at: now - DAY }],
    [{ sam: "JDOE", record: { sam: "jdoe", active: false }, at: now }], // newer, disabled
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].record?.active, false); // fresher wins
});
