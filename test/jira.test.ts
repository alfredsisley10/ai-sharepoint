import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  verifyJira,
  searchJira,
  getJiraIssue,
  listJiraProjects,
  listAllJiraProjects,
  listJiraFavouriteFilters,
  listJsmQueues,
} from "../src/context/adapters/jira";
import { ContextSource, ContextCredential, DEFAULT_CAPS } from "../src/context/types";

const CLOUD: ContextSource = {
  id: "j1",
  type: "jira",
  displayName: "Jira",
  baseUrl: "https://acme.atlassian.net/",
  deployment: "cloud",
  authMethod: "basic",
  addedAt: "2026-07-07T00:00:00Z",
};
const DC: ContextSource = { ...CLOUD, id: "j2", deployment: "datacenter", baseUrl: "https://jira.corp" };
const CRED: ContextCredential = { method: "basic", username: "u@x", secret: "t" };

async function withFetch<T>(
  handler: (url: string, init: RequestInit) => { status?: number; body: unknown },
  run: () => Promise<T>,
): Promise<{ result: T; calls: string[] }> {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init: RequestInit) => {
    calls.push(String(url));
    const r = handler(String(url), init ?? {});
    return new Response(r.body === undefined ? undefined : JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    return { result: await run(), calls };
  } finally {
    globalThis.fetch = original;
  }
}

test("verifyJira resolves an account name from /myself", async () => {
  const { result, calls } = await withFetch(
    () => ({ body: { name: "jdoe", displayName: "J Doe" } }),
    () => verifyJira(CLOUD, CRED, DEFAULT_CAPS),
  );
  assert.match(calls[0], /\/rest\/api\/2\/myself$/);
  assert.equal(result.account, "jdoe");
});

test("searchJira wraps FREE TEXT in a text~ query and escapes quotes (JQL injection guard)", async () => {
  const { result, calls } = await withFetch(
    () => ({
      body: {
        issues: [
          { key: "ABC-1", fields: { summary: "Login broken", status: { name: "Open" }, issuetype: { name: "Bug" }, priority: { name: "High" } } },
        ],
      },
    }),
    () => searchJira(CLOUD, CRED, 'say "hi"\\', DEFAULT_CAPS),
  );
  const jql = decodeURIComponent(new URL(calls[0]).searchParams.get("jql")!);
  assert.equal(jql, 'text ~ "say \\"hi\\"\\\\" order by updated desc');
  assert.deepEqual(result[0], {
    title: "ABC-1: Login broken",
    url: "https://acme.atlassian.net/browse/ABC-1",
    meta: { key: "ABC-1", status: "Open", type: "Bug", assignee: "unassigned", priority: "High" },
  });
});

test("searchJira passes RAW JQL through untouched", async () => {
  const { calls } = await withFetch(
    () => ({ body: { issues: [] } }),
    () => searchJira(CLOUD, CRED, "project = ABC AND status = Open", DEFAULT_CAPS),
  );
  const jql = decodeURIComponent(new URL(calls[0]).searchParams.get("jql")!);
  assert.equal(jql, "project = ABC AND status = Open");
});

test("getJiraIssue flattens an ADF description to plain text", async () => {
  const adf = { content: [{ content: [{ type: "text", text: "Hello" }, { type: "text", text: "world" }] }] };
  const { result } = await withFetch(
    () => ({ body: { key: "ABC-2", fields: { summary: "Doc", description: adf, status: { name: "Done" }, issuetype: { name: "Task" } } } }),
    () => getJiraIssue(CLOUD, CRED, "ABC-2", DEFAULT_CAPS),
  );
  assert.equal(result.title, "ABC-2: Doc");
  assert.equal(result.body, "Hello world");
  assert.equal(result.meta?.status, "Done");
});

test("getJiraIssue keeps a plain-string description", async () => {
  const { result } = await withFetch(
    () => ({ body: { key: "ABC-3", fields: { summary: "S", description: "just text" } } }),
    () => getJiraIssue(CLOUD, CRED, "ABC-3", DEFAULT_CAPS),
  );
  assert.equal(result.body, "just text");
});

test("getJiraIssue tolerates an absent/null description (empty body)", async () => {
  const { result } = await withFetch(
    () => ({ body: { key: "ABC-4", fields: { summary: "S", description: null } } }),
    () => getJiraIssue(CLOUD, CRED, "ABC-4", DEFAULT_CAPS),
  );
  assert.equal(result.body, "");
});

test("listJiraProjects (Data Center) maps key/name and defaults name to key", async () => {
  const { result, calls } = await withFetch(
    () => ({ body: [{ key: "ABC", name: "Alpha" }, { key: "XYZ" }, { name: "no-key" }] }),
    () => listJiraProjects(DC, CRED, DEFAULT_CAPS),
  );
  assert.deepEqual(result, [{ key: "ABC", name: "Alpha" }, { key: "XYZ", name: "XYZ" }]);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /\/rest\/api\/2\/project$/, "DC keeps the unpaged endpoint");
});

test("listJiraProjects (Cloud) pages /project/search — the unpaged /project endpoint is gone on Cloud", async () => {
  const { result, calls } = await withFetch(
    (url) => {
      const startAt = Number(new URL(url).searchParams.get("startAt"));
      return startAt === 0
        ? { body: { values: [{ key: "A", name: "Alpha" }, { key: "B" }], isLast: false } }
        : { body: { values: [{ key: "C" }], isLast: true } };
    },
    () => listJiraProjects(CLOUD, CRED, DEFAULT_CAPS),
  );
  assert.deepEqual(result, [
    { key: "A", name: "Alpha" },
    { key: "B", name: "B" },
    { key: "C", name: "C" },
  ]);
  assert.equal(calls.length, 2);
  assert.match(calls[0], /\/rest\/api\/2\/project\/search\?startAt=0/);
  assert.ok(
    calls.every((c) => !/\/rest\/api\/2\/project(\?|$)/.test(c)),
    "never calls the Cloud-removed unpaged endpoint",
  );
});

test("listJiraProjects (Cloud) stops at caps.maxResults", async () => {
  const { result, calls } = await withFetch(
    (url) => {
      const startAt = Number(new URL(url).searchParams.get("startAt"));
      return { body: { values: Array.from({ length: 50 }, (_, i) => ({ key: `P${startAt + i}` })), isLast: false } };
    },
    () => listJiraProjects(CLOUD, CRED, { ...DEFAULT_CAPS, maxResults: 60 }),
  );
  assert.equal(result.length, 60, "capped at maxResults");
  assert.equal(calls.length, 2, "stops paging once the cap is reached");
});

test("listAllJiraProjects pages the Cloud /project/search until isLast, honoring checkpoint", async () => {
  const { result, calls } = await withFetch(
    (url) => {
      const startAt = Number(new URL(url).searchParams.get("startAt"));
      return startAt === 0
        ? { body: { values: [{ key: "A" }, { key: "B" }], isLast: false } }
        : { body: { values: [{ key: "C" }], isLast: true } };
    },
    () => listAllJiraProjects(CLOUD, CRED, DEFAULT_CAPS, async () => true),
  );
  assert.equal(result.complete, true);
  assert.deepEqual(result.projects.map((p) => p.key), ["A", "B", "C"]);
  assert.equal(calls.length, 2);
  assert.match(calls[0], /\/project\/search\?startAt=0/);
});

test("listAllJiraProjects (Data Center) fetches the whole list in one call", async () => {
  const { result, calls } = await withFetch(
    () => ({ body: [{ key: "A", name: "Alpha" }, { key: "B", name: "Beta" }] }),
    () => listAllJiraProjects(DC, CRED, DEFAULT_CAPS, async () => true),
  );
  assert.equal(result.complete, true);
  assert.equal(result.projects.length, 2);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /\/rest\/api\/2\/project$/);
});

test("listAllJiraProjects stops (incomplete) when checkpoint aborts mid-paging", async () => {
  const { result } = await withFetch(
    () => ({ body: { values: [{ key: "A" }], isLast: false } }),
    () => listAllJiraProjects(CLOUD, CRED, DEFAULT_CAPS, async () => false),
  );
  assert.equal(result.complete, false);
  assert.deepEqual(result.projects.map((p) => p.key), ["A"]);
});

test("listJiraFavouriteFilters keeps only entries with both name and jql", async () => {
  const { result } = await withFetch(
    () => ({ body: [{ name: "Mine", jql: "assignee = currentUser()" }, { name: "No JQL" }, { jql: "x" }] }),
    () => listJiraFavouriteFilters(CLOUD, CRED, DEFAULT_CAPS),
  );
  assert.deepEqual(result, [{ name: "Mine", jql: "assignee = currentUser()" }]);
});

test("listJsmQueues enumerates desks then maps each queue's JQL", async () => {
  const { result } = await withFetch(
    (url) => {
      if (/\/servicedesk\?limit=10/.test(url)) return { body: { values: [{ id: "1", projectName: "IT" }] } };
      if (/\/servicedesk\/1\/queue/.test(url)) {
        return { body: { values: [{ name: "Unassigned", jql: "assignee is EMPTY" }, { name: "no-jql" }] } };
      }
      return { body: {} };
    },
    () => listJsmQueues(CLOUD, CRED, DEFAULT_CAPS),
  );
  assert.deepEqual(result.queues, [{ desk: "IT", name: "Unassigned", jql: "assignee is EMPTY" }]);
  assert.equal(result.note, undefined);
});

test("listJsmQueues reports a note when the service-desk API is unavailable (not JSM)", async () => {
  const { result } = await withFetch(
    () => ({ status: 404, body: { message: "no such endpoint" } }),
    () => listJsmQueues(CLOUD, CRED, DEFAULT_CAPS),
  );
  assert.deepEqual(result.queues, []);
  assert.match(result.note ?? "", /service-desk list unavailable/);
});
