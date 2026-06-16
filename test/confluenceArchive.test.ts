import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  findRootArchivePage,
  archiveConfluencePage,
  removeConfluencePageFromSearch,
  moveConfluencePage,
  moveConfluencePageUnder,
} from "../src/context/adapters/confluenceArchive";
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

test("findRootArchivePage matches the root 'archive' page case-insensitively", async () => {
  const { result } = await withFetch(
    () => ({ body: { results: [{ id: "8", title: "Home" }, { id: "7", title: "ARCHIVE" }] } }),
    () => findRootArchivePage(SRC, CRED, "DEV", 30000),
  );
  assert.deepEqual(result, { id: "7", title: "ARCHIVE" });
});

test("findRootArchivePage returns undefined when there's no root archive page", async () => {
  const { result } = await withFetch(
    () => ({ body: { results: [{ id: "8", title: "Home" }] } }),
    () => findRootArchivePage(SRC, CRED, "DEV", 30000),
  );
  assert.equal(result, undefined);
});

test("archiveConfluencePage moves a page under the existing Archive root", async () => {
  const { result, calls } = await withFetch(
    (url) => {
      if (url.includes("depth=root")) return { body: { results: [{ id: "100", title: "Archive" }] } };
      if (url.includes("/move/append/")) return { status: 200, body: undefined };
      return { body: { id: "55", title: "Old Doc", space: { key: "DEV" }, version: { number: 3 } } };
    },
    () => archiveConfluencePage(SRC, CRED, "55", 30000),
  );
  assert.equal(result.archiveRootId, "100");
  assert.equal(result.createdArchiveRoot, false);
  const move = calls.find((c) => c.url.includes("/move/append/"));
  assert.ok(move, "move endpoint called");
  assert.match(move!.url, /\/content\/55\/move\/append\/100$/);
  assert.equal((move!.init as { method?: string }).method, "PUT");
});

test("archiveConfluencePage creates the Archive root when the space has none", async () => {
  const { result, calls } = await withFetch(
    (url, init) => {
      if (url.includes("depth=root")) return { body: { results: [{ id: "1", title: "Home" }] } };
      if (url.includes("/move/append/")) return { status: 200, body: undefined };
      if ((init as { method?: string }).method === "POST") {
        return { body: { id: "200", title: "Archive", version: { number: 1 }, _links: { webui: "/x" } } };
      }
      return { body: { id: "55", title: "Old Doc", space: { key: "DEV" }, version: { number: 3 } } };
    },
    () => archiveConfluencePage(SRC, CRED, "55", 30000),
  );
  assert.equal(result.createdArchiveRoot, true);
  assert.equal(result.archiveRootId, "200");
  const create = calls.find((c) => (c.init as { method?: string }).method === "POST");
  assert.ok(create, "Archive root created");
  assert.equal(JSON.parse(String((create!.init as { body?: string }).body)).title, "Archive");
  assert.ok(calls.some((c) => c.url.includes("/move/append/200")), "moved under the new root");
});

test("archiveConfluencePage refuses to archive the Archive root itself", async () => {
  await assert.rejects(
    () =>
      withFetch(
        () => ({ body: { id: "55", title: "Archive", space: { key: "DEV" }, version: { number: 1 } } }),
        () => archiveConfluencePage(SRC, CRED, "55", 30000),
      ),
    /Archive root/,
  );
});

test("removeConfluencePageFromSearch blanks the current content, keeps title + bumps version", async () => {
  const { result, calls } = await withFetch(
    (_url, init) =>
      ((init as { method?: string }).method ?? "GET") === "GET"
        ? { body: { id: "55", title: "Old Doc", version: { number: 4 }, body: { storage: { value: "<p>secret</p>" } } } }
        : { body: { id: "55", title: "Old Doc", version: { number: 5 }, _links: { webui: "/x" } } },
    () => removeConfluencePageFromSearch(SRC, CRED, "55", 30000),
  );
  const put = calls.find((c) => (c.init as { method?: string }).method === "PUT");
  assert.ok(put, "page updated");
  const body = JSON.parse(String((put!.init as { body?: string }).body));
  assert.equal(body.body.storage.value, ""); // blanked — nothing for search to index
  assert.equal(body.title, "Old Doc"); // title preserved
  assert.equal(body.version.number, 5); // version bumped (history retains the original)
  assert.equal(result.version, 5);
});

test("moveConfluencePage PUTs to /move/{position}/{target} with the XSRF header", async () => {
  for (const position of ["append", "before", "after"] as const) {
    const { calls } = await withFetch(
      () => ({ status: 200, body: undefined }),
      () => moveConfluencePage(SRC, CRED, "100", position, "200", 30000),
    );
    assert.equal((calls[0].init as { method?: string }).method, "PUT");
    assert.match(calls[0].url, new RegExp(`/rest/api/content/100/move/${position}/200$`));
    assert.equal((calls[0].init.headers as Record<string, string>)["X-Atlassian-Token"], "no-check");
  }
});

test("moveConfluencePageUnder re-parents via /move/append/", async () => {
  const { calls } = await withFetch(
    () => ({ status: 200, body: undefined }),
    () => moveConfluencePageUnder(SRC, CRED, "100", "200", 30000),
  );
  assert.match(calls[0].url, /\/move\/append\/200$/);
});
