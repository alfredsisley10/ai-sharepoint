import { test } from "node:test";
import * as assert from "node:assert/strict";
import { BUILTIN_PROMPTS, newSeedPrompts } from "../src/context/promptSeeds";

test("built-in prompts have stable builtin: ids, titles, and bodies", () => {
  assert.ok(BUILTIN_PROMPTS.length >= 5);
  for (const p of BUILTIN_PROMPTS) {
    assert.match(p.id, /^builtin:/);
    assert.ok(p.title.length > 0 && p.body.length > 0);
    assert.ok(Array.isArray(p.tags) && p.tags.length > 0);
  }
  // The flagship cleanup flow is present.
  assert.ok(BUILTIN_PROMPTS.some((p) => p.id === "builtin:confluence-space-cleanup"));
  // ids are unique.
  assert.equal(new Set(BUILTIN_PROMPTS.map((p) => p.id)).size, BUILTIN_PROMPTS.length);
});

test("newSeedPrompts returns only the not-yet-seeded built-ins (idempotent)", () => {
  // Nothing seeded → all.
  assert.deepEqual(
    newSeedPrompts([]).map((p) => p.id),
    BUILTIN_PROMPTS.map((p) => p.id),
  );
  // All seeded → none (so re-running never duplicates).
  assert.deepEqual(newSeedPrompts(BUILTIN_PROMPTS.map((p) => p.id)), []);
  // A deleted seed is NOT re-offered; a genuinely new one would be.
  const partial = BUILTIN_PROMPTS.slice(1).map((p) => p.id); // pretend the first was deleted-after-seed
  const fresh = newSeedPrompts([...partial, "builtin:confluence-space-cleanup"]);
  assert.deepEqual(fresh, []);
});
