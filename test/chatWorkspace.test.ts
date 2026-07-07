import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  slugify,
  snippet,
  emptyManifest,
  nextSessionId,
  foldTurn,
  renderTurn,
  transcriptHeader,
  renderSummary,
  WorkspaceTurn,
  OUTLINE_CAP,
} from "../src/context/chatWorkspace";

const turn = (prompt: string, reply: string, at = "2026-07-07T10:00:00.000Z", model = "gpt-x"): WorkspaceTurn => ({
  at,
  model,
  prompt,
  reply,
});

test("slugify makes a safe, non-empty folder name", () => {
  assert.equal(slugify("Q3 Cleanup — Confluence!"), "q3-cleanup-confluence");
  assert.equal(slugify("   "), "project");
  assert.equal(slugify("////"), "project");
});

test("snippet collapses whitespace and truncates with an ellipsis", () => {
  assert.equal(snippet("hello\n  world"), "hello world");
  assert.equal(snippet("x".repeat(200)).length, 140);
  assert.ok(snippet("y".repeat(200)).endsWith("…"));
});

test("nextSessionId increments per day", () => {
  const m = emptyManifest("p", "P", "2026-07-07T00:00:00Z");
  assert.equal(nextSessionId("2026-07-07T10:00:00Z", m.sessions), "2026-07-07-1");
  const one = foldTurn(m, turn("a", "b"), true, "2026-07-07T10:00:00Z").manifest;
  assert.equal(nextSessionId("2026-07-07T12:00:00Z", one.sessions), "2026-07-07-2");
  assert.equal(nextSessionId("2026-07-08T09:00:00Z", one.sessions), "2026-07-08-1");
});

test("foldTurn starts a session, appends turns, and titles from the first prompt", () => {
  const m0 = emptyManifest("p", "Cleanup", "2026-07-07T00:00:00Z");
  const r1 = foldTurn(m0, turn("Which pages are stale?", "Here…"), true, "2026-07-07T10:00:00Z");
  assert.equal(r1.manifest.sessions.length, 1);
  assert.equal(r1.session.turns, 1);
  assert.equal(r1.session.title, "Which pages are stale?");
  assert.equal(r1.manifest.totalTurns, 1);

  // Same conversation (newSession=false) appends to the same session.
  const r2 = foldTurn(r1.manifest, turn("Who owns them?", "Owners…"), false, "2026-07-07T10:05:00Z");
  assert.equal(r2.manifest.sessions.length, 1);
  assert.equal(r2.session.turns, 2);
  assert.deepEqual(r2.session.outline, ["Which pages are stale?", "Who owns them?"]);

  // A new conversation the next day starts a second session dated to the turn.
  const r3 = foldTurn(r2.manifest, turn("New topic", "…", "2026-07-08T09:00:00.000Z"), true, "2026-07-08T09:00:00Z");
  assert.equal(r3.manifest.sessions.length, 2);
  assert.equal(r3.session.id, "2026-07-08-1");
});

test("foldTurn caps the per-session outline", () => {
  let m = emptyManifest("p", "P", "2026-07-07T00:00:00Z");
  for (let i = 0; i < OUTLINE_CAP + 25; i++) {
    m = foldTurn(m, turn(`q${i}`, "a"), i === 0, "2026-07-07T10:00:00Z").manifest;
  }
  const outline = m.sessions[0]!.outline;
  assert.equal(outline.length, OUTLINE_CAP);
  assert.equal(outline[outline.length - 1], `q${OUTLINE_CAP + 24}`); // newest kept
  assert.ok(!outline.includes("q0")); // oldest dropped
});

test("foldTurn is pure — the input manifest is not mutated", () => {
  const m0 = emptyManifest("p", "P", "2026-07-07T00:00:00Z");
  foldTurn(m0, turn("a", "b"), true, "2026-07-07T10:00:00Z");
  assert.equal(m0.sessions.length, 0);
  assert.equal(m0.totalTurns, 0);
});

test("renderTurn shows both sides and a divider", () => {
  const md = renderTurn(turn("ask", "answer"), 3);
  assert.match(md, /## Turn 3 —/);
  assert.match(md, /\*\*You:\*\*/);
  assert.match(md, /ask/);
  assert.match(md, /\*\*Assistant:\*\*/);
  assert.match(md, /answer/);
  assert.match(md, /---/);
});

test("transcriptHeader carries the session id and model", () => {
  const { session } = foldTurn(emptyManifest("p", "Proj", "t"), turn("q", "a"), true, "2026-07-07T10:00:00Z");
  const h = transcriptHeader(session, "Proj");
  assert.match(h, /Proj — session 2026-07-07-1/);
  assert.match(h, /model gpt-x/);
});

test("renderSummary includes goals, session index, and the outline", () => {
  let m = emptyManifest("p", "Confluence Cleanup", "2026-07-07T00:00:00Z");
  m = foldTurn(m, turn("Which pages are stale?", "…"), true, "2026-07-07T10:00:00Z").manifest;
  m = foldTurn(m, turn("Who owns them?", "…"), false, "2026-07-07T10:05:00Z").manifest;
  const md = renderSummary(m, { goals: "Clean up the ENG space", description: "Q3 tidy-up" });
  assert.match(md, /# Confluence Cleanup — chat workspace/);
  assert.match(md, /Q3 tidy-up/);
  assert.match(md, /## Goals \(you set\)/);
  assert.match(md, /Clean up the ENG space/);
  assert.match(md, /2 turn\(s\)/);
  assert.match(md, /Which pages are stale\?/);
  assert.match(md, /Who owns them\?/);
  assert.match(md, /\[transcript\]\(sessions\/2026-07-07-1\.md\)/);
});

test("renderSummary handles an empty workspace", () => {
  const md = renderSummary(emptyManifest("p", "P", "2026-07-07T00:00:00Z"), {});
  assert.match(md, /No chats captured yet/);
});
