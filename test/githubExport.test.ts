import { test } from "node:test";
import * as assert from "node:assert/strict";
import { strToU8 } from "fflate";
import { exportToGitHub, gitHubApiBase, gitHubRepoUrl } from "../src/branding/githubExport";

type Call = { method: string; path: string; body?: Record<string, unknown> };

/** Minimal GitHub REST fake; routes by method+path and records the sequence. */
function fakeGitHub(opts: { repoExists: boolean; hasHistory: boolean; userLogin?: string }) {
  const calls: Call[] = [];
  const resp = (status: number, json: unknown) => ({
    ok: status < 300,
    status,
    text: async () => JSON.stringify(json),
    json: async () => json,
  });
  const fetchImpl = async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    const path = url.replace(/^https:\/\/[^/]+/, "").replace(/^\/api\/v3/, "");
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    calls.push({ method, path, body });
    if (method === "GET" && /^\/repos\/[^/]+\/[^/]+$/.test(path)) {
      return opts.repoExists ? resp(200, { default_branch: "main" }) : resp(404, { message: "Not Found" });
    }
    if (method === "GET" && path === "/user") return resp(200, { login: opts.userLogin ?? "contoso" });
    if (method === "POST" && (path === "/user/repos" || /^\/orgs\/[^/]+\/repos$/.test(path))) {
      return resp(201, { default_branch: "main" });
    }
    if (method === "POST" && path.endsWith("/git/blobs")) return resp(201, { sha: "blob" + calls.length });
    if (method === "GET" && /\/git\/ref\/heads\/main$/.test(path)) {
      return opts.hasHistory ? resp(200, { object: { sha: "basecommit" } }) : resp(404, {});
    }
    if (method === "GET" && /\/git\/commits\/basecommit$/.test(path)) return resp(200, { tree: { sha: "basetree" } });
    if (method === "POST" && path.endsWith("/git/trees")) return resp(201, { sha: "newtree" });
    if (method === "POST" && path.endsWith("/git/commits")) return resp(201, { sha: "newcommit" });
    if (method === "PATCH" && /\/git\/refs\/heads\/main$/.test(path)) return resp(200, {});
    if (method === "POST" && path.endsWith("/git/refs")) return resp(201, {});
    return resp(500, { message: `unexpected ${method} ${path}` });
  };
  return { fetchImpl, calls };
}

const FILES = { "package.json": strToU8("{}"), "BUILD.md": strToU8("hi") };
const target = (over = {}) => ({
  host: "",
  token: "t",
  owner: "contoso",
  repo: "contoso-docs-build",
  privateRepo: true,
  message: "wl build",
  ...over,
});

test("gitHubApiBase / gitHubRepoUrl handle github.com and GHES", () => {
  assert.equal(gitHubApiBase(""), "https://api.github.com");
  assert.equal(gitHubApiBase("github.com"), "https://api.github.com");
  assert.equal(gitHubApiBase("ghe.corp.example"), "https://ghe.corp.example/api/v3");
  assert.equal(gitHubApiBase("https://ghe.corp.example/"), "https://ghe.corp.example/api/v3");
  assert.equal(gitHubRepoUrl("", "o", "r"), "https://github.com/o/r");
  assert.equal(gitHubRepoUrl("ghe.corp.example", "o", "r"), "https://ghe.corp.example/o/r");
});

test("creates a USER repo (owner == authenticated login) and pushes one commit", async () => {
  const { fetchImpl, calls } = fakeGitHub({ repoExists: false, hasHistory: true });
  const r = await exportToGitHub(target(), FILES, fetchImpl);
  assert.equal(r.createdRepo, true);
  assert.equal(r.files, 2);
  assert.equal(r.commitSha, "newcommit");
  assert.equal(r.repoUrl, "https://github.com/contoso/contoso-docs-build");
  assert.ok(calls.some((c) => c.method === "POST" && c.path === "/user/repos"));
  assert.equal(calls.filter((c) => c.path.endsWith("/git/blobs")).length, 2, "one blob per file");
  assert.ok(calls.some((c) => c.method === "PATCH" && /git\/refs\/heads\/main$/.test(c.path)), "fast-forwards the branch");
});

test("creates an ORG repo when owner != authenticated login", async () => {
  const { fetchImpl, calls } = fakeGitHub({ repoExists: false, hasHistory: true, userLogin: "someone-else" });
  await exportToGitHub(target({ owner: "acme" }), FILES, fetchImpl);
  assert.ok(calls.some((c) => c.method === "POST" && c.path === "/orgs/acme/repos"));
});

test("existing EMPTY repo (no history) creates the ref instead of patching", async () => {
  const { fetchImpl, calls } = fakeGitHub({ repoExists: true, hasHistory: false });
  const r = await exportToGitHub(target(), FILES, fetchImpl);
  assert.equal(r.createdRepo, false);
  assert.ok(calls.some((c) => c.method === "POST" && c.path.endsWith("/git/refs")), "creates refs/heads/main");
  assert.ok(!calls.some((c) => c.method === "PATCH"), "no fast-forward on an empty repo");
});

test("a 403 on repo lookup surfaces as an auth failure", async () => {
  const fetchImpl = async () => ({ ok: false, status: 403, text: async () => "forbidden", json: async () => ({}) });
  await assert.rejects(
    () => exportToGitHub(target(), FILES, fetchImpl),
    (e: unknown) => (e as { code?: string }).code === "auth.failed",
  );
});
