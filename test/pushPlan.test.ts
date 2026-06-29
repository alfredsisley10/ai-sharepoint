import { test } from "node:test";
import * as assert from "node:assert/strict";
import { parseDesiredState } from "../src/sync/desiredState";
import {
  buildPushPlan,
  columnToCreatable,
  canvasEquals,
  renderPushPlan,
  hasWork,
  PushOp,
} from "../src/sync/pushPlan";
import { serializeSite, SiteSnapshotInput } from "../src/sync/serializer";

function current(over: Partial<SiteSnapshotInput> = {}): SiteSnapshotInput {
  return {
    site: { id: "s1", displayName: "Marketing", webUrl: "https://x.sharepoint.com/sites/m" },
    lists: [
      {
        id: "L1",
        displayName: "Announcements",
        template: "genericList",
        columns: [
          { name: "Title", displayName: "Title", readOnly: false },
          { name: "Body", displayName: "Body" },
        ],
      },
      { id: "L2", displayName: "Documents", template: "documentLibrary", columns: [] },
    ],
    pages: [
      { id: "P1", title: "Welcome", name: "welcome.aspx", canvasLayout: { sections: [1] } },
    ],
    ...over,
  };
}

function desiredFiles(entries: Record<string, unknown>): Map<string, string> {
  return new Map(
    Object.entries(entries).map(([path, v]) => [path, JSON.stringify(v)]),
  );
}

// --- desiredState -------------------------------------------------------------

test("parseDesiredState reads lists/pages, skips malformed files with warnings", () => {
  const state = parseDesiredState(
    new Map([
      ["lists/a.json", JSON.stringify({ displayName: "A", columns: [{ name: "C1" }, { bad: true }] })],
      ["lists/broken.json", "{not json"],
      ["lists/noname.json", JSON.stringify({ description: "x" })],
      ["pages/w.json", JSON.stringify({ title: "W", name: "w.aspx", canvasLayout: { s: 1 } })],
      ["docs/other.md", "ignored"],
      [".aisharepoint/site.json", JSON.stringify({ contents: {} })],
    ]),
  );
  assert.equal(state.lists.length, 1);
  assert.equal(state.lists[0].columns.length, 1);
  assert.equal(state.pages.length, 1);
  assert.equal(state.warnings.length, 3); // broken json, missing displayName, bad column
});

test("round-trip: serialize(current) parsed back → empty plan", () => {
  const snap = current();
  const files = serializeSite(snap);
  const plan = buildPushPlan(parseDesiredState(files), snap);
  assert.deepEqual(plan.ops, []);
  assert.deepEqual(plan.deletions, []);
  assert.ok(!hasWork(plan, true));
  assert.equal(plan.unchanged.lists, 2);
  assert.equal(plan.unchanged.pages, 1);
});

// --- plan: lists ---------------------------------------------------------------

test("new list in repo → createList + addColumn with placeholder listId", () => {
  const files = desiredFiles({
    "lists/products.json": {
      displayName: "Products",
      description: "Catalog",
      template: "genericList",
      columns: [{ name: "SKU", text: {} }],
    },
  });
  const plan = buildPushPlan(parseDesiredState(files), current());
  const kinds = plan.ops.map((o) => o.kind);
  assert.deepEqual(kinds, ["createList", "addColumn"]);
  const add = plan.ops[1] as Extract<PushOp, { kind: "addColumn" }>;
  assert.equal(add.listId, "new:Products");
});

test("new column on existing list → addColumn with creatable payload only", () => {
  const files = desiredFiles({
    "lists/announcements.json": {
      displayName: "Announcements",
      columns: [
        { name: "Title" },
        { name: "Body" },
        { name: "Audience", choice: { choices: ["A", "B"] }, id: "srv-id", readOnly: false },
      ],
    },
  });
  const plan = buildPushPlan(parseDesiredState(files), current());
  const add = plan.ops.find((o) => o.kind === "addColumn") as Extract<PushOp, { kind: "addColumn" }>;
  assert.ok(add);
  assert.equal(add.listId, "L1");
  assert.equal(add.column.name, "Audience");
  assert.equal(add.column.id, undefined); // server-assigned props stripped
  assert.equal(add.column.readOnly, undefined);
  assert.deepEqual(add.column.choice, { choices: ["A", "B"] });
});

test("lookup/calculated columns become warnings, never ops", () => {
  const files = desiredFiles({
    "lists/announcements.json": {
      displayName: "Announcements",
      columns: [{ name: "Title" }, { name: "Body" }, { name: "Ref", lookup: { listId: "x" } }],
    },
  });
  const plan = buildPushPlan(parseDesiredState(files), current());
  assert.ok(!plan.ops.some((o) => o.kind === "addColumn"));
  assert.ok(plan.warnings.some((w) => w.includes('"Ref"') && w.includes("lookup")));
});

test("column metadata drift → updateColumn limited to safe fields", () => {
  const files = desiredFiles({
    "lists/announcements.json": {
      displayName: "Announcements",
      columns: [{ name: "Title" }, { name: "Body", displayName: "Body Text", required: true }],
    },
  });
  const plan = buildPushPlan(parseDesiredState(files), current());
  const upd = plan.ops.find((o) => o.kind === "updateColumn") as Extract<PushOp, { kind: "updateColumn" }>;
  assert.ok(upd);
  assert.equal(upd.column.displayName, "Body Text");
  assert.equal(upd.column.required, true);
});

test("matching is case-insensitive (no spurious creates)", () => {
  const files = desiredFiles({
    "lists/a.json": { displayName: "ANNOUNCEMENTS", columns: [] },
  });
  const plan = buildPushPlan(parseDesiredState(files), current());
  assert.ok(!plan.ops.some((o) => o.kind === "createList"));
});

test("deletions: genericList collected as opt-in deletion; library protected with warning", () => {
  const plan = buildPushPlan(parseDesiredState(new Map()), current());
  const del = plan.deletions.filter((o) => o.kind === "deleteList");
  assert.equal(del.length, 1);
  assert.equal((del[0] as Extract<PushOp, { kind: "deleteList" }>).displayName, "Announcements");
  assert.ok(plan.warnings.some((w) => w.includes("Documents") && w.includes("never deleted")));
  assert.ok(!hasWork(plan, false)); // deletions alone don't count without opt-in
  assert.ok(hasWork(plan, true));
});

test("truncated snapshot suppresses ALL deletions and warns (incomplete view ≠ orphan)", () => {
  // Empty repo against a non-empty live site would normally orphan everything.
  const plan = buildPushPlan(parseDesiredState(new Map()), current({ truncated: true }));
  assert.deepEqual(plan.deletions, [], "no deletions may be derived from a partial snapshot");
  assert.ok(!hasWork(plan, true), "even with opt-in there is nothing destructive to do");
  assert.ok(
    plan.warnings.some((w) => /partial snapshot/i.test(w) && /deletions are disabled/i.test(w)),
    "a loud truncation warning is surfaced",
  );
});

// --- plan: pages ----------------------------------------------------------------

test("page canvas drift → updatePage with canvas; title-only drift → title update", () => {
  const filesCanvas = desiredFiles({
    "pages/welcome.json": { title: "Welcome", name: "welcome.aspx", canvasLayout: { sections: [2] } },
  });
  const planCanvas = buildPushPlan(parseDesiredState(filesCanvas), current());
  const upd = planCanvas.ops.find((o) => o.kind === "updatePage") as Extract<PushOp, { kind: "updatePage" }>;
  assert.ok(upd?.canvasLayout);

  const filesTitle = desiredFiles({
    "pages/welcome.json": { title: "Hello", name: "welcome.aspx", canvasLayout: { sections: [1] } },
  });
  const planTitle = buildPushPlan(parseDesiredState(filesTitle), current());
  const upd2 = planTitle.ops.find((o) => o.kind === "updatePage") as Extract<PushOp, { kind: "updatePage" }>;
  assert.equal(upd2.canvasLayout, null);
  assert.equal(upd2.title, "Hello");
});

test("canvasEquals ignores volatile/odata noise", () => {
  assert.ok(
    canvasEquals(
      { sections: [1], "@odata.context": "x", lastModifiedDateTime: "y" },
      { sections: [1] },
    ),
  );
  assert.ok(!canvasEquals({ sections: [1] }, { sections: [2] }));
});

test("missing page → deletion entry; new page → createPage", () => {
  const files = desiredFiles({
    "pages/about.json": { title: "About", name: "about.aspx", canvasLayout: null },
  });
  const plan = buildPushPlan(parseDesiredState(files), current());
  assert.ok(plan.ops.some((o) => o.kind === "createPage"));
  assert.ok(plan.deletions.some((o) => o.kind === "deletePage"));
});

// --- render ----------------------------------------------------------------------

test("renderPushPlan covers ops, deletion opt-in state, warnings, scope note", () => {
  const files = desiredFiles({
    "lists/new.json": { displayName: "New", columns: [{ name: "X", lookup: {} }] },
  });
  const plan = buildPushPlan(parseDesiredState(files), current());
  const offText = renderPushPlan("Marketing", plan, false);
  assert.match(offText, /create list \*\*New\*\*/);
  assert.match(offText, /skipped \(not opted in\)/);
  assert.match(offText, /⚠️/);
  assert.match(offText, /Out of scope/);
  const onText = renderPushPlan("Marketing", plan, true);
  assert.match(onText, /WILL be applied/);
});

test("columnToCreatable keeps facets and safe fields only", () => {
  const out = columnToCreatable({
    name: "C",
    displayName: "Col",
    required: true,
    text: { maxLength: 255 },
    id: "server",
    readOnly: true,
    columnGroup: "x",
  } as never);
  assert.deepEqual(out, {
    name: "C",
    displayName: "Col",
    required: true,
    text: { maxLength: 255 },
  });
});
