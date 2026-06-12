import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  canAttempt,
  recordAuthFailure,
  recordSuccess,
  MAX_CONSECUTIVE_FAILURES,
  FailureState,
} from "../src/context/authFailures";
import { TtlCache } from "../src/context/cache";
import { authHeader, htmlToText, fetchJson } from "../src/context/http";
import {
  searchConfluence,
  listConfluenceSpaces,
  listAllConfluenceSpaces,
} from "../src/context/adapters/confluence";
import {
  searchJira,
  listJiraFavouriteFilters,
  listJsmQueues,
  listAllJiraProjects,
} from "../src/context/adapters/jira";
import { buildCatalog, isExpired, catalogAge } from "../src/context/catalogCache";
import { ContextSource, DEFAULT_CAPS } from "../src/context/types";

const T0 = "2026-06-11T12:00:00.000Z";
const KEY = "ctx:abc";

// --- ADR-0009 lockout safety -------------------------------------------------

test("fresh credential keys may always attempt", () => {
  assert.deepEqual(canAttempt({}, KEY, T0), { allowed: true });
});

test("a failed credential is never auto-retried — fresh secret required", () => {
  const s = recordAuthFailure({}, KEY, T0);
  const verdict = canAttempt(s, KEY, "2026-06-11T13:00:00.000Z");
  assert.equal(verdict.allowed, false);
  assert.equal((verdict as { reason: string }).reason, "credential-bad");
  // fresh secret unblocks
  assert.equal(canAttempt(s, KEY, T0, true).allowed, true);
});

test("circuit opens at the hard stop and ignores even fresh secrets", () => {
  let s: FailureState = {};
  for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) {
    s = recordAuthFailure(s, KEY, T0);
  }
  assert.equal(canAttempt(s, KEY, T0, true).allowed, false);
  assert.equal(
    (canAttempt(s, KEY, T0, true) as { reason: string }).reason,
    "circuit-open",
  );
});

test("success clears state entirely", () => {
  let s = recordAuthFailure({}, KEY, T0);
  s = recordSuccess(s, KEY);
  assert.deepEqual(canAttempt(s, KEY, T0), { allowed: true });
});

// --- ADR-0011 cache -----------------------------------------------------------

test("ttl cache: hit before expiry, miss after, read-through loads once", async () => {
  let nowMs = 0;
  const cache = new TtlCache(() => nowMs);
  let loads = 0;
  const load = async () => {
    loads++;
    return { v: loads };
  };
  const key = TtlCache.key("s1", "search", "q");
  assert.deepEqual(await cache.getOrLoad(key, 1000, load), { v: 1 });
  assert.deepEqual(await cache.getOrLoad(key, 1000, load), { v: 1 });
  nowMs = 1001;
  assert.deepEqual(await cache.getOrLoad(key, 1000, load), { v: 2 });
});

test("invalidateSource clears only that source's entries", () => {
  const cache = new TtlCache(() => 0);
  cache.set(TtlCache.key("s1", "search", "a"), 1, 1000);
  cache.set(TtlCache.key("s2", "search", "a"), 2, 1000);
  cache.invalidateSource("s1");
  assert.equal(cache.get(TtlCache.key("s1", "search", "a")), undefined);
  assert.equal(cache.get(TtlCache.key("s2", "search", "a")), 2);
});

// --- adapters (stubbed fetch) ---------------------------------------------------

function withFetch<T>(
  responder: (url: string, init?: RequestInit) => { status?: number; body: unknown },
  run: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const r = responder(String(url), init);
    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

const SRC: ContextSource = {
  id: "s1",
  type: "confluence",
  displayName: "Corp Wiki",
  baseUrl: "https://confluence.corp.example",
  deployment: "datacenter",
  authMethod: "pat",
  addedAt: T0,
};
const CRED = { method: "pat" as const, secret: "tok123" };

test("authHeader builds Basic and Bearer correctly", () => {
  assert.equal(authHeader(CRED), "Bearer tok123");
  assert.equal(
    authHeader({ method: "basic", username: "u@x.com", secret: "tok" }),
    `Basic ${Buffer.from("u@x.com:tok").toString("base64")}`,
  );
});

test("htmlToText strips tags/entities and caps length", () => {
  const out = htmlToText("<h1>Hi&nbsp;<b>there</b></h1><script>x()</script> &amp; more", 100);
  assert.equal(out, "Hi there & more");
  assert.ok(htmlToText(`<p>${"x".repeat(50)}</p>`, 10).length <= 11);
});

test("confluence search wraps free text in siteSearch CQL, caps results, maps links", async () => {
  let captured = "";
  const hits = await withFetch(
    (url) => {
      captured = url;
      return {
        body: {
          results: Array.from({ length: 30 }, (_, i) => ({
            content: { id: String(i), title: `Page ${i}`, _links: { webui: `/x/${i}` } },
            excerpt: "<b>match</b> text",
            space: { key: "ENG" },
          })),
        },
      };
    },
    () => searchConfluence(SRC, CRED, "release notes", DEFAULT_CAPS),
  );
  assert.match(captured, /cql=siteSearch(%20|\+|~|%7E)/i);
  assert.match(captured, /limit=25/);
  assert.equal(hits.length, DEFAULT_CAPS.maxResults);
  assert.equal(hits[0].title, "Page 0");
  assert.equal(hits[0].url, "https://confluence.corp.example/x/0");
  assert.equal(hits[0].excerpt, "match text");
});

test("confluence search passes raw CQL through untouched", async () => {
  let captured = "";
  await withFetch(
    (url) => {
      captured = url;
      return { body: { results: [] } };
    },
    () => searchConfluence(SRC, CRED, 'space = ENG and title ~ "Spec"', DEFAULT_CAPS),
  );
  assert.match(decodeURIComponent(captured), /space = ENG and title ~ "Spec"/);
});

test("jira search maps issues with status/assignee meta and browse URLs", async () => {
  const hits = await withFetch(
    () => ({
      body: {
        issues: [
          {
            key: "ENG-42",
            fields: {
              summary: "Fix login",
              status: { name: "In Progress" },
              assignee: { displayName: "Dana" },
              issuetype: { name: "Bug" },
            },
          },
        ],
      },
    }),
    () =>
      searchJira(
        { ...SRC, type: "jira", baseUrl: "https://jira.corp.example" },
        CRED,
        "login",
        DEFAULT_CAPS,
      ),
  );
  assert.equal(hits[0].title, "ENG-42: Fix login");
  assert.equal(hits[0].url, "https://jira.corp.example/browse/ENG-42");
  assert.equal(hits[0].meta?.status, "In Progress");
  assert.equal(hits[0].meta?.assignee, "Dana");
});

test("401 from a source classifies as auth.failed (feeds the lockout tracker)", async () => {
  await assert.rejects(
    withFetch(
      () => ({ status: 401, body: {} }),
      () => searchJira({ ...SRC, type: "jira" }, CRED, "x", DEFAULT_CAPS),
    ),
    /Authentication rejected/,
  );
});

test("confluence spaces map to bookmarkable candidates", async () => {
  const spaces = await withFetch(
    () => ({ body: { results: [{ key: "ENG", name: "Engineering", _links: { webui: "/spaces/ENG" } }, { name: "broken (no key)" }] } }),
    () => listConfluenceSpaces(SRC, CRED, DEFAULT_CAPS),
  );
  assert.deepEqual(spaces, [
    { key: "ENG", name: "Engineering", url: "https://confluence.corp.example/spaces/ENG" },
  ]);
});

test("jira favourite filters expose name + ready-made JQL", async () => {
  const filters = await withFetch(
    () => ({ body: [{ name: "My open bugs", jql: "assignee = currentUser() AND type = Bug" }, { name: "no jql" }] }),
    () => listJiraFavouriteFilters({ ...SRC, type: "jira" }, CRED, DEFAULT_CAPS),
  );
  assert.equal(filters.length, 1);
  assert.equal(filters[0].jql, "assignee = currentUser() AND type = Bug");
});

test("jsm queues flatten desks->queues with their JQL; non-JSM instances yield none + note", async () => {
  const result = await withFetch(
    (url) =>
      url.includes("/servicedesk?")
        ? { body: { values: [{ id: "1", projectName: "IT Help" }] } }
        : { body: { values: [{ name: "Unassigned", jql: "project = ITH AND assignee is EMPTY" }] } },
    () => listJsmQueues({ ...SRC, type: "jira" }, CRED, DEFAULT_CAPS),
  );
  assert.deepEqual(result.queues, [
    { desk: "IT Help", name: "Unassigned", jql: "project = ITH AND assignee is EMPTY" },
  ]);
  assert.equal(result.note, undefined);
  // Not a JSM instance (404): no queues, and the WHY is reported, not
  // swallowed (pilot: empty browse looked broken).
  const none = await withFetch(
    () => ({ status: 404, body: {} }),
    () => listJsmQueues({ ...SRC, type: "jira" }, CRED, DEFAULT_CAPS),
  );
  assert.deepEqual(none.queues, []);
  assert.match(none.note ?? "", /service-desk list unavailable/);
  // Desks visible but every queue API denied (DC without agent license /
  // pre-fix experimental-API 403s).
  const denied = await withFetch(
    (url) =>
      url.includes("/servicedesk?")
        ? { body: { values: [{ id: "1", projectName: "IT Help" }] } }
        : { status: 403, body: {} },
    () => listJsmQueues({ ...SRC, type: "jira" }, CRED, DEFAULT_CAPS),
  );
  assert.deepEqual(denied.queues, []);
  assert.match(denied.note ?? "", /denied on 1/);
});

test("jira search hits carry the issue key for item bookmarking", async () => {
  const hits = await withFetch(
    () => ({ body: { issues: [{ key: "ENG-7", fields: { summary: "X" } }] } }),
    () => searchJira({ ...SRC, type: "jira" }, CRED, "x", DEFAULT_CAPS),
  );
  assert.equal(hits[0].meta?.key, "ENG-7");
});

// --- catalog pre-cache (pilot): paging, checkpoints, expiry -------------------

test("listAllConfluenceSpaces pages until a short page; checkpoint stop keeps a partial", async () => {
  const page = (start: number, n: number) => ({
    body: {
      results: Array.from({ length: n }, (_, i) => ({
        key: `S${start + i}`,
        name: `Space ${start + i}`,
        _links: { webui: `/s/${start + i}` },
      })),
    },
  });
  // Two full pages then a short one → complete catalog of 120 spaces.
  const full = await withFetch(
    (url) => {
      const start = Number(new URL(url).searchParams.get("start") ?? 0);
      return page(start, start < 100 ? 50 : 20);
    },
    () => listAllConfluenceSpaces(SRC, CRED, DEFAULT_CAPS, async () => true),
  );
  assert.equal(full.spaces.length, 120);
  assert.equal(full.complete, true);

  // Checkpoint declines after the first page → usable partial, complete=false.
  let asks = 0;
  const partial = await withFetch(
    (url) => page(Number(new URL(url).searchParams.get("start") ?? 0), 50),
    () =>
      listAllConfluenceSpaces(SRC, CRED, DEFAULT_CAPS, async () => {
        asks += 1;
        return asks < 2;
      }),
  );
  assert.equal(partial.complete, false);
  assert.equal(partial.spaces.length, 100); // stopped before page 3
});

test("listAllJiraProjects: cloud pages via project/search; DC fetches once", async () => {
  const cloud = await withFetch(
    (url) => {
      const startAt = Number(new URL(url).searchParams.get("startAt") ?? 0);
      return {
        body: {
          values: Array.from({ length: startAt === 0 ? 50 : 10 }, (_, i) => ({
            key: `P${startAt + i}`,
            name: `Project ${startAt + i}`,
          })),
          isLast: startAt > 0,
        },
      };
    },
    () =>
      listAllJiraProjects(
        { ...SRC, type: "jira", deployment: "cloud" },
        CRED,
        DEFAULT_CAPS,
        async () => true,
      ),
  );
  assert.equal(cloud.projects.length, 60);
  assert.equal(cloud.complete, true);

  let urls: string[] = [];
  const dc = await withFetch(
    (url) => {
      urls.push(url);
      return { body: [{ key: "OPS", name: "Operations" }] };
    },
    () =>
      listAllJiraProjects({ ...SRC, type: "jira" }, CRED, DEFAULT_CAPS, async () => true),
  );
  assert.equal(dc.projects.length, 1);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /rest\/api\/2\/project$/);
});

test("catalog expiry: fresh within TTL, expired after; age renders humanely", () => {
  const built = buildCatalog(
    [{ name: "X", locator: "q", kind: "query", detail: "d" }],
    true,
    "2026-06-11T00:00:00.000Z",
    24,
  );
  assert.equal(isExpired(built, "2026-06-11T23:59:00.000Z"), false);
  assert.equal(isExpired(built, "2026-06-12T00:00:01.000Z"), true);
  assert.equal(catalogAge(built, "2026-06-11T02:00:00.000Z"), "2 h ago");
  assert.equal(catalogAge(built, "2026-06-14T00:00:00.000Z"), "3 d ago");
  assert.equal(catalogAge(built, "2026-06-11T00:10:00.000Z"), "10 min ago");
});


test("snow-session credentials authenticate by Cookie header, never Authorization", async () => {
  let headers: Record<string, string> = {};
  await withFetch(
    (_url, init) => {
      headers = (init?.headers as Record<string, string>) ?? {};
      return { body: { result: [] } };
    },
    () => fetchJson("https://corp.service-now.com/api/now/table/incident", { method: "snow-session", secret: "JSESSIONID=abc; glide=1" }, 5_000),
  );
  assert.equal(headers["Cookie"], "JSESSIONID=abc; glide=1");
  assert.equal(headers["Authorization"], undefined);
});
