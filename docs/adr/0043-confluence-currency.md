# ADR-0043: Confluence page currency review

- **Status:** Accepted (2026-06-16)
- **Context:** A page can be "stale" in ways content review alone misses: its
  **links rot**, and its **owner tag** can point at people who have left. A
  reusable currency check surfaces these so cleanup can target them.

## Decision

`confluenceCurrency.ts` reviews a page's currency (read-only):
1. **Links** — `extractLinks` pulls the page's distinct outbound hrefs;
   `checkLinks` verifies absolute http(s) links are live (HEAD, falling back to
   GET on 405/501), bounded concurrency + per-link timeout. Relative links are
   reported as unchecked (resolving them needs page context).
2. **Owner tags** — parse the owner label (ADR-0039) and verify each
   sAMAccountName is still **active** via the injected `UserDirectory`
   (ADR-0041); inactive owners and a missing owner label are flagged.
3. **Staleness** — days since `version.when` (last update).

`reviewPageCurrency` returns a `CurrencyReport` (broken links, working count,
owners + which are inactive, last-updated/staleDays, and a rolled-up `issues`
list) for the assistant to turn into cleanup proposals.

## Consequences

- Catches rot that content review misses, and ties back to ownership: an
  inactive owner is both a currency issue *and* a trigger to re-derive ownership
  (most prolific active contributor).
- **Link checking makes outbound requests to the linked URLs** — a deliberate,
  read-only liveness probe (HEAD), bounded in count/concurrency/timeout. Worth
  noting for egress-restricted environments (links to blocked hosts will read as
  broken; that's a false-positive to keep in mind).
- Composes with the cache (ADR-0042): run currency over cached pages during a
  space sweep, grouping the proposals by owner.
- **Next (staged):** a chat tool exposing the currency review (per page or
  across a space), feeding the notify-and-cleanup flow.
