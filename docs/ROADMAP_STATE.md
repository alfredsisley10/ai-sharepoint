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
- [x] **B4. Git layer + engine + commands (vscode).** `src/sync/vscodeGit.ts` (duck-typed VS
      Code Git-extension API: init/open/add/commit/push/addRemote), `src/sync/syncEngine.ts`
      (pull → preview → apply → commit pipeline; dry-run; freshness note), sync config per
      connection (repo folder, remote URL, branch, review gate per ADR-0004). Commands:
      `sync.configureRepo`, `sync.pullSite` (preview-first), `sync.pushRemote` (PR-gate aware →
      opens compare URL on github.com or GHES). Managed-role guard (reference = refused).
      Settings: `aiSharePoint.sync.allowedRemoteHosts` (machine). (defaultReviewGate setting dropped — the gate is chosen per repo in the wizard, PR-first.)
      Sites-view context menu entries. Generated repo hygiene: `.gitattributes` (LF),
      `.gitignore`, README stub in the site repo.
- [x] **B5. Docs.** USER_GUIDE sync section (incl. local-Git best practices + PR-gate flow),
      ADMIN_GUIDE (GHES allowlist, branch-protection guidance), CHANGELOG.
- Deferred (next sessions): navigation/theme serialization; delta-query change detection;
  3-way merge + merge editor (Phase 3); revert-to-commit (ADR-0005); push-to-SharePoint writes
  (Phase 4/5 — requires PnPjs decision); PnPjs provisioning engine.

## Track A — Context-source framework + first adapters

- [x] **A1. Framework core (pure).** `src/context/types.ts` (source/bookmark/result shapes),
      `src/context/authFailures.ts` (ADR-0009 lockout-safe tracker: never auto-retry a bad
      secret, circuit-break at 3 consecutive failures, network≠auth), `src/context/cache.ts`
      (ADR-0011 TTL read-through, default 15 min, invalidate), caps policy (ADR-0012: max
      results/bytes/timeout). Unit tests for all three.
- [x] **A2. Stores + credentials (vscode).** `src/context/sourcesStore.ts` (non-secret
      descriptors incl. chosen auth method per ADR-0015, globalState, events; credential wipe
      on remove). Credential JSON in keychain under `context:<id>:credential`.
- [x] **A3. Adapters: Confluence + Jira (Cloud & Data Center).** `src/context/http.ts` (shared
      fetch wrapper: timeout, result caps, status→ErrorCode), `adapters/confluence.ts`
      (verify, CQL/text search, get page w/ HTML-stripped excerpt, list spaces),
      `adapters/jira.ts` (verify via /myself, JQL/text search, get issue). Basic (user+token/
      password) + PAT Bearer per ADR-0014. Tests with stubbed fetch.
- [x] **A4. Reference Sources view + commands (vscode).** `aiSharePoint.sourcesView` in the
      container; add/test/remove source commands (verify-on-connect, single attempt —
      lockout-safe; failures recorded through the ADR-0009 tracker). Welcome content.
      Settings: `context.cacheTtlMinutes`, `context.maxResults`.
- [x] **A5. Agent tools.** `aisharepoint_list_sources`, `aisharepoint_search_context`,
      `aisharepoint_get_context_item` — read-only, cached, cap-enforced, stored-credential only.
      package.json `languageModelTools` entries.
- [x] **A6. Docs.** USER_GUIDE sources section, ADMIN_GUIDE endpoints (Atlassian hosts),
      CHANGELOG; reference-SharePoint-as-source note (reuses existing reference connections).
- Deferred: bookmarks UI + bookmark tool (store shape ships in A1); automatic auth-method
  probing (ADR-0015 — manual method choice + single verify ships now); remaining §9.2 adapter
  matrix (Splunk, Intune, Databricks, SQL Server, …); workspace scoping (Pillar 7).

## Track C — LDAP / Active Directory connector (read-only) — ADR-0020

- [x] **C1. DNS auto-discovery (pure).** `src/context/ldap/discovery.ts`: workstation domain
      signals (USERDNSDOMAIN/LOGONSERVER/FQDN/resolv.conf), SRV lookups
      (`_ldap._tcp.dc._msdcs`, `_gc._tcp`) via injectable resolver, priority/weight ranking,
      domain→baseDN, candidate endpoints (DC 389/636, GC 3268/3269). Unit tests.
- [x] **C2. LDAP adapter (ldapts).** `src/context/ldap/ldapClient.ts`: verify (simple bind,
      classify invalidCredentials→auth.failed for ADR-0009), search (ANR for free text, raw
      filter passthrough, sizeLimit/timeLimit caps, curated attrs), getEntry by DN; pure
      entry→hit/item mappers unit-tested. TLS/StartTLS options.
- [x] **C3. Framework integration.** ContextService dispatch for `type==="ldap"`; sourcesStore
      `baseDn` field; add-source flow runs discovery; credential prompt (UPN+password); view
      icon; settings (`ldap.tlsRejectUnauthorized`, `ldap.useStartTls`); "Discover AD" surfaced.
- [x] **C4. Docs.** USER_GUIDE LDAP section, ADMIN_GUIDE (SRV records, ports, TLS/internal-CA,
      lockout), CHANGELOG.

## Track D — Remaining scheduled features (enterprise test candidate)

- [x] **D1. Bookmarks (ADR-0010).** Bookmark store (shape already in context/types), add/remove
      from search results, list, and a `#spBookmarks` / resolve-by-name path in context tools.
- [~] **D2. Sync nav + theme serialization.** DEFERRED with rationale: SharePoint navigation
      and theme are not in Graph v1.0 — they require SharePoint REST (`_api/navigation/MenuState`,
      theming endpoints) with a **different token audience** (SP resource, not Graph) that
      cannot be validated in this headless environment and is version-dependent (theme
      especially). Deferred to a dedicated, live-tenant effort rather than shipping untested
      token-acquisition surface into a test candidate. Serializer remains ready to accept
      `navigation.json`/`theme.json` when the read path lands.
- Deferred to dedicated efforts (NOT crammed into this candidate — large/multi-phase, high risk):
  SharePoint write-back via PnPjs (Phase 4/5), 3-way merge + revert (Phase 3), local MCP server
  (engine bump), automatic auth-method probing, remaining §9.2 adapters, workspace scoping.

## Track E — SharePoint write-back slice 1 (ADR-0021)

- [x] **E1. Desired state + push plan (pure).** `src/sync/desiredState.ts` (repo files →
      artifacts, tolerant parse w/ warnings), `src/sync/pushPlan.ts` (artifact-level diff →
      ordered ops: createList/updateList/addColumn/updateColumn/createPage/updatePage;
      deletions separated + opt-in; system lists protected; lookup/calculated columns →
      warnings; markdown preview render). Unit tests.
- [x] **E2. Graph write client + push engine.** `src/auth/sharePointWriteClient.ts`
      (Sites.ReadWrite.All + Sites.Manage.All, POST/PATCH/DELETE w/ timeout+429 retry,
      createList/updateList/createColumn/updateColumn/createPage/updatePage/publishPage/
      deleteList/deletePage), `src/sync/pushEngine.ts` (freshness gate vs plan base → safety
      snapshot via pull+commit → sequential apply stop-on-error → re-pull+commit → summary).
- [x] **E3. Command + UX.** `aiSharePoint.applyRepoToSharePoint`: managed+repo guards, preview
      doc, modal confirm, separate deletions opt-in, progress with per-op messages, partial-
      failure report; manifest (command/menus/palette); chat INSTRUCTIONS updated (write-back
      exists via explicit command; chat/tools stay read-only).
- [x] **E4. Docs + 0.4.0.** USER_GUIDE write-back section, ADMIN_GUIDE consent (Sites.Manage.All)
      + custom-app permissions, CHANGELOG, version bump, VSIX, CI green.

## Track F — Revert-to-commit (ADR-0005 core) — DONE

- [x] **F1.** `aiSharePoint.revertSiteToCommit`: pick from repo history (git API log), file
      inventory read from the committed manifest via show(ref, path), then the shared
      write-back pipeline (preview, deletions opt-in, freshness gate, safety snapshot =
      "undo the undo", reconcile). Write-back flow extracted to one pipeline used by both
      Apply Repository and Revert (writeBackPreflight + runWriteBackFlow).

## Track G — Reference-config sharing (ADR-0013 slice) — DONE

- [x] **G1.** Secret-free export/import of sources + bookmarks: explicit field allowlist
      (no ids/accounts/credentials — no keychain code path by construction), leak-scan before
      write, preview + confirm, JSON schema-validated import with id regeneration, bookmark
      remap by source name, name-collision skip, re-verify-with-own-credentials guidance.
      5 unit tests incl. forbidden-key and leak-scan assertions.

## Wrap-up

- [x] **W1.** Version 0.2.0, CHANGELOG consolidation, VSIX rebuild + CI green, state file final
      pass, deliver VSIX.
- [x] **W2.** Version 0.3.0 (LDAP + bookmarks + nav/theme), CHANGELOG, VSIX, CI green, deliver.

## Final deferral register (the only remaining planned items — all require what this
## environment cannot provide, or a deliberate product gate)

| Item | Why deferred |
|---|---|
| Navigation/theme serialization (D2) | SharePoint REST, different token audience, version-dependent — needs live tenant |
| 3-way merge editor (Phase 3 remainder) | Needs base-snapshot tracking + merge UX; current preview-gated pull + Git history covers the pilot |
| Agent-initiated mutations (§8 full) | Deliberate product gate: human-approved commands first; agent drafts, human applies |
| Remaining §9.2 adapters (Splunk, Intune, Databricks, Aternity, SignalFx, AppDynamics, Grafana, Azure/O365 consoles, ServiceNow, Workday; Oracle excluded per ADR-0022) | Each needs live-instance validation; framework seam proven by 8 adapters |
| Multi-workspace switcher (Pillar 7 remainder) | Sharing slice shipped (ADR-0013); switching is UX-heavy, low pilot demand |
| Local MCP server (ADR-0017 surface 2) | Needs engine floor bump (1.101+) and a child-process secret-handling design; VS Code Copilot already served by LM tools |
| Auto auth-method probing (ADR-0015 full) | Manual method choice + single lockout-safe verify ships; probing is an optimization |

## Resume notes (update each session)

- 2026-06-11: File created; ADR-0019 authored alongside.
- 2026-06-11: B1–B3 done (serializer + gates + Graph reads; 12 sync tests, 74 total).
- 2026-06-11: B4 done (git layer via VS Code Git API, engine, configure/pull/push commands, allowlist setting, menus). B5 docs pending.
- 2026-06-11: A1+A3 done (lockout tracker, TTL cache, http wrapper, Confluence+Jira adapters; 86 tests). A2/A4/A5 next.
- 2026-06-11: A2+A4+A5 done (sources store + keychain creds, Reference Sources view, add/test/remove/reset-lockout/clear-cache commands, 3 context LM tools). Docs (A6+B5) + W1 remain.
- 2026-06-11: B5+A6+W1 done — docs updated (user/admin guides, changelog), v0.2.0 packaged. **All planned increments for this session complete.** Next session: see the Deferred lists above (Phase 3 merge/revert, write-back, more adapters, bookmarks UI).
- 2026-06-11: Track C done — LDAP/AD connector with DNS SRV auto-discovery (ldapts, pure-JS), framework dispatch, discovery + add/test flow, 19 LDAP tests (101 total). Track D (bookmarks, nav/theme) next.
- 2026-06-11: D1 done (bookmarks ADR-0010: store, two-level Reference Sources tree, add/run/remove, #spBookmarks/#spRunBookmark tools, 5 pure tests, 106 total). D2 deferred (SP-REST/different-audience, untestable here). Wrapping 0.3.0.
- 2026-06-11: Tracks E (write-back), F (revert), G (config sharing) done; 0.4.0 wrapped. **Every completable planned feature has shipped**; see the deferral register above.
- 2026-06-11: 0.4.1 — LDAP pilot fixes: durable SRV locators (ldaps+srv://, per-connection re-resolution, network-only failover) + OS trust store for LDAPS (system-CA API, Linux bundles, NODE_EXTRA_CA_CERTS, pinned caCertificatesFile setting). ADR-0020 amended. 142 tests.
- 2026-06-11: 0.5.0 — bookmark discoverability (guided Browse & Bookmark: JSM queues/filters/projects/spaces, search-then-bookmark, inline button) + #spSuggestBookmark agent tool with confirmation-gated persistence. 146 tests.
- 2026-06-11: 0.5.0 (cont.) — @sharepoint participant gained a real tool-calling loop (was agent-mode-only): reference-source search/aggregation + in-chat bookmark confirmations now work from the participant. 146 tests.
- 2026-06-11: 0.6.0 — database wave shipped (mssql/postgres/mysql/mongodb, ADR-0022: layered read-only guard, browse-to-bookmark, OS-trust TLS) + self-service GHES allowlisting fix. 154 tests.
- 2026-06-11: 0.6.1 — git init hardening (trust guard, post-init retry discovery, .git-exists remediation, add-to-workspace offer in the wizard).
- 2026-06-11: 0.6.2 — MSSQL SSMS parity (dual auth incl. NTLM, named instances, trustServerCertificate opt-in, ELOGIN triage) + ignoreFocusOut across all wizards. 160 tests.
- 2026-06-11: 0.6.3 — MSSQL alternate-port support verified + test-locked; port/instance mutual exclusivity enforced at entry. 162 tests.
- 2026-06-11: 0.6.4 — SSMS server-name form accepted verbatim (server\\INSTANCE,port), SqlClient port-over-instance precedence (0.6.3 hard error reverted as wrong vs real DBA strings). 165 tests.
- 2026-06-11: 0.6.5 — MSSQL field-by-field wizard (FQDN→instance→port→database→cert→auth→user→pwd, built URL live-verified; TDS errorMessage detail on rejections) + Support fixes: right-click Delete Error Reports, Output-panel-first openLogs (vscode#40690), deterministic walkthrough deep link (vscode#187958 double-issue). 166 tests.
- 2026-06-11: 0.7.0 (part 1) — source aliases & descriptions (ADR-0023): unique chat alias ("CMDB") + description on ContextSource; shared pure resolver (sourceRef.ts: id→alias→name→type→alias-in-phrase→substring); surfaced in list_sources, tool input schemas, participant context, view, export/import (collision-dropping). Edit Alias & Description command. 174 tests.
- 2026-06-11: 0.7.0 (part 2) — DB schema preload + AI semantic index DONE (ADR-0024): schemaIndex.ts (catalog/prompt/parse/search, pure, 10 tests), describeDb introspection, SchemaStore (globalStorage JSON), SchemaIndexer (consent modal, batched metered copilot.ask, partial-tolerant), db_schema + index_db_schema tools (confirmation-gated), 3 commands + db context menus, allowSchemaIndexing policy setting, participant schema notes. PLUS pilot fixes: usage views explain included 0× models (gauge note, per-model multiplier badges, dashboard banner); Jira browse X-ExperimentalApi header + denial diagnostics (empty no longer silent); bookmark editing (editBookmark command + inline pencil, pre-save SQL tailoring in browse, DB locator validation). 184 tests.
- 2026-06-11: 0.7.0 (part 3) — Confluence/Jira catalog pre-cache DONE: catalogCache (pure TTL/age), CatalogStore (disk), paged full fetchers (listAllConfluenceSpaces 50/page, listAllJiraProjects cloud-paged/DC-single, listAllJsmQueues ≤50 desks) with awaited continue?-checkpoints between requests (pause = throttle), first-browse offer (pre-cache vs capped live), expired → refresh/stale/live choice, precacheSourceCatalog command + atlassian context menu, catalogTtlHours + catalogCheckpointSeconds settings, tooltip Catalog row. 187 tests.
- 2026-06-11: 0.7.0 (part 4) — Communication Channels DONE (ADR-0025): outbox model (pure ops + Memento store), CommsClient (Graph: resolveRecipient/sendTeamsMessage oneOnOne|group/createMailDraft/sendMailDraft; send scopes only here), Communications view with approval badge, draft/edit/discard/review commands (preview doc + recipient-naming modal; outlook "Save to Outlook Drafts" path), agent draft_communication tool (confirmation-gated, prepare-only), ≤10 recipients, directory-resolved at send. 191 tests.
- QUEUED (user, this session): Vertex AI Search connector (vertexaisearch.cloud.google, enterprise Gemini, SSO) for search/analysis.
