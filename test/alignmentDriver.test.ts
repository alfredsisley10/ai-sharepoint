import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  AlignmentRun,
  createAlignmentRun,
  candidateKey,
  contentHash,
  runProgress,
} from "../src/context/alignmentRun";
import { AlignmentEffects, AlignmentPaused, runAlignmentPass } from "../src/context/alignmentDriver";

const T = "2026-07-27T10:00:00.000Z";

function newRun(): AlignmentRun {
  return createAlignmentRun(
    {
      title: "VPN truth",
      authority: { corpus: "sharepoint", siteUrl: "https://c.sharepoint.com/sites/IT", scopeKind: "site", topic: "VPN" },
      targets: [{ corpus: "confluence", sourceId: "src-conf" }],
    },
    "run-1",
    T,
  );
}

interface Counters {
  gather: number;
  sweep: number;
  fetch: number;
  compare: number;
  owner: number;
  draft: number;
  checkpoints: number;
}

/** A complete fake backend. `over` lets a test break exactly one effect. */
function effects(over: Partial<AlignmentEffects> = {}): { fx: AlignmentEffects; n: Counters; saved: AlignmentRun[] } {
  const n: Counters = { gather: 0, sweep: 0, fetch: 0, compare: 0, owner: 0, draft: 0, checkpoints: 0 };
  const saved: AlignmentRun[] = [];
  const fx: AlignmentEffects = {
    now: () => T,
    gatherAuthority: async () => {
      n.gather += 1;
      return [{ id: "a1", title: "VPN policy", url: "u/a1", hash: contentHash("the truth") }];
    },
    sweep: async () => {
      n.sweep += 1;
      return {
        found: [
          { corpus: "confluence", locator: "p1", title: "Old VPN", url: "u/p1" },
          { corpus: "confluence", locator: "p2", title: "Fine VPN", url: "u/p2" },
        ],
      };
    },
    fetchCandidate: async (_r, c) => {
      n.fetch += 1;
      return { contentHash: contentHash(c.locator) };
    },
    compare: async (_r, c) => {
      n.compare += 1;
      // p1 conflicts; p2 is clean.
      return c.locator === "p1"
        ? { conflicts: true, severity: "high", summary: "old VPN host", requestedEdits: ["update the host"] }
        : { conflicts: false, severity: "low", summary: "agrees", requestedEdits: [] };
    },
    resolveOwner: async () => {
      n.owner += 1;
      return { email: "dana@corp.com", basis: "page contributor" };
    },
    draft: async () => {
      n.draft += 1;
      return { draftId: "d1", workItemId: "w1" };
    },
    checkpoint: async (r) => {
      n.checkpoints += 1;
      // Deep-copy so assertions see the state AT that checkpoint, and so a test
      // can reload from one exactly as a restart would.
      saved.push(JSON.parse(JSON.stringify(r)) as AlignmentRun);
    },
    ...over,
  };
  return { fx, n, saved };
}

test("a full pass walks a run to completion and drafts only for the conflict", async () => {
  const { fx, n } = effects();
  const res = await runAlignmentPass(newRun(), fx);
  assert.equal(res.stopped, "done");
  assert.equal(res.run.status, "complete");
  assert.deepEqual(
    [n.gather, n.sweep, n.fetch, n.compare, n.owner, n.draft],
    [1, 1, 2, 2, 1, 1],
    "both pages fetched+compared, but only the conflicting one gets an owner and a draft",
  );
  const p = runProgress(res.run);
  assert.deepEqual([p.total, p.conflicts, p.drafted, p.failed, p.remaining], [2, 1, 1, 0, 0]);
});

test("every step is checkpointed, so an interruption loses at most one step", async () => {
  const { fx, n, saved } = effects();
  const res = await runAlignmentPass(newRun(), fx);
  // gather + sweep + 2 fetch + 2 compare + owner + draft = 8 steps, plus the
  // final "complete" checkpoint.
  assert.equal(res.steps, 8);
  assert.equal(n.checkpoints, 9);
  assert.ok(saved.every((r) => r.id === "run-1"));
});

test("CRASH + RESUME: reloading the last checkpoint redoes no paid-for work", async () => {
  // Stop the pass partway (gather, sweep, fetch p1, fetch p2, compare p1), then
  // reload ONLY the persisted checkpoint — exactly what survives a hard crash.
  const { fx, n, saved } = effects();
  const first = await runAlignmentPass(newRun(), fx, { maxSteps: 5 });
  assert.equal(first.stopped, "max-steps");
  assert.deepEqual([n.gather, n.sweep, n.fetch, n.compare], [1, 1, 2, 1]);

  const reloaded = JSON.parse(JSON.stringify(saved[saved.length - 1])) as AlignmentRun;
  const { fx: fx2, n: n2 } = effects();
  const second = await runAlignmentPass(reloaded, fx2);

  assert.equal(n2.gather, 0, "the authority is NOT re-gathered");
  assert.equal(n2.sweep, 0, "targets are NOT re-swept");
  assert.equal(n2.fetch, 0, "no page body is re-read");
  assert.equal(n2.compare, 1, "only the ONE comparison that never finished is billed");
  assert.equal(second.run.status, "complete");
  assert.equal(runProgress(second.run).remaining, 0);
  assert.equal(runProgress(second.run).drafted, 1);
});

test("a transient failure is retried within the same pass and clears on success", async () => {
  let compares = 0;
  const { fx } = effects({
    compare: async (_r, c) => {
      compares += 1;
      if (compares === 2) throw new Error("network dropped");
      return c.locator === "p1"
        ? { conflicts: true, severity: "high", summary: "old host", requestedEdits: ["fix"] }
        : { conflicts: false, severity: "low", summary: "ok", requestedEdits: [] };
    },
  });
  const res = await runAlignmentPass(newRun(), fx);
  assert.equal(res.run.status, "complete", "one flaky call does not derail the run");
  assert.equal(compares, 3, "the failed comparison was retried once");
  // `attempts` records the blip, but `error` is cleared by the success so it
  // tracks CONSECUTIVE trouble rather than lifetime history.
  const retried = res.run.candidates.find((c) => c.attempts > 0)!;
  assert.equal(retried.error, undefined);
  assert.equal(runProgress(res.run).failed, 0);
});

test("an entitlement failure PAUSES the run — it does not fail or lose work", async () => {
  const { fx, saved } = effects({
    compare: async () => {
      throw new AlignmentPaused("Copilot entitlement unavailable");
    },
  });
  const res = await runAlignmentPass(newRun(), fx);
  assert.equal(res.stopped, "paused");
  assert.equal(res.run.status, "paused");
  assert.match(res.run.pausedReason ?? "", /entitlement/);
  // Both pages were still fetched before the pause — that work is on disk.
  const last = saved[saved.length - 1];
  assert.equal(last.candidates.filter((c) => c.contentHash).length, 2);
  assert.equal(runProgress(res.run).conflicts, 0);

  // Resuming with a working backend finishes without re-fetching.
  const { fx: fx2, n: n2 } = effects();
  const resumed = await runAlignmentPass({ ...res.run, status: "working", pausedReason: undefined }, fx2);
  assert.equal(n2.fetch, 0);
  assert.equal(resumed.run.status, "complete");
});

test("a persistently failing page is parked and reported, never stalling the run", async () => {
  const { fx } = effects({
    fetchCandidate: async (_r, c) => {
      if (c.locator === "p1") throw new Error("404 gone");
      return { contentHash: contentHash(c.locator) };
    },
  });
  const res = await runAlignmentPass(newRun(), fx);
  assert.equal(res.stopped, "done");
  const p = runProgress(res.run);
  assert.equal(p.failed, 1, "the dead page is reported as failed…");
  assert.equal(p.remaining, 0, "…and does not keep the run open forever");
  // The healthy page still completed.
  const ok = res.run.candidates.find((c) => c.key === candidateKey("confluence", "p2"))!;
  assert.equal(ok.stage, "clean");
  // The run is NOT marked complete while a candidate is unfinished-but-parked;
  // progress reports the casualty rather than claiming a clean sweep.
  assert.notEqual(p.finished, p.total);
});

test("a failure while gathering the truth pauses (there is no candidate to blame)", async () => {
  const { fx } = effects({
    gatherAuthority: async () => {
      throw new Error("site unreachable");
    },
  });
  const res = await runAlignmentPass(newRun(), fx);
  assert.equal(res.stopped, "paused");
  assert.match(res.run.pausedReason ?? "", /site unreachable/);
});

test("maxSteps bounds a pass; the next pass continues where it stopped", async () => {
  const { fx, n } = effects();
  const first = await runAlignmentPass(newRun(), fx, { maxSteps: 3 });
  assert.equal(first.stopped, "max-steps");
  assert.equal(first.steps, 3);
  assert.notEqual(first.run.status, "complete");
  const before = n.gather + n.sweep;
  const second = await runAlignmentPass(first.run, fx);
  assert.equal(second.run.status, "complete");
  assert.equal(n.gather + n.sweep, before, "the bounded pass did not redo setup work");
});

test("cancellation stops between steps and leaves a resumable run", async () => {
  const { fx } = effects();
  let calls = 0;
  const res = await runAlignmentPass(newRun(), fx, { isCancelled: () => ++calls > 3 });
  assert.equal(res.stopped, "cancelled");
  assert.notEqual(res.run.status, "complete");
  const { fx: fx2 } = effects();
  assert.equal((await runAlignmentPass(res.run, fx2)).run.status, "complete");
});

test("an interrupted SWEEP resumes mid-pagination instead of re-listing", async () => {
  let sweeps = 0;
  const { fx } = effects({
    sweep: async () => {
      sweeps += 1;
      return sweeps === 1
        ? { found: [{ corpus: "confluence", locator: "p1", title: "A", url: "u1" }], nextCursor: "page-2" }
        : { found: [{ corpus: "confluence", locator: "p2", title: "B", url: "u2" }] };
    },
  });
  const res = await runAlignmentPass(newRun(), fx);
  assert.equal(sweeps, 2, "the cursor drove a second sweep pass");
  assert.equal(res.run.candidates.length, 2);
  assert.ok(res.run.targets.every((t) => t.swept), "the target is only marked swept once pagination is exhausted");
});
