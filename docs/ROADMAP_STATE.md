# Roadmap build state — Tracks A & B

> **Purpose: restartability.** This file is the single source of truth for in-flight roadmap
> work. Every increment lands as its own pushed commit and flips a checkbox here **in the same
> commit**. If a session ends mid-track (token/time limits), the next session reads this file,
> finds the first unchecked box, and continues. Keep it honest: never check a box for code that
> isn't compiled, tested, and pushed.

- Branch: `claude/hopeful-goldberg-jknx3v` · Baseline: v0.1.1 (all green)
- Conventions: each increment = compile + tests + `scan:secrets` + commit + push.
- Design references: PLAN §7 (sync), §9 (context sources), ADR-0004/0005 (gates/revert),
  ADR-0009/0010/0011/0012/0014/0015 (context framework), **ADR-0019 (Git sync controls — new)**.

## Track B — Sync core (Git-backed site code)

- [x] **B1. Serializer (pure).** `src/sync/serializer.ts` + `snapshotSanitize.ts`:
      deterministic site snapshot → file map (`.aisharepoint/site.json`, `lists/*.json`,
      `pages/*.json`). Stable key order, sorted collections, volatile fields stripped
      (etags/odata/timestamps/actors), safe slug filenames with collision hashes. Unit tests
      prove byte-identical re-serialization (the PLAN §7 "no diff" invariant).
- [x] **B2. Change report + repo guards (pure).** `src/sync/changeReport.ts` (added/updated/
      removed/unchanged vs on-disk tree), `src/sync/remotePolicy.ts` (remote-host allowlist
      validation for github.com/GHES, https+ssh forms), size guards (warn 50 MB / block 100 MB),
      content secret-scan reusing `scanForLeaks`. Tests.
- [x] **B3. Graph page-content read.** Extend `SharePointClient` with
      `getPageContent(siteId, pageId)` (`?$expand=canvasLayout`) and `getListColumns(siteId,
      listId)` for the serializer. Tolerates tenants that block the Pages API.
- [ ] **B4. Git layer + engine + commands (vscode).** `src/sync/vscodeGit.ts` (duck-typed VS
      Code Git-extension API: init/open/add/commit/push/addRemote), `src/sync/syncEngine.ts`
      (pull → preview → apply → commit pipeline; dry-run; freshness note), sync config per
      connection (repo folder, remote URL, branch, review gate per ADR-0004). Commands:
      `sync.configureRepo`, `sync.pullSite` (preview-first), `sync.pushRemote` (PR-gate aware →
      opens compare URL on github.com or GHES). Managed-role guard (reference = refused).
      Settings: `aiSharePoint.sync.allowedRemoteHosts` (machine), `sync.defaultReviewGate`.
      Sites-view context menu entries. Generated repo hygiene: `.gitattributes` (LF),
      `.gitignore`, README stub in the site repo.
- [ ] **B5. Docs.** USER_GUIDE sync section (incl. local-Git best practices + PR-gate flow),
      ADMIN_GUIDE (GHES allowlist, branch-protection guidance), CHANGELOG.
- Deferred (next sessions): navigation/theme serialization; delta-query change detection;
  3-way merge + merge editor (Phase 3); revert-to-commit (ADR-0005); push-to-SharePoint writes
  (Phase 4/5 — requires PnPjs decision); PnPjs provisioning engine.

## Track A — Context-source framework + first adapters

- [ ] **A1. Framework core (pure).** `src/context/types.ts` (source/bookmark/result shapes),
      `src/context/authFailures.ts` (ADR-0009 lockout-safe tracker: never auto-retry a bad
      secret, circuit-break at 3 consecutive failures, network≠auth), `src/context/cache.ts`
      (ADR-0011 TTL read-through, default 15 min, invalidate), caps policy (ADR-0012: max
      results/bytes/timeout). Unit tests for all three.
- [ ] **A2. Stores + credentials (vscode).** `src/context/sourcesStore.ts` (non-secret
      descriptors incl. chosen auth method per ADR-0015, globalState, events; credential wipe
      on remove). Credential JSON in keychain under `context:<id>:credential`.
- [ ] **A3. Adapters: Confluence + Jira (Cloud & Data Center).** `src/context/http.ts` (shared
      fetch wrapper: timeout, result caps, status→ErrorCode), `adapters/confluence.ts`
      (verify, CQL/text search, get page w/ HTML-stripped excerpt, list spaces),
      `adapters/jira.ts` (verify via /myself, JQL/text search, get issue). Basic (user+token/
      password) + PAT Bearer per ADR-0014. Tests with stubbed fetch.
- [ ] **A4. Reference Sources view + commands (vscode).** `aiSharePoint.sourcesView` in the
      container; add/test/remove source commands (verify-on-connect, single attempt —
      lockout-safe; failures recorded through the ADR-0009 tracker). Welcome content.
      Settings: `context.cacheTtlMinutes`, `context.maxResults`.
- [ ] **A5. Agent tools.** `aisharepoint_list_sources`, `aisharepoint_search_context`,
      `aisharepoint_get_context_item` — read-only, cached, cap-enforced, stored-credential only.
      package.json `languageModelTools` entries.
- [ ] **A6. Docs.** USER_GUIDE sources section, ADMIN_GUIDE endpoints (Atlassian hosts),
      CHANGELOG; reference-SharePoint-as-source note (reuses existing reference connections).
- Deferred: bookmarks UI + bookmark tool (store shape ships in A1); automatic auth-method
  probing (ADR-0015 — manual method choice + single verify ships now); remaining §9.2 adapter
  matrix (Splunk, Intune, Databricks, SQL Server, …); workspace scoping (Pillar 7).

## Wrap-up

- [ ] **W1.** Version 0.2.0, CHANGELOG consolidation, VSIX rebuild + CI green, state file final
      pass, deliver VSIX.

## Resume notes (update each session)

- 2026-06-11: File created; ADR-0019 authored alongside.
- 2026-06-11: B1–B3 done (serializer + gates + Graph reads; 12 sync tests, 74 total).
