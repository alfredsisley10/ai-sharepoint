# ADR-0045: Confluence write-data hygiene (XHTML + title normalization)

- **Status:** Accepted (2026-06-26)
- **Note (numbering):** the decision shipped in `confluenceWrite.ts` and is cited
  there as "ADR-0045"; the record file was missing and is reconstructed here from
  the shipped behavior.
- **Context:** Confluence storage format is **strict XHTML** and page titles are
  **plain text**, but an LLM authoring a page commonly emits content that is
  *almost* valid — a bare `&` (illegal in XHTML), an un-self-closed void element
  (`<br>`, `<img>`), or a title carrying HTML/entities (`"<b>R&amp;D</b>"`).
  Sending that verbatim makes the Confluence API reject the write, turning a
  well-meaning draft into a confusing failure.

## Decision

1. **Normalize on every write, never trust the model's markup.** A set of pure,
   unit-tested normalizers run before any create/update:
   - decode HTML entities (named + numeric) to characters, then re-escape only
     the XML-significant ones so the body is valid XHTML;
   - self-close void elements (`<br>`, `<img>`, `<hr>`, …);
   - strip markup/entities from the **title** down to plain text.
2. **Fail toward a valid page, not an API error.** The goal is that a
   well-meaning-but-imperfect body/title still produces a valid Confluence page,
   rather than surfacing a raw storage-format rejection to the user.
3. **Pure + tested.** The transforms are side-effect-free and covered by unit
   tests so the hygiene rules are pinned.

## Consequences

- Confluence writes (ADR-0038 and the page-management tools) tolerate realistic
  LLM output without hand-cleaning.
- The normalizers are deterministic and local; they change only the outgoing
  representation, never the user's intent.
