import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  buildPageTree,
  countTreeNodes,
  renderPageTree,
  getPageAncestors,
  getChildPages,
  getDescendantPages,
  getSpaceRootPages,
  getPageHierarchy,
  PageRef,
} from "../src/context/adapters/confluenceHierarchy";
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
const CRED: ContextCredential = { method: "pat", secret: "t" };

async function withFetch<T>(
  handler: (url: string, init: RequestInit) => { status?: number; body: unknown },
  run: () => Promise<T>,
): Promise<{ result: T; calls: string[] }> {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init: RequestInit) => {
    calls.push(String(url));
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

const ref = (id: string, title: string, parentId?: string): PageRef & { parentId?: string } => ({
  id,
  title,
  url: `https://wiki/${id}`,
  ...(parentId ? { parentId } : {}),
});

// --- pure tree building ----------------------------------------------------

test("buildPageTree nests descendants under their parents", () => {
  const root = ref("1", "Root");
  const tree = buildPageTree(root, [
    ref("2", "A", "1"),
    ref("3", "B", "1"),
    ref("4", "A1", "2"),
    ref("5", "A1a", "4"),
  ]);
  assert.equal(tree.id, "1");
  assert.deepEqual(tree.children.map((c) => c.id), ["2", "3"]);
  const a = tree.children.find((c) => c.id === "2")!;
  assert.deepEqual(a.children.map((c) => c.id), ["4"]);
  assert.equal(a.children[0].children[0].id, "5");
  assert.equal(countTreeNodes(tree), 4);
});

test("buildPageTree attaches orphans (unknown parent) to the root", () => {
  const tree = buildPageTree(ref("1", "Root"), [ref("9", "Orphan", "999")]);
  assert.deepEqual(tree.children.map((c) => c.id), ["9"]);
});

test("renderPageTree indents by depth", () => {
  const tree = buildPageTree(ref("1", "Root"), [ref("2", "Child", "1"), ref("3", "Grandchild", "2")]);
  const out = renderPageTree(tree);
  assert.match(out, /- Root \(1\)/);
  assert.match(out, /\n {2}- Child \(2\)/);
  assert.match(out, /\n {4}- Grandchild \(3\)/);
});

// --- IO: ancestors / children / descendants / roots ------------------------

test("getPageAncestors returns the ordered breadcrumb + immediate parent", async () => {
  const { result, calls } = await withFetch(
    () => ({
      body: {
        id: "10",
        title: "Leaf",
        space: { key: "ENG" },
        ancestors: [
          { id: "1", title: "Home", _links: { webui: "/home" } },
          { id: "5", title: "Section", _links: { webui: "/section" } },
        ],
        _links: { webui: "/leaf" },
      },
    }),
    () => getPageAncestors(SRC, CRED, "10", DEFAULT_CAPS),
  );
  assert.match(calls[0], /expand=ancestors,space/);
  assert.deepEqual(result.ancestors.map((a) => a.id), ["1", "5"]);
  assert.equal(result.parent?.id, "5"); // immediate parent = last ancestor
  assert.equal(result.spaceKey, "ENG");
  assert.equal(result.page.url, "https://wiki.example.com/leaf");
});

test("getChildPages paginates until a short page (no truncation)", async () => {
  // 100 children in page 1, 30 in page 2 → 130 total, two requests.
  const { result, calls } = await withFetch(
    (url) => {
      const start = Number(new URL(url).searchParams.get("start"));
      const n = start === 0 ? 100 : 30;
      return { body: { results: Array.from({ length: n }, (_, k) => ({ id: String(start + k), title: `c${start + k}`, _links: { webui: `/c${start + k}` } })) } };
    },
    () => getChildPages(SRC, CRED, "1", DEFAULT_CAPS),
  );
  assert.equal(result.length, 130);
  assert.equal(calls.length, 2, "followed pagination");
  assert.match(calls[0], /\/content\/1\/child\/page\?start=0&limit=100/);
  assert.match(calls[1], /start=100&limit=100/);
});

test("getDescendantPages carries each node's immediate parent (last ancestor)", async () => {
  const { result } = await withFetch(
    () => ({
      body: {
        results: [
          { id: "2", title: "A", _links: { webui: "/a" }, ancestors: [{ id: "1" }] },
          { id: "3", title: "A1", _links: { webui: "/a1" }, ancestors: [{ id: "1" }, { id: "2" }] },
        ],
      },
    }),
    () => getDescendantPages(SRC, CRED, "1", DEFAULT_CAPS),
  );
  assert.equal(result.find((p) => p.id === "2")?.parentId, "1");
  assert.equal(result.find((p) => p.id === "3")?.parentId, "2");
});

test("getSpaceRootPages hits the depth=root listing", async () => {
  const { result, calls } = await withFetch(
    () => ({ body: { results: [{ id: "1", title: "Home", _links: { webui: "/home" } }] } }),
    () => getSpaceRootPages(SRC, CRED, "ENG", DEFAULT_CAPS),
  );
  assert.match(calls[0], /\/space\/ENG\/content\/page\?depth=root/);
  assert.equal(result[0].id, "1");
});

test("getPageHierarchy combines ancestors + children in one view", async () => {
  const { result } = await withFetch(
    (url) => {
      if (/expand=ancestors,space/.test(url)) {
        return { body: { id: "10", title: "Leaf", space: { key: "ENG" }, ancestors: [{ id: "1", title: "Home", _links: { webui: "/home" } }], _links: { webui: "/leaf" } } };
      }
      // child/page
      return { body: { results: [{ id: "11", title: "Kid", _links: { webui: "/kid" } }] } };
    },
    () => getPageHierarchy(SRC, CRED, "10", DEFAULT_CAPS),
  );
  assert.equal(result.page.id, "10");
  assert.equal(result.parent?.id, "1");
  assert.equal(result.childCount, 1);
  assert.equal(result.children[0].id, "11");
  assert.equal(result.spaceKey, "ENG");
});
