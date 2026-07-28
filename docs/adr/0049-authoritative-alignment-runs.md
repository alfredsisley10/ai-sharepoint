# ADR-0049: "Align with Authoritative Source" — durable, restartable alignment runs

- **Status:** Accepted (2026-07-27)
- **Context:** Declaring one space/site authoritative and then hunting the stale
  copies that contradict it is the flagship information-sprawl workflow, and
  today it only exists as *prompt orchestration*: the participant instructions
  tell the model to call `gather_authority` → `find_conflicts` → (separately)
  `scan_site_content` → `resolve_page_owners` → `track_work_item` →
  `draft_communication`, one page at a time, in one chat turn. That has three
  concrete failure modes observed in practice:

  1. **It is not restartable.** The sweep's state lives only in the chat
     transcript. A Copilot interruption — an entitlement 403 (ADR-0023.1), a
     dropped network, a token/context limit, or the user simply closing the
     window — loses every comparison already paid for, and re-running restarts
     from zero and re-bills every model call.
  2. **It is Confluence-only on the authority side.** `mark_authority`,
     `gather_authority` and `find_conflicts` all refuse a non-Confluence source,
     so "this SharePoint site is the source of truth" cannot be expressed even
     though the SharePoint read path (`scan_site_content`, `inspect_site`) exists.
  3. **It re-reads everything.** Each turn re-fetches authority pages and
     candidate bodies that the content cache (ADR-0042) already holds, which is
     slow and burns the read caps on re-work rather than coverage.

## Decision

Model the workflow as a first-class, **persisted alignment run** — an explicit
job with a resumable work queue — rather than a conversation.

### 1. The run is the unit of durability

An `AlignmentRun` is a JSON document in `globalStorage` (one file per run,
alongside the ADR-0042 content cache and the ADR-0045 work inventory). It holds:

- **the authority declaration** — corpus (`confluence` | `sharepoint`), the
  source/site it lives in, its scope (space / page / subtree / site), and the
  topic it is authoritative *for*;
- **the target corpora** to sweep (any mix of Confluence sources and SharePoint
  sites — the authority's own scope is always excluded);
- **an authority snapshot** — the gathered truth as bounded plain text, with a
  content hash per page and a `gatheredAt` stamp;
- **a candidate queue** — one entry per page found by the sweep; and
- **counters + an `updatedAt`**, so the UI can show live progress and the run
  can be listed, resumed, or discarded.

### 2. Per-candidate stage ladder, persisted after every transition

Each candidate advances through a **monotonic** ladder:

```
discovered → fetched → compared → owner-resolved → drafted → done
                    ↘ clean (terminal)      ↘ skipped / failed (terminal)
```

The run is checkpointed **after each transition**, so an interruption loses at
most the single in-flight step. Resume is therefore not a special code path: it
is just "keep planning the next step", because the ladder position *is* the
saved progress. `planNextStep(run)` is a pure function of the persisted document.

This is deliberately finer-grained than checkpointing per phase. The expensive,
interruptible thing is the **Copilot comparison call**, so the checkpoint
boundary is drawn immediately around it — every verdict already paid for is
durable the moment it returns.

### 3. What is cached locally, and why each thing earns its place

| Cached | Key | Invalidated by | Why |
|---|---|---|---|
| **Authority snapshot** (page text + per-page hash) | run id | authority TTL, or a page hash change on refresh | Compared against *every* candidate; re-fetching it per comparison is the single biggest avoidable cost. |
| **Candidate page content** (bounded text) | corpus + locator + content hash | source-side version/etag change | Lets a resumed run re-compare without re-reading, and powers interactive drill-down ("show me the conflicting text") with no round trip. Reuses ADR-0042 for Confluence; the SharePoint half is stored the same way. |
| **Comparison verdict** (conflict?, severity, requested edits) | candidate key + authority hash + candidate content hash | either hash changing | The metered artifact. Keying on **both** hashes means an unchanged pair is never re-billed, while a genuine edit on either side correctly re-opens the question. |
| **Owner resolution** (name/email/basis) | page + site/space | directory cache TTL (ADR-0041) | Owner lookup is several requests (page contributors, then space/site contributions, then active-employee validation); it is stable and reused across every candidate owned by the same person. |
| **Drafted notice** | owner + run | user edit / send | Drafts are grouped per owner, so they must accumulate across candidates before anything is sent. |
| **Sweep cursor** per target | run + target | new run | Lets a sweep interrupted mid-pagination continue instead of re-listing. |

Everything above is **non-secret** (page text, names, emails already visible to
the signed-in user) and lives in `globalStorage`, never in settings, never in a
diagnostics export, and never in the reference-config share.

### 4. Interruption is expected, not exceptional

- A failed step records `error` + `attempts` on the candidate and moves on, so
  one bad page cannot stall the run; it is retried on the next pass.
- A Copilot **entitlement** failure trips the ADR-0023.1 breaker, which marks the
  run `paused` (not `failed`) with the reason, because the correct user action is
  "resume later", not "start over".
- Read caps (ADR-0012) and the cost governor apply per step, so a large run
  degrades into more passes rather than one oversized request.

### 5. Writes stay human-approved

The run **prepares**; it never sends. Conflicts become work items in the existing
event-sourced inventory (ADR-0045, whose `WorkItemTargetKind` already covers
`sharepoint`), and owner notices become **drafts** in the communications outbox
(ADR-0025), which is already approval-gated and recipient-confirmed. The
alignment run adds no new write path and no new send path.

## Consequences

- The flagship workflow survives a Copilot interruption, a window close, and a
  restart, and never re-bills a comparison whose inputs haven't changed.
- SharePoint becomes a first-class authority, not just a sweep target, closing
  the asymmetry that made "this site is the source of truth" unexpressible.
- Runs are inspectable and resumable state rather than transcript, so progress is
  reportable ("42 of 310 compared, 7 conflicts, 3 owners drafted") and a run can
  be handed to a colleague with the project.
- Cost: another JSON store to migrate/version. Mitigated by keeping the run
  document additive and tolerant of unknown fields, as the work inventory is.
