import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  structuredMacro,
  codeBlock,
  panel,
  expand,
  status,
  tableOfContents,
  anchor,
  horizontalRule,
  taskList,
  jira,
  drawio,
  layout,
  MACRO_CATALOG,
  catalogByCategory,
  buildFunctionalitySample,
  extractMacrosFromStorage,
  tallyMacros,
  findLeakedMacroMarkup,
  inventoryRenderedMacros,
  discoverConfluenceMacros,
  detectConfluenceApps,
  validateConfluencePageRendered,
} from "../src/context/adapters/confluenceMacros";
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
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init: RequestInit) => {
    const r = handler(String(url), init ?? {});
    return new Response(r.body === undefined ? undefined : JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

// --- emitters --------------------------------------------------------------

test("structuredMacro emits params + rich/plain bodies and escapes", () => {
  assert.equal(structuredMacro("toc"), '<ac:structured-macro ac:name="toc"></ac:structured-macro>');
  assert.equal(
    structuredMacro("status", { colour: "Green", title: "A & B" }),
    '<ac:structured-macro ac:name="status"><ac:parameter ac:name="colour">Green</ac:parameter><ac:parameter ac:name="title">A &amp; B</ac:parameter></ac:structured-macro>',
  );
  assert.match(structuredMacro("info", {}, { richBody: "<p>x</p>" }), /<ac:rich-text-body><p>x<\/p><\/ac:rich-text-body>/);
});

test("codeBlock uses the code macro with language and CDATA (splitting ]]> )", () => {
  const c = codeBlock("a ]]> b", "python", "Demo");
  assert.match(c, /ac:name="code"/);
  assert.match(c, /ac:name="language">python/);
  assert.match(c, /ac:name="title">Demo/);
  assert.match(c, /<!\[CDATA\[a \]\]\]\]><!\[CDATA\[> b\]\]>/);
});

test("taskList builds checkbox items with status", () => {
  const t = taskList([{ text: "Do X" }, { text: "Done Y", done: true }]);
  assert.match(t, /^<ac:task-list>/);
  assert.match(t, /<ac:task-status>incomplete<\/ac:task-status><ac:task-body>Do X<\/ac:task-body>/);
  assert.match(t, /<ac:task-status>complete<\/ac:task-status><ac:task-body>Done Y<\/ac:task-body>/);
});

test("jira emits key OR jqlQuery + columns", () => {
  assert.match(jira({ key: "PROJ-1" }), /ac:name="key">PROJ-1/);
  const filter = jira({ jql: "project = PROJ", columns: "key,summary" });
  assert.match(filter, /ac:name="jqlQuery">project = PROJ/);
  assert.match(filter, /ac:name="columns">key,summary/);
});

test("drawio / panel / expand / status / anchor / hr / layout / toc", () => {
  assert.match(drawio({ diagramName: "Arch" }), /ac:name="drawio".*ac:name="diagramName">Arch/);
  assert.match(panel("warning", "<p>!</p>"), /ac:name="warning"><ac:rich-text-body><p>!<\/p>/);
  assert.match(expand("<p>b</p>", "More"), /ac:name="expand"><ac:parameter ac:name="title">More<\/ac:parameter><ac:rich-text-body>/);
  assert.match(status("DONE", "Green"), /ac:name="status".*Green.*DONE/s);
  assert.equal(anchor("a1"), '<ac:structured-macro ac:name="anchor"><ac:parameter ac:name="">a1</ac:parameter></ac:structured-macro>');
  assert.equal(horizontalRule(), "<hr/>");
  assert.equal(tableOfContents(), '<ac:structured-macro ac:name="toc"></ac:structured-macro>');
  assert.match(layout([{ type: "two_equal", cells: ["<p>L</p>", "<p>R</p>"] }]), /<ac:layout><ac:layout-section ac:type="two_equal"><ac:layout-cell><p>L<\/p><\/ac:layout-cell><ac:layout-cell><p>R<\/p>/);
});

// --- catalog ---------------------------------------------------------------

test("catalog covers the requested elements and groups them", () => {
  const names = new Set(MACRO_CATALOG.map((m) => m.name));
  for (const n of ["code", "hr", "task-list", "jira", "drawio", "toc", "status", "info", "expand", "layout"]) {
    assert.ok(names.has(n), `catalog missing ${n}`);
  }
  // app-gated ones carry an app
  assert.equal(MACRO_CATALOG.find((m) => m.name === "drawio")?.app !== undefined, true);
  assert.equal(MACRO_CATALOG.find((m) => m.name === "jira")?.app !== undefined, true);
  // built-ins don't
  assert.equal(MACRO_CATALOG.find((m) => m.name === "toc")?.app, undefined);
  const groups = catalogByCategory();
  assert.equal(groups[0].category, "formatting");
  assert.ok(groups.every((g) => g.macros.length > 0));
});

test("buildFunctionalitySample emits real macros for every claimed element", () => {
  const { body, emitted } = buildFunctionalitySample("2026-06-16T18:00:00Z");
  // every emitted built-in element is present as a real element in the body
  const present = new Set(extractMacrosFromStorage(body));
  for (const name of emitted) {
    assert.ok(present.has(name), `sample missing real element ${name}`);
  }
  // and it carries NO wiki/markdown shorthand
  assert.deepEqual(findLeakedMacroMarkup(body.replace(/<[^>]+>/g, " ")), []);
});

// --- extract / tally -------------------------------------------------------

test("extractMacrosFromStorage finds macros and special elements", () => {
  const body = `${tableOfContents()}${jira({ key: "P-1" })}${taskList([{ text: "x" }])}${horizontalRule()}`;
  const found = new Set(extractMacrosFromStorage(body));
  assert.ok(found.has("toc"));
  assert.ok(found.has("jira"));
  assert.ok(found.has("task-list"));
  assert.ok(found.has("hr"));
});

test("tallyMacros counts, annotates from the catalog, flags unknowns", () => {
  const a = `${tableOfContents()}${jira({ key: "P-1" })}`;
  const b = `${tableOfContents()}<ac:structured-macro ac:name="customapp-thing"/>`;
  const t = tallyMacros([a, b]);
  const toc = t.find((u) => u.name === "toc")!;
  assert.equal(toc.count, 2);
  assert.equal(toc.known, true);
  const custom = t.find((u) => u.name === "customapp-thing")!;
  assert.equal(custom.known, false);
});

// --- leaked-markup validation (the [TOC] bug) ------------------------------

test("findLeakedMacroMarkup catches [TOC], {macro} shorthand and raw storage-as-text", () => {
  const leaks = findLeakedMacroMarkup("Intro [TOC] then {info} and {note:title=Hi}. <ac:structured-macro broke.");
  const macros = leaks.map((l) => l.macro);
  assert.ok(macros.includes("toc"));
  assert.ok(macros.includes("info"));
  assert.ok(macros.includes("note"));
  assert.ok(macros.includes("structured-macro"));
});

test("findLeakedMacroMarkup does not flag ordinary braces/text", () => {
  assert.deepEqual(findLeakedMacroMarkup("config {timeout} and a normal sentence."), []);
  assert.deepEqual(findLeakedMacroMarkup("a real toc rendered fine"), []);
});

test("inventoryRenderedMacros tallies rendered macros without double-counting", () => {
  const view = '<div class="toc-macro" data-macro-name="toc">…</div><div class="confluence-information-macro">i</div><ul class="task-list"><li/></ul>';
  const inv = inventoryRenderedMacros(view);
  const byName = Object.fromEntries(inv.map((e) => [e.name, e.count]));
  assert.equal(byName.toc, 1, "toc counted once despite class + data-macro-name");
  assert.equal(byName.panel, 1);
  assert.equal(byName["task-list"], 1);
});

// --- discovery / validation IO ---------------------------------------------

test("discoverConfluenceMacros samples a space and tallies usage", async () => {
  const used = await withFetch(
    (url) => {
      assert.match(url, /\/rest\/api\/content\?spaceKey=ENG/);
      return { body: { results: [{ body: { storage: { value: tableOfContents() + jira({ key: "P-1" }) } } }, { body: { storage: { value: tableOfContents() } } }] } };
    },
    () => discoverConfluenceMacros(SRC, CRED, { spaceKey: "ENG" }, DEFAULT_CAPS),
  );
  assert.equal(used.pagesSampled, 2);
  assert.equal(used.used.find((u) => u.name === "toc")?.count, 2);
});

test("detectConfluenceApps lists enabled user apps and swallows a 403", async () => {
  const apps = await withFetch(
    () => ({ body: { plugins: [{ name: "draw.io", enabled: true, userInstalled: true }, { name: "System", enabled: true, userInstalled: false }] } }),
    () => detectConfluenceApps(SRC, CRED, DEFAULT_CAPS),
  );
  assert.deepEqual(apps, ["draw.io"]);
  const none = await withFetch(() => ({ status: 403, body: { message: "forbidden" } }), () => detectConfluenceApps(SRC, CRED, DEFAULT_CAPS));
  assert.deepEqual(none, []);
});

test("validateConfluencePageRendered flags a leaked [TOC] and reports rendered elements", async () => {
  const bad = await withFetch(
    (url) => {
      assert.match(url, /expand=body\.view,body\.storage/);
      return { body: { title: "P", body: { view: { value: "<p>[TOC]</p><div data-macro-name=\"info\">i</div>" }, storage: { value: "<p>[TOC]</p>" } }, _links: { webui: "/x" } } };
    },
    () => validateConfluencePageRendered(SRC, CRED, "1", DEFAULT_CAPS),
  );
  assert.equal(bad.ok, false);
  assert.ok(bad.leaks.some((l) => l.macro === "toc"));
  assert.ok(bad.rendered.some((e) => e.name === "info"));

  const good = await withFetch(
    () => ({ body: { title: "P", body: { view: { value: '<div data-macro-name="toc">real</div>' }, storage: { value: tableOfContents() } } } }),
    () => validateConfluencePageRendered(SRC, CRED, "1", DEFAULT_CAPS),
  );
  assert.equal(good.ok, true);
  assert.deepEqual(good.leaks, []);
});
