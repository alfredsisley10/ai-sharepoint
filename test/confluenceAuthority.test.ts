import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  topicSlug,
  buildAuthorityLabel,
  parseAuthorityLabel,
  findAuthorityTopics,
  buildTopicSearchCql,
  gatherAuthorityPages,
  findConflictCandidates,
} from "../src/context/adapters/confluenceAuthority";
import { ContextSource, ContextCredential, DEFAULT_CAPS } from "../src/context/types";

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

test("authority label + topic slug helpers", () => {
  assert.equal(topicSlug("VPN Setup & Config!"), "vpn-setup-config");
  assert.equal(buildAuthorityLabel("VPN Setup"), "authoritative|vpn-setup");
  assert.equal(parseAuthorityLabel("authoritative|vpn-setup"), "vpn-setup");
  assert.equal(parseAuthorityLabel("authoritative"), undefined);
  assert.equal(parseAuthorityLabel("topic"), undefined);
  assert.deepEqual(findAuthorityTopics(["authoritative|a", "topic", "authoritative|b"]), ["a", "b"]);
});

test("buildTopicSearchCql excludes the authoritative space when given", () => {
  assert.equal(buildTopicSearchCql("VPN", "DEV"), 'type = page AND text ~ "VPN" AND space != "DEV"');
  assert.equal(buildTopicSearchCql("VPN"), 'type = page AND text ~ "VPN"');
});

test("buildTopicSearchCql: a topic ending in a backslash cannot escape the closing quote", () => {
  // Backslash is escaped BEFORE the quote, so the literal terminates properly
  // and the space-exclusion clause survives instead of being swallowed.
  assert.equal(
    buildTopicSearchCql("VPN\\", "DEV"),
    'type = page AND text ~ "VPN\\\\" AND space != "DEV"',
  );
  // Embedded quotes are still escaped (and their preceding backslashes doubled).
  assert.equal(buildTopicSearchCql('say "hi"'), 'type = page AND text ~ "say \\"hi\\""');
  assert.equal(buildTopicSearchCql('\\"'), 'type = page AND text ~ "\\\\\\""');
});

test("gatherAuthorityPages (page) returns the page's text", async () => {
  const { result } = await withFetch(
    () => ({ body: { id: "1", title: "VPN Guide", body: { storage: { value: "<p>Use GlobalProtect</p>" } }, _links: { webui: "/p/1" } } }),
    () => gatherAuthorityPages(SRC, CRED, { topic: "vpn", kind: "page", pageId: "1" }, DEFAULT_CAPS),
  );
  assert.deepEqual(result, [{ id: "1", title: "VPN Guide", text: "Use GlobalProtect", url: "https://wiki.example.com/p/1" }]);
});

test("gatherAuthorityPages (subtree) includes the root plus its descendants", async () => {
  const { result } = await withFetch(
    (url) => {
      if (!url.includes("/descendant/page")) {
        return { body: { id: "1", title: "Root", body: { storage: { value: "<p>root</p>" } } } };
      }
      const start = Number(new URL(url).searchParams.get("start") ?? "0");
      return { body: { results: start === 0 ? [{ id: "2", title: "Child", body: { storage: { value: "<p>child</p>" } } }] : [] } };
    },
    () => gatherAuthorityPages(SRC, CRED, { topic: "vpn", kind: "subtree", pageId: "1" }, DEFAULT_CAPS),
  );
  assert.deepEqual(result.map((p) => p.id), ["1", "2"]); // root unshifted, then descendants
});

test("gatherAuthorityPages (space) paginates past a full first page instead of truncating", async () => {
  const pageOf = (start: number, count: number) => ({
    body: {
      results: Array.from({ length: count }, (_, i) => ({
        id: String(start + i + 1),
        title: `Page ${start + i + 1}`,
        body: { storage: { value: "<p>x</p>" } },
      })),
    },
  });
  const { result, calls } = await withFetch(
    (url) => {
      const start = Number(new URL(url).searchParams.get("start") ?? "0");
      // A FULL first page (100 = the batch size), then a SHORT second page (a
      // clamped page size looks the same, so the walk continues), then an
      // EMPTY page, which ends the walk.
      return start === 0 ? pageOf(0, 100) : start === 100 ? pageOf(start, 20) : pageOf(start, 0);
    },
    () => gatherAuthorityPages(SRC, CRED, { topic: "vpn", kind: "space", spaceKey: "DEV" }, DEFAULT_CAPS, 150),
  );
  assert.equal(calls.length, 3, "continues after a full first page, stops on the empty batch");
  assert.match(decodeURIComponent(calls[1].url), /start=100/);
  assert.match(decodeURIComponent(calls[2].url), /start=120/);
  assert.equal(result.length, 120);
  assert.equal(result[119].id, "120");
});

test("findConflictCandidates searches the topic and excludes the authoritative pages", async () => {
  const { result, calls } = await withFetch(
    () => ({
      body: {
        results: [
          { content: { id: "9", title: "Bad VPN", _links: { webui: "/p/9" }, space: { key: "OTHER" } }, excerpt: "<b>wrong</b> info" },
          { content: { id: "1", title: "the authoritative page" } }, // excluded by pageIds
        ],
      },
    }),
    () => findConflictCandidates(SRC, CRED, "vpn", { spaceKey: "DEV", pageIds: ["1"] }, DEFAULT_CAPS),
  );
  assert.match(decodeURIComponent(calls[0].url), /space != "DEV"/);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0], { id: "9", title: "Bad VPN", url: "https://wiki.example.com/p/9", excerpt: "wrong info", space: "OTHER" });
});
