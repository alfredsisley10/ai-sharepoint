import { ContextSource, ContextBookmark, ContextAuthMethod } from "./types";

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
}

export const EXPORT_NOTICE =
  "Reference-source configuration shared from the AI SharePoint extension. " +
  "Contains connection descriptors and bookmarks only — no credentials, tokens, or accounts. " +
  "Each recipient supplies their own credentials on first use (verified lockout-safe).";

export function buildReferenceExport(
  sources: ContextSource[],
  bookmarks: ContextBookmark[],
  exportedAt: string,
): ReferenceExport {
  const byId = new Map(sources.map((s) => [s.id, s.displayName]));
  return {
    $schema: REFERENCE_EXPORT_SCHEMA,
    exportedAt,
    notice: EXPORT_NOTICE,
    sources: sources.map((s) => ({
      // Explicit allowlist — never spread, so new descriptor fields can't
      // leak into exports without a deliberate change here.
      type: s.type,
      displayName: s.displayName,
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
  };
}

export interface ParsedImport {
  sources: ContextSource[];
  bookmarks: ContextBookmark[];
  warnings: string[];
}

const SOURCE_TYPES = new Set(["confluence", "jira", "ldap", "mssql", "postgres", "mysql", "mongodb"]);
const AUTH_METHODS = new Set(["basic", "pat", "ldap-simple", "ntlm"]);
const BOOKMARK_KINDS = new Set(["query", "item", "container"]);

/** Parse + validate an export file; ids are regenerated via `newId`. */
export function parseReferenceImport(
  json: string,
  importedAt: string,
  newId: () => string,
): ParsedImport {
  const out: ParsedImport = { sources: [], bookmarks: [], warnings: [] };
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
    out.sources.push({
      id,
      type: s.type,
      displayName: s.displayName,
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
  return out;
}
