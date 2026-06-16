import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  buildCacheEntry,
  ConfluenceContentCache,
  cacheConfluenceScope,
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
    () => ({
      body: {
        results: [
          { id: "1", title: "A", version: { number: 3 }, space: { key: "DEV" }, body: { storage: { value: "<p>a</p>" } }, metadata: { labels: { results: [{ name: "owners|jdoe" }] } }, _links: { webui: "/p/1" } },
          { id: "2", title: "B", version: { number: 1 }, space: { key: "DEV" }, body: { storage: { value: "<p>b</p>" } } },
        ],
      },
    }),
    () => cacheConfluenceScope(SRC, CRED, { topic: "x", kind: "space", spaceKey: "DEV" }, DEFAULT_CAPS, cache, () => "T"),
  );
  assert.equal(result, 2);
  assert.match(calls[0], /spaceKey=DEV/);
  assert.equal(cache.size(), 2);
  assert.equal(cache.get("1")?.bodyText, "a");
  assert.deepEqual(cache.get("1")?.labels, ["owners|jdoe"]);
});
