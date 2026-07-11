import { ContextSource, ContextCredential, JiraWriteScope } from "../types";
import { fetchJson } from "../http";
import { AppError } from "../../core/errors";
import { EXTENSION_VERSION } from "../../core/version";

/**
 * Jira write client (MANAGED Jira — the Confluence-write sibling): update an
 * issue's fields, comment, and drive workflow transitions with the user's OWN
 * API token (Basic) or PAT (Bearer) — the same credential the read adapter
 * uses, so no admin OAuth consent is ever needed. Writes succeed with exactly
 * the project permissions the user already holds in Jira.
 *
 * Deliberately on REST **v2**: /rest/api/2 is served by BOTH Cloud and Data
 * Center/Server, and v2 accepts a plain-text / wiki-markup `description` and
 * comment `body`. The Cloud-only v3 requires Atlassian Document Format (ADF)
 * JSON for those fields — staying on v2 keeps one code path and one body
 * shape across deployments.
 *
 * ADR-0040 parity: reads/search (JQL) stay global; the connector's
 * `jiraWriteScope` bounds MUTATING operations only (see
 * {@link assertIssueInWriteScope}).
 */

const enc = encodeURIComponent;
const base = (source: Pick<ContextSource, "baseUrl">): string => source.baseUrl.replace(/\/+$/, "");

/**
 * Headers for every Jira WRITE — the same CSRF discipline as
 * CONFLUENCE_WRITE_HEADERS (see adapters/confluenceWrite for the full story):
 * Atlassian's XSRF filter also guards Jira Data Center/Server REST writes, and
 * it applies the STRICTER Origin/Referer validation when the request carries a
 * BROWSER User-Agent (which Electron fetch sends). "X-Atlassian-Token:
 * no-check" plus a NON-browser User-Agent reproduces what the Atlassian Python
 * client sends and is what lets programmatic non-GET calls through; Cloud
 * ignores both harmlessly. The http layer additionally presents a same-origin
 * Referer on every non-GET.
 */
export const JIRA_WRITE_HEADERS: Record<string, string> = {
  "X-Atlassian-Token": "no-check",
  "User-Agent": `ai-toolkit-jira/${EXTENSION_VERSION}`,
};

export interface JiraIssueSnapshot {
  /** The issue's CURRENT project key (authoritative — from the server). */
  projectKey: string;
  summary: string;
  statusName: string;
}

/**
 * Resolve where an issue REALLY lives right now — the fail-closed input for
 * every write-scope check. Never trust the issue-key prefix ("ENG-42" ⇒
 * project ENG): issues move between projects and keep their old key, so the
 * prefix can name a project the write scope doesn't cover (or vice versa).
 * Also returns the current summary/status so write previews can show
 * old → new. A global READ — never bounded by the write scope.
 */
export async function getJiraIssueProject(
  source: ContextSource,
  credential: ContextCredential,
  issueKey: string,
  timeoutMs: number,
): Promise<JiraIssueSnapshot> {
  const res = await fetchJson<{
    key?: string;
    fields?: { project?: { key?: string }; summary?: string; status?: { name?: string } };
  }>(
    `${base(source)}/rest/api/2/issue/${enc(issueKey.trim())}?fields=project,summary,status`,
    credential,
    timeoutMs,
  );
  const projectKey = res?.fields?.project?.key;
  if (!projectKey) {
    // Fail CLOSED: without an authoritative project the scope guard can't run.
    throw new AppError(
      `Jira did not return the project of issue "${issueKey}" — refusing to write without it (the write-scope check needs the issue's real project).`,
      "unknown",
    );
  }
  return {
    projectKey,
    summary: res.fields?.summary ?? "",
    statusName: res.fields?.status?.name ?? "",
  };
}

/**
 * Pure write-scope guard for a Jira mutation. "instance" permits any issue;
 * "project" requires the issue's RESOLVED project key (from
 * {@link getJiraIssueProject} — never the key prefix) to match,
 * case-insensitively. NO scope at all fails CLOSED: a connector without a
 * write boundary is read-only — reads/search are unaffected (ADR-0040).
 */
export function assertIssueInWriteScope(
  scope: JiraWriteScope | undefined,
  issueProjectKey: string,
): void {
  if (!scope) {
    throw new AppError(
      "This Jira connector is read-only — re-onboard it as managed (or set a write scope) to enable ticket updates. Reads and JQL search are unaffected.",
      "config",
    );
  }
  if (scope.kind === "instance") return;
  const want = (scope.projectKey ?? "").trim();
  if (!want) {
    // A project scope missing its key is malformed — fail closed, don't widen.
    throw new AppError(
      "This managed Jira connector's write scope names no project key — writes are disabled until the scope is fixed (re-onboard it as managed).",
      "config",
    );
  }
  if (want.toLowerCase() !== issueProjectKey.trim().toLowerCase()) {
    throw new AppError(
      `This managed Jira connector may only write within ${describeJiraWriteScope(scope)} — refused (the issue lives in project "${issueProjectKey}"). Reads and JQL search across all of Jira are unaffected.`,
      "config",
    );
  }
}

/** Human-readable description of a Jira write boundary, for tooltips,
 *  confirmations and the refusal message. Pure. */
export function describeJiraWriteScope(scope: JiraWriteScope | undefined): string {
  if (!scope) return "nothing (read-only — no write scope)";
  if (scope.kind === "instance") return "the entire Jira instance";
  return `the "${scope.projectKey ?? "?"}" project`;
}

/**
 * Build the confirmation body a user must approve before ANY Jira mutation
 * (field update, comment, transition). Like its Confluence sibling it ALWAYS
 * surfaces the instance URL and the connector's write scope on top of the
 * op-specific lines, so the user verifies WHERE the change lands. Pure (no
 * vscode); the tool layer wraps the text in a MarkdownString.
 */
export function jiraWriteConfirmationText(
  target: Pick<ContextSource, "baseUrl" | "jiraWriteScope"> | undefined,
  ref: string | undefined,
  opLines: string[],
): string {
  const head: string[] = [];
  if (target) {
    head.push(`**Jira instance:** ${target.baseUrl}`);
    const ws = target.jiraWriteScope;
    if (ws?.kind === "project" && ws.projectKey) {
      head.push(`**Project (connector write scope):** \`${ws.projectKey}\``);
    } else if (ws?.kind === "instance") {
      head.push(`**Write scope:** the ENTIRE instance — not bounded to one project`);
    } else {
      head.push(`**Write scope:** none — this connector is READ-ONLY and the write will be refused`);
    }
  } else {
    head.push(`**Source:** ${ref ?? "the configured Jira source"}`);
  }
  return [
    ...head,
    ...opLines,
    "",
    "Verify the **issue** and **URL** above before approving — this writes to Jira with your own API token.",
  ].join("\n");
}

export interface JiraIssueFieldUpdate {
  summary?: string;
  description?: string;
  labels?: string[];
}

/** PUT /issue/{key} request body — ONLY the provided fields, so an update
 *  never clobbers a field the user didn't ask to change. Pure, testable. */
export function buildJiraUpdateBody(update: JiraIssueFieldUpdate): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    ...(update.summary !== undefined ? { summary: update.summary } : {}),
    ...(update.description !== undefined ? { description: update.description } : {}),
    ...(update.labels !== undefined ? { labels: update.labels } : {}),
  };
  return { fields };
}

/** Update an issue's summary/description/labels (only the provided ones).
 *  v2 takes description as plain text / wiki markup on both deployments. */
export async function updateJiraIssueFields(
  source: ContextSource,
  credential: ContextCredential,
  issueKey: string,
  update: JiraIssueFieldUpdate,
  timeoutMs: number,
): Promise<void> {
  if (update.summary === undefined && update.description === undefined && update.labels === undefined) {
    throw new AppError("Nothing to update — provide a summary, description, and/or labels.", "config");
  }
  await fetchJson<unknown>(
    `${base(source)}/rest/api/2/issue/${enc(issueKey.trim())}`,
    credential,
    timeoutMs,
    JIRA_WRITE_HEADERS,
    { method: "PUT", body: buildJiraUpdateBody(update) },
  );
}

/** Add a comment to an issue (v2: plain text / wiki markup body). */
export async function addJiraComment(
  source: ContextSource,
  credential: ContextCredential,
  issueKey: string,
  body: string,
  timeoutMs: number,
): Promise<{ id: string }> {
  if (!body.trim()) throw new AppError("A Jira comment needs a body.", "config");
  const res = await fetchJson<{ id?: string }>(
    `${base(source)}/rest/api/2/issue/${enc(issueKey.trim())}/comment`,
    credential,
    timeoutMs,
    JIRA_WRITE_HEADERS,
    { method: "POST", body: { body } },
  );
  return { id: String(res?.id ?? "") };
}

export interface JiraTransition {
  id: string;
  name: string;
  /** The status the issue lands in after this transition. */
  toName: string;
}

/** Transitions available on the issue RIGHT NOW for THIS account (a read). */
export async function listJiraTransitions(
  source: ContextSource,
  credential: ContextCredential,
  issueKey: string,
  timeoutMs: number,
): Promise<JiraTransition[]> {
  const res = await fetchJson<{
    transitions?: Array<{ id?: string | number; name?: string; to?: { name?: string } }>;
  }>(
    `${base(source)}/rest/api/2/issue/${enc(issueKey.trim())}/transitions`,
    credential,
    timeoutMs,
  );
  return (res?.transitions ?? [])
    .filter((t) => t.id !== undefined && t.id !== null)
    .map((t) => ({
      id: String(t.id),
      name: t.name ?? "",
      toName: t.to?.name ?? "",
    }));
}

/** Match a model/user-supplied transition reference against the live list —
 *  by id, by transition name, or by the TARGET status name ("Done"), all
 *  case-insensitive. Pure. */
export function matchTransition(
  transitions: JiraTransition[],
  ref: string,
): JiraTransition | undefined {
  const q = ref.trim().toLowerCase();
  if (!q) return undefined;
  return (
    transitions.find((t) => t.id === ref.trim()) ??
    transitions.find((t) => t.name.toLowerCase() === q) ??
    transitions.find((t) => t.toName.toLowerCase() === q)
  );
}

/** Apply a workflow transition by id. */
export async function transitionJiraIssueTo(
  source: ContextSource,
  credential: ContextCredential,
  issueKey: string,
  transitionId: string,
  timeoutMs: number,
): Promise<void> {
  await fetchJson<unknown>(
    `${base(source)}/rest/api/2/issue/${enc(issueKey.trim())}/transitions`,
    credential,
    timeoutMs,
    JIRA_WRITE_HEADERS,
    { method: "POST", body: { transition: { id: transitionId } } },
  );
}

/** Validate a project key exists (and is visible to this account) —
 *  GET /project/{key}, served by both deployments. Returns the server's
 *  canonical key/name (fixes the user's casing). */
export async function getJiraProject(
  source: Pick<ContextSource, "baseUrl">,
  credential: ContextCredential,
  projectKey: string,
  timeoutMs: number,
): Promise<{ key: string; name: string }> {
  const res = await fetchJson<{ key?: string; name?: string }>(
    `${base(source)}/rest/api/2/project/${enc(projectKey.trim())}`,
    credential,
    timeoutMs,
  );
  if (!res?.key) throw new AppError(`Jira project "${projectKey}" was not found.`, "graph.notFound");
  return { key: res.key, name: res.name ?? res.key };
}

/** The three permissions the managed-Jira write tools exercise. */
export const JIRA_WRITE_PERMISSIONS = ["EDIT_ISSUES", "ADD_COMMENTS", "TRANSITION_ISSUES"] as const;

/**
 * Best-effort write-permission probe for onboarding:
 * GET /mypermissions?permissions=… — Cloud REQUIRES the `permissions` query
 * parameter (it 400s without one); Data Center tolerates it. `projectKey`
 * scopes the answer to the onboarded project when there is one. Returns the
 * permissions that came back NOT granted, so the wizard can warn (never
 * block — the probe itself may be unavailable to some accounts).
 */
export async function probeJiraWritePermissions(
  source: Pick<ContextSource, "baseUrl">,
  credential: ContextCredential,
  projectKey: string | undefined,
  timeoutMs: number,
): Promise<{ missing: string[] }> {
  const params = new URLSearchParams();
  params.set("permissions", JIRA_WRITE_PERMISSIONS.join(","));
  if (projectKey?.trim()) params.set("projectKey", projectKey.trim());
  const res = await fetchJson<{
    permissions?: Record<string, { havePermission?: boolean }>;
  }>(`${base(source)}/rest/api/2/mypermissions?${params.toString()}`, credential, timeoutMs);
  const perms = res?.permissions ?? {};
  const missing = JIRA_WRITE_PERMISSIONS.filter((p) => perms[p]?.havePermission !== true);
  return { missing: [...missing] };
}
