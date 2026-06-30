# ADR-0026: Vertex AI Search connector (Google enterprise search, SSO)

- **Status:** **Reverted** (2026-06-30) — the Vertex AI Search connector was removed in 0.99.0.
  In practice pilots could not get it working: the Google auth/setup paths (gcloud SSO, pasted
  OAuth token, project/engine discovery) were too fragile for normal end users — especially
  under Entra/Azure AD federation, where accounts often hold no GCP project role at all. The
  `vertexai` source type, the `vertexSearch` adapter, the `vertex_answer` tool, and the
  `gcloud-sso` auth method were deleted. The record below is retained for history; this ADR
  returns to consideration only if a reliable end-user auth path emerges.
- **Context:** Pilots run an enterprise Gemini-grounded search portal on
  Vertex AI Search (vertexaisearch.cloud.google.com app; Discovery
  Engine API underneath) reached via Google SSO, and want the assistant
  to use it for searches and analysis.

## Decision

1. **A reference source type `vertexai`** in the PLAN §9 framework —
   same lockout breaker, TTL cache, caps, alias/description, and
   read-only posture as every other source. The descriptor stores the
   app's **serving-config resource URL**
   (`…/v1/projects/P/locations/L/collections/C/engines/E/servingConfigs/S`),
   built field-by-field in the wizard (project → location → app ID →
   endpoint, regional endpoints supported) or pasted whole.
2. **SSO without storing Google secrets:** the default sign-in mode is
   **`gcloud-sso`** — every call asks the workstation's gcloud CLI for a
   live access token (`gcloud auth print-access-token`), riding the
   corporate Google SSO session established by `gcloud auth login`.
   Nothing is persisted (the keychain entry is a marker); token expiry
   self-heals. Fallback: a pasted OAuth access token (`pat`, keychain,
   ~1 h lifetime — the 401 advice says so). A dedicated OAuth client
   (loopback PKCE against accounts.google.com) is deferred until an org
   provisions a client ID.
3. **Two read surfaces:**
   - `:search` → ranked enterprise hits (title/link/snippet, HTML
     stripped, result-capped) through the standard search tool;
   - `:answer` → **Gemini-grounded answer with deduped citations** via
     the new `vertex_answer` tool — the "analysis" surface, used for
     synthesis questions while search stays for raw lists.
4. **No write path, no item fetch** (the corpus is reachable through
   the cited links); adversarial-query protection is enabled on
   `:answer`.

## Consequences

- Works on any workstation that already uses gcloud — zero extra
  credentials to manage; environments without the CLI still work via
  pasted tokens.
- Vertex AI Search bills per query on the Google side; the existing
  read caps (`context.maxResults`, TTL cache) bound the call volume.
- The Discovery Engine schema tolerates both structured and website
  app shapes (derivedStructData with snippets/extractive answers).
