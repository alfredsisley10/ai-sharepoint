# ADR-0005 — Sync directionality and revert-to-commit safety model

- Status: Accepted
- Date: 2026-06-10

## Context
The sync engine must support three distinct operations, not just an abstract "two-way sync":

1. **Pull & reconcile** — capture changes a user made *directly in SharePoint* (including content/data,
   not just structure) and reconcile them with local work.
2. **Push** — apply locally developed / agent-authored changes to the live site.
3. **Revert** — restore the active SharePoint site to the serialized state of an earlier Git commit.

Pull and push are the two halves of the existing 3-way merge design. Revert is materially different:
it applies a *historical* state to a *live* system, which is inherently destructive and not always
losslessly reversible, so it needs its own guardrails.

## Decision
All three operations run through one **preview → approve → apply → commit** pipeline (no silent
writes; every applied change is recorded in Git). Specifics:

- **Pull is the default first step** of any sync, so we never push onto a stale base. Clean remote
  changes fast-forward locally; overlaps surface in the VS Code merge editor labeled "Local vs.
  SharePoint."
- **Push runs an implicit freshness check** (pull) first; if SharePoint moved under us, reconcile
  before writing rather than blind-overwrite. The per-site review gate (ADR-0004) governs how the
  resulting commit reaches GitHub.
- **Revert = roll-forward to an old state, not a Git history rewrite.** We diff the *current live site*
  against the *target commit* and apply the changes that make live match target. Guardrails:
  - **Safety snapshot first** — pull current live state into a fresh commit before applying, so the
    revert is itself reversible.
  - **Structure-vs-content scope is explicit** — default *structure only* (pages, columns, content
    types, nav, theme); *structure + content* is opt-in because overwriting user-entered list/library
    data is destructive.
  - **Non-reversible deltas are flagged, not silently partial** — e.g. a since-deleted column whose
    data is gone, lost version history, broken permission inheritance are listed as "cannot fully
    restore" in the preview.
  - **Explicit confirmation** showing exactly what will be created/updated/deleted; result committed as
    `Revert SharePoint to <sha>`.

## Consequences
- Users get a true "undo to a known-good site state" capability with a clear blast-radius preview.
- Revert fidelity is bounded by serialization fidelity (PLAN §2.2/§7) and by SharePoint's own
  irreversibility — we surface those limits rather than pretend to a perfect rollback.
- The safety snapshot doubles the write cost of a revert but makes the operation safe to attempt.
