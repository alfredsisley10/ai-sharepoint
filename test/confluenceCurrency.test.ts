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

test("checkLinks memoizes each distinct url via the shared cache (one check per url)", async () => {
  const cache = new Map();
  const { calls } = await withFetch(
    () => ({ status: 200, body: undefined }),
    async () => {
      await checkLinks(["https://x/a", "https://x/b"], 30000, 6, cache);
      // A second page re-links the same host: only the NEW url hits the network.
      await checkLinks(["https://x/a", "https://x/c"], 30000, 6, cache);
    },
  );
  assert.deepEqual(calls.sort(), ["https://x/a", "https://x/b", "https://x/c"]);
});

test("reviewPageCurrency captures body text + version and uses the link cache", async () => {
  const dir = async (): Promise<UserRecord | undefined> => undefined;
  const cache = new Map();
  const handler = (url: string) => {
    if (url.includes("/rest/api/content/")) {
      return {
        body: {
          id: "55",
          title: "VPN Guide",
          body: { storage: { value: '<p>Body <a href="https://good.example/x">good</a></p>' } },
          version: { when: "2026-06-01T00:00:00Z", number: 7 },
          metadata: { labels: { results: [] } },
          _links: { webui: "/p/55" },
        },
      };
    }
    return { status: 200, body: undefined };
  };
  const { result, calls } = await withFetch(handler, async () => {
    const a = await reviewPageCurrency(SRC, CRED, "55", dir, DEFAULT_CAPS, () => "2026-06-16T00:00:00Z", cache);
    const b = await reviewPageCurrency(SRC, CRED, "55", dir, DEFAULT_CAPS, () => "2026-06-16T00:00:00Z", cache);
    return [a, b] as const;
  });
  assert.equal(result[0].version, 7);
  assert.match(result[0].bodyText ?? "", /Body good/);
  // Two page fetches, but the shared link is checked exactly once.
  assert.equal(calls.filter((u) => u.includes("good.example")).length, 1);
});

test("reviewPageCurrency with a WIRED directory flags broken links, inactive owners, and staleness", async () => {
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

const TAGGED_PAGE = {
  id: "55",
  title: "VPN Guide",
  body: { storage: { value: "<p>plain</p>" } },
  version: { when: "2026-06-01T00:00:00Z", number: 3 },
  metadata: { labels: { results: [{ name: "owners|jdoe|olduser" }] } },
  _links: { webui: "/p/55" },
};

test("reviewPageCurrency with NO directory treats labeled owners as active (unverified) — no inactive issue", async () => {
  // The regression this locks: with no LDAP directory configured, a fully
  // tagged healthy space must NOT flag every owner inactive/ownerless (which
  // opened a work item per page and drafted outreach for everyone). Matching
  // resolveOwners, everyone is treated active when nothing can verify them.
  const { result } = await withFetch(
    (url) => (url.includes("/rest/api/content/") ? { body: TAGGED_PAGE } : { status: 200, body: undefined }),
    () => reviewPageCurrency(SRC, CRED, "55", undefined, DEFAULT_CAPS, () => "2026-06-16T00:00:00Z"),
  );
  assert.equal(result.hasOwnerLabel, true);
  assert.deepEqual(
    result.owners.map((o) => ({ sam: o.sam, active: o.active })),
    [
      { sam: "jdoe", active: true },
      { sam: "olduser", active: true },
    ],
  );
  assert.deepEqual(result.inactiveOwners, []);
  assert.ok(!result.issues.some((i) => /inactive owner/.test(i)), `no inactive-owner issue: ${result.issues}`);
  // No directory ⇒ no contact enrichment either.
  assert.ok(result.owners.every((o) => o.contact === undefined));
});

test("reviewPageCurrency degrades a FAULTING directory to active-unverified instead of failing or flagging", async () => {
  // Mirrors resolveOwners' checkActive step-down: a flaky/locked-out LDAP must
  // turn the activity check into a less-reliable answer, not an error and not
  // a false "inactive owner(s)" flag.
  const dir = async (): Promise<UserRecord | undefined> => {
    throw new Error("Authentication rejected (401) — LDAP circuit open");
  };
  const { result } = await withFetch(
    (url) => (url.includes("/rest/api/content/") ? { body: TAGGED_PAGE } : { status: 200, body: undefined }),
    () => reviewPageCurrency(SRC, CRED, "55", dir, DEFAULT_CAPS, () => "2026-06-16T00:00:00Z"),
  );
  assert.deepEqual(result.inactiveOwners, []);
  assert.ok(result.owners.every((o) => o.active));
  assert.ok(!result.issues.some((i) => /inactive owner/.test(i)));
});
