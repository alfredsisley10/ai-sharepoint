# ADR-0042: Confluence local content cache

- **Status:** Accepted (2026-06-16)
- **Context:** Cleanup and design initiatives analyze the same space/subtree
  repeatedly (consistency, accuracy, branding, usability passes). Re-fetching
  every page each pass is slow. We also need a baseline to detect that a page
  **changed underneath us** before deploying a change. One cache serves both.

## Decision

A reusable `confluenceCache.ts` construct:

1. **`ConfluencePageCacheEntry`** — the essential content per page: `id`,
   `title`, **`version`**, stripped `bodyText`, `labels`, `parentId`,
   `spaceKey`, `webUrl`, `cachedAt`. Built from a single expanded read
   (`CACHE_EXPAND` = body.storage + version + space + ancestors +
   metadata.labels) by the pure `buildCacheEntry`.
2. **`ConfluenceContentCache`** — in-memory map for one source with
   `put/get/list/bySpace/size`, **persistence-agnostic** `serialize()` +
   constructor `load` (the caller persists the array to globalState/storage),
   and **`stale(liveVersions)`** → the cached pages whose live version differs
   (the drift check: "don't deploy onto a page that changed underneath us").
3. **`cacheConfluenceScope(scope)`** — snapshot a space / subtree / page into
   the cache (bounded), reusing the `AuthorityScope` shape.

## Consequences

- **Fast repeated analytics:** a space/subtree is snapshotted once, then every
  review pass reads from the cache. Also the substrate for the **"review all
  content for consistency / accuracy / branding / usability and summarize
  proposed changes per owner"** flow — the assistant reviews cached pages and
  groups proposals by owner (ADR-0039) for the page's owner.
- **Drift safety:** because each entry keeps the page version, `stale()` against
  current live versions is the explicit pre-deploy check (complements the
  version-bump optimistic concurrency in the write path, ADR-0038).
- Persistence-agnostic by design (testable as pure in-memory + serialize); the
  thin globalState/storage wiring and a freshness/TTL policy are integration
  concerns the caller owns.
- **Next (staged):** wire persistence + a "cache this space" and "review &
  propose per owner" tool into the chat surface.
