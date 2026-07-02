# Review: connector readiness for the information-sprawl reconciliation workflow (2026-07-02)

Scope: assess whether the SharePoint, Confluence (and supporting ServiceNow/LDAP/comms/export)
connectors are optimally configured for the pilot's end-to-end cleanup workflow:

> Declare authoritative content (Confluence / SharePoint / ServiceNow / attached XLS) → incrementally
> sweep other locations for inconsistencies → determine the **effective owner** of each offending
> page (recent active contributors, validated as active employees via LDAP; space contributors;
> configured owners last) → cache ownership + LDAP lookups (exportable) → notify the owner by
> email/Teams → keep a local, exportable **inventory** of all remediation work incl. follow-ups →
> also self-review the authoritative source (currency, accuracy, quality) → export an XLSX-style
> oversight summary.

Verdict up front: **the Confluence primitives for this exact workflow were designed and built
(ADR-0039…0044), but the last mile never landed.** The directory ("active employee") check is
stubbed, nothing is cached or persisted for ownership/LDAP, the authority construct and content
cache are implemented but unwired, SharePoint and ServiceNow have no ownership capability at all,
there is no remediation-work inventory, and exports are CSV/JSON only. The connectors are *capable*
but not *configured* for this workflow yet.

## Requirement-by-requirement assessment

| # | Workflow requirement | Today | Status |
|---|---|---|---|
| 1 | Declare authoritative content | `confluenceAuthority.ts` (ADR-0040): `authoritative\|<topic>` label, `AuthorityScope` (space/page/subtree), `gatherAuthorityPages`, `findConflictCandidates` — **implemented, fully unwired** (no service method, no chat tool). File sources (XLSX/XLS/CSV/DOCX/PDF) can be read as context but cannot be *marked* authoritative. No authority construct for SharePoint/ServiceNow. | 🟡 built, unwired |
| 2 | Incremental sweep of targets | Confluence: `findConflictCandidates` (CQL, excludes authority scope). SharePoint: `scan_site_content` walks every modern page (≤100) with explicit duplicative/out-of-date/confusing guidance. ServiceNow: `search_context` text queries. `ConfluenceContentCache` (ADR-0042) exists precisely for repeated passes + `stale()` drift detection — **unwired**. No cross-source sweep orchestration; every pass refetches. | 🟡 partial |
| 3 | Effective owner — Confluence | `resolveOwners` matches the pilot's spec: owner label (override) → most-prolific **page** contributor → most-prolific **space** contributor; deliberately skips the administrative space owner. Exposed as `resolve_page_owners`. **But:** the active-employee check is stubbed (`isActive: async () => true` in `contextService.ts`), ranking is **all-time count with no recency weighting** (pilot wants "most active of recent history"), and there is no last-resort "configured space owners" basis (returns `none`). | 🟡 shipped, 3 gaps |
| 4 | Effective owner — SharePoint | **Missing.** Page reads select only `id,title,name,webUrl,lastModifiedDateTime` — no `createdBy`/`lastModifiedBy`, no version/author history, no contributor tally. | 🔴 missing |
| 5 | Effective owner — ServiceNow | **Partial.** `assigned_to`/`opened_by` + `sys_updated_on` surface; the actual last-editor identities (`sys_updated_by`, `sys_created_by`) are filtered out by the `sys_`-prefix rule in `getServiceNowItem` and absent from `META_FIELDS`. | 🟡 partial |
| 6 | Owner hints from page content | Nothing looks for owner/contact hints in page bodies (pilot: "may also consider the page content itself"). LLM can do this ad-hoc in chat, but no structured signal. | 🔴 missing |
| 7 | LDAP active-employee validation | `userDirectory.ts` (ADR-0041) is exactly right: `userAccountControl` ACCOUNTDISABLE bit (unknown→active, unresolvable→inactive for ownership), M365 fallback, `contactOf` for notification. **Not wired into ownership or currency** — `resolve_page_owners` treats everyone as active; `review_page_currency` reports every owner inactive (`dir: async () => undefined`). | 🔴 built, stubbed out |
| 8 | LDAP lookup caching (days) | **None.** Every directory lookup is a fresh connect+bind+search+unbind. Only connection hints (`lastGoodUrl`, pinned DNS) are remembered. | 🔴 missing |
| 9 | Ownership cache, exportable/importable | **None.** Ownership is recomputed live each call; nothing persists it; the reference-config export has no ownership block. (Owner labels written back to Confluence via `setConfluencePageOwners` are the only durable record.) | 🔴 missing |
| 10 | Notify owner (email/Teams) | **Strong.** `draft_communication`: Outlook drafts created directly in the user's Drafts folder (review-and-send there); Teams messages staged in a persistent outbox behind per-draft modal approval; recipient resolution, HTML bodies, attachments (≤3 MB), webhook channel option, agent never sends. | 🟢 ready |
| 11 | Remediation-work inventory + follow-up | **Missing entirely.** No work-item store (greenfield): comms outbox tracks only pending drafts (no linkage to findings, no open/notified/resolved/follow-up states); Projects bundle sources/goals/instructions/AI-context, not work items; no reminders (nearest: an Outlook message rule that files replies). | 🔴 missing |
| 12 | Export/import of workflow state | Reference-config export (`reference-config/v1`, JSON, secret-free) covers sources, bookmarks, schemas, projects, sites, memory, prompts with real merge planning. **Does not cover** ownership, LDAP cache, or work inventory (which don't exist). | 🟡 rails exist |
| 13 | Authoritative self-review: currency | `review_page_currency` (ADR-0043): dead-link check (HEAD→GET, ≤60 links), owner-tag validity, staleness (>365 d flag). Per-page only, Confluence only, and owner-activity is wrong until #7 is wired. No space-wide batch sweep tool. | 🟡 partial |
| 14 | Authoritative self-review: accuracy/quality | By design the LLM compares content (`gatherAuthorityPages` + cache as substrate) — but with the cache and authority unwired there is no efficient substrate; quality (grammar/concision) review is ad-hoc chat only. `review_space_manageability` (ADR-0044) usefully pre-checks that cleanup *can* write everywhere. | 🟡 partial |
| 15 | XLSX oversight summary | **No XLSX writer** — `xlsx.ts` is a reader; exports are typed `csv \| json` (`exportData.ts`), and the export tool writes *query results*, not review findings. No findings-report exporter. | 🔴 missing |

## The load-bearing gaps, in dependency order

1. **Wire the user directory (LDAP/M365) into ownership + currency.** Everything the pilot asked for
   hinges on "active employee" being real. The pure construct exists; the two stubs in
   `contextService.ts` (`isActive: async () => true`, `dir: async () => undefined`) are the whole gap.
   Wiring = pick the configured LDAP source (or the M365 sign-in) and pass
   `activeFromDirectory(dir)` / `dir` through. Includes surfacing `contact` (email/UPN) so the
   notification step gets its recipient from the same lookup.
2. **Persistent LDAP lookup cache.** A `Map<sam, UserRecord & {resolvedAt}>` store in
   globalState/globalStorage with a **multi-day TTL** (pilot: "slowly moving for at least several
   days"; default e.g. 5 days, configurable), consulted before any live lookup, and included in the
   reference-config export/import (it is non-secret directory data — display name, email, active flag).
3. **Recency-weighted contributor ranking + full fallback chain.** Add a recency window/weighting to
   `tallyContributors` (e.g. only or preferentially count versions from the last N months; N
   configurable) so "most active contributor of recent history" is honored; add the pilot's explicit
   last-resort basis — configured space owners (clearly labeled `basis: "space-owner"` so callers know
   it's administrative, not effective) — before `none`.
4. **Ownership cache store, exportable.** `OwnershipStore`: per target (source id + page id) the
   resolved owners, basis, considered candidates, resolvedAt, TTL; consulted by `resolve_page_owners`
   (with a `refresh` escape hatch); exported/imported as a new reference-config block. This is what
   makes ownership "compute once, reuse across the team."
5. **SharePoint + ServiceNow ownership parity.**
   - SharePoint: request `createdBy,lastModifiedBy` on page reads and add a page **versions**
     fetch (SitePages/list-item versions API) → feed the same `tallyContributors` →
     `resolveOwners` pipeline (the module is already IO-injected for exactly this reuse).
   - ServiceNow: include `sys_updated_by,sys_created_by` in `sysparm_fields` and allowlist them in
     `META_FIELDS`/item output; map to LDAP sams for the active check. KB articles additionally have
     `author`/`kb_knowledge` ownership fields worth surfacing.
   - Content-hint pass (both + Confluence): a cheap regex/LLM sweep of the page body for
     owner/contact/team markers as a weak, clearly-labeled signal.
6. **Wire authority + content cache into the chat surface.** Tools to (a) mark/list authority scopes
   (label-based for Confluence; a project-level `authoritative` flag for SharePoint sites, ServiceNow
   sources, and file sources so an attached XLSX can be the baseline), (b) snapshot a scope into the
   persisted `ConfluenceContentCache` ("cache this space"), (c) run the conflict sweep incrementally
   from the cache with `stale()` drift detection. This unlocks both the cross-source sweep and the
   fast repeated self-review passes.
7. **Remediation inventory (greenfield, but small).** A `WorkItemsStore` (globalState) with items:
   finding (what's wrong, where — source/page ref, evidence snippet), resolved owner + contact,
   status (`open → notified → in-progress → resolved / wont-fix`), linked comms draft id, timestamps,
   follow-up-due date; a tree/view + "due for follow-up" listing the assistant can act on ("draft a
   reminder for everything overdue"); full export/import block (multi-user handoff + restore).
8. **Findings/oversight exporter.** Reuse `rowsToCsv` now (one CSV per section: authoritative-page
   inventory w/ currency+owner, conflicts found elsewhere, work items w/ status) and add a minimal
   XLSX **writer** (the repo already ships a zip-reading XLSX parser; writing one worksheet set with
   inline strings is a bounded, dependency-free increment) so the pilot gets the single-workbook
   summary they asked for.

## What is already optimal (no change needed)

- **Notification path** (Outlook drafts + approval-gated Teams outbox) — exactly the "prepare, human
  sends" posture the workflow needs; recipient resolution and attachments included.
- **Manageability pre-check** (ADR-0044) — audits that the signed-in user can actually fix what the
  sweep finds, and drafts the access request when not.
- **Export/import rails** (`reference-config/v1`) — secret-free by construction with real merge
  planning; new blocks (ownership, LDAP cache, work items) slot into an existing, proven mechanism.
- **File sources** — attached XLSX/XLS/CSV already parse into bounded tables, ready to serve as
  authoritative baseline input once they can be flagged as such.
- **Archive / remove-from-search escalation** (ADR-0039) — the compliance-safe cleanup actions the
  workflow ends in are already approval-gated tools.

## Sequencing note

Items 1–3 are small and unlock the correctness of everything downstream (today
`resolve_page_owners` can name a long-departed employee, and `review_page_currency` mislabels every
owner inactive). Items 4–6 make the workflow *cheap and repeatable*. Item 7 makes it *trackable
across people*, and item 8 delivers the oversight artifact. 1–4 touch only existing seams; 5 is the
largest new surface (SharePoint versions API); 7 is greenfield but mirrors existing store patterns.
