import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  JIRA_WRITE_HEADERS,
  getJiraIssueProject,
  assertIssueInWriteScope,
  describeJiraWriteScope,
  jiraWriteConfirmationText,
  buildJiraUpdateBody,
  updateJiraIssueFields,
  addJiraComment,
  listJiraTransitions,
  matchTransition,
  transitionJiraIssueTo,
  getJiraProject,
  probeJiraWritePermissions,
} from "../src/context/adapters/jiraWrite";
import { AppError } from "../src/core/errors";
import { ContextSource, ContextCredential, JiraWriteScope } from "../src/context/types";

const SRC: ContextSource = {
  id: "j1",
  type: "jira",
  displayName: "Jira",
  baseUrl: "https://acme.atlassian.net/",
  deployment: "cloud",
  authMethod: "basic",
  addedAt: "2026-07-07T00:00:00Z",
  role: "managed",
  jiraWriteScope: { kind: "project", projectKey: "ENG" },
};
const CRED: ContextCredential = { method: "basic", username: "u@x", secret: "t" };
const TIMEOUT = 5_000;

async function withFetch<T>(
  handler: (url: string, init: RequestInit) => { status?: number; body: unknown },
  run: () => Promise<T>,
): Promise<{ result: T; calls: Array<{ url: string; init: RequestInit }> }> {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
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

// ---------------------------------------------------------------------------
// Write-scope guard (fail closed).
// ---------------------------------------------------------------------------

test("assertIssueInWriteScope: instance scope permits any project", () => {
  assert.doesNotThrow(() => assertIssueInWriteScope({ kind: "instance" }, "ANY"));
});

test("assertIssueInWriteScope: project scope matches case-insensitively", () => {
  assert.doesNotThrow(() => assertIssueInWriteScope({ kind: "project", projectKey: "ENG" }, "eng"));
  assert.doesNotThrow(() => assertIssueInWriteScope({ kind: "project", projectKey: "eng" }, "ENG"));
});

test("assertIssueInWriteScope: project mismatch is refused with the scope named", () => {
  assert.throws(
    () => assertIssueInWriteScope({ kind: "project", projectKey: "ENG" }, "OPS"),
    (err: unknown) =>
      err instanceof AppError &&
      err.code === "config" &&
      /"ENG" project/.test(err.message) &&
      /project "OPS"/.test(err.message) &&
      /unaffected/i.test(err.message),
  );
});

test("assertIssueInWriteScope: NO scope at all fails CLOSED (read-only connector)", () => {
  assert.throws(
    () => assertIssueInWriteScope(undefined, "ENG"),
    (err: unknown) =>
      err instanceof AppError && err.code === "config" && /read-only/.test(err.message) && /managed/.test(err.message),
  );
});

test("assertIssueInWriteScope: a project scope missing its key fails closed too", () => {
  assert.throws(
    () => assertIssueInWriteScope({ kind: "project" }, "ENG"),
    (err: unknown) => err instanceof AppError && /writes are disabled/.test(err.message),
  );
});

test("describeJiraWriteScope covers instance / project / none", () => {
  assert.equal(describeJiraWriteScope({ kind: "instance" }), "the entire Jira instance");
  assert.equal(describeJiraWriteScope({ kind: "project", projectKey: "ENG" }), 'the "ENG" project');
  assert.equal(describeJiraWriteScope(undefined), "nothing (read-only — no write scope)");
});

// ---------------------------------------------------------------------------
// Issue-project resolution (the fail-closed scope input).
// ---------------------------------------------------------------------------

test("getJiraIssueProject fetches project+summary+status and returns the REAL project", async () => {
  const { result, calls } = await withFetch(
    () => ({
      body: { key: "ENG-42", fields: { project: { key: "OPS" }, summary: "Moved issue", status: { name: "Open" } } },
    }),
    () => getJiraIssueProject(SRC, CRED, "ENG-42", TIMEOUT),
  );
  assert.match(calls[0].url, /\/rest\/api\/2\/issue\/ENG-42\?fields=project,summary,status$/);
  // The issue key SAYS "ENG" but the server says OPS — the server wins.
  assert.deepEqual(result, { projectKey: "OPS", summary: "Moved issue", statusName: "Open" });
});

test("getJiraIssueProject fails CLOSED when Jira returns no project", async () => {
  await assert.rejects(
    withFetch(
      () => ({ body: { key: "ENG-1", fields: { summary: "?" } } }),
      () => getJiraIssueProject(SRC, CRED, "ENG-1", TIMEOUT),
    ),
    (err: unknown) => err instanceof AppError && /refusing to write/.test(err.message),
  );
});

test("getJiraIssueProject: a 403 stays graph.forbidden (never auth.failed → no lockout)", async () => {
  await assert.rejects(
    withFetch(
      () => ({ status: 403, body: { errorMessages: ["No browse permission"] } }),
      () => getJiraIssueProject(SRC, CRED, "ENG-1", TIMEOUT),
    ),
    (err: unknown) => err instanceof AppError && err.code === "graph.forbidden",
  );
});

// ---------------------------------------------------------------------------
// Field updates — only the provided fields travel.
// ---------------------------------------------------------------------------

test("buildJiraUpdateBody carries ONLY the provided fields", () => {
  assert.deepEqual(buildJiraUpdateBody({ summary: "New" }), { fields: { summary: "New" } });
  assert.deepEqual(buildJiraUpdateBody({ description: "d", labels: [] }), {
    fields: { description: "d", labels: [] },
  });
  assert.deepEqual(buildJiraUpdateBody({ summary: "s", description: "d", labels: ["a", "b"] }), {
    fields: { summary: "s", description: "d", labels: ["a", "b"] },
  });
});

test("updateJiraIssueFields PUTs /rest/api/2/issue/{key} with the write headers", async () => {
  const { calls } = await withFetch(
    () => ({ status: 204, body: undefined }),
    () => updateJiraIssueFields(SRC, CRED, "ENG-42", { summary: "New title" }, TIMEOUT),
  );
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/rest\/api\/2\/issue\/ENG-42$/);
  assert.equal(calls[0].init.method, "PUT");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { fields: { summary: "New title" } });
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers["X-Atlassian-Token"], "no-check");
  assert.match(headers["User-Agent"], /^ai-toolkit-jira\//, "non-browser UA (Atlassian CSRF discipline)");
});

test("updateJiraIssueFields refuses an empty update", async () => {
  await assert.rejects(
    withFetch(
      () => ({ body: undefined }),
      () => updateJiraIssueFields(SRC, CRED, "ENG-42", {}, TIMEOUT),
    ),
    (err: unknown) => err instanceof AppError && err.code === "config" && /Nothing to update/.test(err.message),
  );
});

test("updateJiraIssueFields: a 403 write denial is graph.forbidden", async () => {
  await assert.rejects(
    withFetch(
      () => ({ status: 403, body: { errorMessages: ["You do not have permission to edit issues"] } }),
      () => updateJiraIssueFields(SRC, CRED, "ENG-42", { summary: "x" }, TIMEOUT),
    ),
    (err: unknown) => err instanceof AppError && err.code === "graph.forbidden",
  );
});

// ---------------------------------------------------------------------------
// Comments.
// ---------------------------------------------------------------------------

test("addJiraComment POSTs the v2 plain-text body and returns the comment id", async () => {
  const { result, calls } = await withFetch(
    () => ({ body: { id: "10001" } }),
    () => addJiraComment(SRC, CRED, "ENG-42", "Deployed to staging.", TIMEOUT),
  );
  assert.match(calls[0].url, /\/rest\/api\/2\/issue\/ENG-42\/comment$/);
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { body: "Deployed to staging." });
  assert.equal((calls[0].init.headers as Record<string, string>)["X-Atlassian-Token"], "no-check");
  assert.deepEqual(result, { id: "10001" });
});

test("addJiraComment refuses an empty body", async () => {
  await assert.rejects(
    withFetch(() => ({ body: undefined }), () => addJiraComment(SRC, CRED, "ENG-42", "   ", TIMEOUT)),
    (err: unknown) => err instanceof AppError && err.code === "config",
  );
});

// ---------------------------------------------------------------------------
// Transitions — list, match, apply.
// ---------------------------------------------------------------------------

test("listJiraTransitions parses id/name/target status (id may be numeric)", async () => {
  const { result, calls } = await withFetch(
    () => ({
      body: {
        transitions: [
          { id: 11, name: "Start Progress", to: { name: "In Progress" } },
          { id: "31", name: "Done", to: { name: "Done" } },
          { name: "no-id-dropped" },
        ],
      },
    }),
    () => listJiraTransitions(SRC, CRED, "ENG-42", TIMEOUT),
  );
  assert.match(calls[0].url, /\/rest\/api\/2\/issue\/ENG-42\/transitions$/);
  assert.equal(calls[0].init.method ?? "GET", "GET");
  assert.deepEqual(result, [
    { id: "11", name: "Start Progress", toName: "In Progress" },
    { id: "31", name: "Done", toName: "Done" },
  ]);
});

test("matchTransition resolves by id, by name, and by TARGET status — case-insensitive", () => {
  const transitions = [
    { id: "11", name: "Start Progress", toName: "In Progress" },
    { id: "31", name: "Close it", toName: "Done" },
  ];
  assert.equal(matchTransition(transitions, "31")?.name, "Close it");
  assert.equal(matchTransition(transitions, "start progress")?.id, "11");
  assert.equal(matchTransition(transitions, "done")?.id, "31", "target status name works too");
  assert.equal(matchTransition(transitions, "Reopen"), undefined);
  assert.equal(matchTransition(transitions, "  "), undefined);
});

test("transitionJiraIssueTo POSTs {transition:{id}} with the write headers", async () => {
  const { calls } = await withFetch(
    () => ({ status: 204, body: undefined }),
    () => transitionJiraIssueTo(SRC, CRED, "ENG-42", "31", TIMEOUT),
  );
  assert.match(calls[0].url, /\/rest\/api\/2\/issue\/ENG-42\/transitions$/);
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { transition: { id: "31" } });
  assert.equal((calls[0].init.headers as Record<string, string>)["X-Atlassian-Token"], "no-check");
});

// ---------------------------------------------------------------------------
// Onboarding helpers: project validation + write-permission probe.
// ---------------------------------------------------------------------------

test("getJiraProject validates a key and returns the server's canonical casing", async () => {
  const { result, calls } = await withFetch(
    () => ({ body: { key: "ENG", name: "Engineering" } }),
    () => getJiraProject(SRC, CRED, "eng", TIMEOUT),
  );
  assert.match(calls[0].url, /\/rest\/api\/2\/project\/eng$/);
  assert.deepEqual(result, { key: "ENG", name: "Engineering" });
});

test("getJiraProject surfaces a missing project as graph.notFound", async () => {
  await assert.rejects(
    withFetch(() => ({ status: 404, body: {} }), () => getJiraProject(SRC, CRED, "NOPE", TIMEOUT)),
    (err: unknown) => err instanceof AppError && err.code === "graph.notFound",
  );
});

test("probeJiraWritePermissions sends the Cloud-required permissions param (+projectKey) and reports gaps", async () => {
  const { result, calls } = await withFetch(
    () => ({
      body: {
        permissions: {
          EDIT_ISSUES: { havePermission: true },
          ADD_COMMENTS: { havePermission: false },
          // TRANSITION_ISSUES absent entirely → also missing
        },
      },
    }),
    () => probeJiraWritePermissions(SRC, CRED, "ENG", TIMEOUT),
  );
  const u = new URL(calls[0].url);
  assert.match(u.pathname, /\/rest\/api\/2\/mypermissions$/);
  assert.equal(u.searchParams.get("permissions"), "EDIT_ISSUES,ADD_COMMENTS,TRANSITION_ISSUES");
  assert.equal(u.searchParams.get("projectKey"), "ENG");
  assert.deepEqual(result.missing, ["ADD_COMMENTS", "TRANSITION_ISSUES"]);
});

test("probeJiraWritePermissions omits projectKey for an instance scope and passes when all granted", async () => {
  const granted = Object.fromEntries(
    ["EDIT_ISSUES", "ADD_COMMENTS", "TRANSITION_ISSUES"].map((p) => [p, { havePermission: true }]),
  );
  const { result, calls } = await withFetch(
    () => ({ body: { permissions: granted } }),
    () => probeJiraWritePermissions(SRC, CRED, undefined, TIMEOUT),
  );
  assert.equal(new URL(calls[0].url).searchParams.get("projectKey"), null);
  assert.deepEqual(result.missing, []);
});

// ---------------------------------------------------------------------------
// Confirmation text (the approval card body).
// ---------------------------------------------------------------------------

test("jiraWriteConfirmationText always names the instance and the write scope", () => {
  const projectScoped = jiraWriteConfirmationText(SRC, undefined, ["**Action:** update issue `ENG-42`"]);
  assert.match(projectScoped, /\*\*Jira instance:\*\* https:\/\/acme\.atlassian\.net\//);
  assert.match(projectScoped, /Project \(connector write scope\):\*\* `ENG`/);
  assert.match(projectScoped, /update issue `ENG-42`/);
  assert.match(projectScoped, /your own API token/);

  const instanceScoped = jiraWriteConfirmationText(
    { baseUrl: "https://jira.corp", jiraWriteScope: { kind: "instance" } as JiraWriteScope },
    undefined,
    [],
  );
  assert.match(instanceScoped, /ENTIRE instance/);

  const unscoped = jiraWriteConfirmationText({ baseUrl: "https://jira.corp" }, undefined, []);
  assert.match(unscoped, /READ-ONLY/);

  const unresolved = jiraWriteConfirmationText(undefined, "tracker", []);
  assert.match(unresolved, /\*\*Source:\*\* tracker/);
});

test("JIRA_WRITE_HEADERS mirror the Confluence CSRF discipline", () => {
  assert.equal(JIRA_WRITE_HEADERS["X-Atlassian-Token"], "no-check");
  assert.match(JIRA_WRITE_HEADERS["User-Agent"], /^ai-toolkit-jira\/\d/);
});
