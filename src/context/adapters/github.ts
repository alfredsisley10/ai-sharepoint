import {
  ContextSource,
  ContextCredential,
  ContextSearchHit,
  ContextItem,
  ReadCaps,
} from "../types";
import { fetchJson } from "../http";

/**
 * GitHub adapter — read-only. Works for github.com (SaaS) and GitHub Enterprise
 * Server (on-prem) alike; the only difference is the REST base URL, derived from
 * the source's deployment. Authenticates with a Personal Access Token (Bearer),
 * stored in the OS keychain like every other reference source — so searching
 * GitHub never touches the git credential manager.
 *
 * Search spans GitHub's four search corpora: code, issues & pull requests,
 * repositories, and commits. Item fetch addresses one issue/PR, commit, file, or
 * repository. All reads are capped (ADR-0012) and lockout-protected (ADR-0009).
 */

const enc = encodeURIComponent;

/** GitHub recommends pinning the API version and the v3 JSON media type. */
const GH_HEADERS: Record<string, string> = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
};

/** GitHub's Search API caps per_page at 100 regardless of our read window. */
const GH_MAX_PER_PAGE = 100;

export type GithubSearchType = "code" | "issues" | "repositories" | "commits";
const SEARCH_TYPES: readonly GithubSearchType[] = ["code", "issues", "repositories", "commits"];

/**
 * REST base for a source: github.com → api.github.com; GitHub Enterprise Server
 * → `<instance host>/api/v3`. The source's baseUrl is the browser host the user
 * onboarded (e.g. https://github.com or https://github.corp.example).
 */
export function githubApiBase(source: Pick<ContextSource, "baseUrl" | "deployment">): string {
  const base = source.baseUrl.replace(/\/+$/, "");
  if (source.deployment === "cloud") return "https://api.github.com";
  try {
    const u = new URL(base);
    return `${u.protocol}//${u.host}/api/v3`;
  } catch {
    return `${base}/api/v3`;
  }
}

export interface GithubQuery {
  type: GithubSearchType;
  q: string;
  limit?: number;
}

/**
 * Parse a search query into a corpus + GitHub query string. Three shapes:
 *  - JSON spec: {"type":"code|issues|repositories|commits","q":"…","limit":n}
 *  - leading selector: "code: parseUser", "repos: payments", "commits: hotfix"
 *    (issues/PRs is the default, so "is:open label:bug" needs no selector)
 *  - plain text → searched as issues & pull requests
 * GitHub's own qualifiers (repo:, org:, is:, in:, language:, author:…) pass
 * through untouched in `q`.
 */
export function parseGithubQuery(raw: string): GithubQuery {
  const trimmed = (raw ?? "").trim();
  if (trimmed.startsWith("{")) {
    try {
      const spec = JSON.parse(trimmed) as { type?: string; q?: string; query?: string; limit?: number };
      const type = SEARCH_TYPES.includes(spec.type as GithubSearchType)
        ? (spec.type as GithubSearchType)
        : "issues";
      const q = String(spec.q ?? spec.query ?? "").trim();
      return { type, q, ...(typeof spec.limit === "number" ? { limit: spec.limit } : {}) };
    } catch {
      // not JSON — fall through to text handling
    }
  }
  const sel = /^(code|issues|issue|prs|pulls|repos|repositories|repo|commits|commit)\s*:\s*([\s\S]+)$/i.exec(trimmed);
  if (sel) {
    const k = sel[1].toLowerCase();
    const type: GithubSearchType =
      k === "code"
        ? "code"
        : k === "commits" || k === "commit"
          ? "commits"
          : k === "repos" || k === "repositories" || k === "repo"
            ? "repositories"
            : "issues";
    return { type, q: sel[2].trim() };
  }
  return { type: "issues", q: trimmed };
}

function clampPerPage(caps: ReadCaps, limit?: number): number {
  return Math.max(1, Math.min(limit ?? caps.maxResults, caps.maxResults, GH_MAX_PER_PAGE));
}

/** Collapse whitespace and cap — for model-facing excerpts/bodies (Markdown). */
function snippet(text: string | undefined | null, max: number): string {
  const t = (text ?? "").replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** "owner/name" from a REST repository_url like .../repos/owner/name. */
function repoFromUrl(url: string | undefined): string {
  const m = /\/repos\/([^/]+\/[^/]+?)(?:$|\/)/.exec(url ?? "");
  return m ? m[1] : "";
}

interface CodeItem {
  name?: string;
  path?: string;
  html_url?: string;
  repository?: { full_name?: string };
}
interface IssueItem {
  title?: string;
  html_url?: string;
  number?: number;
  state?: string;
  body?: string;
  user?: { login?: string };
  labels?: Array<{ name?: string } | string>;
  pull_request?: unknown;
  repository_url?: string;
  updated_at?: string;
}
interface RepoItem {
  full_name?: string;
  html_url?: string;
  description?: string;
  language?: string;
  visibility?: string;
  private?: boolean;
  pushed_at?: string;
  stargazers_count?: number;
}
interface CommitItem {
  sha?: string;
  html_url?: string;
  commit?: { message?: string; author?: { name?: string; date?: string } };
  repository?: { full_name?: string };
}

function labelNames(labels: IssueItem["labels"]): string {
  return (labels ?? [])
    .map((l) => (typeof l === "string" ? l : (l?.name ?? "")))
    .filter(Boolean)
    .join(", ");
}

function mapHit(type: GithubSearchType, raw: unknown): ContextSearchHit {
  if (type === "code") {
    const it = raw as CodeItem;
    const repo = it.repository?.full_name ?? "";
    return {
      title: `${repo}${repo && it.path ? " · " : ""}${it.path ?? it.name ?? ""}`.trim() || (it.html_url ?? "code"),
      url: it.html_url ?? "",
      meta: { kind: "code", ...(repo ? { repo } : {}), ...(it.path ? { path: it.path } : {}) },
    };
  }
  if (type === "repositories") {
    const it = raw as RepoItem;
    return {
      title: it.full_name ?? it.html_url ?? "repository",
      url: it.html_url ?? "",
      excerpt: snippet(it.description, 200) || undefined,
      meta: {
        kind: "repository",
        ...(it.language ? { language: it.language } : {}),
        visibility: it.visibility ?? (it.private ? "private" : "public"),
        ...(it.pushed_at ? { pushed: it.pushed_at } : {}),
        ...(typeof it.stargazers_count === "number" ? { stars: String(it.stargazers_count) } : {}),
      },
    };
  }
  if (type === "commits") {
    const it = raw as CommitItem;
    const repo = it.repository?.full_name ?? "";
    const sha = (it.sha ?? "").slice(0, 7);
    const firstLine = (it.commit?.message ?? "").split("\n")[0];
    return {
      title: `${repo ? `${repo}@` : ""}${sha}${firstLine ? `: ${firstLine}` : ""}`.trim() || "commit",
      url: it.html_url ?? "",
      excerpt: snippet(it.commit?.message, 200) || undefined,
      meta: {
        kind: "commit",
        ...(repo ? { repo } : {}),
        ...(it.sha ? { sha: it.sha } : {}),
        ...(it.commit?.author?.name ? { author: it.commit.author.name } : {}),
        ...(it.commit?.author?.date ? { date: it.commit.author.date } : {}),
      },
    };
  }
  // issues & pull requests
  const it = raw as IssueItem;
  const repo = repoFromUrl(it.repository_url);
  const isPr = Boolean(it.pull_request);
  return {
    title: `${repo ? `${repo}` : ""}#${it.number ?? "?"} ${it.title ?? ""}`.trim(),
    url: it.html_url ?? "",
    excerpt: snippet(it.body, 200) || undefined,
    meta: {
      kind: isPr ? "pull-request" : "issue",
      ...(it.state ? { state: it.state } : {}),
      ...(repo ? { repo } : {}),
      ...(it.user?.login ? { author: it.user.login } : {}),
      ...(labelNames(it.labels) ? { labels: labelNames(it.labels) } : {}),
      ...(it.updated_at ? { updated: it.updated_at } : {}),
    },
  };
}

/** Single deliberate verification read (ADR-0009 verify-on-connect). */
export async function verifyGithub(
  source: Pick<ContextSource, "baseUrl" | "deployment">,
  credential: ContextCredential,
  caps: ReadCaps,
): Promise<{ account: string }> {
  const me = await fetchJson<{ login?: string; name?: string }>(
    `${githubApiBase(source)}/user`,
    credential,
    caps.timeoutMs,
    GH_HEADERS,
  );
  return { account: me.login ?? me.name ?? "verified" };
}

/** Search code / issues & PRs / repositories / commits (capped). */
export async function searchGithub(
  source: ContextSource,
  credential: ContextCredential,
  query: string,
  caps: ReadCaps,
): Promise<ContextSearchHit[]> {
  const { type, q, limit } = parseGithubQuery(query);
  if (!q) return [];
  const perPage = clampPerPage(caps, limit);
  const res = await fetchJson<{ items?: unknown[] }>(
    `${githubApiBase(source)}/search/${type}?q=${enc(q)}&per_page=${perPage}`,
    credential,
    caps.timeoutMs,
    GH_HEADERS,
  );
  return (res.items ?? []).slice(0, perPage).map((it) => mapHit(type, it));
}

export interface GithubItemRef {
  kind: "issue" | "commit" | "file" | "repo";
  owner: string;
  repo: string;
  number?: number;
  sha?: string;
  path?: string;
  ref?: string;
}

/**
 * Parse an item locator:
 *  - issue / pull request: `owner/repo#123`
 *  - commit:               `owner/repo@<sha>`
 *  - file:                 `owner/repo:path/to/file` (optionally `@<ref>`)
 *  - repository:           `owner/repo`
 */
export function parseGithubItemRef(id: string): GithubItemRef | undefined {
  const s = (id ?? "").trim();
  let m = /^([^/\s]+)\/([^/\s#:@]+):([^@]+)(?:@(.+))?$/.exec(s);
  if (m) return { kind: "file", owner: m[1], repo: m[2], path: m[3].replace(/^\/+/, ""), ...(m[4] ? { ref: m[4].trim() } : {}) };
  m = /^([^/\s]+)\/([^/\s#:@]+)#(\d+)$/.exec(s);
  if (m) return { kind: "issue", owner: m[1], repo: m[2], number: Number(m[3]) };
  m = /^([^/\s]+)\/([^/\s#:@]+)@([0-9a-fA-F]{7,40})$/.exec(s);
  if (m) return { kind: "commit", owner: m[1], repo: m[2], sha: m[3] };
  m = /^([^/\s]+)\/([^/\s#:@]+)$/.exec(s);
  if (m) return { kind: "repo", owner: m[1], repo: m[2] };
  return undefined;
}

/** Fetch one issue/PR, commit, file, or repository as a plain-text item. */
export async function getGithubItem(
  source: ContextSource,
  credential: ContextCredential,
  id: string,
  caps: ReadCaps,
): Promise<ContextItem> {
  const ref = parseGithubItemRef(id);
  if (!ref) {
    throw new Error(
      `Unrecognized GitHub item id "${id}". Use owner/repo#123 (issue/PR), owner/repo@sha (commit), owner/repo:path (file), or owner/repo (repository).`,
    );
  }
  const api = githubApiBase(source);
  const repoFull = `${ref.owner}/${ref.repo}`;

  if (ref.kind === "issue") {
    const it = await fetchJson<IssueItem>(
      `${api}/repos/${enc(ref.owner)}/${enc(ref.repo)}/issues/${ref.number}`,
      credential,
      caps.timeoutMs,
      GH_HEADERS,
    );
    return {
      title: `${repoFull}#${it.number ?? ref.number} ${it.title ?? ""}`.trim(),
      url: it.html_url ?? "",
      body: snippet(it.body, caps.maxBodyChars),
      meta: {
        kind: it.pull_request ? "pull-request" : "issue",
        ...(it.state ? { state: it.state } : {}),
        ...(it.user?.login ? { author: it.user.login } : {}),
        ...(labelNames(it.labels) ? { labels: labelNames(it.labels) } : {}),
      },
    };
  }

  if (ref.kind === "commit") {
    const it = await fetchJson<
      CommitItem & { stats?: { additions?: number; deletions?: number }; files?: Array<{ filename?: string; status?: string }> }
    >(`${api}/repos/${enc(ref.owner)}/${enc(ref.repo)}/commits/${enc(ref.sha!)}`, credential, caps.timeoutMs, GH_HEADERS);
    const files = (it.files ?? []).map((f) => `${f.status ?? "changed"} ${f.filename ?? ""}`.trim()).filter(Boolean);
    const body = snippet(
      [it.commit?.message ?? "", files.length ? `\nFiles:\n${files.join("\n")}` : ""].join("").trim(),
      caps.maxBodyChars,
    );
    return {
      title: `${repoFull}@${(it.sha ?? ref.sha ?? "").slice(0, 7)}: ${(it.commit?.message ?? "").split("\n")[0]}`.trim(),
      url: it.html_url ?? "",
      body,
      meta: {
        kind: "commit",
        ...(it.commit?.author?.name ? { author: it.commit.author.name } : {}),
        ...(it.commit?.author?.date ? { date: it.commit.author.date } : {}),
        ...(typeof it.stats?.additions === "number" ? { additions: String(it.stats.additions) } : {}),
        ...(typeof it.stats?.deletions === "number" ? { deletions: String(it.stats.deletions) } : {}),
      },
    };
  }

  if (ref.kind === "file") {
    const it = await fetchJson<{ content?: string; encoding?: string; html_url?: string; name?: string; size?: number }>(
      `${api}/repos/${enc(ref.owner)}/${enc(ref.repo)}/contents/${ref.path!.split("/").map(enc).join("/")}${ref.ref ? `?ref=${enc(ref.ref)}` : ""}`,
      credential,
      caps.timeoutMs,
      GH_HEADERS,
    );
    const decoded =
      it.encoding === "base64" && it.content
        ? Buffer.from(it.content.replace(/\n/g, ""), "base64").toString("utf8")
        : (it.content ?? "");
    return {
      title: `${repoFull}:${ref.path}`,
      url: it.html_url ?? "",
      body: snippet(decoded, caps.maxBodyChars),
      meta: {
        kind: "file",
        ...(ref.ref ? { ref: ref.ref } : {}),
        ...(typeof it.size === "number" ? { size: String(it.size) } : {}),
      },
    };
  }

  // repository
  const it = await fetchJson<
    RepoItem & { default_branch?: string; topics?: string[]; open_issues_count?: number }
  >(`${api}/repos/${enc(ref.owner)}/${enc(ref.repo)}`, credential, caps.timeoutMs, GH_HEADERS);
  return {
    title: it.full_name ?? repoFull,
    url: it.html_url ?? "",
    body: snippet(it.description, caps.maxBodyChars),
    meta: {
      kind: "repository",
      ...(it.language ? { language: it.language } : {}),
      visibility: it.visibility ?? (it.private ? "private" : "public"),
      ...(it.default_branch ? { defaultBranch: it.default_branch } : {}),
      ...(it.topics && it.topics.length ? { topics: it.topics.join(", ") } : {}),
      ...(it.pushed_at ? { pushed: it.pushed_at } : {}),
      ...(typeof it.stargazers_count === "number" ? { stars: String(it.stargazers_count) } : {}),
      ...(typeof it.open_issues_count === "number" ? { openIssues: String(it.open_issues_count) } : {}),
    },
  };
}
