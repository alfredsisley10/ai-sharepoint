import { test } from "node:test";
import * as assert from "node:assert/strict";
import { computeFollowups, FollowupInput } from "../src/chat/followups";

const base: FollowupInput = { sourceTypes: [], hasSites: false };
const labels = (i: FollowupInput) => computeFollowups(i).map((f) => f.label);

test("always ends with a cost/activity option and caps at four", () => {
  const f = computeFollowups({ ...base, sourceTypes: ["confluence", "jira", "mssql"], hasSites: true });
  assert.ok(f.length <= 4);
  assert.equal(f[f.length - 1]!.label, "Check Copilot cost & activity");
  // A plain-language prompt, NOT the /usage slash command — a slash-command
  // follow-up would make the next round of follow-ups inherit /usage.
  assert.doesNotMatch(f[f.length - 1]!.prompt, /^\//);
  assert.match(f[f.length - 1]!.prompt, /cost/i);
});

test("Confluence cleanup in flight surfaces dossier → owners → outreach", () => {
  const l = labels({ ...base, sourceTypes: ["confluence"], lastPrompt: "help me clean up our Confluence space and find stale pages" });
  assert.ok(l.includes("Build space dossier"));
  assert.ok(l.includes("Find page owners"));
  assert.ok(l.includes("Draft owner outreach"));
});

test("Confluence without a cleanup task offers a review, not site planning", () => {
  const l = labels({ ...base, sourceTypes: ["confluence"], lastPrompt: "search my wiki for onboarding" });
  assert.ok(l.includes("Review Confluence"));
  assert.ok(!l.includes("Explore my site"));
  assert.ok(!l.includes("Plan my site"));
});

test("site suggestions only appear when a site is connected", () => {
  assert.ok(!labels({ ...base, sourceTypes: ["jira"] }).includes("Explore my site"));
  const withSite = labels({ ...base, hasSites: true });
  assert.ok(withSite.includes("Explore my site"));
  assert.ok(withSite.includes("Plan my site"));
});

test("a tracked project workspace offers resume; an untracked one nudges goals", () => {
  assert.ok(
    labels({ ...base, project: { name: "P", hasGoals: true, workspaceEnabled: true } }).includes("Resume from workspace"),
  );
  assert.ok(
    labels({ ...base, project: { name: "P", hasGoals: false, workspaceEnabled: false } }).includes("Set project goals"),
  );
  assert.ok(
    labels({ ...base, project: { name: "P", hasGoals: true, workspaceEnabled: false } }).includes("Suggest next steps"),
  );
});

test("nothing connected → onboarding get-started", () => {
  assert.ok(labels(base).includes("Get started"));
});
