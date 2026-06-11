import {
  ContextSource,
  ContextCredential,
  ContextSearchHit,
  ContextItem,
  ReadCaps,
} from "../types";
import { fetchJson } from "../http";

/**
 * Jira adapter — Cloud (Basic email+API token) and Data Center (PAT Bearer
 * or Basic). REST v2 (served by both deployments), read-only, capped.
 */

const enc = encodeURIComponent;

interface Issue {
  key: string;
  fields?: {
    summary?: string;
    status?: { name?: string };
    assignee?: { displayName?: string } | null;
    issuetype?: { name?: string };
    priority?: { name?: string };
    description?: string | { content?: unknown };
    updated?: string;
  };
}

function issueUrl(source: ContextSource, key: string): string {
  return `${source.baseUrl.replace(/\/$/, "")}/browse/${key}`;
}

function plainDescription(d: Issue["fields"] extends infer F ? (F extends { description?: infer D } ? D : never) : never, max: number): string {
  if (typeof d === "string") {
    return d.length > max ? `${d.slice(0, max)}…` : d;
  }
  if (d && typeof d === "object") {
    // Cloud may return ADF on some endpoints — flatten text nodes crudely.
    const text = JSON.stringify(d).match(/"text":"((?:[^"\\]|\\.)*)"/g)
      ?.map((m) => JSON.parse(`{${m}}`).text)
      .join(" ") ?? "";
    return text.length > max ? `${text.slice(0, max)}…` : text;
  }
  return "";
}

/** Single deliberate verification read (ADR-0009 verify-on-connect). */
export async function verifyJira(
  source: Pick<ContextSource, "baseUrl">,
  credential: ContextCredential,
  caps: ReadCaps,
): Promise<{ account: string }> {
  const me = await fetchJson<{ name?: string; displayName?: string; emailAddress?: string }>(
    `${source.baseUrl.replace(/\/$/, "")}/rest/api/2/myself`,
    credential,
    caps.timeoutMs,
  );
  return { account: me.name ?? me.displayName ?? "verified" };
}

/** JQL search (raw JQL, or free text wrapped in a text ~ query). */
export async function searchJira(
  source: ContextSource,
  credential: ContextCredential,
  query: string,
  caps: ReadCaps,
): Promise<ContextSearchHit[]> {
  const looksLikeJql = /[=~]|\border by\b|\bAND\b|\bOR\b/i.test(query);
  const jql = looksLikeJql ? query : `text ~ "${query.replace(/"/g, '\\"')}" order by updated desc`;
  const res = await fetchJson<{ issues?: Issue[] }>(
    `${source.baseUrl.replace(/\/$/, "")}/rest/api/2/search?jql=${enc(jql)}&maxResults=${caps.maxResults}&fields=summary,status,assignee,issuetype,priority,updated`,
    credential,
    caps.timeoutMs,
  );
  return (res.issues ?? []).slice(0, caps.maxResults).map((i) => ({
    title: `${i.key}: ${i.fields?.summary ?? ""}`.trim(),
    url: issueUrl(source, i.key),
    meta: {
      status: i.fields?.status?.name ?? "",
      type: i.fields?.issuetype?.name ?? "",
      assignee: i.fields?.assignee?.displayName ?? "unassigned",
      ...(i.fields?.priority?.name ? { priority: i.fields.priority.name } : {}),
    },
  }));
}

/** Fetch one issue with a plain-text description. */
export async function getJiraIssue(
  source: ContextSource,
  credential: ContextCredential,
  issueKey: string,
  caps: ReadCaps,
): Promise<ContextItem> {
  const issue = await fetchJson<Issue>(
    `${source.baseUrl.replace(/\/$/, "")}/rest/api/2/issue/${enc(issueKey)}?fields=summary,status,assignee,issuetype,priority,description,updated`,
    credential,
    caps.timeoutMs,
  );
  return {
    title: `${issue.key}: ${issue.fields?.summary ?? ""}`.trim(),
    url: issueUrl(source, issue.key),
    body: plainDescription(issue.fields?.description as never, caps.maxBodyChars),
    meta: {
      status: issue.fields?.status?.name ?? "",
      type: issue.fields?.issuetype?.name ?? "",
      assignee: issue.fields?.assignee?.displayName ?? "unassigned",
      ...(issue.fields?.updated ? { updated: issue.fields.updated } : {}),
    },
  };
}
