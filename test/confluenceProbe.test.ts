import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  buildProbeTitle,
  probeBody,
  summarizeProbe,
  probeConfluenceWriteAccess,
  probeConfluenceFunctionality,
  summarizeFunctionalityProbe,
  WriteProbeResult,
} from "../src/context/adapters/confluenceProbe";
import { ContextSource, ContextCredential } from "../src/context/types";

const SRC: ContextSource = {
  id: "c1",
  type: "confluence",
  displayName: "Wiki",
  baseUrl: "https://wiki.example.com",
  deployment: "datacenter",
  authMethod: "basic",
  addedAt: "2026-06-15T00:00:00Z",
};
const CRED: ContextCredential = { method: "basic", username: "u", secret: "p" };

async function withFetch<T>(
  handler: (url: string, init: RequestInit) => { status?: number; body: unknown },
  run: () => Promise<T>,
): Promise<{ result: T; calls: Array<{ url: string; method: string }> }> {
  const calls: Array<{ url: string; method: string }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init: RequestInit) => {
    calls.push({ url: String(url), method: (init?.method as string) ?? "GET" });
    const r = handler(String(url), init ?? {});
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

test("buildProbeTitle is obvious, time-stamped and disposable", () => {
  const t = buildProbeTitle("2026-06-16T15:00:00Z");
  assert.match(t, /AI Toolkit/);
  assert.match(t, /safe to delete/i);
  assert.match(t, /2026-06-16T15:00:00Z/);
  assert.match(probeBody("2026-06-16T15:00:00Z"), /non-destructive/i);
});

test("happy path: create → update → delete all succeed in a space scope", async () => {
  const { result, calls } = await withFetch(
    (url, init) => {
      const m = (init.method as string) ?? "GET";
      if (m === "POST" && /\/content$/.test(url)) return { body: { id: "100", title: "t", version: { number: 1 }, _links: { webui: "/p/100" } } };
      if (m === "GET" && /\/content\/100/.test(url)) return { body: { id: "100", title: "t", version: { number: 1 } } };
      if (m === "PUT" && /\/content\/100$/.test(url)) return { body: { id: "100", title: "t", version: { number: 2 }, _links: { webui: "/p/100" } } };
      if (m === "DELETE" && /\/content\/100$/.test(url)) return { status: 204, body: undefined };
      return { status: 500, body: {} };
    },
    () => probeConfluenceWriteAccess(SRC, CRED, { spaceKey: "ENG" }, 30000, "2026-06-16T15:00:00Z"),
  );
  assert.equal(result.ok, true);
  assert.deepEqual(
    [result.create, result.update, result.remove, result.cleanedUp],
    [true, true, true, true],
  );
  assert.equal(result.spaceKey, "ENG");
  // create(POST) + getMeta(GET) + update(PUT) + delete(DELETE)
  assert.deepEqual(calls.map((c) => c.method), ["POST", "GET", "PUT", "DELETE"]);
  assert.match(summarizeProbe(result), /Write access confirmed in ENG/);
});

test("create refused (403): fails fast at create, nothing to clean up", async () => {
  const { result, calls } = await withFetch(
    (url, init) =>
      ((init.method as string) ?? "GET") === "POST" && /\/content$/.test(url)
        ? { status: 403, body: { message: "user not permitted to create content" } }
        : { status: 500, body: {} },
    () => probeConfluenceWriteAccess(SRC, CRED, { spaceKey: "ENG" }, 30000, "2026-06-16T15:00:00Z"),
  );
  assert.equal(result.ok, false);
  assert.equal(result.failedAt, "create");
  assert.equal(result.create, false);
  assert.ok(/permission|refused|forbidden/i.test(result.reason ?? ""));
  assert.equal(calls.length, 1, "stops after the failed create");
  assert.match(summarizeProbe(result), /NOT fully available/);
});

test("update refused but cleanup still runs (no stray page)", async () => {
  const { result } = await withFetch(
    (url, init) => {
      const m = (init.method as string) ?? "GET";
      if (m === "POST" && /\/content$/.test(url)) return { body: { id: "7", version: { number: 1 }, _links: { webui: "/p/7" } } };
      if (m === "GET" && /\/content\/7/.test(url)) return { body: { id: "7", version: { number: 1 } } };
      if (m === "PUT") return { status: 403, body: { message: "no edit" } };
      if (m === "DELETE") return { status: 204, body: undefined };
      return { status: 500, body: {} };
    },
    () => probeConfluenceWriteAccess(SRC, CRED, { spaceKey: "ENG" }, 30000, "2026-06-16T15:00:00Z"),
  );
  assert.equal(result.ok, false);
  assert.equal(result.failedAt, "update");
  assert.equal(result.create, true);
  assert.equal(result.remove, true, "still deleted the probe page");
  assert.equal(result.cleanedUp, true);
});

test("page scope resolves the parent's space, then creates a child", async () => {
  const { result, calls } = await withFetch(
    (url, init) => {
      const m = (init.method as string) ?? "GET";
      if (m === "GET" && /\/content\/500\?/.test(url)) return { body: { id: "500", space: { key: "TEAM" }, version: { number: 1 } } };
      if (m === "POST" && /\/content$/.test(url)) return { body: { id: "501", version: { number: 1 }, _links: { webui: "/p/501" } } };
      if (m === "GET" && /\/content\/501/.test(url)) return { body: { id: "501", version: { number: 1 } } };
      if (m === "PUT") return { body: { id: "501", version: { number: 2 }, _links: { webui: "/p/501" } } };
      if (m === "DELETE") return { status: 204, body: undefined };
      return { status: 500, body: {} };
    },
    () => probeConfluenceWriteAccess(SRC, CRED, { parentId: "500" }, 30000, "2026-06-16T15:00:00Z"),
  );
  assert.equal(result.ok, true);
  assert.equal(result.spaceKey, "TEAM");
  assert.equal(calls[0].method, "GET", "first resolves the parent page's space");
});

test("instance scope (no space/page) reports it can't test", async () => {
  const result: WriteProbeResult = await probeConfluenceWriteAccess(SRC, CRED, {}, 30000, "2026-06-16T15:00:00Z");
  assert.equal(result.ok, false);
  assert.equal(result.failedAt, "resolve");
  assert.match(result.reason ?? "", /instance-scoped/);
});

// --- content functionality probe -------------------------------------------

const CAPS = { maxResults: 25, maxBodyChars: 8000, timeoutMs: 30000 };

test("functionality probe: create → validate (clean) → delete = ok", async () => {
  const { result, calls } = await withFetch(
    (url, init) => {
      const m = (init.method as string) ?? "GET";
      if (m === "POST" && /\/content$/.test(url)) return { body: { id: "70", version: { number: 1 }, _links: { webui: "/p/70" } } };
      // validate: rendered view with real macros, no leaks
      if (m === "GET" && /\/content\/70\?expand=body\.view/.test(url)) {
        return { body: { title: "T", body: { view: { value: '<div data-macro-name="toc">x</div><div data-macro-name="info">i</div>' } }, _links: { webui: "/p/70" } } };
      }
      if (m === "DELETE" && /\/content\/70$/.test(url)) return { status: 204, body: undefined };
      return { status: 500, body: {} };
    },
    () => probeConfluenceFunctionality(SRC, CRED, { spaceKey: "ENG" }, CAPS, "2026-06-16T18:00:00Z"),
  );
  assert.equal(result.ok, true);
  assert.equal(result.create, true);
  assert.equal(result.cleanedUp, true);
  assert.deepEqual(result.leaks, []);
  assert.ok(result.rendered.some((e) => e.name === "toc"));
  assert.deepEqual(calls.map((c) => c.method), ["POST", "GET", "DELETE"]);
  assert.match(summarizeFunctionalityProbe(result), /Content functionality confirmed/);
});

test("functionality probe: a leaked [TOC] fails the check (still cleans up)", async () => {
  const result = (
    await withFetch(
      (_url, init) => {
        const m = (init.method as string) ?? "GET";
        if (m === "POST") return { body: { id: "71", version: { number: 1 }, _links: { webui: "/p/71" } } };
        if (m === "GET") return { body: { title: "T", body: { view: { value: "<p>[TOC]</p>" } }, _links: { webui: "/p/71" } } };
        if (m === "DELETE") return { status: 204, body: undefined };
        return { status: 500, body: {} };
      },
      () => probeConfluenceFunctionality(SRC, CRED, { spaceKey: "ENG" }, CAPS, "2026-06-16T18:00:00Z"),
    )
  ).result;
  assert.equal(result.ok, false);
  assert.ok(result.leaks.some((l) => l.macro === "toc"));
  assert.equal(result.cleanedUp, true);
  assert.match(summarizeFunctionalityProbe(result), /leaked as literal text/);
});
