/**
 * Push the white-labeled build components to an enterprise GitHub (github.com or
 * GitHub Enterprise Server) so a team can maintain and re-package the plugin
 * going forward. Creates the repository if needed and writes all files in ONE
 * commit via the Git Data API (blobs → tree → commit → ref), which works on an
 * empty or an existing repo alike.
 *
 * `fetch` is injected so the request sequence is unit-tested without a network.
 * No native deps — the extension host's global fetch is used at runtime.
 */
import { AppError } from "../core/errors";

export interface GitHubExportTarget {
  /** Host: blank/"github.com" → SaaS; otherwise a GHES host (e.g. ghe.corp.com). */
  host: string;
  token: string;
  owner: string;
  repo: string;
  privateRepo: boolean;
  /** Commit message for the export. */
  message: string;
}

export interface GitHubExportResult {
  repoUrl: string;
  commitSha: string;
  createdRepo: boolean;
  branch: string;
  files: number;
}

type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> }>;

/** Normalize a host to the REST API base. github.com → api.github.com; a GHES
 *  host → https://<host>/api/v3. Accepts hosts with or without a scheme. */
export function gitHubApiBase(host: string): string {
  const h = (host || "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (!h || h.toLowerCase() === "github.com" || h.toLowerCase() === "api.github.com") {
    return "https://api.github.com";
  }
  return `https://${h}/api/v3`;
}

/** The browsable repo URL for the host. */
export function gitHubRepoUrl(host: string, owner: string, repo: string): string {
  const h = (host || "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const base = !h || h.toLowerCase() === "github.com" || h.toLowerCase() === "api.github.com" ? "github.com" : h;
  return `https://${base}/${owner}/${repo}`;
}

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export async function exportToGitHub(
  target: GitHubExportTarget,
  files: Record<string, Uint8Array>,
  fetchImpl: FetchLike,
): Promise<GitHubExportResult> {
  const api = gitHubApiBase(target.host);
  const headers = {
    Authorization: `Bearer ${target.token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
    "User-Agent": "ai-sharepoint-rebrand",
  };

  const gh = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const res = await fetchImpl(`${api}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      const code = res.status === 401 || res.status === 403 ? "auth.failed" : "network";
      throw new AppError(`GitHub ${method} ${path} failed (${res.status}). ${detail}`, code);
    }
    return res.status === 204 ? undefined : res.json();
  };

  const { owner, repo } = target;

  // 1) Ensure the repo exists; create under the user or the org as appropriate.
  let createdRepo = false;
  let defaultBranch = "main";
  const existing = await fetchImpl(`${api}/repos/${owner}/${repo}`, { method: "GET", headers });
  if (existing.ok) {
    defaultBranch = ((await existing.json().catch(() => ({}))) as { default_branch?: string }).default_branch || "main";
  } else if (existing.status === 404) {
    const me = (await gh("GET", "/user")) as { login?: string };
    const underUser = (me.login || "").toLowerCase() === owner.toLowerCase();
    const created = (await gh(
      "POST",
      underUser ? "/user/repos" : `/orgs/${owner}/repos`,
      { name: repo, private: target.privateRepo, auto_init: true, description: "White-labeled build components." },
    )) as { default_branch?: string };
    createdRepo = true;
    defaultBranch = created.default_branch || "main";
  } else {
    const detail = (await existing.text().catch(() => "")).slice(0, 300);
    const code = existing.status === 401 || existing.status === 403 ? "auth.failed" : "network";
    throw new AppError(`GitHub repo lookup failed (${existing.status}). ${detail}`, code);
  }

  // 2) Blobs for every file.
  const tree: Array<{ path: string; mode: "100644"; type: "blob"; sha: string }> = [];
  for (const [path, bytes] of Object.entries(files)) {
    const blob = (await gh("POST", `/repos/${owner}/${repo}/git/blobs`, {
      content: b64(bytes),
      encoding: "base64",
    })) as { sha: string };
    tree.push({ path, mode: "100644", type: "blob", sha: blob.sha });
  }

  // 3) Base commit/tree, if the branch already has history (auto_init or prior export).
  let baseCommitSha: string | undefined;
  let baseTreeSha: string | undefined;
  const refRes = await fetchImpl(`${api}/repos/${owner}/${repo}/git/ref/heads/${defaultBranch}`, {
    method: "GET",
    headers,
  });
  if (refRes.ok) {
    baseCommitSha = ((await refRes.json()) as { object?: { sha?: string } }).object?.sha;
    if (baseCommitSha) {
      const baseCommit = (await gh("GET", `/repos/${owner}/${repo}/git/commits/${baseCommitSha}`)) as {
        tree?: { sha?: string };
      };
      baseTreeSha = baseCommit.tree?.sha;
    }
  }

  // 4) Tree → commit → ref (create the ref for an empty repo, else fast-forward).
  const newTree = (await gh("POST", `/repos/${owner}/${repo}/git/trees`, {
    ...(baseTreeSha ? { base_tree: baseTreeSha } : {}),
    tree,
  })) as { sha: string };
  const commit = (await gh("POST", `/repos/${owner}/${repo}/git/commits`, {
    message: target.message,
    tree: newTree.sha,
    ...(baseCommitSha ? { parents: [baseCommitSha] } : {}),
  })) as { sha: string };
  if (baseCommitSha) {
    await gh("PATCH", `/repos/${owner}/${repo}/git/refs/heads/${defaultBranch}`, { sha: commit.sha, force: false });
  } else {
    await gh("POST", `/repos/${owner}/${repo}/git/refs`, { ref: `refs/heads/${defaultBranch}`, sha: commit.sha });
  }

  return {
    repoUrl: gitHubRepoUrl(target.host, owner, repo),
    commitSha: commit.sha,
    createdRepo,
    branch: defaultBranch,
    files: tree.length,
  };
}
