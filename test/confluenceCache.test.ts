import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  buildCacheEntry,
  ConfluenceContentCache,
  cacheConfluenceScope,
  fetchScopeVersions,
  ConfluencePageCacheEntry,
} from "../src/context/adapters/confluenceCache";
import { ContextSource, ContextCredential, DEFAULT_CAPS } from "../src/context/types";

const SRC: ContextSource = {
  id: "c1",
  type: "confluence",
  displayName: "Wiki",
  baseUrl: "https://wiki.example.com",
  deployment: "datacenter",
  authMethod: "pat",
  addedAt: "2026-06-16T00:00:00Z",
};
const CRED: ContextCredential = { method: "pat", secret: "token" };

async function withFetch<T>(
  handler: (url: string) => { status?: number; body: unknown },
  run: () => Promise<T>,
): Promise<{ result: T; calls: string[] }> {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: unknown) => {
    calls.push(String(url));
    const r = handler(String(url));
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    return { result: await run(), calls };
  } finally {
    globalThis.fetch = original;
  }
}

const entry = (id: string, version: number, spaceKey?: string): ConfluencePageCacheEntry => ({
  id,
  title: `P${id}`,
  version,
  bodyText: "",
  labels: [],
  ...(spaceKey ? { spaceKey } : {}),
  webUrl: "",
  cachedAt: "",
});

test("buildCacheEntry maps content (version, labels, parent, stripped body)", () => {
  const e = buildCacheEntry(
    SRC,
    {
      id: "5",
      title: "T",
      version: { number: 2 },
      space: { key: "DEV" },
      ancestors: [{ id: "4" }],
      body: { storage: { value: "<p>hi <b>x</b></p>" } },
      metadata: { labels: { results: [{ name: "a" }, { name: "b" }] } },
      _links: { webui: "/p/5" },
    },
    8000,
    () => "NOW",
  );
  assert.deepEqual(e, {
    id: "5",
    title: "T",
    version: 2,
    bodyText: "hi x",
    labels: ["a", "b"],
    parentId: "4",
    spaceKey: "DEV",
    webUrl: "https://wiki.example.com/p/5",
    cachedAt: "NOW",
  });
});

test("ConfluenceContentCache: put/get/list/bySpace/serialize round-trip", () => {
  const cache = new ConfluenceContentCache("c1", [entry("1", 3, "DEV"), entry("2", 1, "OPS")]);
  assert.equal(cache.size(), 2);
  assert.equal(cache.get("1")?.version, 3);
  assert.deepEqual(cache.bySpace("DEV").map((e) => e.id), ["1"]);
  const reloaded = new ConfluenceContentCache("c1", cache.serialize());
  assert.equal(reloaded.size(), 2);
});

test("ConfluenceContentCache.stale flags only cached pages whose live version differs", () => {
  const cache = new ConfluenceContentCache("c1", [entry("1", 3), entry("2", 1)]);
  const live = new Map([
    ["1", 3], // unchanged
    ["2", 5], // changed underneath us
    ["3", 9], // not cached → ignored
  ]);
  assert.deepEqual(cache.stale(live), [{ id: "2", title: "P2", cachedVersion: 1, liveVersion: 5 }]);
});

test("cacheConfluenceScope (space) fetches pages and populates the cache", async () => {
  const cache = new ConfluenceContentCache("c1");
  const { result, calls } = await withFetch(
    (url) => {
      const start = Number(new URL(url).searchParams.get("start") ?? "0");
      if (start > 0) return { body: { results: [] } };
      return {
        body: {
          results: [
            { id: "1", title: "A", version: { number: 3 }, space: { key: "DEV" }, body: { storage: { value: "<p>a</p>" } }, metadata: { labels: { results: [{ name: "owners|jdoe" }] } }, _links: { webui: "/p/1" } },
            { id: "2", title: "B", version: { number: 1 }, space: { key: "DEV" }, body: { storage: { value: "<p>b</p>" } } },
          ],
        },
      };
    },
    () => cacheConfluenceScope(SRC, CRED, { topic: "x", kind: "space", spaceKey: "DEV" }, DEFAULT_CAPS, cache, () => "T"),
  );
  assert.equal(result, 2);
  assert.match(calls[0], /spaceKey=DEV/);
  assert.equal(cache.size(), 2);
  assert.equal(cache.get("1")?.bodyText, "a");
  assert.deepEqual(cache.get("1")?.labels, ["owners|jdoe"]);
  assert.equal(cache.lastSnapshotTruncated, false);
});

test("cacheConfluenceScope PAGINATES the listing (a clamped first batch no longer truncates the snapshot)", async () => {
  const cache = new ConfluenceContentCache("c1");
  const page = (start: number, n: number) => ({
    body: {
      results: Array.from({ length: n }, (_, k) => ({
        id: String(start + k + 1),
        title: `P${start + k + 1}`,
        version: { number: 1 },
        space: { key: "DEV" },
      })),
    },
  });
  const { result, calls } = await withFetch(
    (url) => {
      const start = Number(new URL(url).searchParams.get("start") ?? "0");
      // The server clamps every batch to 3 despite limit=100; 6 pages total.
      return start < 6 ? page(start, 3) : page(start, 0);
    },
    () => cacheConfluenceScope(SRC, CRED, { topic: "x", kind: "space", spaceKey: "DEV" }, DEFAULT_CAPS, cache, () => "T"),
  );
  assert.equal(result, 6, "all pages cached, not just the clamped first batch");
  assert.equal(calls.length, 3, "walked start=0,3,6");
  assert.equal(cache.lastSnapshotTruncated, false);
});

test("cacheConfluenceScope reports truncation on the cache when the page cap is hit", async () => {
  const cache = new ConfluenceContentCache("c1");
  const { result } = await withFetch(
    (url) => {
      const start = Number(new URL(url).searchParams.get("start") ?? "0");
      return {
        body: {
          results: Array.from({ length: 2 }, (_, k) => ({ id: String(start + k + 1), title: `P${start + k + 1}`, version: { number: 1 } })),
          _links: { next: `/rest/api/content?start=${start + 2}` }, // always more available
        },
      };
    },
    () => cacheConfluenceScope(SRC, CRED, { topic: "x", kind: "space", spaceKey: "DEV" }, DEFAULT_CAPS, cache, () => "T", 4),
  );
  assert.equal(result, 4, "bounded by maxPages");
  assert.equal(cache.lastSnapshotTruncated, true, "the snapshot says it is PARTIAL");
});

test("fetchScopeVersions: space scope → Map<id, version> (lightweight expand=version)", async () => {
  const { result, calls } = await withFetch(
    (url) => {
      assert.match(url, /spaceKey=ENG.*expand=version/);
      return {
        body: {
          results: [{ id: "10", version: { number: 2 } }, { id: "11", version: { number: 7 } }],
          _links: {}, // last page — the server's own signal ends the walk
        },
      };
    },
    () => fetchScopeVersions(SRC, CRED, { topic: "", kind: "space", spaceKey: "ENG" }, DEFAULT_CAPS),
  );
  assert.equal(result.get("10"), 2);
  assert.equal(result.get("11"), 7);
  assert.equal(calls.length, 1);
  assert.equal(result.truncated, undefined, "no cap hit → no truncation flag");
});

test("fetchScopeVersions paginates and flags truncation when the cap is hit (honest drift check)", async () => {
  // Two full batches available beyond the cap of 3 → only 3 versions fetched,
  // and the map SAYS it is partial instead of letting the drift check pretend
  // it compared the whole scope.
  const { result, calls } = await withFetch(
    (url) => {
      const start = Number(new URL(url).searchParams.get("start") ?? "0");
      return {
        body: {
          results: Array.from({ length: 2 }, (_, k) => ({ id: String(start + k + 1), version: { number: 1 } })),
          _links: { next: `/rest/api/content?start=${start + 2}` },
        },
      };
    },
    () => fetchScopeVersions(SRC, CRED, { topic: "", kind: "space", spaceKey: "ENG" }, DEFAULT_CAPS, 3),
  );
  assert.equal(result.size, 3, "bounded by maxPages");
  assert.equal(result.truncated, true);
  assert.equal(calls.length, 2);
});

test("fetchScopeVersions: page scope → single id→version", async () => {
  const { result } = await withFetch(
    (url) => {
      assert.match(url, /\/content\/99\?expand=version/);
      return { body: { id: "99", version: { number: 4 } } };
    },
    () => fetchScopeVersions(SRC, CRED, { topic: "", kind: "page", pageId: "99" }, DEFAULT_CAPS),
  );
  assert.deepEqual([...result.entries()], [["99", 4]]);
});
