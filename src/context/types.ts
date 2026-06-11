/**
 * Read-only context-source framework types (PLAN §9). Descriptors are
 * non-secret: credentials live in the keychain under
 * `context:<sourceId>:credential` and are referenced by id only.
 */

export type ContextSourceType = "confluence" | "jira";
export type ContextDeployment = "cloud" | "datacenter";

/** Auth method descriptor persisted per source (ADR-0014/0015). */
export type ContextAuthMethod = "basic" | "pat";

export interface ContextSource {
  /** Stable random id; also keys the keychain credential entry. */
  id: string;
  type: ContextSourceType;
  displayName: string;
  /** e.g. https://x.atlassian.net/wiki (Confluence Cloud) or https://confluence.corp.example */
  baseUrl: string;
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
