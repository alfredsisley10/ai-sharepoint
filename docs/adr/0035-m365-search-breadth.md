# ADR-0035: Microsoft 365 Copilot connector — Search breadth + Retrieval refinements

- **Status:** Accepted (2026-06-15)
- **Context:** ADR-0034 shipped the connector against the **Copilot Retrieval
  API**, which only reaches **SharePoint/OneDrive documents and Copilot
  (Graph) connectors**. Pilots noted the Copilot *web app* also searches
  **email, calendar, Teams messages, and people** — the Retrieval API does
  not. Matching that breadth needs a second engine.

## Decision

1. **Two complementary engines under one `m365copilot` source:**
   - **Retrieval API** (`POST /copilot/retrieval`) for semantic grounding on
     **SharePoint/OneDrive** docs and **Graph connectors**.
   - **Microsoft Search API** (`POST /search/query`) for **email** (`message`),
     **calendar** (`event`), **Teams** (`chatMessage`), and **people**
     (`person`) — the surfaces Retrieval can't reach.
2. **Surfaces are opt-in per source**, stored on the source `baseUrl`
   (`?surfaces=sharePoint,message,…`, default `sharePoint`; back-compatible with
   the old `?dataSource=`). **The delegated consent footprint equals exactly the
   enabled surfaces** — `Files.Read.All`+`Sites.Read.All` for documents,
   `ExternalItem.Read.All` for connectors, `Mail.Read` / `Calendars.Read` /
   `Chat.Read` / `People.Read` for the Search surfaces — computed at token time
   from the source. A SharePoint-only source never asks for mailbox scope.
3. **One `search_context` call fans out** to every enabled engine in parallel
   (`Promise.allSettled`): a surface a tenant doesn't support (e.g. Teams
   `chatMessage`) can't void the others; results merge and cap to the read caps.
   The Search request issues **one sub-request per entity type** for the same
   reason. Verify probes each enabled engine once (ADR-0009).
4. **Retrieval refinements (ADR-0034 follow-ups), now shipped:**
   - **KQL scoping** — `search_context` accepts either plain text or a
     `{"query":"…","filter":"<KQL>"}` spec; the filter becomes the Retrieval
     `filterExpression` and is AND-ed into the Search `queryString`
     (Path / SiteID / Author / FileType / LastModifiedTime / …).
   - **Richer hits** — request `resourceMetadata` (title/author/lastModified)
     and surface the per-extract `relevanceScore`; Search hits carry
     entity-aware title/url/from/received/start + highlights stripped.
   - **Fixed the connectors scope gap** — `externalItem` now requests
     `ExternalItem.Read.All` (it would 403 before).

## Consequences

- The connector now matches the Copilot web app's grounding breadth — but
  email/Teams/calendar are a **real consent expansion**, so they are deliberate
  per-source opt-ins (default stays SharePoint/OneDrive only) and the wizard
  spells out the scope each adds.
- Still strictly read-only and delegated (the user's own content, never more),
  behind the standard lockout/cache/caps rails. Retrieval still needs a Copilot
  licence; Search does not — a tenant without Copilot can still enable the
  email/calendar/Teams/people surfaces.
- `chatMessage` search support varies by tenant/cloud; isolated so it degrades
  gracefully. Both APIs share `graph.microsoft.com` (already allowlisted).
