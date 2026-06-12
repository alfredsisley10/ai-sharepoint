# ADR-0029: Splunk connector (read-only SPL)

- **Status:** Accepted (2026-06-11); amended 2026-06-12 (job-mode execution)
- **Context:** Splunk leads the deferred observability adapters (§9.2).

## Decision

1. **Source type `splunk`** against the management REST API (`:8089` —
   the wizard says so explicitly; Splunk Web on 8000 is a different
   port). Auth: **authentication token** (recommended) or Basic, via the
   standard keychain/lockout/caps machinery; the search POST has its own
   wire-logged client (form-encoded; fetchJson is GET-only).
2. **Job-mode execution** (`exec_mode=normal` + poll + fetch + delete),
   amending the original oneshot decision. At Splunk's concurrent-search
   cap a oneshot dispatch is rejected outright (503), while async jobs
   are accepted and **queued** for a free slot — exactly what Splunk Web
   does. The pilot's metered Splunk Cloud stack runs at its cap, so
   oneshot meant every connector search failed while the same user's
   browser searched fine. The lifecycle is bounded and leak-proof: one
   time budget covers dispatch + queue + run, the job is **always
   deleted** (success, failure, or timeout), and `auto_cancel` is set at
   dispatch so a dying client can't strand a job holding a concurrency
   slot. `max_count` server-caps rows. Every search remains
   **time-bounded** — default `earliest=-24h` unless the query/spec says
   otherwise — so a casual question can never become an all-time scan.
3. **Read-only barrier**: SPL has no read-only session, so a fail-closed
   blocklist rejects write/exfil/exec commands anywhere in the text —
   `delete, collect, mcollect, meventcollect, tscollect, outputlookup,
   outputcsv, sendemail, sendalert, script, runshellscript, dump` —
   which also covers `map`/subsearch bodies (the whole string is
   scanned). Reads like `inputlookup`, `stats`, `tstats`, `savedsearch`
   pass.
4. **Three query shapes**: plain keywords (default `?index=`, last 24 h),
   raw SPL (`search …`, `| tstats …`, `index=…`), or JSON
   `{"spl","earliest","latest","limit"}`. Raw events map with
   host/source/sourcetype/index/time meta; transforming results render
   as field rows. Optional `?web=` enables Splunk Web deep links.
5. **Browse & Bookmark**: the user's saved searches
   (`| savedsearch "…"`) plus non-internal indexes — each listing
   best-effort so a permission gap on one never empties the other.

## Consequences

- Works on Splunk Enterprise and Splunk Cloud (management endpoint);
  role-based access (srchIndexesAllowed etc.) is enforced server-side.
- Real-time searches and exports are out of scope; the result cap means
  very large result sets must be aggregated in SPL (which is the right
  pattern anyway).
- A search that stays queued past the time budget reports the
  concurrency cap explicitly (and cancels the job) instead of a generic
  failure — the cap is visible, never silently fatal.
