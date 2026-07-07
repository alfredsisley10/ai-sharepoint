# ADR-0048 — Project chat workspaces

## Status

Accepted (0.111.0). Core-first; follow-ups tracked below.

## Context

Copilot chat models expose a small input-context window, and in corporate
tenants it is frequently clamped well below the advertised `maxInputTokens`
(see ADR-0009 / the effective-context probing work). The consequence for
`@sharepoint` is that a long or research-heavy conversation loses its earlier
turns and the connected data it gathered: the user cannot easily follow a long
thread, work is re-fetched, and a chat that overflows or fails is effectively
lost — there is nowhere to "look back."

Projects already exist as a durable scope (goals, user instructions, AI-managed
memory, member sources), but they did not retain the *conversations* held under
them.

## Decision

A project can opt into a **chat workspace**: a durable, browsable mirror of the
`@sharepoint` conversations held while that project is active. It keeps the
record OUTSIDE the chat's context window.

- **On disk, browsable.** Written to `.ai-sharepoint/projects/<slug>/` in the
  first workspace folder (falls back to the extension's global storage when no
  folder is open). The `.ai-sharepoint/` directory is added to the workspace
  `.gitignore` on creation so chat content is not committed by accident.
- **Artifacts:** `SUMMARY.md` (a rolling, deterministic digest — the user's
  goals/instructions, a session index, and a per-session conversation outline),
  per-session transcripts under `sessions/<id>.md`, and `manifest.json` (the
  index the Projects tree and future restart flow read).
- **Opt-in.** Nothing is written until **Start Project Workspace** runs for a
  project. After that, `enabled(projectId)` gates a best-effort, redacted mirror
  of each completed turn from the chat participant — it never blocks or breaks a
  reply.
- **Redaction.** Prompts and replies pass through the same `redactText` used by
  the diagnostics bundle before being written.
- **Purity.** All rendering/record math lives in `context/chatWorkspace.ts`
  (pure, unit-tested); `context/chatWorkspaceStore.ts` layers the filesystem,
  redaction, per-project write serialization, and gitignore management.

A session = one conversation; the first turn (empty chat history) starts a new
`sessions/<date>-<n>.md`. The manifest read-modify-write is serialized per
project so interleaved turns cannot clobber the summary.

## Consequences

- Users can follow a long conversation, and restart a starved/failed chat by
  skimming `SUMMARY.md` and the relevant transcript, then continuing in a fresh
  chat with the same project active.
- Chat content lands on disk (git-ignored, local, redacted) only after explicit
  opt-in — acceptable for corporate use, and reversible (disable + delete the
  folder).

## Follow-ups

- **Delivered (0.112.0) — Confluence space dossier.** `context/spaceDossier.ts`
  (pure) + `ContextService.buildConfluenceSpaceDossier` aggregate a target space
  (page inventory, owners, staleness, data-quality) into the workspace under
  `space/<KEY>/` (`inventory.md/.json`, `owners.md`, `dossier.xlsx`), open a
  de-duplicated work item per flagged page (ADR-0045), and draft per-owner
  outreach under `space/<KEY>/outreach/`. Reuses the ownership/currency suite.
- Cache the connected-context blocks and tool results per turn into the
  workspace so later chats reuse them instead of re-fetching (efficiency).
- "Resume in new chat" that seeds a fresh chat directly from the summary +
  cached context.
