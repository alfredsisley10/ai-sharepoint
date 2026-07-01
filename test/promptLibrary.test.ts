import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  PromptItem,
  promptKey,
  samePromptScope,
  listPromptsForScope,
  withPrompt,
  withUpdatedPrompt,
  withoutPrompt,
  withoutPromptScope,
  normalizePromptInput,
  promptScopes,
  PROMPT_TITLE_MAX,
  PROMPT_BODY_MAX,
} from "../src/context/promptLibrary";

function prompt(over: Partial<PromptItem> = {}): PromptItem {
  return {
    id: over.id ?? "p1",
    scope: over.scope ?? { kind: "source", key: "src-1" },
    title: over.title ?? "Summarize",
    body: over.body ?? "Summarize this page for execs.",
    createdAt: "2026-06-30T00:00:00.000Z",
    updatedAt: "2026-06-30T00:00:00.000Z",
    ...over,
  };
}

test("samePromptScope: global ignores key; scoped compares key", () => {
  assert.ok(samePromptScope({ kind: "global" }, { kind: "global", key: "ignored" }));
  assert.ok(samePromptScope({ kind: "site", key: "u" }, { kind: "site", key: "u" }));
  assert.ok(!samePromptScope({ kind: "site", key: "u" }, { kind: "site", key: "v" }));
  assert.ok(!samePromptScope({ kind: "site", key: "u" }, { kind: "source", key: "u" }));
});

test("promptKey folds scope + case/whitespace; global is its own bucket", () => {
  assert.equal(
    promptKey({ scope: { kind: "source", key: "s" }, title: "  Summarize  Page " }),
    promptKey({ scope: { kind: "source", key: "s" }, title: "summarize page" }),
  );
  assert.notEqual(
    promptKey({ scope: { kind: "global" }, title: "x" }),
    promptKey({ scope: { kind: "source", key: "s" }, title: "x" }),
  );
});

test("listPromptsForScope filters by scope and sorts by title", () => {
  const items = [
    prompt({ id: "b", title: "Zeta", scope: { kind: "global" } }),
    prompt({ id: "a", title: "Alpha", scope: { kind: "global" } }),
    prompt({ id: "c", title: "Other", scope: { kind: "site", key: "https://x" } }),
  ];
  assert.deepEqual(listPromptsForScope(items, { kind: "global" }).map((p) => p.title), ["Alpha", "Zeta"]);
  assert.equal(listPromptsForScope(items, { kind: "site", key: "https://x" }).length, 1);
  assert.equal(listPromptsForScope(items, { kind: "project", key: "nope" }).length, 0);
});

test("with/update/without are immutable and id-keyed", () => {
  const a = prompt({ id: "a" });
  const b = prompt({ id: "b", title: "B" });
  let items = withPrompt(withPrompt([], a), b);
  assert.equal(items.length, 2);
  items = withPrompt(items, prompt({ id: "a", title: "A2" })); // replace, no dup
  assert.equal(items.length, 2);
  items = withUpdatedPrompt(items, prompt({ id: "b", title: "B2" }));
  assert.equal(items.find((p) => p.id === "b")?.title, "B2");
  items = withoutPrompt(items, "a");
  assert.deepEqual(items.map((p) => p.id), ["b"]);
});

test("withoutPromptScope drops a removed entity's prompts but never touches global", () => {
  const items = [
    prompt({ id: "1", scope: { kind: "source", key: "s" } }),
    prompt({ id: "2", scope: { kind: "global" } }),
  ];
  assert.deepEqual(withoutPromptScope(items, { kind: "source", key: "s" }).map((p) => p.id), ["2"]);
  // Global scope is a no-op (we never bulk-delete global prompts via entity removal).
  assert.equal(withoutPromptScope(items, { kind: "global" }).length, 2);
});

test("normalizePromptInput trims, clamps, and cleans tags", () => {
  const out = normalizePromptInput(" T ".padEnd(200, "x"), " body ".padEnd(9000, "y"), ["  a ", "", "b"]);
  assert.ok(out.title.length <= PROMPT_TITLE_MAX);
  assert.ok(out.body.length <= PROMPT_BODY_MAX);
  assert.deepEqual(out.tags, ["a", "b"]);
  assert.ok(!("tags" in normalizePromptInput("t", "b", [])), "no empty tags array");
});

test("promptScopes returns distinct scopes ordered global → site → source → project", () => {
  const items = [
    prompt({ id: "1", scope: { kind: "project", key: "pr" } }),
    prompt({ id: "2", scope: { kind: "global" } }),
    prompt({ id: "3", scope: { kind: "source", key: "s" } }),
    prompt({ id: "4", scope: { kind: "global" } }), // duplicate scope collapses
    prompt({ id: "5", scope: { kind: "site", key: "u" } }),
  ];
  assert.deepEqual(promptScopes(items).map((s) => s.kind), ["global", "site", "source", "project"]);
});
