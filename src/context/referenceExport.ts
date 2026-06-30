import { ContextSource, ContextBookmark, ContextAuthMethod } from "./types";
import { normalizeAlias, DESCRIPTION_MAX_LENGTH } from "./sourceRef";
import { SourceSchema } from "./db/schemaIndex";
import { Project, INSTRUCTIONS_MAX_CHARS, GOALS_MAX_CHARS, AI_CONTEXT_MAX_CHARS } from "./types";
import { MemoryItem, MemoryScope, MemoryScopeKind, memoryKey, mergeMemory, sameMemoryContent, normalizeMemoryInput } from "./memory";
import { PromptItem, PromptScope, PromptScopeKind, promptKey, mergePrompt, samePromptContent, normalizePromptInput } from "./promptLibrary";
import { scanForLeaks } from "../diagnostics/bundle";

/**
 * Secret-free reference-config sharing (ADR-0013 slice 1).
 *
 * Secret-free **by construction**: the exporter consumes only non-secret
 * descriptors and copies an explicit field allowlist — there is no code path
 * to the keychain, no account/credential fields, and ids are regenerated on
 * import. The command layer additionally leak-scans the serialized output
 * (defense in depth) before anything is written.
 */

// Brand-NEUTRAL on purpose: reference-config files must move freely between
// white-labeled builds. The old id was brand-prefixed (`<kebab>/reference-config/v1`),
// and `<kebab>` is a deep-rename token — so every white-label rebuilt it to its own
// value and rejected every other build's files. This id contains no brand token, so
// it is identical across the original and all white-labels. `isReferenceExportSchema`
// additionally accepts the legacy brand-prefixed ids, so files exported by older or
// differently-branded builds still import.
export const REFERENCE_EXPORT_SCHEMA = "reference-config/v1";

/** Whether `s` identifies a reference-config export — the neutral id, or any
 *  legacy `<brand>/reference-config/v1`. Keeps configs portable across builds. */
export function isReferenceExportSchema(s: unknown): boolean {
  return typeof s === "string" && /(^|\/)reference-config\/v1$/.test(s);
}

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

/** A managed/reference SharePoint site descriptor — secret-free (URL + title +
 *  role only). No credentials/tokens/accounts: the recipient signs in on import. */
export interface ExportedSite {
  siteUrl: string;
  displayName: string;
  role: "managed" | "reference";
}

/** A memory note, portably keyed: site memory references its `siteUrl` (stable
 *  across machines); source memory references the source **displayName** (ids are
 *  machine-local) and is remapped to the local id on import. User-authored,
 *  secret-free — shared so a team carries the same conventions/gotchas. */
export interface ExportedMemory {
  scopeKind: MemoryScopeKind;
  /** site → siteUrl; source → source displayName. */
  scopeRef: string;
  title: string;
  text: string;
  tags?: string[];
  origin: "user" | "ai";
}

/** A Prompt Library entry, portably keyed: global prompts carry no ref; site →
 *  siteUrl; source → source displayName; project → project name (all remapped to
 *  local ids on import). Secret-free reusable prompt text. */
export interface ExportedPrompt {
  scopeKind: PromptScopeKind;
  /** Omitted for `global`; siteUrl / source displayName / project name otherwise. */
  scopeRef?: string;
  title: string;
  body: string;
  tags?: string[];
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
  /** Managed/reference SharePoint sites — secret-free descriptors; recipients
   *  sign in on import. Optional so older importers (and the schema) tolerate it. */
  sites?: ExportedSite[];
  /** Per-entity memory notes (user + assistant-proposed), portably keyed. Optional
   *  so older importers tolerate it. Imported with review + dedup/merge. */
  memory?: ExportedMemory[];
  /** Prompt Library entries (global or scoped), portably keyed. Optional so older
   *  importers tolerate it. Imported with review + dedup/merge. */
  prompts?: ExportedPrompt[];
}

export const EXPORT_NOTICE =
  "Reference-source configuration shared from the AI SharePoint extension. " +
  "Contains connection descriptors and bookmarks only — no credentials, tokens, or accounts. " +
  "Each recipient supplies their own credentials on first use (verified lockout-safe).";

/**
 * Defense-in-depth gate for a serialized export: the names of any block-severity
 * leak findings that should STOP the write (empty = safe). Excludes
 * `raw-tenant-host` on purpose — a site/source URL is the intended payload of a
 * user-initiated, peer-to-peer config share (the recipient connects to it). That
 * rule guards a *different* threat model: keeping tenant hosts out of the
 * telemetry we send to our own servers. Everything genuinely secret-shaped
 * (tokens, PEM blocks, bearer creds, emails, auth codes in URLs) still blocks.
 */
export function exportLeakBlockers(json: string): string[] {
  return scanForLeaks(json)
    .filter((f) => f.severity === "block" && f.pattern !== "raw-tenant-host")
    .map((f) => f.pattern);
}

export function buildReferenceExport(
  sources: ContextSource[],
  bookmarks: ContextBookmark[],
  exportedAt: string,
  schemasById?: Map<string, SourceSchema>,
  projects?: Project[],
  sites?: Array<{ siteUrl: string; displayName: string; role: "managed" | "reference" }>,
  memoryItems?: MemoryItem[],
  /** id→displayName for ALL sources (not just exported ones) so source-memory
   *  re-keys even when its source descriptor isn't part of this export — the
   *  recipient resolves it against a same-named source they already have. */
  sourceNamesById?: Map<string, string>,
  promptItems?: PromptItem[],
  /** id→name for ALL projects, so a project-scoped prompt re-keys to the project
   *  name (machine-local ids never travel) even if that project isn't exported. */
  projectNamesById?: Map<string, string>,
): ReferenceExport {
  const byId = new Map(sources.map((s) => [s.id, s.displayName]));
  const memNames = sourceNamesById ?? byId;
  const schemas: Record<string, SourceSchema> = {};
  if (schemasById) {
    for (const s of sources) {
      const schema = schemasById.get(s.id);
      if (schema) schemas[s.displayName] = schema;
    }
  }
  // Memory: site notes carry their (portable) siteUrl key; source notes are
  // re-keyed to the source displayName (machine-local ids never travel). A
  // source note whose source can't be named (gone entirely) is dropped — its
  // scopeRef would dangle on import.
  const memory: ExportedMemory[] = (memoryItems ?? [])
    .map((m): ExportedMemory | undefined => {
      const base = { title: m.title, text: m.text, ...(m.tags?.length ? { tags: m.tags } : {}), origin: m.origin };
      if (m.scope.kind === "site") return { scopeKind: "site", scopeRef: m.scope.key, ...base };
      const name = memNames.get(m.scope.key);
      return name ? { scopeKind: "source", scopeRef: name, ...base } : undefined;
    })
    .filter((m): m is ExportedMemory => Boolean(m));
  // Prompts: global carries no ref; site → siteUrl (portable); source/project →
  // the entity NAME (ids never travel). A scoped prompt whose entity can't be
  // named is dropped (its ref would dangle on import).
  const prompts: ExportedPrompt[] = (promptItems ?? [])
    .map((p): ExportedPrompt | undefined => {
      const base = { title: p.title, body: p.body, ...(p.tags?.length ? { tags: p.tags } : {}) };
      if (p.scope.kind === "global") return { scopeKind: "global", ...base };
      if (p.scope.kind === "site") return { scopeKind: "site", scopeRef: p.scope.key, ...base };
      const name = p.scope.kind === "source" ? memNames.get(p.scope.key ?? "") : projectNamesById?.get(p.scope.key ?? "");
      return name ? { scopeKind: p.scope.kind, scopeRef: name, ...base } : undefined;
    })
    .filter((p): p is ExportedPrompt => Boolean(p));
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
    // Explicit allowlist (secret-free by construction): URL, title, role only.
    ...(sites && sites.length > 0
      ? { sites: sites.map((s) => ({ siteUrl: s.siteUrl, displayName: s.displayName, role: s.role })) }
      : {}),
    ...(memory.length > 0 ? { memory } : {}),
    ...(prompts.length > 0 ? { prompts } : {}),
  };
}

/** A memory note from an import file, still keyed by its portable reference
 *  (siteUrl, or source displayName). The command layer resolves source refs to a
 *  local source id and applies dedup/merge before storing. */
export interface ParsedMemory {
  scopeKind: MemoryScopeKind;
  scopeRef: string;
  title: string;
  text: string;
  tags?: string[];
  origin: "user" | "ai";
}

/** A Prompt Library entry from an import file, still keyed by its portable ref.
 *  The command resolves the ref to a local scope and applies dedup/merge. */
export interface ParsedPrompt {
  scopeKind: PromptScopeKind;
  scopeRef?: string;
  title: string;
  body: string;
  tags?: string[];
}

export interface ParsedImport {
  sources: ContextSource[];
  bookmarks: ContextBookmark[];
  warnings: string[];
  /** Schema indexes mapped onto the regenerated source ids. */
  schemas: Array<{ sourceId: string; schema: SourceSchema }>;
  /** Projects with memberships remapped onto regenerated ids. */
  projects: Project[];
  /** Managed/reference sites to (re-)create; recipient signs in afterwards. */
  sites: ExportedSite[];
  /** Memory notes, still portably keyed; the command remaps source refs + merges. */
  memory: ParsedMemory[];
  /** Prompt Library entries, still portably keyed; the command remaps + merges. */
  prompts: ParsedPrompt[];
}

const SOURCE_TYPES = new Set(["confluence", "jira", "ldap", "mssql", "postgres", "mysql", "mongodb", "vertexai", "powerbi", "servicenow", "splunk", "splunkobs", "grafana", "m365copilot"]);
const AUTH_METHODS = new Set(["basic", "pat", "ldap-simple", "ntlm", "gcloud-sso", "az-sso", "aad-sso", "snow-oauth", "splunk-session", "snow-session", "sfx-token"]);
const BOOKMARK_KINDS = new Set(["query", "item", "container"]);

/** Parse + validate an export file; ids are regenerated via `newId`. */
export function parseReferenceImport(
  json: string,
  importedAt: string,
  newId: () => string,
): ParsedImport {
  const out: ParsedImport = { sources: [], bookmarks: [], warnings: [], schemas: [], projects: [], sites: [], memory: [], prompts: [] };
  let raw: ReferenceExport;
  try {
    raw = JSON.parse(json) as ReferenceExport;
  } catch {
    throw new Error("Not valid JSON.");
  }
  if (!isReferenceExportSchema(raw?.$schema)) {
    throw new Error(
      `Not a reference-config file (expected a "$schema" of "${REFERENCE_EXPORT_SCHEMA}", or a legacy "<name>/reference-config/v1").`,
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

  // Sites: secret-free descriptors → recreated on import; the recipient signs in
  // afterwards (no credentials travel). Deduped within the file by URL.
  const seenSiteUrls = new Set<string>();
  for (const s of Array.isArray(raw.sites) ? raw.sites : []) {
    if (!s || typeof s.siteUrl !== "string" || typeof s.displayName !== "string" || (s.role !== "managed" && s.role !== "reference")) {
      out.warnings.push("Skipped a malformed site entry.");
      continue;
    }
    const siteUrl = s.siteUrl.trim().replace(/\/+$/, "");
    try {
      if (!new URL(siteUrl).hostname) throw new Error("no host");
    } catch {
      out.warnings.push(`Skipped site "${s.displayName}" — not a valid URL.`);
      continue;
    }
    if (seenSiteUrls.has(siteUrl.toLowerCase())) continue;
    seenSiteUrls.add(siteUrl.toLowerCase());
    out.sites.push({ siteUrl, displayName: s.displayName.trim().slice(0, 200) || siteUrl, role: s.role });
  }

  // Memory: keep the portable ref (siteUrl / source displayName); the command
  // resolves source refs to a local id and applies dedup/merge. Clamp lengths and
  // sanitize the origin here so storage limits hold regardless of the file.
  for (const m of Array.isArray(raw.memory) ? raw.memory : ([] as ExportedMemory[])) {
    if (!m || (m.scopeKind !== "site" && m.scopeKind !== "source") || typeof m.scopeRef !== "string" || !m.scopeRef.trim() || typeof m.title !== "string" || typeof m.text !== "string" || !m.title.trim() || !m.text.trim()) {
      out.warnings.push("A memory note was malformed and was skipped.");
      continue;
    }
    const norm = normalizeMemoryInput(m.title, m.text, Array.isArray(m.tags) ? m.tags.filter((t): t is string => typeof t === "string") : undefined);
    out.memory.push({
      scopeKind: m.scopeKind,
      scopeRef: m.scopeKind === "site" ? m.scopeRef.trim().replace(/\/+$/, "") : m.scopeRef.trim(),
      title: norm.title,
      text: norm.text,
      ...(norm.tags ? { tags: norm.tags } : {}),
      origin: m.origin === "ai" ? "ai" : "user",
    });
  }

  // Prompts: global needs no ref; scoped ones keep their portable ref for the
  // command to resolve to a local scope. Clamp lengths here.
  const PROMPT_KINDS = new Set(["global", "site", "source", "project"]);
  for (const p of Array.isArray(raw.prompts) ? raw.prompts : ([] as ExportedPrompt[])) {
    const scoped = p && p.scopeKind !== "global";
    if (!p || !PROMPT_KINDS.has(p.scopeKind) || typeof p.title !== "string" || typeof p.body !== "string" || !p.title.trim() || !p.body.trim() || (scoped && (typeof p.scopeRef !== "string" || !p.scopeRef.trim()))) {
      out.warnings.push("A prompt was malformed and was skipped.");
      continue;
    }
    const norm = normalizePromptInput(p.title, p.body, Array.isArray(p.tags) ? p.tags.filter((t): t is string => typeof t === "string") : undefined);
    out.prompts.push({
      scopeKind: p.scopeKind,
      ...(scoped ? { scopeRef: p.scopeKind === "site" ? p.scopeRef!.trim().replace(/\/+$/, "") : p.scopeRef!.trim() } : {}),
      title: norm.title,
      body: norm.body,
      ...(norm.tags ? { tags: norm.tags } : {}),
    });
  }
  return out;
}

export interface MemoryImportPlan {
  /** New notes to store (scope resolved, key not already present). */
  toAdd: MemoryItem[];
  /** Same scope+title, different content → rule-based merged result to write
   *  over the existing note (intelligent-merge default). `existing` is kept so
   *  the caller can offer AI merge / keep-mine instead. */
  toMerge: Array<{ existing: MemoryItem; merged: MemoryItem }>;
  /** Same scope+title AND identical content — nothing to do. */
  duplicates: number;
  /** Notes whose `scopeRef` couldn't be mapped to a local site/source. */
  unresolved: ParsedMemory[];
}

/**
 * Plan a memory import: resolve each note's portable ref to a local scope, then
 * classify against what's already stored (and earlier items in the same batch):
 *  - new key            → add
 *  - same key, same body→ duplicate (skip)
 *  - same key, different→ rule-based MERGE (union tags + lossless text join)
 * Pure (the caller supplies `resolveScope`), so it's unit-tested. The command
 * applies merges by default and can offer an AI pass over each merged result.
 */
export function planMemoryImport(
  parsed: ParsedMemory[],
  resolveScope: (kind: MemoryScopeKind, ref: string) => MemoryScope | undefined,
  existing: MemoryItem[],
  newId: () => string,
  now: string,
): MemoryImportPlan {
  const existingByKey = new Map(existing.map((m) => [memoryKey(m), m]));
  // work tracks the item we'll write per key (so a 2nd same-key item in the
  // batch merges into the 1st rather than spawning a duplicate).
  const work = new Map<string, { item: MemoryItem; kind: "add" | "merge"; base?: MemoryItem }>();
  const unresolved: ParsedMemory[] = [];
  let duplicates = 0;
  for (const p of parsed) {
    const scope = resolveScope(p.scopeKind, p.scopeRef);
    if (!scope) {
      unresolved.push(p);
      continue;
    }
    const key = memoryKey({ scope, title: p.title });
    const inProgress = work.get(key);
    if (inProgress) {
      inProgress.item = mergeMemory(inProgress.item, p.text, p.tags, now);
      continue;
    }
    const exist = existingByKey.get(key);
    if (exist) {
      if (sameMemoryContent(exist, p.text, p.tags)) {
        duplicates++;
        continue;
      }
      work.set(key, { item: mergeMemory(exist, p.text, p.tags, now), kind: "merge", base: exist });
    } else {
      work.set(key, {
        item: { id: newId(), scope, title: p.title, text: p.text, ...(p.tags ? { tags: p.tags } : {}), origin: p.origin, createdAt: now, updatedAt: now },
        kind: "add",
      });
    }
  }
  const toAdd: MemoryItem[] = [];
  const toMerge: Array<{ existing: MemoryItem; merged: MemoryItem }> = [];
  for (const w of work.values()) {
    if (w.kind === "add") toAdd.push(w.item);
    else toMerge.push({ existing: w.base!, merged: w.item });
  }
  return { toAdd, toMerge, duplicates, unresolved };
}

export interface PromptImportPlan {
  toAdd: PromptItem[];
  /** Same scope+title, different body → rule-based merged result + the existing
   *  prompt (so the caller can offer AI merge / keep-mine). */
  toMerge: Array<{ existing: PromptItem; merged: PromptItem }>;
  /** Same scope+title AND identical body — nothing to do. */
  duplicates: number;
  /** Skipped: a scoped prompt whose site/source/project isn't here. */
  unresolved: ParsedPrompt[];
}

/**
 * Plan a prompt import — the prompt twin of `planMemoryImport`. Global prompts
 * always resolve; scoped ones resolve via the caller-supplied `resolveScope`.
 * New key → add; same key + same body → duplicate; same key + different body →
 * rule-based merge (union tags + lossless body join), which the command applies
 * by default and can refine with an AI pass.
 */
export function planPromptImport(
  parsed: ParsedPrompt[],
  resolveScope: (kind: PromptScopeKind, ref?: string) => PromptScope | undefined,
  existing: PromptItem[],
  newId: () => string,
  now: string,
): PromptImportPlan {
  const existingByKey = new Map(existing.map((p) => [promptKey(p), p]));
  const work = new Map<string, { item: PromptItem; kind: "add" | "merge"; base?: PromptItem }>();
  const unresolved: ParsedPrompt[] = [];
  let duplicates = 0;
  for (const p of parsed) {
    const scope = resolveScope(p.scopeKind, p.scopeRef);
    if (!scope) {
      unresolved.push(p);
      continue;
    }
    const key = promptKey({ scope, title: p.title });
    const inProgress = work.get(key);
    if (inProgress) {
      inProgress.item = mergePrompt(inProgress.item, p.body, p.tags, now);
      continue;
    }
    const exist = existingByKey.get(key);
    if (exist) {
      if (samePromptContent(exist, p.body, p.tags)) {
        duplicates++;
        continue;
      }
      work.set(key, { item: mergePrompt(exist, p.body, p.tags, now), kind: "merge", base: exist });
    } else {
      work.set(key, {
        item: { id: newId(), scope, title: p.title, body: p.body, ...(p.tags ? { tags: p.tags } : {}), createdAt: now, updatedAt: now },
        kind: "add",
      });
    }
  }
  const toAdd: PromptItem[] = [];
  const toMerge: Array<{ existing: PromptItem; merged: PromptItem }> = [];
  for (const w of work.values()) {
    if (w.kind === "add") toAdd.push(w.item);
    else toMerge.push({ existing: w.base!, merged: w.item });
  }
  return { toAdd, toMerge, duplicates, unresolved };
}
