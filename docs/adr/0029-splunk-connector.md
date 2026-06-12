# ADR-0029: Splunk connector (read-only SPL, queued jobs)

- **Status:** Accepted (2026-06-11); amended 2026-06-12 (oneshot → queued jobs)
- **Context:** Splunk leads the deferred observability adapters (§9.2).

## Decision

1. **Source type `splunk`** against the management REST API (`:8089` —
   the wizard says so explicitly; Splunk Web on 8000 is a different
   port). Auth: **authentication token** (recommended) or Basic, via the
   standard keychain/lockout/caps machinery; the search POST has its own
   wire-logged client (form-encoded; fetchJson is GET-only).
2. **Queued job execution** (`exec_mode=normal`; amended 2026-06-12 —
   originally oneshot). At the concurrent-search limit splunkd REFUSES
   oneshot dispatches outright (HTTP 503 "The maximum number of
   concurrent historical searches … has been reached"), while normal
   asynchronous jobs QUEUE for a slot — which is what Splunk Web always
   dispatches, and why a user's browser searches keep working on a busy
   line-of-business stack where every oneshot fails. The connector now
   dispatches a normal job (`auto_cancel=60` as a crash net, capacity
   refusals retried briefly), polls until DONE within a bounded wait
   (default 90 s; per-query `{"wait": seconds}` up to 600), fetches
   results, and **always deletes the job** — a timed-out or abandoned
   search is cancelled rather than piled onto the user's quota.
   `max_count`/results `count` server-cap rows, and every search remains
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
- Real-time searches and exports are out of scope; the job lifecycle is
  internal (dispatch → poll → results → delete) and the row caps mean
  very large result sets must be aggregated in SPL (which is the right
  pattern anyway).
- Hitting the concurrency cap now behaves like the browser: the search
  waits in Splunk's queue (up to the wait budget) instead of failing;
  if no slot frees, the error names the cap, the wait, and the
  `{"wait": …}` escape hatch — and the queued job is cancelled.
