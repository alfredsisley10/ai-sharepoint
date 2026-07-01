/**
 * Read-only context-source framework types (PLAN §9). Descriptors are
 * non-secret: credentials live in the keychain under
 * `context:<sourceId>:credential` and are referenced by id only.
 */

export type ContextSourceType =
  | "confluence"
  | "jira"
  | "github"
  | "ldap"
  | "mssql"
  | "postgres"
  | "mysql"
  | "mongodb"
  | "powerbi"
  | "servicenow"
  | "splunk"
  | "splunkobs"
  | "grafana"
  | "m365copilot";
export type ContextDeployment = "cloud" | "datacenter";

/** Which credential-entry UI a source type uses on connect AND reconnect.
 *  Microsoft Entra source types must NOT fall through to the generic prompt,
 *  whose cloud default is the Atlassian "account email" form — that crossed
 *  wiring once made the m365copilot reconnect ("plug") path ask for an
 *  Atlassian account when it should reuse the Microsoft 365 / Graph sign-in.
 *  Centralizing the decision here (consumed by one router) keeps the add wizard
 *  and the reconnect path from ever diverging on it again. */
export type ContextCredentialUi = "powerbi-aad" | "m365-graph" | "generic";
export function contextCredentialUi(type: ContextSourceType): ContextCredentialUi {
  switch (type) {
    case "powerbi":
      return "powerbi-aad";
    case "m365copilot":
      return "m365-graph";
    default:
      return "generic";
  }
}

/** Auth method descriptor persisted per source (ADR-0014/0015).
 *  ldap-simple = LDAP simple bind; ntlm = Windows Authentication (MSSQL);
 *  az-sso = live token from the Azure CLI's `az login` session (a
 *  marker-only pattern — the no-admin-consent Power BI path);
 *  aad-sso = Microsoft 365 sign-in reused from a connected site (the
 *  keychain entry stores only the provider/cache handles, no secret). */
export type ContextAuthMethod =
  | "basic"
  | "pat"
  | "github-oauth"
  | "github-app"
  | "ldap-simple"
  | "ntlm"
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

/** Result-window (maxResults) bounds — the read-safety cap is user-configurable
 *  (setting + mid-chat tool) but never unbounded (ADR-0012). */
export const MAX_RESULT_WINDOW = 200;

/** Query-timeout bounds (seconds). The base timeout is configurable; the
 *  cost-aware probe scaler may grant up to the ceiling for a legitimately large
 *  scan instead of dying at the flat default (#1). */
export const MIN_QUERY_TIMEOUT_SECONDS = 5;
export const MAX_QUERY_TIMEOUT_SECONDS = 600;
export const DEFAULT_QUERY_TIMEOUT_SECONDS = 30;

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
export const AI_CONTEXT_MAX_CHARS = 6_000;

/** Normalize a note for similarity comparison (lowercase, punctuation → space). */
function normForCompare(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

/** Content words (length > 2) of a note, for token-overlap similarity. */
function tokenSet(s: string): Set<string> {
  return new Set(normForCompare(s).split(" ").filter((w) => w.length > 2));
}

/**
 * Are two memory notes near-duplicates? Conservative: exact-normalized,
 * substring containment, or high token overlap (Jaccard ≥ threshold). Pure —
 * underpins dedup on remember and matching on forget.
 */
export function similarNote(a: string, b: string, threshold = 0.8): boolean {
  const na = normForCompare(a);
  const nb = normForCompare(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.length >= 8 && nb.length >= 8 && (na.includes(nb) || nb.includes(na))) return true;
  const ta = tokenSet(a);
  const tb = tokenSet(b);
  if (ta.size === 0 || tb.size === 0) return false;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union > 0 && inter / union >= threshold;
}

/** Parse a stored AI-context blob into individual note texts (bullets stripped). */
export function listNotes(existing: string | undefined): string[] {
  return (existing ?? "")
    .split("\n")
    .map((l) => l.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean);
}

/** Re-serialize notes to the bulleted blob, evicting the oldest (front) when
 *  over the character cap. */
function serializeNotes(notes: string[], max: number): string {
  const lines = notes.map((n) => `- ${n}`);
  let out = lines.join("\n");
  while (out.length > max && lines.length > 1) {
    lines.shift();
    out = lines.join("\n");
  }
  return out.slice(-max);
}

export interface RememberResult {
  text: string;
  status: "added" | "reinforced";
}

/**
 * Dedup-aware append (the heart of project memory): if a near-duplicate note
 * already exists, drop it and re-add the more-informative phrasing at the end —
 * "reinforced", so it moves to the front of the keep-queue and survives FIFO
 * eviction — instead of stacking duplicates that crowd out distinct learnings.
 * Otherwise append. Evicts the oldest when over the cap. Pure.
 */
export function rememberNote(
  existing: string | undefined,
  note: string,
  max = AI_CONTEXT_MAX_CHARS,
): RememberResult {
  const clean = note.trim().replace(/\s+/g, " ").slice(0, 400);
  if (!clean) return { text: existing ?? "", status: "added" };
  const keep: string[] = [];
  let reinforced = false;
  let merged = clean;
  for (const n of listNotes(existing)) {
    if (similarNote(n, clean)) {
      reinforced = true;
      if (n.length > merged.length) merged = n; // keep the richer phrasing
    } else {
      keep.push(n);
    }
  }
  keep.push(merged);
  return { text: serializeNotes(keep, max), status: reinforced ? "reinforced" : "added" };
}

/** Append one AI-learned note to a project's AI context (dedup-aware). Pure;
 *  kept as the legacy entry point — delegates to {@link rememberNote}. */
export function appendAiNote(
  existing: string | undefined,
  note: string,
  max = AI_CONTEXT_MAX_CHARS,
): string {
  return rememberNote(existing, note, max).text;
}

export interface ForgetResult {
  text: string;
  removed: string[];
}

/**
 * Remove notes matching a query (looser similarity than dedup, plus substring),
 * so the user can correct a wrong/stale memory — "forget that I prefer X" — or
 * delete a specific item. Pure.
 */
export function forgetNotes(
  existing: string | undefined,
  query: string,
  max = AI_CONTEXT_MAX_CHARS,
): ForgetResult {
  const q = query.trim();
  if (!q) return { text: existing ?? "", removed: [] };
  const nq = normForCompare(q);
  const removed: string[] = [];
  const keep = listNotes(existing).filter((n) => {
    const hit = similarNote(n, q, 0.5) || (nq.length >= 4 && normForCompare(n).includes(nq));
    if (hit) removed.push(n);
    return !hit;
  });
  return { text: serializeNotes(keep, max), removed };
}
