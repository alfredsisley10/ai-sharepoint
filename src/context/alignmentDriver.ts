/**
 * The alignment-run driver (ADR-0049): turn `planNextStep` into forward
 * progress, checkpointing after every transition.
 *
 * Effects are INJECTED, so the whole interrupt/resume story is unit-testable
 * without vscode, Copilot, or a network. The command layer supplies real
 * implementations (Confluence/SharePoint reads, the metered comparison, owner
 * resolution, the comms outbox); this module owns only the control flow —
 * ordering, checkpointing, failure isolation, and stopping conditions.
 */

import {
  AlignmentRun,
  AlignmentCandidate,
  AlignmentTarget,
  AuthoritySnapshotPage,
  CandidateOwner,
  ConflictVerdict,
  DiscoveredCandidate,
  applyCandidatePatch,
  mergeDiscovered,
  planNextStep,
  runProgress,
  withSnapshot,
  pauseRun,
} from "./alignmentRun";

/** Thrown by an effect to pause (not fail) the run — the Copilot entitlement
 *  breaker's signal, where the right user action is "resume later". */
export class AlignmentPaused extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "AlignmentPaused";
  }
}

export interface AlignmentEffects {
  /** Read the authoritative content (Confluence space/page/subtree, or a
   *  SharePoint site) as bounded plain text with a hash per page. */
  gatherAuthority(run: AlignmentRun): Promise<AuthoritySnapshotPage[]>;
  /** Enumerate candidate pages in one target. `cursor` continues a sweep that
   *  was interrupted mid-pagination; returning `nextCursor` asks for another
   *  pass at the same target. */
  sweep(
    run: AlignmentRun,
    target: AlignmentTarget,
  ): Promise<{ found: DiscoveredCandidate[]; nextCursor?: string }>;
  /** Fetch (and cache) a candidate's body; return its content hash. */
  fetchCandidate(run: AlignmentRun, candidate: AlignmentCandidate): Promise<{ contentHash: string; title?: string; url?: string }>;
  /** The metered step: compare the candidate against the authority snapshot. */
  compare(run: AlignmentRun, candidate: AlignmentCandidate): Promise<ConflictVerdict>;
  /** Determine the effective owner from page + site/space contributions. */
  resolveOwner(run: AlignmentRun, candidate: AlignmentCandidate): Promise<CandidateOwner>;
  /** Prepare (never send) the owner notice; returns ids to link back. */
  draft(run: AlignmentRun, candidate: AlignmentCandidate): Promise<{ draftId?: string; workItemId?: string }>;
  /** Persist the run — the checkpoint. Called after every transition. */
  checkpoint(run: AlignmentRun): Promise<void>;
  /** Optional progress callback for a progress bar / status line. */
  onProgress?(run: AlignmentRun): void;
  /** Wall-clock now, injected so tests are deterministic. */
  now(): string;
}

export interface AlignmentPassOptions {
  /** Stop after this many steps so one pass can't run unbounded (the user can
   *  always resume). Defaults to 50. */
  maxSteps?: number;
  /** Cooperative cancellation — checked between steps. */
  isCancelled?: () => boolean;
}

export interface AlignmentPassResult {
  run: AlignmentRun;
  steps: number;
  /** Why the pass stopped. `done` means there is no work left. */
  stopped: "done" | "max-steps" | "cancelled" | "paused";
}

/**
 * Advance a run until it is finished, budget-limited, cancelled, or paused.
 *
 * Failure isolation: a step that throws records the error on its candidate and
 * the loop continues, so one unreachable page cannot stall a 300-page sweep.
 * After MAX_CANDIDATE_ATTEMPTS the planner stops offering that candidate, and
 * `runProgress().failed` reports it — a run never silently claims success while
 * having dropped pages.
 *
 * Every branch checkpoints BEFORE looping, so an interruption at any point
 * leaves the run resumable with everything already paid for intact.
 */
export async function runAlignmentPass(
  input: AlignmentRun,
  fx: AlignmentEffects,
  opts: AlignmentPassOptions = {},
): Promise<AlignmentPassResult> {
  const maxSteps = opts.maxSteps ?? 50;
  let run = input;
  let steps = 0;

  while (steps < maxSteps) {
    if (opts.isCancelled?.()) return { run, steps, stopped: "cancelled" };
    const step = planNextStep(run);
    if (step.kind === "done") {
      // Only mark complete when there is genuinely nothing left; a paused run
      // also plans "done" but must keep its status.
      if (run.status !== "paused" && runProgress(run).remaining === 0) {
        run = { ...run, status: "complete", updatedAt: fx.now() };
        await fx.checkpoint(run);
      }
      return { run, steps, stopped: run.status === "paused" ? "paused" : "done" };
    }

    steps += 1;
    try {
      run = await applyStep(run, step, fx);
    } catch (e) {
      if (e instanceof AlignmentPaused) {
        run = pauseRun(run, e.message, fx.now());
        await fx.checkpoint(run);
        return { run, steps, stopped: "paused" };
      }
      run = recordStepFailure(run, step, e, fx);
    }
    await fx.checkpoint(run);
    fx.onProgress?.(run);
  }
  return { run, steps, stopped: "max-steps" };
}

/** Perform one planned step and fold its result into the run. */
async function applyStep(
  run: AlignmentRun,
  step: ReturnType<typeof planNextStep>,
  fx: AlignmentEffects,
): Promise<AlignmentRun> {
  switch (step.kind) {
    case "gather-authority": {
      const pages = await fx.gatherAuthority(run);
      return withSnapshot(run, pages, fx.now());
    }
    case "sweep": {
      const { found, nextCursor } = await fx.sweep(run, step.target);
      const merged = mergeDiscovered(run, found, fx.now());
      // A target is only `swept` once its pagination is exhausted, so an
      // interrupted sweep resumes mid-listing instead of re-enumerating.
      return {
        ...merged,
        targets: merged.targets.map((t) =>
          sameTarget(t, step.target)
            ? { ...t, ...(nextCursor ? { cursor: nextCursor } : { swept: true, cursor: undefined }) }
            : t,
        ),
        status: "working",
        updatedAt: fx.now(),
      };
    }
    case "fetch": {
      const r = await fx.fetchCandidate(run, step.candidate);
      return applyCandidatePatch(
        run,
        step.candidate.key,
        { stage: "fetched", contentHash: r.contentHash, ...(r.title ? { title: r.title } : {}), ...(r.url ? { url: r.url } : {}) },
        fx.now(),
      );
    }
    case "compare": {
      const verdict = await fx.compare(run, step.candidate);
      return applyCandidatePatch(
        run,
        step.candidate.key,
        {
          // No conflict is terminal — nothing to own, nothing to draft.
          stage: verdict.conflicts ? "compared" : "clean",
          verdict,
          verdictAuthorityHash: run.snapshot?.hash,
        },
        fx.now(),
      );
    }
    case "resolve-owner": {
      const owner = await fx.resolveOwner(run, step.candidate);
      return applyCandidatePatch(run, step.candidate.key, { stage: "owner-resolved", owner }, fx.now());
    }
    case "draft": {
      const r = await fx.draft(run, step.candidate);
      return applyCandidatePatch(
        run,
        step.candidate.key,
        { stage: "done", ...(r.draftId ? { draftId: r.draftId } : {}), ...(r.workItemId ? { workItemId: r.workItemId } : {}) },
        fx.now(),
      );
    }
    default:
      return run;
  }
}

/**
 * Record a step failure. Candidate-scoped steps mark their candidate (retried on
 * a later pass, parked after MAX_CANDIDATE_ATTEMPTS). A failure in the run-wide
 * steps — gathering the truth, or sweeping — has no candidate to blame and would
 * otherwise spin forever, so it pauses the run with the reason instead.
 */
function recordStepFailure(
  run: AlignmentRun,
  step: ReturnType<typeof planNextStep>,
  e: unknown,
  fx: AlignmentEffects,
): AlignmentRun {
  const message = e instanceof Error ? e.message : String(e);
  if (step.kind === "gather-authority" || step.kind === "sweep" || step.kind === "done") {
    return pauseRun(run, message, fx.now());
  }
  return applyCandidatePatch(run, step.candidate.key, { error: message }, fx.now());
}

function sameTarget(a: AlignmentTarget, b: AlignmentTarget): boolean {
  return a.corpus === b.corpus && a.sourceId === b.sourceId && a.siteUrl === b.siteUrl;
}
