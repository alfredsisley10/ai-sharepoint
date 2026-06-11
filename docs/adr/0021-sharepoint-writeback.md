# ADR-0021 — SharePoint write-back slice 1: Graph-based, command-driven, snapshot-guarded

- Status: Accepted
- Date: 2026-06-11
- Amends: ADR-0002 (engine), realizes PLAN §7 push direction; groundwork for §8/ADR-0005

## Context
Pilot direction: implement write-back (repo → live SharePoint). The plan designated PnPjs
(ADR-0002), but the artifact set our serializer round-trips — **lists, list columns, modern
pages incl. web-part canvas** — is fully writable through **Microsoft Graph v1.0**
(`POST/PATCH/DELETE /sites/{id}/lists`, `/columns`, `/pages` + `publish`). PnPjs would add a
large dependency, a second HTTP/auth stack, and a SharePoint-audience token path — none of it
needed for this slice, and none of it testable from this environment.

## Decision

**1. Engine: Microsoft Graph for slice 1.** Same fetch path (VS Code networking), same MSAL
provider, same error taxonomy as every other call. PnPjs is re-scoped to artifacts Graph
cannot write (navigation, theme) and revisited when those land with live-tenant validation.

**2. Write scopes are requested only at write time.** Reads keep `Sites.Read.All`. The write
client requests `Sites.ReadWrite.All` (pages/items) + `Sites.Manage.All` (lists/columns) via
the same per-tenant MSAL cache — incremental consent on first use; admins pre-consent in
managed tenants (admin guide).

**3. Human-driven command, not agent-driven.** Write-back ships as an explicit command
(*Apply Repository to SharePoint*). Chat and LM tools remain strictly read-only — the §8
agent-mutation UX (plan → approval inside chat) is a later, separate gate. The agent may draft
files in the repo; a human applies them.

**4. Artifact-level plan with conservative semantics.**
- Desired state parses from repo files; current state from a live re-serialization. Diff is by
  artifact identity (list displayName, page name), not file bytes.
- Slice 1 supports: create list, update list metadata, add column, update column, create page,
  update page (title/canvas), publish after create/update.
- **Deletions are off by default** and applied only with an explicit per-push opt-in; system
  lists (non-`genericList` templates) are never deletable; renames are out of scope (surface as
  create + flagged orphan, never auto-delete).
- Lookup/calculated columns are planned as warnings, not ops (cross-list references need
  manual setup).

**5. Safety pipeline (PLAN §7 made concrete).** Every push runs:
preview (full op list + warnings) → explicit confirm →
**freshness gate** (live site re-serialized and compared to the plan's base; any drift aborts
with "pull & re-review") → **safety snapshot** (a pull commit capturing pre-push live state, so
the push is revertible from Git history) → sequential apply, stop on first error →
**re-pull + commit** so repo == live afterward. No silent writes at any step.

## Consequences
- Write-back lands with zero new dependencies and the existing security posture (keychain,
  redaction, role guard — `reference` connections are refused).
- A failed mid-apply leaves the site partially updated: mitigated by stop-on-first-error, the
  safety snapshot, and the closing re-pull that makes the actual state visible in Git.
- Graph constraints accepted for slice 1: no nav/theme writes, no site rename, no column
  deletion/retyping (flagged, manual).
- Needs live-tenant pilot validation (page canvas PATCH behavior varies by tenant ring) — same
  posture as every adapter; the diagnostics bundle is the feedback channel.
