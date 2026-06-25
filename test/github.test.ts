import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  parseGithubQuery,
  parseGithubItemRef,
  githubApiBase,
  searchGithub,
  getGithubItem,
  verifyGithub,
} from "../src/context/adapters/github";
import { ContextSource, DEFAULT_CAPS } from "../src/context/types";

const CRED = { method: "pat" as const, secret: "ghp_test" };

const CLOUD: ContextSource = {
  id: "gh1",
  type: "github",
  displayName: "GitHub",
  baseUrl: "https://github.com",
  deployment: "cloud",
  authMethod: "pat",
  addedAt: "2026-06-01T00:00:00.000Z",
};
const GHES: ContextSource = { ...CLOUD, id: "gh2", baseUrl: "https://github.corp.example", deployment: "datacenter" };

/** Mock global fetch; capture the requested URL for assertions. */
function withFetch<T>(
  responder: (url: string) => { status?: number; body: unknown },
  run: (seen: { url: string; calls: number }) => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  const seen = { url: "", calls: 0 };
  globalThis.fetch = (async (url: unknown) => {
    seen.url = String(url);
    seen.calls += 1;
    const r = responder(String(url));
    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return run(seen).finally(() => {
    globalThis.fetch = original;
  });
}

test("githubApiBase: github.com → api.github.com; GHES → host/api/v3", () => {
  assert.equal(githubApiBase(CLOUD), "https://api.github.com");
  assert.equal(githubApiBase(GHES), "https://github.corp.example/api/v3");
  assert.equal(githubApiBase({ ...GHES, baseUrl: "https://github.corp.example/" }), "https://github.corp.example/api/v3");
});

test("parseGithubQuery: JSON spec, leading selector, and plain-text default", () => {
  assert.deepEqual(parseGithubQuery('{"type":"code","q":"parseUser","limit":3}'), { type: "code", q: "parseUser", limit: 3 });
  assert.deepEqual(parseGithubQuery("code: parseUser repo:acme/web"), { type: "code", q: "parseUser repo:acme/web" });
  assert.equal(parseGithubQuery("repos: payments").type, "repositories");
  assert.equal(parseGithubQuery("commits: hotfix").type, "commits");
  // GitHub's own qualifiers are NOT selectors → default to issues & PRs.
  assert.deepEqual(parseGithubQuery("is:open label:bug"), { type: "issues", q: "is:open label:bug" });
  assert.deepEqual(parseGithubQuery("login fails"), { type: "issues", q: "login fails" });
  // Unknown JSON type falls back to issues.
  assert.equal(parseGithubQuery('{"type":"nope","q":"x"}').type, "issues");
});

test("parseGithubItemRef: issue / commit / file / repo / invalid", () => {
  assert.deepEqual(parseGithubItemRef("acme/web#42"), { kind: "issue", owner: "acme", repo: "web", number: 42 });
  assert.deepEqual(parseGithubItemRef("acme/web@abcdef1"), { kind: "commit", owner: "acme", repo: "web", sha: "abcdef1" });
  assert.deepEqual(parseGithubItemRef("acme/web:src/app.ts"), { kind: "file", owner: "acme", repo: "web", path: "src/app.ts" });
  assert.deepEqual(parseGithubItemRef("acme/web:src/app.ts@dev"), {
    kind: "file",
    owner: "acme",
    repo: "web",
    path: "src/app.ts",
    ref: "dev",
  });
  assert.deepEqual(parseGithubItemRef("acme/web"), { kind: "repo", owner: "acme", repo: "web" });
  assert.equal(parseGithubItemRef("not a ref"), undefined);
});

test("searchGithub issues: hits /search/issues and maps issues & PRs", async () => {
  const hits = await withFetch(
    () => ({
      body: {
        items: [
          {
            title: "Login fails",
            html_url: "https://github.com/acme/web/issues/42",
            number: 42,
            state: "open",
            body: "Steps to reproduce…",
            user: { login: "alice" },
            labels: [{ name: "bug" }],
            repository_url: "https://api.github.com/repos/acme/web",
          },
          { title: "Add SSO", html_url: "https://github.com/acme/web/pull/50", number: 50, state: "open", pull_request: {}, repository_url: "https://api.github.com/repos/acme/web" },
        ],
      },
    }),
    (seen) => searchGithub(CLOUD, CRED, "is:open label:bug", DEFAULT_CAPS).then((h) => {
      assert.match(seen.url, /^https:\/\/api\.github\.com\/search\/issues\?q=is%3Aopen%20label%3Abug&per_page=25$/);
      return h;
    }),
  );
  assert.equal(hits[0].title, "acme/web#42 Login fails");
  assert.equal(hits[0].url, "https://github.com/acme/web/issues/42");
  assert.equal(hits[0].meta?.kind, "issue");
  assert.equal(hits[0].meta?.state, "open");
  assert.equal(hits[0].meta?.repo, "acme/web");
  assert.equal(hits[0].meta?.author, "alice");
  assert.equal(hits[0].meta?.labels, "bug");
  assert.equal(hits[1].meta?.kind, "pull-request");
});

test("searchGithub code: hits /search/code and maps repo · path", async () => {
  const hits = await withFetch(
    () => ({ body: { items: [{ name: "user.ts", path: "src/user.ts", html_url: "https://github.com/acme/web/blob/main/src/user.ts", repository: { full_name: "acme/web" } }] } }),
    (seen) => searchGithub(CLOUD, CRED, "code: parseUser", DEFAULT_CAPS).then((h) => {
      assert.match(seen.url, /\/search\/code\?q=parseUser/);
      return h;
    }),
  );
  assert.equal(hits[0].title, "acme/web · src/user.ts");
  assert.equal(hits[0].meta?.kind, "code");
  assert.equal(hits[0].meta?.path, "src/user.ts");
});

test("searchGithub repositories & commits map their fields; limit caps per_page", async () => {
  const repos = await withFetch(
    () => ({ body: { items: [{ full_name: "acme/payments", html_url: "https://github.com/acme/payments", description: "Billing service", language: "TypeScript", visibility: "private", stargazers_count: 12 }] } }),
    () => searchGithub(GHES, CRED, "repos: payments", DEFAULT_CAPS),
  );
  assert.equal(repos[0].title, "acme/payments");
  assert.equal(repos[0].excerpt, "Billing service");
  assert.equal(repos[0].meta?.language, "TypeScript");
  assert.equal(repos[0].meta?.visibility, "private");
  assert.equal(repos[0].meta?.stars, "12");

  const commits = await withFetch(
    () => ({ body: { items: [{ sha: "abcdef1234567890", html_url: "https://github.com/acme/web/commit/abcdef1", commit: { message: "hotfix: npe\n\ndetails", author: { name: "Bob", date: "2026-02-02" } }, repository: { full_name: "acme/web" } }] } }),
    (seen) => searchGithub(CLOUD, CRED, '{"type":"commits","q":"hotfix","limit":5}', DEFAULT_CAPS).then((h) => {
      assert.match(seen.url, /\/search\/commits\?q=hotfix&per_page=5$/);
      return h;
    }),
  );
  assert.equal(commits[0].title, "acme/web@abcdef1: hotfix: npe");
  assert.match(commits[0].excerpt ?? "", /hotfix: npe/);
  assert.equal(commits[0].meta?.sha, "abcdef1234567890");
  assert.equal(commits[0].meta?.author, "Bob");
});

test("searchGithub returns [] for an empty query without calling the API", async () => {
  await withFetch(
    () => {
      throw new Error("fetch must not be called for an empty query");
    },
    async (seen) => {
      assert.deepEqual(await searchGithub(CLOUD, CRED, "{}", DEFAULT_CAPS), []);
      assert.equal(seen.calls, 0);
    },
  );
});

test("getGithubItem: issue, commit, file (base64), repo — correct endpoints & bodies", async () => {
  const issue = await withFetch(
    () => ({ body: { number: 42, title: "Login fails", html_url: "https://github.com/acme/web/issues/42", body: "Steps to repro", state: "open", user: { login: "alice" }, labels: [{ name: "bug" }] } }),
    (seen) => getGithubItem(CLOUD, CRED, "acme/web#42", DEFAULT_CAPS).then((i) => {
      assert.equal(seen.url, "https://api.github.com/repos/acme/web/issues/42");
      return i;
    }),
  );
  assert.equal(issue.title, "acme/web#42 Login fails");
  assert.equal(issue.body, "Steps to repro");
  assert.equal(issue.meta?.kind, "issue");

  const commit = await withFetch(
    () => ({ body: { sha: "abcdef1234567", html_url: "https://github.com/acme/web/commit/abcdef1", commit: { message: "fix: thing", author: { name: "Bob", date: "2026-02-02" } }, stats: { additions: 3, deletions: 1 }, files: [{ filename: "a.ts", status: "modified" }] } }),
    (seen) => getGithubItem(GHES, CRED, "acme/web@abcdef1234567", DEFAULT_CAPS).then((i) => {
      assert.equal(seen.url, "https://github.corp.example/api/v3/repos/acme/web/commits/abcdef1234567");
      return i;
    }),
  );
  assert.match(commit.title, /^acme\/web@abcdef1: fix: thing$/);
  assert.match(commit.body, /fix: thing/);
  assert.match(commit.body, /modified a\.ts/);
  assert.equal(commit.meta?.additions, "3");

  const b64 = Buffer.from("export const x = 1;\n", "utf8").toString("base64");
  const file = await withFetch(
    () => ({ body: { content: b64, encoding: "base64", html_url: "https://github.com/acme/web/blob/main/src/app.ts", name: "app.ts", size: 19 } }),
    (seen) => getGithubItem(CLOUD, CRED, "acme/web:src/app.ts@main", DEFAULT_CAPS).then((i) => {
      assert.match(seen.url, /\/repos\/acme\/web\/contents\/src\/app\.ts\?ref=main$/);
      return i;
    }),
  );
  assert.equal(file.title, "acme/web:src/app.ts");
  assert.equal(file.body, "export const x = 1;");
  assert.equal(file.meta?.kind, "file");
  assert.equal(file.meta?.ref, "main");

  const repo = await withFetch(
    () => ({ body: { full_name: "acme/web", html_url: "https://github.com/acme/web", description: "Web app", language: "TypeScript", visibility: "public", default_branch: "main", topics: ["web"], stargazers_count: 5, open_issues_count: 2 } }),
    () => getGithubItem(CLOUD, CRED, "acme/web", DEFAULT_CAPS),
  );
  assert.equal(repo.title, "acme/web");
  assert.equal(repo.body, "Web app");
  assert.equal(repo.meta?.defaultBranch, "main");
  assert.equal(repo.meta?.topics, "web");
});

test("getGithubItem rejects an unrecognized id", async () => {
  await assert.rejects(() => getGithubItem(CLOUD, CRED, "not a ref", DEFAULT_CAPS), /Unrecognized GitHub item id/);
});

test("verifyGithub reads /user and returns the login", async () => {
  const res = await withFetch(
    () => ({ body: { login: "octocat", name: "The Octocat" } }),
    (seen) => verifyGithub(GHES, CRED, DEFAULT_CAPS).then((r) => {
      assert.equal(seen.url, "https://github.corp.example/api/v3/user");
      return r;
    }),
  );
  assert.equal(res.account, "octocat");
});
