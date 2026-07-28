import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  AlignmentRun,
  AlignmentAuthority,
  alignmentRunIssue,
  createAlignmentRun,
  candidateKey,
  contentHash,
  snapshotHash,
  withSnapshot,
  mergeDiscovered,
  applyCandidatePatch,
  planNextStep,
  runProgress,
  describeRun,
  groupByOwner,
  isAuthorityTarget,
  verdictIsCurrent,
  pauseRun,
  resumeRun,
  isTerminal,
  staleActionedCandidates,
  MAX_CANDIDATE_ATTEMPTS,
} from "../src/context/alignmentRun";

const T0 = "2026-07-27T10:00:00.000Z";
const T1 = "2026-07-27T11:00:00.000Z";

const CONF_AUTHORITY: AlignmentAuthority = {
  corpus: "confluence",
  sourceId: "src-conf",
  scopeKind: "space",
  spaceKey: "OPS",
  topic: "VPN access",
};

function newRun(): AlignmentRun {
  return createAlignmentRun(
    {
      title: "VPN truth",
      authority: CONF_AUTHORITY,
      targets: [
        { corpus: "confluence", sourceId: "src-conf" }, // the authority's own space
        { corpus: "confluence", sourceId: "src-other" },
        { corpus: "sharepoint", siteUrl: "https://c.sharepoint.com/sites/IT" },
      ],
    },
    "run-1",
    T0,
  );
}

/** Drive a run to the point where its candidates are ready to process. */
function swept(): AlignmentRun {
  let r = newRun();
  r = withSnapshot(r, [{ id: "a1", title: "VPN policy", url: "u/a1", hash: contentHash("truth") }], T0);
  r = { ...r, targets: r.targets.map((t) => ({ ...t, swept: true })) };
  return mergeDiscovered(
    r,
    [
      { corpus: "confluence", locator: "p1", title: "Old VPN notes", url: "u/p1" },
      { corpus: "sharepoint", locator: "https://c.sharepoint.com/sites/IT/vpn.aspx", title: "VPN", url: "u/sp" },
    ],
    T0,
  );
}

test("alignmentRunIssue enforces what each corpus needs", () => {
  assert.match(alignmentRunIssue({}) ?? "", /authoritative source/i);
  assert.match(alignmentRunIssue({ authority: { ...CONF_AUTHORITY, topic: " " } }) ?? "", /topic/i);
  // Confluence needs a source; SharePoint needs a site URL.
  assert.match(
    alignmentRunIssue({ authority: { ...CONF_AUTHORITY, sourceId: undefined }, targets: [{ corpus: "confluence" }] }) ?? "",
    /Confluence source/i,
  );
  assert.match(
    alignmentRunIssue({
      authority: { corpus: "sharepoint", scopeKind: "site", topic: "t" },
      targets: [{ corpus: "confluence" }],
    }) ?? "",
    /site URL/i,
  );
  // A space scope needs its key; a page scope needs its page id.
  assert.match(
    alignmentRunIssue({ authority: { ...CONF_AUTHORITY, spaceKey: undefined }, targets: [{ corpus: "confluence" }] }) ?? "",
    /space key/i,
  );
  assert.match(
    alignmentRunIssue({ authority: { ...CONF_AUTHORITY, scopeKind: "page" }, targets: [{ corpus: "confluence" }] }) ?? "",
    /page id/i,
  );
  // Somewhere to sweep is required.
  assert.match(alignmentRunIssue({ authority: CONF_AUTHORITY, targets: [] }) ?? "", /at least one/i);
  assert.equal(
    alignmentRunIssue({ authority: CONF_AUTHORITY, targets: [{ corpus: "sharepoint", siteUrl: "https://s" }] }),
    undefined,
  );
});

test("contentHash is stable and change-sensitive; snapshotHash ignores page ORDER", () => {
  assert.equal(contentHash("hello"), contentHash("hello"));
  assert.notEqual(contentHash("hello"), contentHash("hello "));
  assert.equal(contentHash(""), contentHash(""));
  // A listing that returns the same pages in a different order must not
  // invalidate every verdict.
  const a = [{ id: "1", hash: "aa" }, { id: "2", hash: "bb" }];
  assert.equal(snapshotHash(a), snapshotHash([...a].reverse()));
  // …but an actual content change must.
  assert.notEqual(snapshotHash(a), snapshotHash([{ id: "1", hash: "aa" }, { id: "2", hash: "cc" }]));
});

test("the authority's own scope is never swept against itself", () => {
  const r = newRun();
  assert.equal(isAuthorityTarget(r.authority, { corpus: "confluence", sourceId: "src-conf" }), true);
  assert.equal(isAuthorityTarget(r.authority, { corpus: "confluence", sourceId: "src-other" }), false);
  assert.equal(isAuthorityTarget(r.authority, { corpus: "sharepoint", siteUrl: "https://x" }), false);
  // A SharePoint authority excludes its own site, case-insensitively.
  const spAuth: AlignmentAuthority = { corpus: "sharepoint", siteUrl: "https://C.sharepoint.com/sites/IT", scopeKind: "site", topic: "t" };
  assert.equal(isAuthorityTarget(spAuth, { corpus: "sharepoint", siteUrl: "https://c.sharepoint.com/sites/it" }), true);
  // A PAGE-scoped Confluence authority still sweeps the rest of its own source.
  const pageAuth: AlignmentAuthority = { ...CONF_AUTHORITY, scopeKind: "page", pageId: "p9", spaceKey: undefined };
  assert.equal(isAuthorityTarget(pageAuth, { corpus: "confluence", sourceId: "src-conf" }), false);
});

test("planNextStep walks the ladder: authority → sweep → fetch → compare → owner → draft → done", () => {
  let r = newRun();
  assert.deepEqual(planNextStep(r), { kind: "gather-authority" });

  r = withSnapshot(r, [{ id: "a1", title: "T", url: "u", hash: contentHash("truth") }], T0);
  // The authority's own target is skipped; the next unswept one is planned.
  const step = planNextStep(r);
  assert.equal(step.kind, "sweep");
  assert.equal(step.kind === "sweep" && step.target.sourceId, "src-other");

  r = swept();
  const fetchStep = planNextStep(r);
  assert.equal(fetchStep.kind, "fetch");

  const k = candidateKey("confluence", "p1");
  r = applyCandidatePatch(r, k, { stage: "fetched", contentHash: contentHash("old vpn") }, T1);
  // The OTHER candidate still needs fetching first — cheap reads before the
  // metered comparison.
  assert.equal(planNextStep(r).kind, "fetch");
  r = applyCandidatePatch(r, candidateKey("sharepoint", "https://c.sharepoint.com/sites/IT/vpn.aspx"), { stage: "clean", contentHash: "x" }, T1);

  const cmp = planNextStep(r);
  assert.equal(cmp.kind, "compare");
  assert.equal(cmp.kind === "compare" && cmp.candidate.key, k);

  r = applyCandidatePatch(
    r,
    k,
    {
      stage: "compared",
      verdictAuthorityHash: r.snapshot!.hash,
      verdict: { conflicts: true, severity: "high", summary: "states the old VPN host", requestedEdits: ["update host"] },
    },
    T1,
  );
  assert.deepEqual(planNextStep(r), { kind: "resolve-owner", candidate: r.candidates.find((c) => c.key === k)! });

  r = applyCandidatePatch(r, k, { stage: "owner-resolved", owner: { email: "a@b.c", basis: "page contributor" } }, T1);
  assert.equal(planNextStep(r).kind, "draft");

  r = applyCandidatePatch(r, k, { stage: "done", draftId: "d1" }, T1);
  assert.deepEqual(planNextStep(r), { kind: "done" });
});

test("a compared candidate with NO conflict needs no owner or draft", () => {
  let r = swept();
  for (const c of r.candidates) {
    r = applyCandidatePatch(
      r,
      c.key,
      {
        stage: "clean",
        contentHash: "h",
        verdictAuthorityHash: r.snapshot!.hash,
        verdict: { conflicts: false, severity: "low", summary: "agrees", requestedEdits: [] },
      },
      T1,
    );
  }
  assert.deepEqual(planNextStep(r), { kind: "done" });
  assert.equal(runProgress(r).conflicts, 0);
  assert.equal(runProgress(r).percent, 100);
});

test("RESUME: a run reloaded mid-flight continues from the ladder, redoing nothing", () => {
  let r = swept();
  const k1 = candidateKey("confluence", "p1");
  const k2 = candidateKey("sharepoint", "https://c.sharepoint.com/sites/IT/vpn.aspx");
  // Candidate 1 got all the way to a draft before the interruption.
  r = applyCandidatePatch(r, k1, { stage: "done", contentHash: "h1", verdictAuthorityHash: r.snapshot!.hash, verdict: { conflicts: true, severity: "low", summary: "s", requestedEdits: [] }, draftId: "d1" }, T1);
  // Candidate 2 was fetched but never compared — the interrupted step.
  r = applyCandidatePatch(r, k2, { stage: "fetched", contentHash: "h2" }, T1);

  // Simulate a full reload: the document is all that survives.
  const reloaded: AlignmentRun = JSON.parse(JSON.stringify(r));
  const next = planNextStep(reloaded);
  assert.equal(next.kind, "compare");
  assert.equal(next.kind === "compare" && next.candidate.key, k2, "resumes at the interrupted candidate, not the finished one");
});

test("verdict cache: unchanged inputs are not re-compared; either side moving re-opens it", () => {
  let r = swept();
  const k = candidateKey("confluence", "p1");
  const k2 = candidateKey("sharepoint", "https://c.sharepoint.com/sites/IT/vpn.aspx");
  const authHash = r.snapshot!.hash;
  const cleanVerdict = { conflicts: false, severity: "low" as const, summary: "ok", requestedEdits: [] };
  r = applyCandidatePatch(r, k, { stage: "clean", contentHash: "h1", verdictAuthorityHash: authHash, verdict: cleanVerdict }, T1);
  r = applyCandidatePatch(r, k2, { stage: "skipped", contentHash: "h2" }, T1);
  const c = r.candidates.find((x) => x.key === k)!;
  assert.equal(verdictIsCurrent(c, authHash), true);
  // The AUTHORITY moved → stale.
  assert.equal(verdictIsCurrent(c, "different-authority-hash"), false);
  // No verdict at all → stale.
  assert.equal(verdictIsCurrent({ ...c, verdict: undefined }, authHash), false);
  // Nothing left to do while the truth is unchanged — the clean verdict is cached.
  assert.deepEqual(planNextStep(r), { kind: "done" });

  // Re-gathering a CHANGED authority re-opens the previously-CLEAN verdict: a
  // page that agreed with the old wording may contradict the new one.
  const moved = withSnapshot(r, [{ id: "a1", title: "T", url: "u", hash: contentHash("NEW truth") }], T1);
  const swept2 = { ...moved, targets: moved.targets.map((t) => ({ ...t, swept: true })) };
  const reopened = swept2.candidates.find((x) => x.key === k)!;
  assert.equal(reopened.stage, "fetched", "demoted to fetched — the body is still good, so nothing is re-read");
  assert.equal(reopened.verdict, undefined, "the stale verdict is cleared");
  assert.equal(reopened.contentHash, "h1", "the cached content is kept");
  const step = planNextStep(swept2);
  assert.equal(step.kind, "compare");
  assert.equal(step.kind === "compare" && step.candidate.key, k);
  // A user/caps `skipped` decision is NOT re-opened by a truth change.
  assert.equal(swept2.candidates.find((x) => x.key === k2)!.stage, "skipped");

  // Re-gathering the SAME truth changes nothing (no needless re-comparison).
  const same = withSnapshot(r, [{ id: "a1", title: "T", url: "u", hash: contentHash("truth") }], T1);
  assert.equal(same.candidates.find((x) => x.key === k)!.stage, "clean");
});

test("an ACTIONED candidate is not silently re-opened, but is reported as stale", () => {
  let r = swept();
  const k = candidateKey("confluence", "p1");
  const authHash = r.snapshot!.hash;
  r = applyCandidatePatch(
    r,
    k,
    { stage: "done", contentHash: "h", verdictAuthorityHash: authHash, verdict: { conflicts: true, severity: "high", summary: "s", requestedEdits: [] }, draftId: "d1" },
    T1,
  );
  assert.deepEqual(staleActionedCandidates(r), [], "current while the truth is unchanged");
  const moved = withSnapshot(r, [{ id: "a1", title: "T", url: "u", hash: contentHash("NEW") }], T1);
  const done = moved.candidates.find((x) => x.key === k)!;
  assert.equal(done.stage, "done", "a drafted notice is not silently re-opened");
  assert.equal(done.draftId, "d1");
  assert.deepEqual(staleActionedCandidates(moved).map((c) => c.key), [k], "…but the user is told it may need revisiting");
});

test("mergeDiscovered dedupes and NEVER discards work already paid for", () => {
  let r = swept();
  const k = candidateKey("confluence", "p1");
  r = applyCandidatePatch(r, k, { stage: "compared", contentHash: "h", verdict: { conflicts: true, severity: "high", summary: "s", requestedEdits: [] } }, T1);
  const before = r.candidates.length;
  // A second sweep pass returns the same page (differently cased) plus a new one.
  const r2 = mergeDiscovered(
    r,
    [
      { corpus: "confluence", locator: "P1", title: "Old VPN notes", url: "u/p1" },
      { corpus: "confluence", locator: "p2", title: "Another", url: "u/p2" },
    ],
    T1,
  );
  assert.equal(r2.candidates.length, before + 1, "only the genuinely new page is added");
  const kept = r2.candidates.find((c) => c.key === k)!;
  assert.equal(kept.stage, "compared", "the existing candidate keeps its stage");
  assert.equal(kept.verdict?.conflicts, true, "…and its verdict");
  // An identical re-sweep is a no-op (same object back — no churn).
  assert.equal(mergeDiscovered(r2, [{ corpus: "confluence", locator: "p2", title: "x", url: "y" }], T1), r2);
});

test("stage transitions are monotonic — a late/duplicate result cannot demote", () => {
  let r = swept();
  const k = candidateKey("confluence", "p1");
  r = applyCandidatePatch(r, k, { stage: "compared", contentHash: "h" }, T1);
  // A straggler "fetched" completion arrives after the comparison finished.
  r = applyCandidatePatch(r, k, { stage: "fetched" }, T1);
  assert.equal(r.candidates.find((c) => c.key === k)!.stage, "compared");
  // Terminal stays terminal.
  r = applyCandidatePatch(r, k, { stage: "done" }, T1);
  r = applyCandidatePatch(r, k, { stage: "compared" }, T1);
  assert.equal(r.candidates.find((c) => c.key === k)!.stage, "done");
  assert.equal(isTerminal("done"), true);
  assert.equal(isTerminal("compared"), false);
});

test("a failing candidate is retried, then parked — it never stalls the run", () => {
  let r = swept();
  const k = candidateKey("confluence", "p1");
  for (let i = 0; i < MAX_CANDIDATE_ATTEMPTS; i++) {
    r = applyCandidatePatch(r, k, { error: "timeout" }, T1);
  }
  const c = r.candidates.find((x) => x.key === k)!;
  assert.equal(c.attempts, MAX_CANDIDATE_ATTEMPTS);
  assert.equal(c.stage, "discovered", "an error never advances the stage");
  // The planner moves on to the OTHER candidate rather than looping forever.
  const step = planNextStep(r);
  assert.equal(step.kind, "fetch");
  assert.notEqual(step.kind === "fetch" && step.candidate.key, k);
  // The run reports the casualty instead of silently claiming success.
  assert.equal(runProgress(r).failed, 1);
  assert.match(describeRun(r), /1 failed/);
  // A later SUCCESS clears the error so `attempts` tracks consecutive trouble.
  r = applyCandidatePatch(r, k, { stage: "fetched", contentHash: "h" }, T1);
  assert.equal(r.candidates.find((x) => x.key === k)!.error, undefined);
});

test("pause/resume keeps every completed step and stops the planner", () => {
  let r = swept();
  r = applyCandidatePatch(r, candidateKey("confluence", "p1"), { stage: "fetched", contentHash: "h" }, T1);
  const paused = pauseRun(r, "Copilot entitlement unavailable", T1);
  assert.equal(paused.status, "paused");
  assert.deepEqual(planNextStep(paused), { kind: "done" }, "a paused run schedules no work");
  assert.match(describeRun(paused), /paused — Copilot entitlement/);
  const back = resumeRun(paused, T1);
  assert.equal(back.status, "working");
  assert.equal(back.pausedReason, undefined);
  assert.equal(back.candidates.find((c) => c.key === candidateKey("confluence", "p1"))!.stage, "fetched", "work survived the pause");
  // The sibling candidate was never fetched, so the planner correctly does the
  // cheap read first — the point is that it resumes rather than restarting.
  assert.equal(planNextStep(back).kind, "fetch");
  // Resuming before the authority was gathered goes back to gathering.
  assert.equal(resumeRun(pauseRun(newRun(), "x", T1), T1).status, "gathering");
});

test("groupByOwner gives each person ONE notice covering all their pages", () => {
  let r = swept();
  const k1 = candidateKey("confluence", "p1");
  const k2 = candidateKey("sharepoint", "https://c.sharepoint.com/sites/IT/vpn.aspx");
  const v = { conflicts: true, severity: "medium" as const, summary: "s", requestedEdits: ["fix"] };
  r = applyCandidatePatch(r, k1, { stage: "owner-resolved", verdict: v, owner: { email: "Dana@corp.com" } }, T1);
  r = applyCandidatePatch(r, k2, { stage: "owner-resolved", verdict: v, owner: { email: "dana@corp.com" } }, T1);
  const groups = groupByOwner(r);
  assert.equal(groups.size, 1, "same person, case-insensitively, gets one group");
  assert.equal(groups.get("dana@corp.com")!.length, 2);
  // A conflict with no resolved owner is grouped under "" for the caller to report.
  const r2 = applyCandidatePatch(r, k2, { owner: {} }, T1);
  assert.equal(groupByOwner(r2).get("")?.length, 1);
  // Non-conflicting pages are never included.
  assert.equal([...groupByOwner(swept()).values()].flat().length, 0);
});

test("runProgress counts terminal, conflicting and failed candidates", () => {
  let r = swept();
  const p0 = runProgress(r);
  assert.deepEqual([p0.total, p0.finished, p0.percent], [2, 0, 0]);
  r = applyCandidatePatch(r, candidateKey("confluence", "p1"), { stage: "clean", contentHash: "h" }, T1);
  const p1 = runProgress(r);
  assert.equal(p1.finished, 1);
  assert.equal(p1.remaining, 1);
  assert.equal(p1.percent, 50);
  // An empty run reports 0% rather than dividing by zero.
  assert.equal(runProgress({ ...r, candidates: [] }).percent, 0);
});
