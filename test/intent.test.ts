import { test } from "node:test";
import * as assert from "node:assert/strict";
import { looksLikeConfluenceOptimization } from "../src/chat/intent";

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
