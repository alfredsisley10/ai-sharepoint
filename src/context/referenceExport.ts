import { ContextSource, ContextBookmark, ContextAuthMethod } from "./types";
import { normalizeAlias, DESCRIPTION_MAX_LENGTH } from "./sourceRef";
import { SourceSchema } from "./db/schemaIndex";
import { Project, INSTRUCTIONS_MAX_CHARS, GOALS_MAX_CHARS, AI_CONTEXT_MAX_CHARS } from "./types";

/**
 * Secret-free reference-config sharing (ADR-0013 slice 1).
 *
 * Secret-free **by construction**: the exporter consumes only non-secret
 * descriptors and copies an explicit field allowlist — there is no code path
 * to the keychain, no account/credential fields, and ids are regenerated on
 * import. The command layer additionally leak-scans the serialized output
 * (defense in depth) before anything is written.
 */

export const REFERENCE_EXPORT_SCHEMA = "ai-sharepoint/reference-config/v1";

export interface ExportedSource {
  type: ContextSource["type"];
  displayName: string;
  /** Chat alias + description: non-secret, user-authored, shared so the
   *  whole team can say "…in the CMDB database". */
  alias?: string;
  description?: string;
  baseUrl: string;
  baseDn?: string;
  deployment: ContextSource["deployment"];
  /** The discovered working auth *method* (ADR-0015) — descriptor only. */
  authMethod: ContextAuthMethod;
}

export interface ExportedBookmark {
  /** Linked by source displayName (ids are machine-local). */
  source: string;
  name: string;
  locator: string;
  kind: ContextBookmark["kind"];
}

export interface ReferenceExport {
  $schema: typeof REFERENCE_EXPORT_SCHEMA;
  exportedAt: string;
  notice: string;
  sources: ExportedSource[];
  bookmarks: ExportedBookmark[];
  /** Database schema/semantic indexes keyed by source displayName —
   *  non-secret metadata + AI summaries, shared so teammates skip the
   *  (metered) indexing run. */
  schemas?: Record<string, SourceSchema>;
  /** Project scopes: sources linked by displayName, remapped on import. */
  projects?: Array<{
    name: string;
    description?: string;
    goals?: string;
    instructions?: string;
    aiContext?: string;
    sources: string[];
  }>;
}

export const EXPORT_NOTICE =
  "Reference-source configuration shared from the AI SharePoint extension. " +
  "Contains connection descriptors and bookmarks only — no credentials, tokens, or accounts. " +
  "Each recipient supplies their own credentials on first use (verified lockout-safe).";

export function buildReferenceExport(
  sources: ContextSource[],
  bookmarks: ContextBookmark[],
  exportedAt: string,
  schemasById?: Map<string, SourceSchema>,
  projects?: Project[],
): ReferenceExport {
  const byId = new Map(sources.map((s) => [s.id, s.displayName]));
  const schemas: Record<string, SourceSchema> = {};
  if (schemasById) {
    for (const s of sources) {
      const schema = schemasById.get(s.id);
      if (schema) schemas[s.displayName] = schema;
    }
  }
  return {
    $schema: REFERENCE_EXPORT_SCHEMA,
    exportedAt,
    notice: EXPORT_NOTICE,
    sources: sources.map((s) => ({
      // Explicit allowlist — never spread, so new descriptor fields can't
      // leak into exports without a deliberate change here.
      type: s.type,
      displayName: s.displayName,
      ...(s.alias ? { alias: s.alias } : {}),
      ...(s.description ? { description: s.description } : {}),
      baseUrl: s.baseUrl,
      ...(s.baseDn ? { baseDn: s.baseDn } : {}),
      deployment: s.deployment,
      authMethod: s.authMethod,
    })),
    bookmarks: bookmarks
      .filter((b) => byId.has(b.sourceId))
      .map((b) => ({
        source: byId.get(b.sourceId)!,
        name: b.name,
        locator: b.locator,
        kind: b.kind,
      })),
    ...(Object.keys(schemas).length > 0 ? { schemas } : {}),
    ...(projects && projects.length > 0
      ? {
          projects: projects.map((pr) => ({
            name: pr.name,
            ...(pr.description ? { description: pr.description } : {}),
            ...(pr.goals ? { goals: pr.goals } : {}),
            ...(pr.instructions ? { instructions: pr.instructions } : {}),
            ...(pr.aiContext ? { aiContext: pr.aiContext } : {}),
            sources: pr.sourceIds
              .map((id) => byId.get(id))
              .filter((n): n is string => Boolean(n)),
          })),
        }
      : {}),
  };
}

export interface ParsedImport {
  sources: ContextSource[];
  bookmarks: ContextBookmark[];
  warnings: string[];
  /** Schema indexes mapped onto the regenerated source ids. */
  schemas: Array<{ sourceId: string; schema: SourceSchema }>;
  /** Projects with memberships remapped onto regenerated ids. */
  projects: Project[];
}

const SOURCE_TYPES = new Set(["confluence", "jira", "ldap", "mssql", "postgres", "mysql", "mongodb", "vertexai", "powerbi", "servicenow", "splunk"]);
const AUTH_METHODS = new Set(["basic", "pat", "ldap-simple", "ntlm", "gcloud-sso", "az-sso", "aad-sso", "snow-oauth", "splunk-session", "snow-session"]);
const BOOKMARK_KINDS = new Set(["query", "item", "container"]);

/** Parse + validate an export file; ids are regenerated via `newId`. */
export function parseReferenceImport(
  json: string,
  importedAt: string,
  newId: () => string,
): ParsedImport {
  const out: ParsedImport = { sources: [], bookmarks: [], warnings: [], schemas: [], projects: [] };
  let raw: ReferenceExport;
  try {
    raw = JSON.parse(json) as ReferenceExport;
  } catch {
    throw new Error("Not valid JSON.");
  }
  if (raw?.$schema !== REFERENCE_EXPORT_SCHEMA) {
    throw new Error(
      `Not an AI SharePoint reference-config file (expected $schema ${REFERENCE_EXPORT_SCHEMA}).`,
    );
  }

  const idByName = new Map<string, string>();
  const seenAliases = new Set<string>();
  for (const s of Array.isArray(raw.sources) ? raw.sources : []) {
    if (
      !s ||
      typeof s.displayName !== "string" ||
      typeof s.baseUrl !== "string" ||
      !SOURCE_TYPES.has(s.type) ||
      !AUTH_METHODS.has(s.authMethod)
    ) {
      out.warnings.push("A source entry was malformed and was skipped.");
      continue;
    }
    if (s.type === "ldap" && typeof s.baseDn !== "string") {
      out.warnings.push(`LDAP source "${s.displayName}" lacks a baseDn — skipped.`);
      continue;
    }
    const id = newId();
    idByName.set(s.displayName.toLowerCase(), id);
    // Aliases must be unique within the file too — first one wins.
    let alias = typeof s.alias === "string" ? normalizeAlias(s.alias) : "";
    if (alias && seenAliases.has(alias.toLowerCase())) {
      out.warnings.push(`Duplicate alias "${alias}" on "${s.displayName}" — dropped.`);
      alias = "";
    }
    if (alias) seenAliases.add(alias.toLowerCase());
    out.sources.push({
      id,
      type: s.type,
      displayName: s.displayName,
      ...(alias ? { alias } : {}),
      ...(typeof s.description === "string" && s.description.trim()
        ? { description: s.description.trim().slice(0, DESCRIPTION_MAX_LENGTH) }
        : {}),
      baseUrl: s.baseUrl,
      ...(s.baseDn ? { baseDn: s.baseDn } : {}),
      deployment: s.deployment === "cloud" ? "cloud" : "datacenter",
      authMethod: s.authMethod,
      addedAt: importedAt,
      // No account / lastVerifiedAt: recipients verify with their own
      // credentials (ADR-0013 import re-verification).
    });
  }

  for (const b of Array.isArray(raw.bookmarks) ? raw.bookmarks : []) {
    if (
      !b ||
      typeof b.source !== "string" ||
      typeof b.name !== "string" ||
      typeof b.locator !== "string" ||
      !BOOKMARK_KINDS.has(b.kind)
    ) {
      out.warnings.push("A bookmark entry was malformed and was skipped.");
      continue;
    }
    const sourceId = idByName.get(b.source.toLowerCase());
    if (!sourceId) {
      out.warnings.push(`Bookmark "${b.name}" references unknown source "${b.source}" — skipped.`);
      continue;
    }
    out.bookmarks.push({ id: newId(), sourceId, name: b.name, locator: b.locator, kind: b.kind });
  }
  if (raw.schemas && typeof raw.schemas === "object") {
    for (const [name, schema] of Object.entries(raw.schemas)) {
      const sourceId = idByName.get(name.toLowerCase());
      if (!sourceId) {
        out.warnings.push(`Schema index for unknown source "${name}" — skipped.`);
        continue;
      }
      if (!schema || !Array.isArray(schema.catalog?.tables)) {
        out.warnings.push(`Schema index for "${name}" was malformed — skipped.`);
        continue;
      }
      out.schemas.push({ sourceId, schema });
    }
  }
  for (const pr of Array.isArray(raw.projects) ? raw.projects : []) {
    if (!pr || typeof pr.name !== "string" || !pr.name.trim() || !Array.isArray(pr.sources)) {
      out.warnings.push("A project entry was malformed and was skipped.");
      continue;
    }
    const sourceIds = pr.sources
      .filter((n): n is string => typeof n === "string")
      .map((n) => idByName.get(n.toLowerCase()))
      .filter((id): id is string => Boolean(id));
    out.projects.push({
      id: newId(),
      name: pr.name.trim().slice(0, 80),
      ...(typeof pr.description === "string" && pr.description.trim()
        ? { description: pr.description.trim().slice(0, DESCRIPTION_MAX_LENGTH) }
        : {}),
      ...(typeof pr.goals === "string" && pr.goals.trim()
        ? { goals: pr.goals.trim().slice(0, GOALS_MAX_CHARS) }
        : {}),
      ...(typeof pr.instructions === "string" && pr.instructions.trim()
        ? { instructions: pr.instructions.trim().slice(0, INSTRUCTIONS_MAX_CHARS) }
        : {}),
      ...(typeof pr.aiContext === "string" && pr.aiContext.trim()
        ? { aiContext: pr.aiContext.trim().slice(0, AI_CONTEXT_MAX_CHARS) }
        : {}),
      sourceIds,
    });
  }
  return out;
}
