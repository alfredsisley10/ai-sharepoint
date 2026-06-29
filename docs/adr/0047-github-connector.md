# ADR-0047: Read-only GitHub connector (github.com + GitHub Enterprise Server)

- **Status:** Accepted (2026-06-29)
- **Context:** Enterprises keep a large share of institutional knowledge in
  GitHub — code, issues/PRs, commit history, repository metadata — across both
  github.com (SaaS) and on-prem **GitHub Enterprise Server (GHES)**. Users wanted
  to search and analyze that content from the assistant alongside SharePoint,
  Confluence, Jira, and the database sources (ADR-0008 framework). It had to fit
  the existing read-only context-source contract and **must not** disturb git
  itself — searching GitHub should never trigger the OS git credential manager
  (the source of earlier unexpected sign-in prompts).

## Decision

1. **A read-only adapter on the ADR-0008 framework** (`github.ts`). One source
   covers github.com and GHES alike; the only difference is the REST base URL,
   derived from the source's `deployment` (SaaS vs. datacenter + host). Reads pin
   the API version (`X-GitHub-Api-Version`) and the v3 JSON media type.
2. **Search spans GitHub's four corpora** — code, issues & PRs, repositories,
   commits — and item-fetch addresses one issue/PR, commit, file, or repository.
   Everything is capped (ADR-0012) and lockout-protected (ADR-0009); GitHub's
   Search API `per_page` ceiling (100) is honored under our read window.
3. **All GitHub auth methods, in the keychain, not git.** Credentials are stored
   in the OS keychain like every other reference source (`githubAuth.ts`), so
   GitHub reads **never touch the git credential manager**. Supported:
   - **Personal Access Token** (classic / fine-grained) — Bearer;
   - **OAuth** (device or app flow) for interactive sign-in;
   - **GitHub App** installation tokens (minted from the app id + private key +
     installation id) for org-scoped, least-privilege automation.
   Read scopes only; verify-on-connect (ADR-0009) does one deliberate read.
4. **Same model exposure as other sources.** It participates in `search_context`
   / `get_context_item`, carries an alias + description (ADR-0023), and travels
   with reference-config export/import.

## Consequences

- GitHub becomes a first-class, strictly read-only reference source for chat and
  agent tools, on SaaS and air-gapped GHES alike.
- Keeping GitHub credentials in the keychain (never in git config) means
  enterprise content search cannot perturb the user's git push/pull auth.
- Three auth methods cover the spectrum from a single developer (PAT) to
  org-governed automation (GitHub App); each requests read-only access.
