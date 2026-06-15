# ADR-0034: Microsoft 365 Copilot connector (read-only)

- **Status:** Accepted (2026-06-15)
- **Context:** Pilots want @sharepoint to leverage the **same grounded
  enterprise context that Microsoft 365 Copilot reasons over** — the
  semantically-indexed content of the user's SharePoint, OneDrive, and
  (optionally) Microsoft Graph connectors — without re-implementing
  search ranking. Microsoft now exposes this directly through the
  **Microsoft 365 Copilot Retrieval API** (`POST /copilot/retrieval`),
  which returns relevance-ranked grounding passages trimmed to what the
  signed-in user is permitted to see.

## Decision

1. **New `m365copilot` source type** that calls the Retrieval API on
   `graph.microsoft.com/v1.0/copilot/retrieval`. It is a reference
   (read-only) context source like the others: chat reaches it through
   `search_context`, and results are normal `ContextSearchHit`s
   (title from the result URL, the joined `extracts[].text` as the
   excerpt, resource type / sensitivity label as meta).
2. **Auth reuses the existing Microsoft 365 sign-in.** The Retrieval
   API is a Graph call, so the connector takes a delegated
   `graph.microsoft.com` token via the **same MSAL sign-in already used
   for SharePoint sites** (method `aad-sso`, no new app registration),
   or a pasted Graph access token (`pat`) as a fallback. Required
   delegated scopes: **`Files.Read.All` + `Sites.Read.All`** (both, for
   SharePoint/OneDrive grounding); `ExternalItem.Read.All` would extend
   it to Graph connectors.
3. **Grounding surface is a per-source choice** (`dataSource`:
   `sharePoint` for documents/sites, `externalItem` for Copilot
   connectors), persisted on the source `baseUrl` query so it travels
   with the reference-config export.
4. **Query shape:** a natural-language `queryString` (capped at the
   API's 1,500 characters); `maximumNumberOfResults` is clamped to the
   read caps (≤25). The request body is built by a pure function and
   the response mapped by a pure function, both unit-tested; the wire
   call goes through the connector's own bearer-token `graphFetch`
   (mirrors the Power BI adapter — wire logging with the token masked,
   per-status error triage).
5. **Verification read (ADR-0009):** a minimal one-result retrieval —
   the smallest call that proves the endpoint, the delegated scopes,
   **and** the Copilot licence in a single deliberate read.
6. **No item fetch:** retrieval returns ranked passages, not
   addressable items, so `get_context_item` is explicitly unsupported
   for this type (clear guidance to use search instead).

## Consequences

- Strictly read-only: only the retrieval POST is ever issued, scoped to
  the user's delegated permissions (never more than they could see in
  Copilot itself).
- **Requires a Microsoft 365 Copilot licence** on the account and admin
  consent for the delegated scopes; a 403 names exactly that
  (licence + `Files.Read.All`/`Sites.Read.All`) instead of failing
  opaquely. Tenants without the API enabled get a clear 404 message.
- No new network host: the call shares `graph.microsoft.com` with site
  reads (already in the admin allowlist).
- The Retrieval API is recent (public preview → GA through 2025–26); the
  response mapper is deliberately defensive about field presence so
  schema evolution degrades gracefully rather than throwing. Behind the
  standard lockout/cache/caps rails like every other source.
