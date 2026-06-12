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

test("parseVertexHint extracts project/location/engine from console and resource URLs", async () => {
  const { parseVertexHint, endpointForLocation } = await import("../src/context/adapters/vertexSearch");
  assert.deepEqual(
    parseVertexHint("https://console.cloud.google.com/gen-app-builder/locations/eu/engines/corp-search_17/preview?project=corp-prod"),
    { projectId: "corp-prod", location: "eu", engineId: "corp-search_17" },
  );
  assert.deepEqual(
    parseVertexHint("https://x/v1/projects/p1/locations/us/collections/c/engines/e1/servingConfigs/s"),
    { projectId: "p1", location: "us", engineId: "e1" },
  );
  assert.deepEqual(parseVertexHint("https://corp-search.example/portal"), {});
  assert.equal(endpointForLocation("eu"), "https://eu-discoveryengine.googleapis.com");
  assert.equal(endpointForLocation("global"), "https://discoveryengine.googleapis.com");
  assert.equal(endpointForLocation("weird"), "https://discoveryengine.googleapis.com");
});

test("parseVertexHint understands the corporate end-user search URL (cid + region; csesidx ignored)", async () => {
  const { parseVertexHint } = await import("../src/context/adapters/vertexSearch");
  // The URL corporate users open via SSO — region in the first path segment,
  // app id after cid/, per-session csesidx in the query string.
  assert.deepEqual(
    parseVertexHint("https://vertexaisearch.cloud.google/us/home/cid/corp-search_1700000000000?csesidx=SESSION123"),
    { location: "us", engineId: "corp-search_1700000000000" },
  );
  // .com host variant and global region also parse; no project is invented.
  assert.deepEqual(
    parseVertexHint("https://vertexaisearch.cloud.google.com/global/home/cid/kb-app?csesidx=abc"),
    { location: "global", engineId: "kb-app" },
  );
  const hint = parseVertexHint("https://vertexaisearch.cloud.google/eu/home/cid/app-1?csesidx=zzz");
  assert.equal(hint.projectId, undefined);
  assert.ok(!JSON.stringify(hint).includes("zzz"), "session id must never leak into config");
});

test("gcloudInvocation uses shell:true for the Windows .cmd shim (spawn EINVAL fix), plain binary elsewhere", async () => {
  const { gcloudInvocation } = await import("../src/context/adapters/vertexSearch");
  assert.deepEqual(gcloudInvocation("win32"), { bin: "gcloud.cmd", shell: true });
  assert.deepEqual(gcloudInvocation("linux"), { bin: "gcloud", shell: false });
  assert.deepEqual(gcloudInvocation("darwin"), { bin: "gcloud", shell: false });
});

test("findVertexProjectForEngine probes the hinted region across visible projects and matches the app", async () => {
  const { findVertexProjectForEngine } = await import("../src/context/adapters/vertexSearch");
  const urls: string[] = [];
  const progress: Array<[number, number]> = [];
  const matches = await withFetch(
    (url) => {
      urls.push(url);
      if (url.includes("/projects/p-denied/")) return { status: 403, body: {} };
      if (url.includes("/projects/p-other/")) {
        return { body: { engines: [{ name: "projects/p-other/locations/us/collections/default_collection/engines/another-app" }] } };
      }
      return { body: { engines: [{ name: "projects/p-host/locations/us/collections/default_collection/engines/corp-search_17" }] } };
    },
    () =>
      findVertexProjectForEngine(
        "tok",
        [{ projectId: "p-denied" }, { projectId: "p-other" }, { projectId: "p-host" }],
        "corp-search_17",
        "us",
        5_000,
        (checked, total) => progress.push([checked, total]),
      ),
  );
  assert.deepEqual(matches, ["p-host"]);
  // Only the hinted region's endpoint is probed (us → us-discoveryengine).
  assert.ok(urls.every((u) => u.startsWith("https://us-discoveryengine.googleapis.com/") && u.includes("/locations/us/")), urls.join("\n"));
  // A 403 on one project never aborts the scan; progress reports completion.
  assert.deepEqual(progress.at(-1), [3, 3]);
});

test("parseVertexHint reads full resource names from the search page's own API traffic (Entra users)", async () => {
  const { parseVertexHint } = await import("../src/context/adapters/vertexSearch");
  // A request URL copied from the corporate page's Network tab — the
  // standard-user source when there is no GCP/console access at all.
  // Project NUMBERS work like IDs.
  assert.deepEqual(
    parseVertexHint(
      "https://vertexaisearch.cloud.google/v1alpha/projects/123456789012/locations/us/collections/default_collection/engines/corp-search_17/servingConfigs/default_search:search?csesidx=S1",
    ),
    { projectId: "123456789012", location: "us", engineId: "corp-search_17" },
  );
  // A bare resource string (no scheme) parses too.
  assert.deepEqual(
    parseVertexHint("projects/123456789012/locations/eu/collections/default_collection/engines/kb/servingConfigs/s"),
    { projectId: "123456789012", location: "eu", engineId: "kb" },
  );
});
