/**
 * "Align with Authoritative Source" — the durable, restartable run model
 * (ADR-0049). PURE: no vscode, no I/O, no clock, no randomness. The store
 * (alignmentRunStore.ts) persists these documents and the command layer performs
 * the effects; everything that decides *what happens next* lives here so it is
 * unit-tested.
 *
 * The central idea is that resume is not a special code path. Each candidate
 * advances through a monotonic stage ladder, the document is checkpointed after
 * every transition, and `planNextStep` is a pure function of the persisted
 * document — so "continue an interrupted run" and "start a fresh one" are the
 * same loop.
 */

/** Which corpus a piece of content lives in. Both can be the authority, and
 *  both can be swept — the asymmetry that made "this SharePoint site is the
 *  source of truth" unexpressible is deliberately gone (ADR-0049 §context). */
export type CorpusKind = "confluence" | "sharepoint";

/** Where the truth lives. `sourceId` for Confluence, `siteUrl` for SharePoint. */
export interface AlignmentAuthority {
  corpus: CorpusKind;
  sourceId?: string;
  siteUrl?: string;
  /** Confluence: space | page | subtree. SharePoint: site (the whole site). */
  scopeKind: "space" | "page" | "subtree" | "site";
  spaceKey?: string;
  pageId?: string;
  /** What this content is authoritative ON — drives the conflict search. */
  topic: string;
}

/** A corpus to sweep for content that contradicts the authority. */
export interface AlignmentTarget {
  corpus: CorpusKind;
  sourceId?: string;
  siteUrl?: string;
  /** Opaque pagination cursor so an interrupted sweep resumes mid-listing
   *  instead of re-listing from the start. */
  cursor?: string;
  /** Set once the sweep for this target has enumerated everything. */
  swept?: boolean;
}

/**
 * A candidate's position on the ladder. Monotonic: a candidate never moves
 * backwards, so the stage IS the saved progress.
 *
 *   discovered → fetched → compared → owner-resolved → drafted → done
 *                       ↘ clean                    (terminal — no conflict)
 *                       ↘ skipped                  (terminal — user//caps)
 */
export type CandidateStage =
  | "discovered"
  | "fetched"
  | "compared"
  | "owner-resolved"
  | "drafted"
  | "done"
  | "clean"
  | "skipped";

/** Stages that need no further work. */
const TERMINAL: ReadonlySet<CandidateStage> = new Set<CandidateStage>(["done", "clean", "skipped"]);

export function isTerminal(stage: CandidateStage): boolean {
  return TERMINAL.has(stage);
}

/** Ladder order, used to keep transitions monotonic. Terminal stages sort last
 *  so a re-run can never demote a finished candidate. */
const STAGE_ORDER: Record<CandidateStage, number> = {
  discovered: 0,
  fetched: 1,
  compared: 2,
  "owner-resolved": 3,
  drafted: 4,
  done: 5,
  clean: 5,
  skipped: 5,
};

export interface ConflictVerdict {
  conflicts: boolean;
  /** Rough triage so the worst offenders can be actioned first. */
  severity: "high" | "medium" | "low";
  /** One-line statement of what contradicts the authority. */
  summary: string;
  /** Concrete corrections to request from the owner. */
  requestedEdits: string[];
}

export interface CandidateOwner {
  name?: string;
  email?: string;
  /** How the owner was determined — "page contributor", "space admin",
   *  "site contributions" — surfaced so a human can sanity-check a guess. */
  basis?: string;
}

export interface AlignmentCandidate {
  /** Stable identity: `${corpus}:${locator}`. Dedupes across sweep passes. */
  key: string;
  corpus: CorpusKind;
  /** Confluence pageId, or the SharePoint item/page URL. */
  locator: string;
  title: string;
  url: string;
  stage: CandidateStage;
  /** Hash of the candidate body last fetched — half of the verdict cache key. */
  contentHash?: string;
  /** Authority hash the verdict was computed against — the other half. */
  verdictAuthorityHash?: string;
  verdict?: ConflictVerdict;
  owner?: CandidateOwner;
  /** Links into the existing event-sourced inventory / outbox (ADR-0045/0025). */
  workItemId?: string;
  draftId?: string;
  /** Last failure, kept so a bad page is retried rather than stalling the run. */
  error?: string;
  attempts: number;
}

export interface AuthoritySnapshotPage {
  id: string;
  title: string;
  url: string;
  hash: string;
}

export interface AuthoritySnapshot {
  pages: AuthoritySnapshotPage[];
  gatheredAt: string;
  /** Hash over the whole snapshot — changing it correctly re-opens every
   *  verdict, because the truth itself moved. */
  hash: string;
}

export type RunStatus = "gathering" | "sweeping" | "working" | "paused" | "complete";

export interface AlignmentRun {
  id: string;
  /** The project this run belongs to, when started from one. */
  projectId?: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  status: RunStatus;
  authority: AlignmentAuthority;
  targets: AlignmentTarget[];
  snapshot?: AuthoritySnapshot;
  candidates: AlignmentCandidate[];
  /** Why a run is paused (e.g. the Copilot entitlement breaker) — the correct
   *  user action is "resume later", so this is not a failure state. */
  pausedReason?: string;
}

/** Stable candidate identity across sweep passes. */
export function candidateKey(corpus: CorpusKind, locator: string): string {
  return `${corpus}:${locator.trim().toLowerCase()}`;
}

/**
 * A cheap, stable content hash (FNV-1a, 32-bit, hex). Not cryptographic — its
 * only job is change detection for cache keys, where a collision costs one
 * unnecessary skip, never a correctness bug. Pure JS keeps the native-free
 * dependency gate (ADR-0016) satisfied.
 */
export function contentHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** Hash a gathered authority snapshot from its pages (order-independent, so a
 *  listing that returns pages in a different order doesn't invalidate work). */
export function snapshotHash(pages: readonly { id: string; hash: string }[]): string {
  return contentHash(
    [...pages]
      .map((p) => `${p.id}:${p.hash}`)
      .sort()
      .join("|"),
  );
}

export interface NewAlignmentRun {
  title: string;
  authority: AlignmentAuthority;
  targets: AlignmentTarget[];
  projectId?: string;
}

/** Validation shared by the wizard and any programmatic caller. */
export function alignmentRunIssue(input: Partial<NewAlignmentRun>): string | undefined {
  const a = input.authority;
  if (!a) return "An authoritative source is required.";
  if (!a.topic?.trim()) return "A topic is required — what this content is the authority on.";
  if (a.corpus === "confluence" && !a.sourceId) return "A Confluence source is required for a Confluence authority.";
  if (a.corpus === "sharepoint" && !a.siteUrl) return "A site URL is required for a SharePoint authority.";
  if (a.corpus === "confluence" && a.scopeKind === "space" && !a.spaceKey) return "A space key is required for a space scope.";
  if (a.corpus === "confluence" && (a.scopeKind === "page" || a.scopeKind === "subtree") && !a.pageId) {
    return "A page id is required for a page/subtree scope.";
  }
  if (!input.targets?.length) return "Select at least one place to search for conflicting content.";
  return undefined;
}

export function createAlignmentRun(input: NewAlignmentRun, id: string, nowIso: string): AlignmentRun {
  return {
    id,
    ...(input.projectId ? { projectId: input.projectId } : {}),
    title: input.title.trim(),
    createdAt: nowIso,
    updatedAt: nowIso,
    status: "gathering",
    authority: { ...input.authority, topic: input.authority.topic.trim() },
    targets: input.targets.map((t) => ({ ...t })),
    candidates: [],
  };
}

/** Is a target the authority's own scope? Those must never be swept against
 *  themselves — every authoritative page would "conflict" with itself. */
export function isAuthorityTarget(a: AlignmentAuthority, t: AlignmentTarget): boolean {
  if (a.corpus !== t.corpus) return false;
  if (a.corpus === "sharepoint") {
    return Boolean(a.siteUrl && t.siteUrl && a.siteUrl.toLowerCase() === t.siteUrl.toLowerCase());
  }
  // A Confluence authority excludes only its own SOURCE when the whole space is
  // the authority; a page/subtree authority still sweeps the rest of that source.
  return Boolean(a.sourceId && t.sourceId && a.sourceId === t.sourceId && a.scopeKind === "space");
}

/**
 * Record the gathered truth.
 *
 * When the snapshot hash CHANGES, every verdict computed against the old truth
 * is stale — a page that agreed with the previous wording may contradict the new
 * one. Those candidates are re-opened here: demoted to `fetched` (their body is
 * still good, so nothing is re-read) with the stale verdict cleared, which is
 * the one place the ladder deliberately moves backwards. It is an explicit
 * "the truth moved" event, not a step completion, so it does not go through
 * `applyCandidatePatch`'s monotonic guard.
 *
 * Two stages are deliberately NOT re-opened:
 *   - `done` — a draft already exists for it; silently re-opening work the user
 *     has acted on would be surprising. `staleActionedCandidates` reports them
 *     so the caller can tell the user which notices may need revisiting.
 *   - `skipped` — a user/caps decision, not a verdict.
 */
export function withSnapshot(
  run: AlignmentRun,
  pages: readonly AuthoritySnapshotPage[],
  nowIso: string,
): AlignmentRun {
  const hash = snapshotHash(pages);
  const changed = run.snapshot !== undefined && run.snapshot.hash !== hash;
  const candidates = changed
    ? run.candidates.map((c) => {
        if (c.stage === "done" || c.stage === "skipped") return c;
        if (!c.verdict || c.verdictAuthorityHash === hash) return c;
        const reopened: AlignmentCandidate = { ...c, stage: c.contentHash ? "fetched" : "discovered" };
        delete reopened.verdict;
        delete reopened.verdictAuthorityHash;
        return reopened;
      })
    : run.candidates;
  return {
    ...run,
    snapshot: { pages: [...pages], gatheredAt: nowIso, hash },
    candidates,
    status: "sweeping",
    updatedAt: nowIso,
  };
}

/** Candidates already actioned (a draft exists) whose verdict predates the
 *  current authority snapshot — the notices a user may want to revisit after
 *  the truth changed. Reported rather than silently re-opened. */
export function staleActionedCandidates(run: AlignmentRun): AlignmentCandidate[] {
  const hash = run.snapshot?.hash;
  if (!hash) return [];
  return run.candidates.filter(
    (c) => c.stage === "done" && c.verdict !== undefined && c.verdictAuthorityHash !== hash,
  );
}

export interface DiscoveredCandidate {
  corpus: CorpusKind;
  locator: string;
  title: string;
  url: string;
}

/**
 * Merge a sweep's results into the queue. Existing candidates keep their stage
 * and verdict — re-running a sweep must never discard work already paid for —
 * while genuinely new pages enter at `discovered`. Deduped by `candidateKey`,
 * including within the incoming batch.
 */
export function mergeDiscovered(
  run: AlignmentRun,
  found: readonly DiscoveredCandidate[],
  nowIso: string,
): AlignmentRun {
  const byKey = new Map(run.candidates.map((c) => [c.key, c]));
  let added = 0;
  for (const f of found) {
    const key = candidateKey(f.corpus, f.locator);
    if (byKey.has(key)) continue;
    byKey.set(key, {
      key,
      corpus: f.corpus,
      locator: f.locator,
      title: f.title,
      url: f.url,
      stage: "discovered",
      attempts: 0,
    });
    added += 1;
  }
  if (!added) return run;
  return { ...run, candidates: [...byKey.values()], updatedAt: nowIso };
}

/** Fields a step may write back onto a candidate. */
export type CandidatePatch = Partial<
  Pick<
    AlignmentCandidate,
    "stage" | "contentHash" | "verdictAuthorityHash" | "verdict" | "owner" | "workItemId" | "draftId" | "error" | "title" | "url"
  >
>;

/**
 * Apply one step's result to a candidate — the checkpoint the run is saved at.
 * Stage moves are **monotonic**: a patch can never demote a candidate (so a
 * duplicate or out-of-order completion is harmless). A patch carrying `error`
 * increments `attempts` and leaves the stage alone, so the page is retried on a
 * later pass instead of stalling the run.
 */
export function applyCandidatePatch(
  run: AlignmentRun,
  key: string,
  patch: CandidatePatch,
  nowIso: string,
): AlignmentRun {
  let touched = false;
  const candidates = run.candidates.map((c) => {
    if (c.key !== key) return c;
    touched = true;
    if (patch.error) {
      return { ...c, ...patch, stage: c.stage, attempts: c.attempts + 1 };
    }
    const nextStage =
      patch.stage && STAGE_ORDER[patch.stage] > STAGE_ORDER[c.stage] ? patch.stage : c.stage;
    const merged: AlignmentCandidate = { ...c, ...patch, stage: nextStage };
    // A successful step clears the previous failure so `attempts` reflects
    // consecutive trouble, not lifetime history.
    delete merged.error;
    return merged;
  });
  if (!touched) return run;
  return { ...run, candidates, updatedAt: nowIso };
}

/** Max consecutive failures before a candidate is parked as `skipped`. */
export const MAX_CANDIDATE_ATTEMPTS = 3;

/**
 * Whether a candidate's verdict is still valid: it must have been computed
 * against BOTH the current authority snapshot and the current page content.
 * This is the cache key that stops an unchanged pair from being re-billed while
 * still re-opening the question when either side genuinely moves (ADR-0049 §3).
 */
export function verdictIsCurrent(c: AlignmentCandidate, authorityHash: string | undefined): boolean {
  if (!c.verdict || !authorityHash) return false;
  return c.verdictAuthorityHash === authorityHash && Boolean(c.contentHash);
}

export type NextStep =
  | { kind: "gather-authority" }
  | { kind: "sweep"; target: AlignmentTarget }
  | { kind: "fetch"; candidate: AlignmentCandidate }
  | { kind: "compare"; candidate: AlignmentCandidate }
  | { kind: "resolve-owner"; candidate: AlignmentCandidate }
  | { kind: "draft"; candidate: AlignmentCandidate }
  | { kind: "done" };

/**
 * The planner. A pure function of the persisted document — which is exactly
 * what makes resume free: after an interruption the same call returns the next
 * unfinished unit of work, with everything already completed skipped.
 *
 * Order is deliberate: establish the truth, enumerate candidates, then advance
 * the queue. Within the queue, the cheap read (`fetch`) runs before the metered
 * comparison, and conflicts are carried all the way to a draft before the next
 * page starts, so an interrupted run leaves finished work actionable rather than
 * a pile of half-processed pages.
 */
export function planNextStep(run: AlignmentRun): NextStep {
  if (run.status === "paused") return { kind: "done" };
  if (!run.snapshot) return { kind: "gather-authority" };

  const pending = run.targets.find((t) => !t.swept && !isAuthorityTarget(run.authority, t));
  if (pending) return { kind: "sweep", target: pending };

  const live = run.candidates.filter(
    (c) => !isTerminal(c.stage) && c.attempts < MAX_CANDIDATE_ATTEMPTS,
  );
  // Content first: a candidate with no (or stale) body can't be compared.
  const needsFetch = live.find((c) => c.stage === "discovered" || !c.contentHash);
  if (needsFetch) return { kind: "fetch", candidate: needsFetch };

  const needsCompare = live.find(
    (c) => c.stage === "fetched" || !verdictIsCurrent(c, run.snapshot?.hash),
  );
  if (needsCompare) return { kind: "compare", candidate: needsCompare };

  const needsOwner = live.find((c) => c.stage === "compared" && c.verdict?.conflicts);
  if (needsOwner) return { kind: "resolve-owner", candidate: needsOwner };

  const needsDraft = live.find((c) => c.stage === "owner-resolved");
  if (needsDraft) return { kind: "draft", candidate: needsDraft };

  return { kind: "done" };
}

export interface RunProgress {
  total: number;
  /** Reached a terminal stage. */
  finished: number;
  compared: number;
  conflicts: number;
  drafted: number;
  /** Parked after repeated failures — surfaced so a run never claims success
   *  while silently having dropped pages. */
  failed: number;
  remaining: number;
  /** 0–100, for a progress bar. 100 only when nothing is left. */
  percent: number;
}

export function runProgress(run: AlignmentRun): RunProgress {
  const total = run.candidates.length;
  let finished = 0;
  let compared = 0;
  let conflicts = 0;
  let drafted = 0;
  let failed = 0;
  for (const c of run.candidates) {
    if (isTerminal(c.stage)) finished += 1;
    if (STAGE_ORDER[c.stage] >= STAGE_ORDER.compared) compared += 1;
    if (c.verdict?.conflicts) conflicts += 1;
    if (c.draftId) drafted += 1;
    if (c.attempts >= MAX_CANDIDATE_ATTEMPTS && !isTerminal(c.stage)) failed += 1;
  }
  const remaining = total - finished - failed;
  return {
    total,
    finished,
    compared,
    conflicts,
    drafted,
    failed,
    remaining,
    percent: total === 0 ? 0 : Math.round(((finished + failed) / total) * 100),
  };
}

/** One-line status for the view / a chat reply. */
export function describeRun(run: AlignmentRun): string {
  const p = runProgress(run);
  if (run.status === "gathering") return "gathering the authoritative content…";
  if (run.status === "paused") return `paused — ${run.pausedReason ?? "resume when ready"}`;
  const bits = [
    `${p.compared}/${p.total} compared`,
    `${p.conflicts} conflict${p.conflicts === 1 ? "" : "s"}`,
    p.drafted ? `${p.drafted} drafted` : "",
    p.failed ? `${p.failed} failed` : "",
  ].filter(Boolean);
  return bits.join(", ");
}

/** Group conflicting candidates by owner email, so one person receives ONE
 *  notice listing every page they own rather than a message per page. Owners
 *  without an email are grouped under "" for the caller to report as unresolved. */
export function groupByOwner(run: AlignmentRun): Map<string, AlignmentCandidate[]> {
  const out = new Map<string, AlignmentCandidate[]>();
  for (const c of run.candidates) {
    if (!c.verdict?.conflicts) continue;
    const key = (c.owner?.email ?? "").trim().toLowerCase();
    const list = out.get(key);
    if (list) list.push(c);
    else out.set(key, [c]);
  }
  return out;
}

/** Pause a run without losing anything — the Copilot entitlement breaker's
 *  landing state (ADR-0023.1); every completed step stays on disk. */
export function pauseRun(run: AlignmentRun, reason: string, nowIso: string): AlignmentRun {
  return { ...run, status: "paused", pausedReason: reason, updatedAt: nowIso };
}

/** Resume a paused run. Clears the reason; the planner does the rest. */
export function resumeRun(run: AlignmentRun, nowIso: string): AlignmentRun {
  const next: AlignmentRun = { ...run, status: run.snapshot ? "working" : "gathering", updatedAt: nowIso };
  delete next.pausedReason;
  return next;
}
