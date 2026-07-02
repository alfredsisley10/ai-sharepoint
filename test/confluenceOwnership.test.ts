import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  buildOwnerLabel,
  parseOwnerLabel,
  findOwnerLabel,
  tallyContributors,
  tallyContributorsWeighted,
  resolveOwners,
  getConfluencePageLabels,
  getConfluencePageContributors,
  setConfluencePageOwners,
  ContributorTally,
} from "../src/context/adapters/confluenceOwnership";
import { ContextSource, ContextCredential } from "../src/context/types";

const SRC: ContextSource = {
  id: "c1",
  type: "confluence",
  displayName: "Wiki",
  baseUrl: "https://wiki.example.com",
  deployment: "datacenter",
  authMethod: "pat",
  addedAt: "2026-06-15T00:00:00Z",
};
const CRED: ContextCredential = { method: "pat", secret: "token" };

async function withFetch<T>(
  handler: (url: string, init: RequestInit) => { status?: number; body: unknown },
  run: () => Promise<T>,
): Promise<{ result: T; calls: Array<{ url: string; init: RequestInit }> }> {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = handler(String(url), init ?? {});
    return new Response(r.body === undefined ? undefined : JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const result = await run();
    return { result, calls };
  } finally {
    globalThis.fetch = original;
  }
}

const ranked = (...pairs: Array<[string, number]>): ContributorTally[] =>
  pairs.map(([sam, count]) => ({ sam, count }));

test("owner label build/parse/find (pipe-delimited sams, lowercased)", () => {
  assert.equal(buildOwnerLabel(["JDoe", " asmith ", "jdoe"]), "owners|jdoe|asmith");
  assert.deepEqual(parseOwnerLabel("owners|jdoe|asmith"), ["jdoe", "asmith"]);
  assert.equal(parseOwnerLabel("just-a-tag"), undefined);
  assert.equal(parseOwnerLabel("owners"), undefined); // marker with no sams
  assert.deepEqual(findOwnerLabel(["topic", "owners|bwong"]), ["bwong"]);
  assert.equal(findOwnerLabel(["topic", "draft"]), undefined);
});

test("tallyContributors counts case-insensitively and ranks most-prolific first", () => {
  assert.deepEqual(tallyContributors(["a", "b", "a", "A", "c"]), [
    { sam: "a", count: 3 },
    { sam: "b", count: 1 },
    { sam: "c", count: 1 },
  ]);
});

test("resolveOwners: explicit owner label is authoritative (flags inactive)", async () => {
  const isActive = async (s: string) => s !== "asmith";
  const res = await resolveOwners({
    pageLabels: ["owners|jdoe|asmith", "policy"],
    pageContributors: ranked(["bwong", 9]),
    spaceContributors: async () => ranked(["x", 1]),
    isActive,
  });
  assert.deepEqual(res.owners, ["jdoe", "asmith"]);
  assert.equal(res.basis, "label");
  assert.match(res.note ?? "", /inactive.*asmith/);
});

test("resolveOwners: most prolific ACTIVE page contributor (skips inactive)", async () => {
  const isActive = async (s: string) => s === "jdoe";
  const res = await resolveOwners({
    pageLabels: ["policy"],
    pageContributors: ranked(["bwong", 12], ["jdoe", 5]), // bwong most prolific but inactive
    spaceContributors: async () => ranked(["nope", 99]),
    isActive,
  });
  assert.deepEqual(res.owners, ["jdoe"]);
  assert.equal(res.basis, "page-contributor");
});

test("resolveOwners: falls back to space contributor, then none", async () => {
  const space = await resolveOwners({
    pageLabels: [],
    pageContributors: ranked(["inactivea", 4]),
    spaceContributors: async () => ranked(["csmith", 20], ["inactiveb", 30]),
    isActive: async (s) => s === "csmith",
  });
  assert.deepEqual(space.owners, ["csmith"]);
  assert.equal(space.basis, "space-contributor");

  const none = await resolveOwners({
    pageLabels: [],
    pageContributors: ranked(["a", 1]),
    spaceContributors: async () => ranked(["b", 1]),
    isActive: async () => false,
  });
  assert.equal(none.basis, "none");
  assert.deepEqual(none.owners, []);
});

test("getConfluencePageLabels reads label names", async () => {
  const { result } = await withFetch(
    () => ({ body: { results: [{ name: "owners|jdoe" }, { name: "policy" }] } }),
    () => getConfluencePageLabels(SRC, CRED, "1", 30000),
  );
  assert.deepEqual(result, ["owners|jdoe", "policy"]);
});

test("getConfluencePageContributors tallies version authors (by.username)", async () => {
  const { result, calls } = await withFetch(
    () => ({
      body: {
        results: [
          { by: { username: "jdoe" } },
          { by: { username: "asmith" } },
          { by: { username: "jdoe" } },
        ],
      },
    }),
    () => getConfluencePageContributors(SRC, CRED, "7", 30000),
  );
  assert.match(calls[0].url, /\/rest\/api\/content\/7\/version/);
  assert.deepEqual(result, [
    { sam: "jdoe", count: 2 },
    { sam: "asmith", count: 1 },
  ]);
});

test("setConfluencePageOwners removes the old owner label and POSTs the new one", async () => {
  const { result, calls } = await withFetch(
    (_url, init) => {
      if ((init as { method?: string }).method === "GET") {
        return { body: { results: [{ name: "owners|olduser" }, { name: "keepme" }] } }; // GET labels
      }
      return { status: 200, body: undefined }; // DELETE + POST
    },
    () => setConfluencePageOwners(SRC, CRED, "9", ["JDoe", "asmith"], 30000),
  );
  const del = calls.find((c) => (c.init as { method?: string }).method === "DELETE");
  const post = calls.find((c) => (c.init as { method?: string }).method === "POST");
  assert.ok(del, "old owner label deleted");
  assert.match(del!.url, /name=owners%7Colduser/); // only the owner label removed, not "keepme"
  assert.ok(post, "new owner label added");
  assert.equal(JSON.parse(String((post!.init as { body?: string }).body))[0].name, "owners|jdoe|asmith");
  assert.equal(result, "owners|jdoe|asmith");
});

const DAY = 86_400_000;

test("tallyContributorsWeighted: recent activity outranks a long-departed prolific editor", () => {
  const now = Date.UTC(2026, 6, 1);
  const authors = [
    // 'oldpro' edited 10× two years ago; 'recent' edited 3× this month.
    ...Array.from({ length: 10 }, () => ({ sam: "oldpro", whenMs: now - 730 * DAY })),
    ...Array.from({ length: 3 }, () => ({ sam: "recent", whenMs: now - 5 * DAY })),
  ];
  const out = tallyContributorsWeighted(authors, { nowMs: now, halfLifeDays: 180 });
  assert.equal(out[0].sam, "recent"); // recency beats raw volume
  assert.equal(out.find((r) => r.sam === "oldpro")?.count, 10); // raw count still exposed
  assert.ok((out[0].score ?? 0) > (out[1].score ?? 0));
});

test("tallyContributorsWeighted: undated contributions rank below any dated one", () => {
  const now = Date.UTC(2026, 6, 1);
  const out = tallyContributorsWeighted(
    [{ sam: "dated", whenMs: now - 1000 * DAY }, { sam: "undated" }],
    { nowMs: now },
  );
  assert.equal(out[0].sam, "dated");
});

test("resolveOwners: falls back to configured space owners (basis space-owner) when contributors are inactive", async () => {
  const res = await resolveOwners({
    pageLabels: [],
    pageContributors: [{ sam: "ghost", count: 5 }],
    spaceContributors: async () => [{ sam: "alsoghost", count: 3 }],
    spaceOwners: async () => ["SpaceAdmin"],
    isActive: async (sam) => sam === "spaceadmin", // only the configured owner is active
  });
  assert.equal(res.basis, "space-owner");
  assert.deepEqual(res.owners, ["spaceadmin"]);
  assert.match(res.note ?? "", /administratively assigned|may not be the effective/i);
});

test("resolveOwners: prefers an active recent page contributor over the space-owner fallback", async () => {
  const res = await resolveOwners({
    pageLabels: [],
    pageContributors: [{ sam: "jdoe", count: 2, score: 1.5 }],
    spaceContributors: async () => [],
    spaceOwners: async () => ["spaceadmin"],
    isActive: async () => true,
  });
  assert.equal(res.basis, "page-contributor");
  assert.deepEqual(res.owners, ["jdoe"]);
});
