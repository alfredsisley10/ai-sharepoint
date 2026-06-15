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

test("gatherAuthorityPages (page) returns the page's text", async () => {
  const { result } = await withFetch(
    () => ({ body: { id: "1", title: "VPN Guide", body: { storage: { value: "<p>Use GlobalProtect</p>" } }, _links: { webui: "/p/1" } } }),
    () => gatherAuthorityPages(SRC, CRED, { topic: "vpn", kind: "page", pageId: "1" }, DEFAULT_CAPS),
  );
  assert.deepEqual(result, [{ id: "1", title: "VPN Guide", text: "Use GlobalProtect", url: "https://wiki.example.com/p/1" }]);
});

test("gatherAuthorityPages (subtree) includes the root plus its descendants", async () => {
  const { result } = await withFetch(
    (url) =>
      url.includes("/descendant/page")
        ? { body: { results: [{ id: "2", title: "Child", body: { storage: { value: "<p>child</p>" } } }] } }
        : { body: { id: "1", title: "Root", body: { storage: { value: "<p>root</p>" } } } },
    () => gatherAuthorityPages(SRC, CRED, { topic: "vpn", kind: "subtree", pageId: "1" }, DEFAULT_CAPS),
  );
  assert.deepEqual(result.map((p) => p.id), ["1", "2"]); // root unshifted, then descendants
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
