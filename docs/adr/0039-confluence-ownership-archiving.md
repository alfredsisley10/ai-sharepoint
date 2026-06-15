# ADR-0039: Confluence page ownership + archiving constructs

- **Status:** Accepted (2026-06-15)
- **Context:** Driving content cleanup needs **accountability**: who to contact
  before updating a page, or to notify before archiving it. Confluence *space
  owners* are often inaccurate, so ownership is derived from **contribution
  history**. Archiving needs a consistent home. These are reusable building
  blocks, designed for **Confluence Data Center** (where a version author's
  `by.username` is the AD **sAMAccountName**).

## Decision

### Ownership (`confluenceOwnership.ts`)
Determine a page's *likely owner* via a priority pipeline (pure core, all IO
injected so it's testable and reusable):
1. **Explicit owner label** — a single Confluence label `<marker>|sam1|sam2`
   (pipe-delimited sAMAccountNames; default marker `owners`). Confluence label
   limits forbid emails, so sam names are the identifier. When present, it is
   **authoritative** (inactive members are flagged, not dropped).
2. **Most prolific contributor to the page that is also active** — tallied from
   the page's version history (`/rest/api/content/{id}/version` → `by.username`).
3. **Most prolific active contributor for the whole space** (bounded crawl).

"Active" is an **injected predicate** (`(sam) => Promise<boolean>`) so it can be
backed by **LDAP** (`sAMAccountName` + `userAccountControl`) or **M365**
(`onPremisesSamAccountName` + `accountEnabled`) — wired next. Owners are written
back with `setConfluencePageOwners` (replace the existing owner label).

### Archiving (`confluenceArchive.ts`)
"Archive a page" = move it **under a root-level page named "archive"** in its
space, matched **case-insensitively** and **created if absent**. The move uses
Confluence's content-safe move endpoint (`/move/append/{targetId}` — no body
round-trip, so macros/content are untouched). Refuses to archive the Archive
root itself.

## Consequences

- Ownership reflects **contributions** (accountability), never the unreliable
  space-owner field. Authoritative override via the label; transparent about
  which basis (label / page / space) and which candidates were considered.
- All writes use the source's **own API token** — no admin OAuth consent, like
  the rest of Confluence management (ADR-0038).
- **Data Center-oriented:** sam names come from `by.username`; Confluence Cloud
  exposes accountId/publicName instead (the active-user/sam model wouldn't apply
  cleanly there).
- **Next (staged):** the LDAP/M365 active-user predicates, chat tools/commands
  exposing "who owns this page?", "set owners", and "archive page" (the archive
  one notifying the resolved owner first), and a local page cache + drift check
  ("don't deploy onto a page that changed underneath us"). The constructs here
  are the reusable foundation those build on.
