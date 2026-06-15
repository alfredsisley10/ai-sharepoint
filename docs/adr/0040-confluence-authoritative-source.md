# ADR-0040: Confluence authoritative-source construct

- **Status:** Accepted (2026-06-15)
- **Context:** We can't control what others publish in Confluence about a topic,
  so inaccurate or misleading pages proliferate. We want to declare a **space**,
  **page**, or **subtree** as the *authority* for a topic, then sweep the rest
  of Confluence for content that conflicts with it and needs cleanup
  (archive / remove-from-search / notify owner — ADR-0038/0039).

## Decision

A reusable `confluenceAuthority.ts` construct providing the **retrieval
primitives**; the LLM does the actual conflict/accuracy judgement over them:

1. **Self-describing authority marker** — a label `authoritative|<topic-slug>`
   on the authoritative content (same pipe-delimited, label-safe pattern as the
   owner label). `buildAuthorityLabel` / `parseAuthorityLabel` /
   `findAuthorityTopics` are pure.
2. **`AuthorityScope`** = `{ topic, kind: space | page | subtree, spaceKey?,
   pageId? }`. A *subtree* is a page plus its descendants.
3. **`gatherAuthorityPages(scope)`** — fetch the authoritative content (the
   topic's truth) as bounded plain text: a single page, a page + its
   descendants (`/descendant/page`), or a whole space's pages.
4. **`findConflictCandidates(topic, exclude)`** — CQL search the rest of
   Confluence for the topic (`text ~ "<topic>" and type = page`), **excluding
   the authoritative space** (via `space != "…"`) and the authoritative **page
   ids** (post-filter). Returns candidate pages for the assistant to compare
   against the gathered authority and flag conflicts/misleading info.

## Consequences

- Clean separation: the construct does **scoping + retrieval** (deterministic,
  testable); the assistant does **comparison + recommendation** (which page
  conflicts, how, and the cleanup — archive, remove-from-search, or contact the
  owner). This composes the ownership/archiving/search-removal constructs into a
  full "find and clean up inaccurate content" flow.
- Read-only retrieval (writes only happen through the approval-gated cleanup
  actions). Bounded results/text keep sweeps chat-sized.
- Topic search is keyword/CQL `text ~`, so very broad topics return many
  candidates — the authority *content* (not just the topic string) is what the
  model compares against, which keeps precision reasonable.
- **Next (staged):** chat tools to mark authority and run the sweep
  ("using <space/page> as authoritative for <topic>, find conflicting Confluence
  pages and recommend cleanup"), wired with the active-user/owner notification.
