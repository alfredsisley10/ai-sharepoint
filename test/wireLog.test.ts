import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  setWireSink,
  wireEnabled,
  emitWire,
  capDetail,
  safeJson,
  safeHeaders,
  safeUrl,
  WIRE_DETAIL_CAP,
  WireEvent,
} from "../src/core/wireLog";
import { fetchJson } from "../src/context/http";
import { searchVertex, buildVertexServingConfig } from "../src/context/adapters/vertexSearch";
import { ContextSource, DEFAULT_CAPS } from "../src/context/types";

function withSink<T>(run: () => Promise<T> | T): Promise<{ events: WireEvent[]; result: T }> {
  const events: WireEvent[] = [];
  setWireSink((e) => events.push(e));
  return Promise.resolve(run())
    .then((result) => ({ events, result }))
    .finally(() => setWireSink(undefined));
}

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

test("sink mechanics: disabled by default, no-throw without a sink, events flow when set", async () => {
  assert.equal(wireEnabled(), false);
  emitWire("x", "→", "no sink — must not throw");
  const { events } = await withSink(() => {
    assert.equal(wireEnabled(), true);
    emitWire("graph", "→", "GET /me", "detail");
  });
  assert.deepEqual(events, [{ integration: "graph", direction: "→", summary: "GET /me", detail: "detail" }]);
  assert.equal(wireEnabled(), false); // uninstalled afterwards
});

test("a throwing sink never breaks the emitting integration", () => {
  setWireSink(() => {
    throw new Error("sink exploded");
  });
  try {
    assert.doesNotThrow(() => emitWire("graph", "→", "x"));
  } finally {
    setWireSink(undefined);
  }
});

test("safeJson masks secret-shaped keys at any depth; cycles degrade gracefully", () => {
  const out = safeJson({
    query: "SELECT 1",
    password: "p@ss",
    nested: { client_secret: "abc", Authorization: "Bearer xyz", apiKey: "k", ok: 1 },
    list: [{ refresh_token: "rt" }, "plain"],
  });
  assert.ok(!out.includes("p@ss"));
  assert.ok(!out.includes("abc"));
  assert.ok(!out.includes("xyz"));
  assert.ok(!out.includes("rt"));
  assert.match(out, /"password": "\*\*\*"/);
  assert.match(out, /"ok": 1/);
  assert.match(out, /SELECT 1/);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.equal(safeJson(cyclic), "[unserializable payload]");
});

test("safeHeaders keeps schemes but never values; safeUrl masks creds and token params", () => {
  const rendered = safeHeaders({
    Authorization: "Basic dXNlcjpwYXNz",
    Accept: "application/json",
    Cookie: "session=abc123",
  });
  assert.ok(!rendered.includes("dXNlcjpwYXNz"));
  assert.ok(!rendered.includes("abc123"));
  assert.match(rendered, /Authorization: Basic \*\*\*/);
  assert.match(rendered, /Accept: application\/json/);
  assert.match(rendered, /Cookie: \*\*\*/);

  assert.equal(safeUrl("https://u:secretpw@host/x"), "https://u:***@host/x");
  assert.equal(
    safeUrl("https://h/cb?code=AUTHCODE123&state=ok&access_token=tok"),
    "https://h/cb?code=***&state=ok&access_token=***",
  );
});

test("capDetail bounds payloads and says how much was cut", () => {
  const capped = capDetail("x".repeat(WIRE_DETAIL_CAP + 500));
  assert.ok(capped.length < WIRE_DETAIL_CAP + 100);
  assert.match(capped, /500 more chars truncated/);
  assert.equal(capDetail("short"), "short");
});

test("http tap: request/response events carry detail but the Basic credential never appears", async () => {
  const { events } = await withSink(() =>
    withFetch(
      () => ({ body: { results: [{ id: 1 }] } }),
      () =>
        fetchJson(
          "https://jira.corp.example/rest/api/2/search",
          { method: "basic", username: "jdoe@corp.example", secret: "supersecret123" },
          5_000,
        ),
    ),
  );
  const all = JSON.stringify(events);
  assert.ok(!all.includes("supersecret123"), "credential leaked into wire log");
  assert.ok(!all.includes(Buffer.from("jdoe@corp.example:supersecret123").toString("base64")));
  const req = events.find((e) => e.direction === "→");
  const res = events.find((e) => e.direction === "←");
  assert.match(req?.summary ?? "", /GET https:\/\/jira\.corp\.example/);
  assert.match(req?.detail ?? "", /Authorization: Basic \*\*\*/);
  assert.match(res?.summary ?? "", /200/);
  assert.match(res?.detail ?? "", /"results"/); // full (capped) body is visible
});

test("vertex tap: bearer token never appears; query and response detail do", async () => {
  const src: ContextSource = {
    id: "v1",
    type: "vertexai",
    displayName: "Search",
    baseUrl: buildVertexServingConfig({ projectId: "p", location: "global", engineId: "e" }),
    deployment: "cloud",
    authMethod: "pat",
    addedAt: "2026-06-11T00:00:00.000Z",
  };
  const { events } = await withSink(() =>
    withFetch(
      () => ({ body: { results: [{ document: { id: "d1", derivedStructData: { title: "T" } } }] } }),
      () => searchVertex(src, { method: "pat", secret: "ya29.SECRET" }, "find things", DEFAULT_CAPS),
    ),
  );
  const all = JSON.stringify(events);
  assert.ok(!all.includes("ya29.SECRET"), "vertex token leaked into wire log");
  assert.match(all, /Bearer \\\*\\\*\\\*|Bearer \*\*\*/);
  assert.match(all, /find things/); // the query IS the sent detail
  assert.match(all, /:search/);
});

test("emitting while disabled is free: no events recorded outside the sink window", async () => {
  const before: WireEvent[] = [];
  setWireSink((e) => before.push(e));
  setWireSink(undefined);
  await withFetch(
    () => ({ body: {} }),
    () =>
      fetchJson(
        "https://x.example/api",
        { method: "pat", secret: "tok" },
        5_000,
      ).catch(() => undefined),
  );
  assert.equal(before.length, 0);
});
