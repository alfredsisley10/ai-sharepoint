import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  appendAiNote,
  rememberNote,
  forgetNotes,
  listNotes,
  similarNote,
  AI_CONTEXT_MAX_CHARS,
  normSiteUrl,
  projectMemberCount,
  describeProjectScope,
  scopeMembers,
} from "../src/context/types";

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
  // Distinct notes (unique tokens per i) so dedup doesn't collapse them.
  for (let i = 0; i < 400; i++) ctx = appendAiNote(ctx, `learning alpha${i} about topic${i} and detail${i}`);
  assert.ok(ctx.length <= AI_CONTEXT_MAX_CHARS);
  assert.ok(ctx.includes("alpha399")); // newest kept
  assert.ok(!ctx.includes("alpha0 ")); // oldest evicted
});

// --- #2 extended memory: dedup / reinforce / forget ------------------------

test("rememberNote dedups near-duplicates and reinforces (no stacking)", () => {
  let ctx = rememberNote(undefined, "The user prefers concise answers").text;
  ctx = rememberNote(ctx, "Cite the CMDB for app ownership").text;
  const again = rememberNote(ctx, "prefers concise answers"); // near-dup (shorter)
  assert.equal(again.status, "reinforced");
  // only two distinct learnings remain, and the reinforced one moved to the end
  assert.deepEqual(listNotes(again.text), [
    "Cite the CMDB for app ownership",
    "The user prefers concise answers",
  ]);
  // a genuinely new note is "added"
  assert.equal(rememberNote(again.text, "Always answer in German").status, "added");
});

test("rememberNote keeps the more informative phrasing on merge", () => {
  let ctx = rememberNote(undefined, "use the CMDB").text;
  ctx = rememberNote(ctx, "use the CMDB for application ownership lookups").text;
  assert.deepEqual(listNotes(ctx), ["use the CMDB for application ownership lookups"]);
});

test("forgetNotes removes matching learnings, leaves the rest", () => {
  let ctx = rememberNote(undefined, "Always answer in German").text;
  ctx = rememberNote(ctx, "Cite the CMDB for app ownership").text;
  const r = forgetNotes(ctx, "answer in German");
  assert.deepEqual(r.removed, ["Always answer in German"]);
  assert.deepEqual(listNotes(r.text), ["Cite the CMDB for app ownership"]);
  // a non-matching query removes nothing
  assert.deepEqual(forgetNotes(ctx, "something unrelated entirely").removed, []);
});

test("similarNote: exact/containment/overlap match; distinct notes don't", () => {
  assert.ok(similarNote("answer in German", "Answer in German!"));
  assert.ok(similarNote("use the CMDB", "use the CMDB for ownership"));
  assert.ok(!similarNote("answer in German", "cite the CMDB for ownership"));
});

// --- project scope: sources + SharePoint sites + attached files -------------
// Regression: the project wizard only ever offered ContextSources, so a
// SharePoint site could not be scoped to a project at all (SiteConnection has
// no id — `siteUrl` is its key), and Project had no field to hold one.

test("normSiteUrl makes site identity trailing-slash and case insensitive", () => {
  assert.equal(normSiteUrl("https://c.sharepoint.com/sites/Ops/"), "https://c.sharepoint.com/sites/ops");
  assert.equal(normSiteUrl("  HTTPS://C.SharePoint.com/sites/Ops//  "), "https://c.sharepoint.com/sites/ops");
  // the two forms a user/export could realistically produce must agree
  assert.equal(normSiteUrl("https://c.sharepoint.com/sites/Ops"), normSiteUrl("https://c.sharepoint.com/sites/Ops/"));
});

test("projectMemberCount and describeProjectScope span all three member kinds", () => {
  assert.equal(projectMemberCount({ sourceIds: ["a", "b"], siteUrls: ["u"], fileSourceIds: ["f"] }), 4);
  assert.equal(describeProjectScope({ sourceIds: ["a", "b"], siteUrls: ["u"] }), "2 sources, 1 site");
  assert.equal(describeProjectScope({ sourceIds: ["a"], fileSourceIds: ["f", "g"] }), "1 source, 2 files");
  // A project with nothing selected scopes EVERYTHING — "0 sources" would be a lie.
  assert.equal(describeProjectScope({ sourceIds: [] }), "everything (unscoped)");
  assert.equal(projectMemberCount({ sourceIds: [] }), 0);
  // Absent optional fields are not counted as members.
  assert.equal(describeProjectScope({ sourceIds: ["a"] }), "1 source");
});

test("scopeMembers: absent membership is UNSCOPED, empty array excludes everything", () => {
  const sites = [{ siteUrl: "a" }, { siteUrl: "b" }];
  const key = (s: { siteUrl: string }) => s.siteUrl;
  // Absent (a project saved before sites could be scoped) ⇒ everything stays
  // visible. This is the back-compat case that must never silently empty a view.
  assert.deepEqual(scopeMembers(sites, undefined, key), sites);
  // Explicitly empty ⇒ the user deselected them all.
  assert.deepEqual(scopeMembers(sites, [], key), []);
  assert.deepEqual(scopeMembers(sites, ["b"], key), [{ siteUrl: "b" }]);
  // A member that no longer exists locally simply matches nothing.
  assert.deepEqual(scopeMembers(sites, ["ghost"], key), []);
});
