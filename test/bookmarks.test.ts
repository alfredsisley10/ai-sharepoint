import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  listForSource,
  resolveBookmark,
  withBookmark,
  withoutBookmark,
  withoutSource,
} from "../src/context/bookmarkOps";
import { ContextBookmark } from "../src/context/types";

function bm(over: Partial<ContextBookmark>): ContextBookmark {
  return { id: "b1", sourceId: "s1", name: "Q", locator: "(anr=x)", kind: "query", ...over };
}

test("withBookmark replaces a same-source same-name entry", () => {
  let all: ContextBookmark[] = [];
  all = withBookmark(all, bm({ id: "b1", name: "Dup", locator: "old" }));
  all = withBookmark(all, bm({ id: "b2", name: "Dup", locator: "new" }));
  assert.equal(all.length, 1);
  assert.equal(all[0].locator, "new");
});

test("withBookmark keeps same name across different sources", () => {
  let all: ContextBookmark[] = [];
  all = withBookmark(all, bm({ id: "b1", sourceId: "s1", name: "Mine" }));
  all = withBookmark(all, bm({ id: "b2", sourceId: "s2", name: "Mine" }));
  assert.equal(all.length, 2);
});

test("listForSource filters and sorts by name", () => {
  const all = [
    bm({ id: "b1", sourceId: "s1", name: "Zed" }),
    bm({ id: "b2", sourceId: "s1", name: "Alpha" }),
    bm({ id: "b3", sourceId: "s2", name: "Other" }),
  ];
  assert.deepEqual(listForSource(all, "s1").map((b) => b.name), ["Alpha", "Zed"]);
});

test("resolveBookmark is case-insensitive and source-scopable", () => {
  const all = [
    bm({ id: "b1", sourceId: "s1", name: "Mine" }),
    bm({ id: "b2", sourceId: "s2", name: "Mine" }),
  ];
  assert.equal(resolveBookmark(all, "mine")?.id, "b1");
  assert.equal(resolveBookmark(all, "MINE", "s2")?.id, "b2");
  assert.equal(resolveBookmark(all, "nope"), undefined);
});

test("withoutBookmark / withoutSource remove the right entries", () => {
  const all = [
    bm({ id: "b1", sourceId: "s1" }),
    bm({ id: "b2", sourceId: "s2" }),
    bm({ id: "b3", sourceId: "s1" }),
  ];
  assert.deepEqual(withoutBookmark(all, "b2").map((b) => b.id), ["b1", "b3"]);
  assert.deepEqual(withoutSource(all, "s1").map((b) => b.id), ["b2"]);
});
