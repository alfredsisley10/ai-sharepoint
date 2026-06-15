# ADR-0038: Manage Confluence pages (read + write)

- **Status:** Accepted (2026-06-15)
- **Context:** Pilots cannot get tenant-admin consent for SharePoint write
  scopes (`Sites.ReadWrite.All`/`Sites.Manage.All`, or even `Sites.Selected`),
  so the SharePoint write-back lifecycle is blocked for them. They *can*,
  however, write to **Confluence** with their own API token — no admin OAuth
  consent involved. Confluence becomes the writable authoring target.

## Decision

1. **Confluence-native write client** (`confluenceWrite.ts`), not the
   SharePoint-shaped `PushWriter`. Confluence is page-centric (no lists /
   columns / web-part canvas), so the writer models **pages**: create
   (`POST /rest/api/content`), update (`PUT`, reading the current version and
   sending `version+1` so concurrent edits fail loudly), and trash (`DELETE`).
   Authenticated with the source's existing `ContextCredential` (Basic API
   token or PAT) — the same one the read adapter uses.
2. **`fetchJson` widened** to allow `PUT`/`DELETE` and to tolerate `204 No
   Content` (a backward-compatible change; existing GET callers are unaffected).
3. **Markdown → storage** — a pragmatic converter (`markdownToStorage`) turns
   the Markdown the assistant naturally writes into Confluence storage-format
   XHTML (headings, paragraphs, lists, fenced code, inline emphasis/links, with
   HTML escaping). Pure and tested.
4. **One approval-gated chat tool** (`#spWriteConfluencePage` /
   `aisharepoint_write_confluence_page`): the assistant proposes a page
   (space/title/markdown to create, or pageId+title/markdown to update); VS
   Code's tool **confirmation dialog** gates it; only on approval does
   `ContextService.writeConfluencePage` (which owns the stored credential and
   lockout gating) perform the write. This is the single write path over the
   otherwise read-only context framework.
5. **Reversible by construction** — Confluence keeps full version history, so an
   update is recoverable there; deletes go to the space trash.

## Consequences

- The assistant can manage Confluence content **without any admin consent** —
  the writable target that unblocks pilots walled off from SharePoint writes.
- Strictly opt-in and gated: nothing is written without the per-write approval;
  writes are never cached and are lockout-gated like reads.
- This is the **complete** Confluence management model — **not** a stepping
  stone to a Git lifecycle. Confluence keeps full **page version history**
  natively, so a SharePoint-style pull → edit-as-files → apply/revert
  round-trip is **intentionally not built** for Confluence: native versioning
  provides revert, and the approval-gated direct write provides create/update.
  (Unlike SharePoint, whose Git lifecycle exists precisely because it has no
  comparable built-in versioning/rollback for the structures it manages.)
- The Markdown converter is intentionally not a full Markdown engine; complex
  source may need hand-tuned storage. Tables/macros are future extensions.
