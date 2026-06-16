/**
 * Read-only context-source framework types (PLAN §9). Descriptors are
 * non-secret: credentials live in the keychain under
 * `context:<sourceId>:credential` and are referenced by id only.
 */

export type ContextSourceType =
  | "confluence"
  | "jira"
  | "ldap"
  | "mssql"
  | "postgres"
  | "mysql"
  | "mongodb"
  | "vertexai"
  | "powerbi"
  | "servicenow"
  | "splunk"
  | "splunkobs"
  | "grafana"
  | "m365copilot";
export type ContextDeployment = "cloud" | "datacenter";

/** Auth method descriptor persisted per source (ADR-0014/0015).
 *  ldap-simple = LDAP simple bind; ntlm = Windows Authentication (MSSQL);
 *  gcloud-sso = live token from the gcloud CLI's Google SSO session
 *  (nothing persisted — the keychain entry is a marker);
 *  az-sso = live token from the Azure CLI's `az login` session (same
 *  marker-only pattern — the no-admin-consent Power BI path);
 *  aad-sso = Microsoft 365 sign-in reused from a connected site (the
 *  keychain entry stores only the provider/cache handles, no secret). */
export type ContextAuthMethod =
  | "basic"
  | "pat"
  | "ldap-simple"
  | "ntlm"
  | "gcloud-sso"
  | "az-sso"
  | "aad-sso"
  | "snow-oauth"
  | "splunk-session"
  | "snow-session"
  | "sfx-token";

export interface ContextSource {
  /** Stable random id; also keys the keychain credential entry. */
  id: string;
  type: ContextSourceType;
  displayName: string;
  /** Short, unique, chat-friendly handle (e.g. "CMDB") — how users refer to
   *  the source in @sharepoint chat. Matched case-insensitively. */
  alias?: string;
  /** User-authored one-liner on what the source contains; shown to the
   *  model so it picks the right source for a question. */
  description?: string;
  /** HTTP base for Confluence/Jira; ldap(s):// server URL for LDAP. */
  baseUrl: string;
  /** LDAP search base, e.g. DC=corp,DC=example,DC=com (LDAP sources only). */
  baseDn?: string;
  deployment: ContextDeployment;
  /** The method that verified successfully on connect (ADR-0015). */
  authMethod: ContextAuthMethod;
  addedAt: string;
  lastVerifiedAt?: string;
  /** Account hint from verification (display only, e.g. "jdoe"). */
  account?: string;
  /** Lifecycle role (parallels SiteConnection.role). "managed" targets (e.g. a
   *  Confluence space we actively manage) show under Managed Sites; absent or
   *  "reference" = read-only context under Reference Sources. */
  role?: "managed" | "reference";
  /** MANAGED Confluence only: the space/page the user onboarded, which bounds
   *  MUTATING operations (page write, archive, remove-from-search). Reads,
   *  ownership lookup and owner notifications are global and ignore this — the
   *  connector's baseUrl always points at the instance root so those span all
   *  of Confluence (ADR-0040). */
  writeScope?: ConfluenceWriteScope;
}

/** The write boundary of a managed Confluence connector. "instance" = the
 *  whole site (no boundary); "space"/"page" = the onboarded target. Derived
 *  from the onboarding URL; see adapters/confluenceScope. */
export interface ConfluenceWriteScope {
  kind: "instance" | "space" | "page";
  /** Space key — includes a leading "~" for a personal space. */
  spaceKey?: string;
  pageId?: string;
  /** The human URL the scope was derived from (display only). */
  url?: string;
}

/** Credential JSON stored in the keychain (never in the descriptor). */
export interface ContextCredential {
  method: ContextAuthMethod;
  /** Basic: username/email. PAT: unused. */
  username?: string;
  /** Basic: password or API token. PAT: the token. */
  secret: string;
}

/** Named, non-secret pointer to a reusable query/location (ADR-0010). */
export interface ContextBookmark {
  id: string;
  sourceId: string;
  name: string;
  /** Raw locator: a CQL/JQL string, page id, issue key, space key… */
  locator: string;
  kind: "query" | "item" | "container";
}

export interface ContextSearchHit {
  title: string;
  url: string;
  /** Short plain-text excerpt (HTML stripped, length-capped). */
  excerpt?: string;
  /** Source-specific extras (status, space, assignee…), small + flat. */
  meta?: Record<string, string>;
}

export interface ContextItem {
  title: string;
  url: string;
  body: string;
  meta?: Record<string, string>;
}

/** ADR-0012 read-safety caps applied to every adapter call. */
export interface ReadCaps {
  maxResults: number;
  maxBodyChars: number;
  timeoutMs: number;
}

export const DEFAULT_CAPS: ReadCaps = {
  maxResults: 25,
  maxBodyChars: 8_000,
  timeoutMs: 30_000,
};

/** Project scope (Pillar 7): a named bundle of sources (bookmarks follow
 *  their sources) plus context for AI interactions. Non-secret; travels with
 *  the reference-config export. USER-DEFINED context (goals, instructions) is
 *  kept strictly separate from AI-MANAGED context (aiContext), which the
 *  assistant appends to as the user teaches it expected behavior. */
export interface Project {
  id: string;
  name: string;
  description?: string;
  /** User-defined goals/objectives for the project. */
  goals?: string;
  /** User-defined baseline instructions & common reference context. */
  instructions?: string;
  /** AI-managed saved context: learnings the assistant persists (via the
   *  remember tool) across sessions. Never written by the user-edit flow;
   *  managed separately and resettable. */
  aiContext?: string;
  sourceIds: string[];
}

export const INSTRUCTIONS_MAX_CHARS = 2_000;
export const GOALS_MAX_CHARS = 1_000;
export const AI_CONTEXT_MAX_CHARS = 4_000;

/** Append one AI-learned note to a project's AI context (a bulleted log),
 *  trimming the oldest entries when it would exceed the cap. Pure. */
export function appendAiNote(
  existing: string | undefined,
  note: string,
  max = AI_CONTEXT_MAX_CHARS,
): string {
  const clean = note.trim().replace(/\s+/g, " ").slice(0, 400);
  if (!clean) return existing ?? "";
  const lines = (existing ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  lines.push(`- ${clean}`);
  let out = lines.join("\n");
  while (out.length > max && lines.length > 1) {
    lines.shift();
    out = lines.join("\n");
  }
  return out.slice(-max);
}
