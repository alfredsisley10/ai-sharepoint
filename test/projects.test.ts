import { test } from "node:test";
import * as assert from "node:assert/strict";
import { appendAiNote, AI_CONTEXT_MAX_CHARS } from "../src/context/types";

test("appendAiNote builds a bulleted log, dedupes whitespace, caps each note", () => {
  let ctx = appendAiNote(undefined, "Prefer the CMDB for app ownership");
  ctx = appendAiNote(ctx, "Answer\n  in   German");
  assert.equal(ctx, "- Prefer the CMDB for app ownership\n- Answer in German");
  // empty/whitespace notes are ignored
  assert.equal(appendAiNote(ctx, "   "), ctx);
  // each note is length-bounded
  const long = appendAiNote(undefined, "x".repeat(1000));
  assert.ok(long.length <= 402);
});

test("appendAiNote trims oldest entries when over the cap", () => {
  let ctx = "";
  for (let i = 0; i < 200; i++) ctx = appendAiNote(ctx, `note number ${i} with some length to it`);
  assert.ok(ctx.length <= AI_CONTEXT_MAX_CHARS);
  assert.ok(ctx.includes("note number 199")); // newest kept
  assert.ok(!ctx.includes("note number 0\n")); // oldest dropped
});
