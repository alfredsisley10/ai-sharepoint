import { test } from "node:test";
import * as assert from "node:assert/strict";
import { looksLikeConfluenceOptimization, extractSpaceKey, confluenceOptimizationSeed, hasConfluenceSignal } from "../src/chat/intent";

test("hasConfluenceSignal detects Confluence-flavored prompts", () => {
  for (const p of [
    "review our Confluence site for stale pages",
    "clean up the DOCS space",
    "our wiki navigation",
  ]) {
    assert.equal(hasConfluenceSignal(p), true, p);
  }
});

test("hasConfluenceSignal ignores plain SharePoint asks", () => {
  assert.equal(hasConfluenceSignal("what's on my site's home page"), false);
});

test("detects Confluence optimization/cleanup intent", () => {
  for (const p of [
    "Help me optimize our Confluence space ENG",
    "Can you clean up the wiki and find stale pages?",
    "audit the documentation site for inaccurate pages",
    "I need to reconcile duplicate Confluence pages and find owners",
    "review the space for out-of-date content",
    "who are the page owners for stale pages in our knowledge base",
  ]) {
    assert.equal(looksLikeConfluenceOptimization(p), true, p);
  }
});

test("does not trip on plain reads or unrelated asks", () => {
  for (const p of [
    "search my wiki for the onboarding guide",
    "what's the capital of France?",
    "show me the latest Jira tickets",
    "optimize my SQL query", // optimize but no confluence subject
    "list pages", // subject but no cleanup action
  ]) {
    assert.equal(looksLikeConfluenceOptimization(p), false, p);
  }
});

test("extractSpaceKey pulls a space key from 'space X' / 'X space', not filler", () => {
  assert.equal(extractSpaceKey("optimize the ENG space"), "ENG");
  assert.equal(extractSpaceKey("clean up space DOCS please"), "DOCS");
  assert.equal(extractSpaceKey("space: HR"), "HR");
  assert.equal(extractSpaceKey('the "Plat" space'), "PLAT");
  // Stopwords / no key → undefined (don't guess).
  assert.equal(extractSpaceKey("clean up the space"), undefined);
  assert.equal(extractSpaceKey("optimize our Confluence pages"), undefined);
});

test("confluenceOptimizationSeed pre-fills wizard fields + carries sources", () => {
  const seed = confluenceOptimizationSeed("optimize the ENG space", ["src1", "src2"]);
  assert.equal(seed.name, "Confluence ENG cleanup");
  assert.equal(seed.spaceKey, "ENG");
  assert.match(seed.goals, /the ENG Confluence space/);
  assert.match(seed.instructions, /space ENG/);
  assert.deepEqual(seed.sourceIds, ["src1", "src2"]);

  // No detectable space → generic but still useful.
  const generic = confluenceOptimizationSeed("clean up our wiki", []);
  assert.equal(generic.name, "Confluence space cleanup");
  assert.equal(generic.spaceKey, undefined);
  assert.deepEqual(generic.sourceIds, []);
});
