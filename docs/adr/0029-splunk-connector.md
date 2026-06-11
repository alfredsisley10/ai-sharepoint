# ADR-0029: Splunk connector (read-only SPL, oneshot)

- **Status:** Accepted (2026-06-11)
- **Context:** Splunk leads the deferred observability adapters (§9.2).

## Decision

1. **Source type `splunk`** against the management REST API (`:8089` —
   the wizard says so explicitly; Splunk Web on 8000 is a different
   port). Auth: **authentication token** (recommended) or Basic, via the
   standard keychain/lockout/caps machinery; the search POST has its own
   wire-logged client (form-encoded; fetchJson is GET-only).
2. **Oneshot execution** (`exec_mode=oneshot`): synchronous results,
   no job lifecycle to leak, `count` server-caps rows. Every search is
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
- Real-time searches, exports, and the job API are out of scope; the
  oneshot cap means very large result sets must be aggregated in SPL
  (which is the right pattern anyway).
