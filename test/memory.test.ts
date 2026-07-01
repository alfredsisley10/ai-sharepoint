import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  MemoryItem,
  memoryKey,
  listForScope,
  withMemory,
  withUpdatedMemory,
  withoutMemory,
  withoutScope,
  normalizeMemoryInput,
  memoryContextBlock,
  mergeText,
  mergeTags,
  mergeMemory,
  sameMemoryContent,
  MEMORY_TITLE_MAX,
  MEMORY_TEXT_MAX,
} from "../src/context/memory";

function mem(over: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: over.id ?? "m1",
    scope: over.scope ?? { kind: "source", key: "src-1" },
    title: over.title ?? "Soft deletes",
    text: over.text ?? "filter deleted_at IS NULL",
    origin: over.origin ?? "user",
    createdAt: "2026-06-29T00:00:00.000Z",
    updatedAt: "2026-06-29T00:00:00.000Z",
    ...over,
  };
}

test("memoryKey folds scope + case/whitespace so shared entries dedupe", () => {
  assert.equal(
    memoryKey({ scope: { kind: "source", key: "s" }, title: "  Soft   Deletes " }),
    memoryKey({ scope: { kind: "source", key: "s" }, title: "soft deletes" }),
  );
  // Different scope ⇒ different key (same title under another source is distinct).
  assert.notEqual(
    memoryKey({ scope: { kind: "source", key: "a" }, title: "x" }),
    memoryKey({ scope: { kind: "source", key: "b" }, title: "x" }),
  );
  // Site vs source with same key are distinct.
  assert.notEqual(
    memoryKey({ scope: { kind: "site", key: "k" }, title: "x" }),
    memoryKey({ scope: { kind: "source", key: "k" }, title: "x" }),
  );
});

test("listForScope filters by entity and sorts by title", () => {
  const items = [
    mem({ id: "b", title: "Zeta", scope: { kind: "source", key: "s" } }),
    mem({ id: "a", title: "Alpha", scope: { kind: "source", key: "s" } }),
    mem({ id: "c", title: "Other", scope: { kind: "site", key: "https://x" } }),
  ];
  const forSource = listForScope(items, { kind: "source", key: "s" });
  assert.deepEqual(forSource.map((m) => m.title), ["Alpha", "Zeta"]);
  assert.equal(listForScope(items, { kind: "site", key: "https://x" }).length, 1);
  assert.equal(listForScope(items, { kind: "source", key: "nope" }).length, 0);
});

test("with/update/without operations are immutable and id-keyed", () => {
  const a = mem({ id: "a" });
  const b = mem({ id: "b", title: "B" });
  let items = withMemory(withMemory([], a), b);
  assert.equal(items.length, 2);
  // add with an existing id replaces (no dup)
  items = withMemory(items, mem({ id: "a", title: "A2" }));
  assert.equal(items.length, 2);
  items = withUpdatedMemory(items, mem({ id: "b", title: "B2" }));
  assert.equal(items.find((m) => m.id === "b")?.title, "B2");
  items = withoutMemory(items, "a");
  assert.deepEqual(items.map((m) => m.id), ["b"]);
});

test("withoutScope drops every memory of a removed entity", () => {
  const items = [
    mem({ id: "1", scope: { kind: "source", key: "s" } }),
    mem({ id: "2", scope: { kind: "source", key: "s" } }),
    mem({ id: "3", scope: { kind: "site", key: "https://x" } }),
  ];
  const out = withoutScope(items, { kind: "source", key: "s" });
  assert.deepEqual(out.map((m) => m.id), ["3"]);
});

test("normalizeMemoryInput trims, clamps, and cleans tags", () => {
  const out = normalizeMemoryInput("  T  ".padEnd(200, "x"), " body ".padEnd(5000, "y"), ["  a ", "", "b"]);
  assert.ok(out.title.length <= MEMORY_TITLE_MAX);
  assert.ok(out.text.length <= MEMORY_TEXT_MAX);
  assert.deepEqual(out.tags, ["a", "b"]);
  assert.ok(!("tags" in normalizeMemoryInput("t", "b", [])), "no empty tags array");
});

test("mergeText is lossless: identical/superset keep the richer; otherwise join", () => {
  assert.equal(mergeText("same", "same"), "same");
  assert.equal(mergeText("a long note with detail", "long note"), "a long note with detail", "existing superset kept");
  assert.equal(mergeText("short", "short plus more detail"), "short plus more detail", "incoming superset kept");
  assert.equal(mergeText("alpha", "beta"), "alpha\n\nbeta", "disjoint joined");
  assert.ok(mergeText("x".repeat(MEMORY_TEXT_MAX), "y".repeat(50)).length <= MEMORY_TEXT_MAX, "clamped");
});

test("mergeTags unions and caps; mergeMemory combines text + tags, keeps id/origin", () => {
  assert.deepEqual(mergeTags(["a", "b"], ["b", "c"]), ["a", "b", "c"]);
  assert.equal(mergeTags([], undefined), undefined, "empty union → undefined");
  const existing = mem({ id: "keep", text: "Platform team.", tags: ["own"], origin: "ai" });
  const merged = mergeMemory(existing, "Also SecOps.", ["sec"], "2026-07-01T00:00:00.000Z");
  assert.equal(merged.id, "keep");
  assert.equal(merged.origin, "ai", "origin preserved");
  assert.deepEqual(merged.tags, ["own", "sec"]);
  assert.match(merged.text, /Platform team\.\n\nAlso SecOps\./);
  assert.equal(merged.updatedAt, "2026-07-01T00:00:00.000Z");
});

test("sameMemoryContent: text + tags equal (order-insensitive) ⇒ true duplicate", () => {
  const a = mem({ text: "note", tags: ["a", "b"] });
  assert.ok(sameMemoryContent(a, "note", ["b", "a"]));
  assert.ok(!sameMemoryContent(a, "note", ["a"]));
  assert.ok(!sameMemoryContent(a, "different", ["a", "b"]));
});

test("memoryContextBlock renders a compact block, or empty when none", () => {
  assert.equal(memoryContextBlock("CMDB", []), "");
  const block = memoryContextBlock("CMDB", [mem({ title: "Soft deletes", text: "filter deleted_at IS NULL" })]);
  assert.match(block, /Saved notes for CMDB/);
  assert.match(block, /- Soft deletes: filter deleted_at IS NULL/);
});
