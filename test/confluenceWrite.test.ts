import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  buildCreateBody,
  buildUpdateBody,
  markdownToStorage,
  createConfluencePage,
  updateConfluencePage,
  deleteConfluencePage,
  normalizeLabel,
  addConfluenceLabels,
  removeConfluenceLabel,
  normalizeTitle,
  decodeEntities,
  sanitizeStorageBody,
  confluenceWriteConfirmationText,
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

test("decodeEntities handles named + numeric entities", () => {
  assert.equal(decodeEntities("R&amp;D &lt;v2&gt; &#39;x&#39; &#x41;"), "R&D <v2> 'x' A");
  assert.equal(decodeEntities("no entities here"), "no entities here");
});

test("normalizeTitle yields plain text: strips HTML, decodes entities, fixes &", () => {
  assert.equal(normalizeTitle("R&amp;D Process"), "R&D Process"); // the reported bug
  assert.equal(normalizeTitle("<b>Release</b> Notes"), "Release Notes");
  assert.equal(normalizeTitle("Plan &lt;v2&gt;"), "Plan <v2>");
  assert.equal(normalizeTitle("Q&A"), "Q&A"); // a bare & stays literal
  assert.equal(normalizeTitle("  spaced   out  "), "spaced out");
});

test("sanitizeStorageBody escapes bare & and self-closes void elements", () => {
  assert.equal(sanitizeStorageBody("<p>Tom & Jerry</p>"), "<p>Tom &amp; Jerry</p>");
  assert.equal(sanitizeStorageBody('<a href="x?a=1&b=2">L</a>'), '<a href="x?a=1&amp;b=2">L</a>');
  assert.equal(sanitizeStorageBody("a<br>b<hr>c"), "a<br/>b<hr/>c");
  assert.equal(sanitizeStorageBody('<img src="d.png">'), '<img src="d.png"/>');
  // already-valid markup is left alone (idempotent)
  assert.equal(sanitizeStorageBody("<p>A &amp; B</p><br/>"), "<p>A &amp; B</p><br/>");
});

test("sanitizeStorageBody leaves CDATA (code blocks) verbatim", () => {
  const code = markdownToStorage("```js\nif (a && b) x = '<br>';\n```");
  // the & and <br> inside the code macro's CDATA must NOT be altered
  assert.match(sanitizeStorageBody(code), /a && b/);
  assert.match(sanitizeStorageBody(code), /'<br>'/);
});

test("buildCreateBody normalizes a messy title and malformed body", () => {
  const b = buildCreateBody({ spaceKey: "DEV", title: "R&amp;D & QA", body: "<p>x & y</p><br>" }) as {
    title: string;
    body: { storage: { value: string } };
  };
  assert.equal(b.title, "R&D & QA");
  assert.equal(b.body.storage.value, "<p>x &amp; y</p><br/>");
});

test("markdownToStorage converts headings, paragraphs, lists, code, and inline spans", () => {
  const html = markdownToStorage(
    "# Title\n\nHello **bold** and [link](https://x).\n\n- a\n- b\n\n```\ncode <x>\n```",
  );
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<p>Hello <strong>bold<\/strong> and <a href="https:\/\/x">link<\/a>\.<\/p>/);
  assert.match(html, /<ul><li>a<\/li><li>b<\/li><\/ul>/);
  // A fenced block now becomes a real code macro (CDATA is verbatim, not escaped).
  assert.match(html, /ac:name="code"><ac:plain-text-body><!\[CDATA\[code <x>\]\]><\/ac:plain-text-body>/);
});

test("markdownToStorage escapes HTML in body text", () => {
  assert.match(markdownToStorage("a < b & c"), /<p>a &lt; b &amp; c<\/p>/);
});

test("markdownToStorage emits real macros: fenced code → code macro, task list, hr, [TOC]", () => {
  const code = markdownToStorage("```python\nprint(1)\n```");
  assert.match(code, /ac:name="code"/);
  assert.match(code, /ac:name="language">python/);
  assert.match(code, /<!\[CDATA\[print\(1\)\]\]>/);
  assert.doesNotMatch(code, /<pre>/);

  const tasks = markdownToStorage("- [ ] todo\n- [x] done");
  assert.match(tasks, /<ac:task-list>/);
  assert.match(tasks, /incomplete<\/ac:task-status><ac:task-body>todo/);
  assert.match(tasks, /complete<\/ac:task-status><ac:task-body>done/);

  assert.match(markdownToStorage("above\n\n---\n\nbelow"), /<hr\/>/);
});

test("markdownToStorage rescues a literal [TOC]/{toc} into the real toc macro", () => {
  for (const shorthand of ["[TOC]", "[[TOC]]", "{toc}", "{toc:maxLevel=2}"]) {
    const out = markdownToStorage(`Intro\n\n${shorthand}\n\nBody`);
    assert.match(out, /<ac:structured-macro ac:name="toc">/, `failed for ${shorthand}`);
    assert.doesNotMatch(out, /\[TOC\]|\{toc/i);
  }
});

test("normalizeLabel enforces Confluence's lowercase/no-space rules", () => {
  assert.equal(normalizeLabel("Needs Review"), "needs-review");
  assert.equal(normalizeLabel("  ARCHIVE  "), "archive");
  assert.equal(normalizeLabel("team:platform_v2.0"), "team:platform_v2.0");
  assert.equal(normalizeLabel("bad/chars!"), "badchars");
});

test("addConfluenceLabels POSTs normalized labels with the write headers", async () => {
  const { result, calls } = await withFetch(
    () => ({ body: { results: [{ name: "needs-review" }, { name: "q3" }] } }),
    () => addConfluenceLabels(SRC, CRED, "55", ["Needs Review", "Q3", "Needs Review"], 30000),
  );
  assert.match(calls[0].url, /\/rest\/api\/content\/55\/label$/);
  assert.equal((calls[0].init as { method?: string }).method, "POST");
  assert.equal((calls[0].init.headers as Record<string, string>)["X-Atlassian-Token"], "no-check");
  const body = JSON.parse(String((calls[0].init as { body?: string }).body));
  // de-duped + normalized
  assert.deepEqual(body, [{ prefix: "global", name: "needs-review" }, { prefix: "global", name: "q3" }]);
  assert.deepEqual(result, ["needs-review", "q3"]);
});

test("removeConfluenceLabel DELETEs by normalized name", async () => {
  const { calls } = await withFetch(
    () => ({ status: 204, body: undefined }),
    () => removeConfluenceLabel(SRC, CRED, "55", "Needs Review", 30000),
  );
  assert.equal((calls[0].init as { method?: string }).method, "DELETE");
  assert.match(calls[0].url, /\/label\?name=needs-review$/);
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

test("writes mirror the Python client: no-check token + a NON-browser User-Agent", async () => {
  const header = (init: RequestInit, name: string) => (init.headers as Record<string, string>)[name];
  const create = await withFetch(
    () => ({ body: { id: "1", title: "T", version: { number: 1 } } }),
    () => createConfluencePage(SRC, CRED, { spaceKey: "DEV", title: "T", body: "<p/>" }, 30000),
  );
  assert.equal(header(create.calls[0].init, "X-Atlassian-Token"), "no-check");
  const ua = header(create.calls[0].init, "User-Agent");
  assert.match(ua, /ai-toolkit-confluence/);
  // The decisive property: it must NOT look like a browser (no Mozilla/Chrome).
  assert.doesNotMatch(ua, /Mozilla|Chrome|Safari|AppleWebKit/i);

  const del = await withFetch(
    () => ({ status: 204, body: undefined }),
    () => deleteConfluencePage(SRC, CRED, "9", 30000),
  );
  assert.equal(header(del.calls[0].init, "X-Atlassian-Token"), "no-check");

  // The GET that reads the current version before an update need not carry it.
  const upd = await withFetch(
    (_url, init) =>
      ((init as { method?: string }).method ?? "GET") === "GET"
        ? { body: { id: "5", title: "Old", version: { number: 3 } } }
        : { body: { id: "5", title: "New", version: { number: 4 } } },
    () => updateConfluencePage(SRC, CRED, { id: "5", title: "New", body: "<p/>" }, 30000),
  );
  assert.equal(header(upd.calls[1].init, "X-Atlassian-Token"), "no-check", "the PUT carries the header");
});

test("confluenceWriteConfirmationText always surfaces the instance URL + write scope before a change", () => {
  // Space-scoped connector → the gate names the space key AND the URL.
  const spaceScoped = { baseUrl: "https://wiki.example.com/wiki", writeScope: { kind: "space" as const, spaceKey: "ENG" } };
  const m1 = confluenceWriteConfirmationText(spaceScoped, "Wiki", ["**Action:** archive page `123`"]);
  assert.match(m1, /https:\/\/wiki\.example\.com\/wiki/);
  assert.match(m1, /Space \(connector write scope\):\*\* `ENG`/);
  assert.match(m1, /archive page `123`/);
  assert.match(m1, /Verify the \*\*space\*\* and \*\*URL\*\*/);

  // Instance-scoped connector (no space bound) → explicit "ENTIRE instance" warning + URL.
  const instance = { baseUrl: "https://wiki.example.com/wiki", writeScope: { kind: "instance" as const } };
  const m2 = confluenceWriteConfirmationText(instance, undefined, ["**Action:** update page `9`"]);
  assert.match(m2, /ENTIRE instance/);
  assert.match(m2, /https:\/\/wiki\.example\.com\/wiki/);

  // Unresolved source → still a gate, naming the source ref.
  const m3 = confluenceWriteConfirmationText(undefined, "Wiki", ["**Action:** remove page `9` from search"]);
  assert.match(m3, /\*\*Source:\*\* Wiki/);
  assert.match(m3, /remove page `9` from search/);
});
