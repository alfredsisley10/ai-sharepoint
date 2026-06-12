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
  | "splunk";
export type ContextDeployment = "cloud" | "datacenter";

/** Auth method descriptor persisted per source (ADR-0014/0015).
 *  ldap-simple = LDAP simple bind; ntlm = Windows Authentication (MSSQL);
 *  gcloud-sso = live token from the gcloud CLI's Google SSO session
 *  (nothing persisted — the keychain entry is a marker);
 *  aad-sso = Microsoft 365 sign-in reused from a connected site (the
 *  keychain entry stores only the provider/cache handles, no secret). */
export type ContextAuthMethod =
  | "basic"
  | "pat"
  | "ldap-simple"
  | "ntlm"
  | "gcloud-sso"
  | "aad-sso"
  | "snow-oauth"
  | "splunk-session";

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
 *  their sources) plus baseline agent instructions. Non-secret; travels
 *  with the reference-config export. */
export interface Project {
  id: string;
  name: string;
  description?: string;
  instructions?: string;
  sourceIds: string[];
}

export const INSTRUCTIONS_MAX_CHARS = 2_000;
