import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  applyPushPlan,
  assertFresh,
  fileMapsEqual,
  describeOp,
  PushWriter,
} from "../src/sync/pushEngine";
import { PushPlan, buildPushPlan } from "../src/sync/pushPlan";
import { parseDesiredState } from "../src/sync/desiredState";
import { serializeSite, SiteSnapshotInput } from "../src/sync/serializer";

/** Recording fake writer; ops fail when their label is in `failOn`. */
function fakeWriter(failOn: string[] = []) {
  const calls: string[] = [];
  const maybeFail = (label: string) => {
    calls.push(label);
    if (failOn.includes(label)) throw new Error(`boom: ${label}`);
  };
  let nextId = 100;
  const writer: PushWriter = {
    async createList(_s, l) {
      maybeFail(`createList:${l.displayName}`);
      return { id: `gen-${nextId++}` };
    },
    async updateList(_s, id) {
      maybeFail(`updateList:${id}`);
    },
    async createColumn(_s, listId, col) {
      maybeFail(`createColumn:${listId}:${col.name}`);
    },
    async updateColumn(_s, listId, colId) {
      maybeFail(`updateColumn:${listId}:${colId}`);
    },
    async createPage(_s, p) {
      maybeFail(`createPage:${p.name}`);
      return { id: `pg-${nextId++}` };
    },
    async updatePage(_s, pageId) {
      maybeFail(`updatePage:${pageId}`);
    },
    async publishPage(_s, pageId) {
      maybeFail(`publish:${pageId}`);
    },
    async deleteList(_s, listId) {
      maybeFail(`deleteList:${listId}`);
    },
    async deletePage(_s, pageId) {
      maybeFail(`deletePage:${pageId}`);
    },
  };
  return { writer, calls };
}

function snapshot(): SiteSnapshotInput {
  return {
    site: { id: "s1", displayName: "M", webUrl: "https://x.sharepoint.com/sites/m" },
    lists: [{ id: "L1", displayName: "Announcements", template: "genericList", columns: [{ name: "Title" }] }],
    pages: [{ id: "P1", title: "Welcome", name: "welcome.aspx", canvasLayout: { sections: [1] } }],
  };
}

function planFor(files: Record<string, unknown>, snap = snapshot()): PushPlan {
  return buildPushPlan(
    parseDesiredState(new Map(Object.entries(files).map(([k, v]) => [k, JSON.stringify(v)]))),
    snap,
  );
}

test("apply resolves new-list placeholder ids and creates columns on the generated list", async () => {
  const plan = planFor({
    "lists/products.json": { displayName: "Products", columns: [{ name: "SKU", text: {} }] },
  });
  const { writer, calls } = fakeWriter();
  const outcome = await applyPushPlan(writer, "s1", plan, false);
  assert.equal(outcome.failedAt, undefined);
  assert.deepEqual(calls.filter((c) => !c.startsWith("delete")), [
    "createList:Products",
    "createColumn:gen-100:SKU",
  ]);
});

test("pages publish after create and after update", async () => {
  const plan = planFor({
    "pages/new.json": { title: "New", name: "new.aspx", canvasLayout: { s: 1 } },
    "pages/welcome.json": { title: "Welcome 2", name: "welcome.aspx", canvasLayout: { sections: [1] } },
  });
  const { writer, calls } = fakeWriter();
  await applyPushPlan(writer, "s1", plan, false);
  assert.ok(calls.includes("createPage:new.aspx"));
  assert.ok(calls.some((c) => c.startsWith("publish:pg-")));
  assert.ok(calls.includes("updatePage:P1"));
  assert.ok(calls.includes("publish:P1"));
});

test("stop on first error: later ops are not attempted, partial progress reported", async () => {
  const plan = planFor({
    "lists/a.json": { displayName: "Alpha", columns: [] },
    "lists/b.json": { displayName: "Beta", columns: [] },
  });
  const { writer, calls } = fakeWriter(["createList:Alpha"]);
  const outcome = await applyPushPlan(writer, "s1", plan, false);
  assert.ok(outcome.failedAt);
  assert.match(outcome.failedAt!.op, /Alpha/);
  assert.equal(outcome.applied.length, 0);
  assert.ok(!calls.includes("createList:Beta"));
});

test("deletions only run with opt-in", async () => {
  const plan = planFor({}); // live has Announcements + welcome.aspx → deletions
  assert.ok(plan.deletions.length >= 2);
  const off = fakeWriter();
  await applyPushPlan(off.writer, "s1", plan, false);
  assert.ok(!off.calls.some((c) => c.startsWith("delete")));
  const on = fakeWriter();
  const outcome = await applyPushPlan(on.writer, "s1", plan, true);
  assert.ok(on.calls.includes("deleteList:L1"));
  assert.ok(on.calls.includes("deletePage:P1"));
  assert.equal(outcome.failedAt, undefined);
});

test("assertFresh passes on identical live state and throws on drift", async () => {
  const base = serializeSite(snapshot());
  await assertFresh(async () => snapshot(), base); // no throw
  const drifted = snapshot();
  drifted.pages[0].title = "Changed in SharePoint";
  await assert.rejects(
    assertFresh(async () => drifted, base),
    /changed since this plan was previewed/,
  );
});

test("fileMapsEqual compares size and bytes", () => {
  const a = new Map([["x", "1"]]);
  assert.ok(fileMapsEqual(a, new Map([["x", "1"]])));
  assert.ok(!fileMapsEqual(a, new Map([["x", "2"]])));
  assert.ok(!fileMapsEqual(a, new Map([["x", "1"], ["y", "1"]])));
});

test("describeOp covers every op kind", () => {
  const plan = planFor({
    "lists/new.json": { displayName: "New", columns: [{ name: "C" }] },
    "pages/p.json": { title: "P", name: "p.aspx" },
  });
  for (const op of [...plan.ops, ...plan.deletions]) {
    assert.ok(describeOp(op).length > 0);
  }
});
