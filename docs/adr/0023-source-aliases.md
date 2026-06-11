# ADR-0023: Chat aliases & descriptions for reference sources

- **Status:** Accepted (2026-06-11)
- **Context:** PLAN §9 sources are stored with technical display names
  (host + type). Pilots ask for sources the way they talk about them —
  *"@sharepoint find information about application X in the CMDB
  database"* — and the model needs a deterministic way to map "CMDB" to
  one configured connection, plus enough content knowledge to pick a
  source when none is named.

## Decision

1. **Two optional, non-secret descriptor fields** on `ContextSource`:
   - `alias` — a short handle (≤ 32 chars), **unique case-insensitively**
     across sources so a chat reference can never be ambiguous. Uniqueness
     is enforced at entry (add/edit validation), on import (in-file dupes
     and collisions with existing sources are dropped with warnings) —
     never at resolve time.
   - `description` — a one-liner (≤ 200 chars) on what the source
     contains, written for the model as much as for the user.
2. **One shared resolver** (`sourceRef.ts`, pure): id → alias (exact,
   case-insensitive) → display name → type → *alias mentioned in the
   reference* (word-boundary match, so a model may pass the user's phrase
   "the CMDB database" verbatim and short aliases like "DB" can never
   match inside "database") → display-name substring. The store, every LM
   tool, and the commands all delegate to it — there is exactly one
   matching semantics.
3. **Model exposure on every path**: the fields ride in the
   `list_sources` tool output, in the `source` input-schema descriptions
   (`package.json`), in the participant's per-turn context block (alias
   quoted, description appended), and in resolution-failure messages —
   so both @sharepoint and agent-mode `#`-tools ground "CMDB" without
   extra round-trips.
4. **Sharing**: alias + description join the export **allowlist**
   (ADR-0013) — they are user-authored, non-secret configuration the
   whole team benefits from.

## Consequences

- Renaming a server or DBA-style display name no longer breaks the way
  people refer to a source in chat; the alias is the stable handle.
- A dropped/changed alias only affects convenience — resolution falls
  back to display name/type exactly as before (fully backward
  compatible: descriptors without the new fields behave unchanged).
- Aliases are descriptors, not secrets — they appear in exports and
  tooltips; redaction rules are unaffected.
