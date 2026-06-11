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
      key: i.key,
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

export interface JiraProjectInfo {
  key: string;
  name: string;
}

export interface JiraFilterInfo {
  name: string;
  jql: string;
}

export interface JsmQueueInfo {
  desk: string;
  name: string;
  jql: string;
}

/** Projects (capped) — each becomes a "project = KEY" query bookmark. */
/** Full project catalog for pre-caching. Cloud pages via /project/search
 *  (50/page, `checkpoint` between pages); Data Center returns the whole list
 *  in one call. */
export async function listAllJiraProjects(
  source: ContextSource,
  credential: ContextCredential,
  caps: ReadCaps,
  checkpoint: () => Promise<boolean>,
): Promise<{ projects: JiraProjectInfo[]; complete: boolean }> {
  const base = source.baseUrl.replace(/\/$/, "");
  if (source.deployment !== "cloud") {
    const res = await fetchJson<Array<{ key?: string; name?: string }>>(
      `${base}/rest/api/2/project`,
      credential,
      caps.timeoutMs,
    );
    return {
      projects: (Array.isArray(res) ? res : [])
        .filter((p) => p.key)
        .map((p) => ({ key: p.key!, name: p.name ?? p.key! })),
      complete: true,
    };
  }
  const pageSize = 50;
  const projects: JiraProjectInfo[] = [];
  for (let startAt = 0; projects.length < 10_000; startAt += pageSize) {
    const res = await fetchJson<{
      values?: Array<{ key?: string; name?: string }>;
      isLast?: boolean;
    }>(
      `${base}/rest/api/2/project/search?startAt=${startAt}&maxResults=${pageSize}`,
      credential,
      caps.timeoutMs,
    );
    for (const p of res.values ?? []) {
      if (p.key) projects.push({ key: p.key, name: p.name ?? p.key });
    }
    if (res.isLast !== false) return { projects, complete: true };
    if (!(await checkpoint())) return { projects, complete: false };
  }
  return { projects, complete: false };
}

export async function listJiraProjects(
  source: ContextSource,
  credential: ContextCredential,
  caps: ReadCaps,
): Promise<JiraProjectInfo[]> {
  const res = await fetchJson<Array<{ key?: string; name?: string }>>(
    `${source.baseUrl.replace(/\/$/, "")}/rest/api/2/project`,
    credential,
    caps.timeoutMs,
  );
  return (Array.isArray(res) ? res : [])
    .filter((p) => p.key)
    .slice(0, caps.maxResults)
    .map((p) => ({ key: p.key!, name: p.name ?? p.key! }));
}

/** The user's favourite saved filters — name + ready-made JQL. */
export async function listJiraFavouriteFilters(
  source: ContextSource,
  credential: ContextCredential,
  caps: ReadCaps,
): Promise<JiraFilterInfo[]> {
  const res = await fetchJson<Array<{ name?: string; jql?: string }>>(
    `${source.baseUrl.replace(/\/$/, "")}/rest/api/2/filter/favourite`,
    credential,
    caps.timeoutMs,
  );
  return (Array.isArray(res) ? res : [])
    .filter((f) => f.name && f.jql)
    .slice(0, caps.maxResults)
    .map((f) => ({ name: f.name!, jql: f.jql! }));
}

/** JSM queues (service desks expose each queue's JQL). Best-effort: plain
 *  Jira instances without Service Management return no queues — but every
 *  swallowed denial is reported in `note` so an empty browse is explainable
 *  (pilot: "no results despite having queue access").
 *
 *  The X-ExperimentalApi header is required on Data Center/Server, where the
 *  queue endpoint is flagged experimental and 403s without it; Cloud ignores
 *  the header. */
const JSM_HEADERS = { "X-ExperimentalApi": "opt-in" };

/** Full queue catalog for pre-caching: up to 50 desks (paged), `checkpoint`
 *  between every desk's queue fetch. Denials are noted, not fatal. */
export async function listAllJsmQueues(
  source: ContextSource,
  credential: ContextCredential,
  caps: ReadCaps,
  checkpoint: () => Promise<boolean>,
): Promise<{ queues: JsmQueueInfo[]; complete: boolean; note?: string }> {
  const base = source.baseUrl.replace(/\/$/, "");
  const desks: Array<{ id?: string; projectName?: string }> = [];
  try {
    for (let start = 0; desks.length < 50; start += 50) {
      const res = await fetchJson<{
        values?: Array<{ id?: string; projectName?: string }>;
        isLastPage?: boolean;
      }>(`${base}/rest/servicedeskapi/servicedesk?limit=50&start=${start}`, credential, caps.timeoutMs, JSM_HEADERS);
      desks.push(...(res.values ?? []));
      if (res.isLastPage !== false || (res.values ?? []).length === 0) break;
      if (!(await checkpoint())) return { queues: [], complete: false };
    }
  } catch (err) {
    return {
      queues: [],
      complete: true, // nothing more to fetch — not a JSM instance / no access
      note: `service-desk list unavailable (${err instanceof Error ? err.message : String(err)})`,
    };
  }
  const queues: JsmQueueInfo[] = [];
  let denied = 0;
  for (const desk of desks) {
    if (!desk.id) continue;
    try {
      const res = await fetchJson<{ values?: Array<{ name?: string; jql?: string }> }>(
        `${base}/rest/servicedeskapi/servicedesk/${encodeURIComponent(desk.id)}/queue?limit=50`,
        credential,
        caps.timeoutMs,
        JSM_HEADERS,
      );
      for (const q of res.values ?? []) {
        if (q.name && q.jql) {
          queues.push({ desk: desk.projectName ?? desk.id, name: q.name, jql: q.jql });
        }
      }
    } catch {
      denied += 1;
    }
    if (!(await checkpoint())) {
      return { queues, complete: false, ...(denied ? { note: `${denied} desk(s) denied` } : {}) };
    }
  }
  return { queues, complete: true, ...(denied ? { note: `${denied} desk(s) denied` } : {}) };
}

export async function listJsmQueues(
  source: ContextSource,
  credential: ContextCredential,
  caps: ReadCaps,
): Promise<{ queues: JsmQueueInfo[]; note?: string }> {
  const base = source.baseUrl.replace(/\/$/, "");
  let desks: Array<{ id?: string; projectName?: string }>;
  try {
    const res = await fetchJson<{ values?: Array<{ id?: string; projectName?: string }> }>(
      `${base}/rest/servicedeskapi/servicedesk?limit=10`,
      credential,
      caps.timeoutMs,
      JSM_HEADERS,
    );
    desks = res.values ?? [];
  } catch (err) {
    // Not a JSM instance, or no agent access.
    return {
      queues: [],
      note: `service-desk list unavailable (${err instanceof Error ? err.message : String(err)})`,
    };
  }
  if (desks.length === 0) {
    return { queues: [], note: "no service desks visible to this account" };
  }
  const queues: JsmQueueInfo[] = [];
  let denied = 0;
  let lastError = "";
  for (const desk of desks.slice(0, 5)) {
    if (!desk.id) continue;
    try {
      const res = await fetchJson<{ values?: Array<{ name?: string; jql?: string }> }>(
        `${base}/rest/servicedeskapi/servicedesk/${encodeURIComponent(desk.id)}/queue?limit=${caps.maxResults}`,
        credential,
        caps.timeoutMs,
        JSM_HEADERS,
      );
      for (const q of res.values ?? []) {
        if (q.name && q.jql) {
          queues.push({ desk: desk.projectName ?? desk.id, name: q.name, jql: q.jql });
        }
        if (queues.length >= caps.maxResults) return { queues };
      }
    } catch (err) {
      denied += 1;
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  return {
    queues,
    ...(denied > 0
      ? {
          note: `${desks.length} service desk(s) found but the queue API was denied on ${denied} (last: ${lastError}) — queue listing needs a JSM agent license`,
        }
      : {}),
  };
}
