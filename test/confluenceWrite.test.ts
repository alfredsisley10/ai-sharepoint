import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  buildCreateBody,
  buildUpdateBody,
  markdownToStorage,
  createConfluencePage,
  updateConfluencePage,
  deleteConfluencePage,
} from "../src/context/adapters/confluenceWrite";
import { ContextSource, ContextCredential } from "../src/context/types";

const SRC: ContextSource = {
  id: "c1",
  type: "confluence",
  displayName: "Wiki",
  baseUrl: "https://wiki.example.com/wiki",
  deployment: "cloud",
  authMethod: "basic",
  addedAt: "2026-06-15T00:00:00Z",
};
const CRED: ContextCredential = { method: "basic", username: "u@example.com", secret: "token" };

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

test("buildCreateBody / buildUpdateBody shape the storage payloads", () => {
  assert.deepEqual(buildCreateBody({ spaceKey: "DEV", title: "Hi", body: "<p>x</p>", parentId: "42" }), {
    type: "page",
    title: "Hi",
    space: { key: "DEV" },
    body: { storage: { value: "<p>x</p>", representation: "storage" } },
    ancestors: [{ id: "42" }],
  });
  assert.deepEqual(buildUpdateBody("Hi", "<p>y</p>", 4), {
    type: "page",
    title: "Hi",
    version: { number: 4 },
    body: { storage: { value: "<p>y</p>", representation: "storage" } },
  });
});

test("markdownToStorage converts headings, paragraphs, lists, code, and inline spans", () => {
  const html = markdownToStorage(
    "# Title\n\nHello **bold** and [link](https://x).\n\n- a\n- b\n\n```\ncode <x>\n```",
  );
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<p>Hello <strong>bold<\/strong> and <a href="https:\/\/x">link<\/a>\.<\/p>/);
  assert.match(html, /<ul><li>a<\/li><li>b<\/li><\/ul>/);
  assert.match(html, /<pre><code>code &lt;x&gt;<\/code><\/pre>/);
});

test("markdownToStorage escapes HTML in body text", () => {
  assert.match(markdownToStorage("a < b & c"), /<p>a &lt; b &amp; c<\/p>/);
});

test("createConfluencePage POSTs to the content API and maps the result", async () => {
  const { result, calls } = await withFetch(
    () => ({
      body: { id: "123", title: "Hello", version: { number: 1 }, _links: { webui: "/spaces/DEV/pages/123/Hello" } },
    }),
    () => createConfluencePage(SRC, CRED, { spaceKey: "DEV", title: "Hello", body: "<p>hi</p>" }, 30000),
  );
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/rest\/api\/content$/);
  assert.equal((calls[0].init as { method?: string }).method, "POST");
  const body = JSON.parse(String((calls[0].init as { body?: string }).body));
  assert.equal(body.space.key, "DEV");
  assert.equal(body.body.storage.value, "<p>hi</p>");
  assert.equal(result.id, "123");
  assert.equal(result.url, "https://wiki.example.com/wiki/spaces/DEV/pages/123/Hello");
});

test("updateConfluencePage reads the current version and PUTs version+1", async () => {
  const { result, calls } = await withFetch(
    (_url, init) =>
      ((init as { method?: string }).method ?? "GET") === "GET"
        ? { body: { id: "5", title: "Old", version: { number: 3 } } }
        : { body: { id: "5", title: "New", version: { number: 4 }, _links: { webui: "/p/5" } } },
    () => updateConfluencePage(SRC, CRED, { id: "5", title: "New", body: "<p>v2</p>" }, 30000),
  );
  assert.equal(calls.length, 2); // GET version, then PUT
  assert.equal((calls[1].init as { method?: string }).method, "PUT");
  assert.equal(JSON.parse(String((calls[1].init as { body?: string }).body)).version.number, 4);
  assert.equal(result.version, 4);
});

test("deleteConfluencePage issues a DELETE (tolerates 204 No Content)", async () => {
  const { calls } = await withFetch(
    () => ({ status: 204, body: undefined }),
    () => deleteConfluencePage(SRC, CRED, "9", 30000),
  );
  assert.equal((calls[0].init as { method?: string }).method, "DELETE");
  assert.match(calls[0].url, /\/rest\/api\/content\/9$/);
});
