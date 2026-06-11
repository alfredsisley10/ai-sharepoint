import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  buildVertexServingConfig,
  vertexUrlIssue,
  vertexLabel,
  getVertexToken,
  searchVertex,
  answerVertex,
  VERTEX_DEFAULT_ENDPOINT,
} from "../src/context/adapters/vertexSearch";
import { ContextSource, DEFAULT_CAPS } from "../src/context/types";

const T0 = "2026-06-11T12:00:00.000Z";

const SRC: ContextSource = {
  id: "v1",
  type: "vertexai",
  displayName: "Corp Enterprise Search",
  baseUrl: buildVertexServingConfig({
    projectId: "corp-search-prod",
    location: "global",
    engineId: "enterprise-search_17",
  }),
  deployment: "cloud",
  authMethod: "pat",
  addedAt: T0,
};
const TOKEN_CRED = { method: "pat" as const, secret: "ya29.test-token" };

function withFetch<T>(
  responder: (url: string, init?: RequestInit) => { status?: number; body: unknown },
  run: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const r = responder(String(url), init);
    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

test("buildVertexServingConfig assembles the Discovery Engine resource path", () => {
  assert.equal(
    SRC.baseUrl,
    `${VERTEX_DEFAULT_ENDPOINT}/v1/projects/corp-search-prod/locations/global/collections/default_collection/engines/enterprise-search_17/servingConfigs/default_search`,
  );
  // Regional endpoint override flows through.
  assert.match(
    buildVertexServingConfig({
      projectId: "p",
      location: "us",
      engineId: "e",
      endpoint: "https://us-discoveryengine.googleapis.com/",
    }),
    /^https:\/\/us-discoveryengine\.googleapis\.com\/v1\/projects\/p\/locations\/us\//,
  );
});

test("vertexUrlIssue accepts built/pasted configs, rejects malformed ones", () => {
  assert.equal(vertexUrlIssue(SRC.baseUrl), undefined);
  assert.match(vertexUrlIssue("https://example.com/nope") ?? "", /Expected/);
  assert.match(vertexUrlIssue("not a url") ?? "", /valid https/);
  assert.match(vertexUrlIssue("http://x/v1/projects/p/locations/l/collections/c/engines/e/servingConfigs/s") ?? "", /HTTPS/);
  assert.equal(vertexLabel(SRC.baseUrl), "corp-search-prod/enterprise-search_17");
});

test("pasted-token credentials pass through without touching the gcloud CLI", async () => {
  assert.equal(await getVertexToken(TOKEN_CRED), "ya29.test-token");
});

test("searchVertex maps results (title/link/snippet), strips HTML, caps results", async () => {
  let captured: { url?: string; auth?: string; body?: unknown } = {};
  const hits = await withFetch(
    (url, init) => {
      captured = {
        url,
        auth: (init?.headers as Record<string, string>)?.Authorization,
        body: JSON.parse(String(init?.body)),
      };
      return {
        body: {
          results: Array.from({ length: 30 }, (_, i) => ({
            document: {
              id: `doc-${i}`,
              derivedStructData: {
                title: `<b>Result ${i}</b>`,
                link: `https://kb.corp.example/${i}`,
                snippets: [{ snippet: `snippet <em>${i}</em>` }],
              },
            },
          })),
        },
      };
    },
    () => searchVertex(SRC, TOKEN_CRED, "ai automation", DEFAULT_CAPS),
  );
  assert.match(captured.url ?? "", /:search$/);
  assert.equal(captured.auth, "Bearer ya29.test-token");
  assert.equal((captured.body as { query: string }).query, "ai automation");
  assert.equal(hits.length, DEFAULT_CAPS.maxResults); // capped client-side
  assert.equal(hits[0].title, "Result 0");
  assert.equal(hits[0].url, "https://kb.corp.example/0");
  assert.equal(hits[0].excerpt, "snippet 0");
});

test("answerVertex returns the grounded answer with deduped citations", async () => {
  const result = await withFetch(
    (url) => {
      assert.match(url, /:answer$/);
      return {
        body: {
          answer: {
            answerText: "Our policy requires X.",
            references: [
              { chunkInfo: { documentMetadata: { title: "Policy A", uri: "https://kb/a" } } },
              { chunkInfo: { documentMetadata: { title: "Policy A", uri: "https://kb/a" } } },
              { unstructuredDocumentInfo: { title: "Handbook", uri: "https://kb/h" } },
            ],
          },
        },
      };
    },
    () => answerVertex(SRC, TOKEN_CRED, "what is our policy on X?", DEFAULT_CAPS),
  );
  assert.equal(result.answer, "Our policy requires X.");
  assert.deepEqual(result.citations, [
    { title: "Policy A", url: "https://kb/a" },
    { title: "Handbook", url: "https://kb/h" },
  ]);
});

test("expired/rejected tokens classify as auth.failed (lockout-safe) with SSO advice", async () => {
  await assert.rejects(
    withFetch(
      () => ({ status: 401, body: {} }),
      () => searchVertex(SRC, TOKEN_CRED, "x", DEFAULT_CAPS),
    ),
    (err: Error & { code?: string }) => {
      assert.match(err.message, /rejected the token/);
      return true;
    },
  );
});
