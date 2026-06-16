import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  extractLinks,
  checkLinks,
  reviewPageCurrency,
} from "../src/context/adapters/confluenceCurrency";
import { UserRecord } from "../src/context/userDirectory";
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
    return new Response(r.body === undefined ? undefined : JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    return { result: await run(), calls };
  } finally {
    globalThis.fetch = original;
  }
}

test("extractLinks pulls distinct href targets, skipping anchors/mailto", () => {
  assert.deepEqual(
    extractLinks('<a href="https://x/a">a</a> <a href="#s">s</a> <a href="https://x/a">dup</a> <a href="/rel">r</a> <a href="mailto:x@y">m</a>'),
    ["https://x/a", "/rel"],
  );
});

test("checkLinks checks only absolute links and reports broken ones", async () => {
  const { result } = await withFetch(
    (url) => (url.includes("bad") ? { status: 404, body: undefined } : { status: 200, body: undefined }),
    () => checkLinks(["https://good/x", "https://bad/y", "/relative"], 30000),
  );
  assert.deepEqual(result, [
    { url: "https://good/x", ok: true, status: 200 },
    { url: "https://bad/y", ok: false, status: 404 },
  ]);
});

test("reviewPageCurrency flags broken links, inactive owners, and staleness", async () => {
  const dir = async (sam: string): Promise<UserRecord | undefined> =>
    sam === "jdoe"
      ? { sam: "jdoe", active: true, email: "jdoe@x" }
      : sam === "olduser"
        ? { sam: "olduser", active: false }
        : undefined;
  const { result } = await withFetch(
    (url) => {
      if (url.includes("/rest/api/content/")) {
        return {
          body: {
            id: "55",
            title: "VPN Guide",
            body: { storage: { value: '<p>see <a href="https://good.example/x">good</a> and <a href="https://bad.example/y">bad</a></p>' } },
            version: { when: "2024-01-01T00:00:00Z" },
            metadata: { labels: { results: [{ name: "owners|jdoe|olduser" }, { name: "policy" }] } },
            _links: { webui: "/p/55" },
          },
        };
      }
      return url.includes("bad.example") ? { status: 404, body: undefined } : { status: 200, body: undefined };
    },
    () => reviewPageCurrency(SRC, CRED, "55", dir, DEFAULT_CAPS, () => "2026-06-16T00:00:00Z"),
  );
  assert.equal(result.brokenLinks.length, 1);
  assert.match(result.brokenLinks[0].url, /bad\.example/);
  assert.equal(result.brokenLinks[0].status, 404);
  assert.equal(result.workingLinks, 1);
  assert.deepEqual(result.inactiveOwners, ["olduser"]);
  assert.equal(result.owners.find((o) => o.sam === "jdoe")?.contact, "jdoe@x");
  assert.ok((result.staleDays ?? 0) > 365);
  assert.ok(result.issues.some((i) => /broken link/.test(i)));
  assert.ok(result.issues.some((i) => /inactive owner/.test(i)));
  assert.ok(result.issues.some((i) => /not updated/.test(i)));
});
