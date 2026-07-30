import { ContextSourceType } from "../types";

/**
 * Database schema catalog + AI semantic index (ADR-0024).
 *
 * Two layers, strictly separated:
 *  - the CATALOG is deterministic metadata read from the database itself
 *    (INFORMATION_SCHEMA / sampled MongoDB field names) — table/column
 *    NAMES and TYPES only, never row values;
 *  - the SEMANTIC INDEX is Copilot's generalization of those names
 *    (consent-gated, metered): tags + synonyms per column so free-form
 *    questions ("records owned by X") reach the right columns
 *    (e.g. group_cio → ownership).
 */

export interface ColumnDef {
  name: string;
  dataType: string;
  nullable?: boolean;
}

export interface TableDef {
  /** dbo / public / database schema; absent for MongoDB collections. */
  schema?: string;
  name: string;
  kind: "table" | "view" | "collection";
  columns: ColumnDef[];
}

export interface SchemaCatalog {
  fetchedAt: string;
  engine: ContextSourceType;
  database: string;
  tables: TableDef[];
  /** True when caps were hit — the catalog is a prefix, not the whole DB. */
  truncated?: boolean;
}

/** Measured facts about a column's VALUES, computed locally from the sampled
 *  rows — never inferred by the model. Sample-based, so rates are estimates;
 *  `sampled` says how many rows they came from so nothing reads as exact. */
export interface ColumnProfile {
  /** Rows examined. */
  sampled: number;
  /** Rows where the value was NULL/undefined. */
  nulls: number;
  /** Distinct non-null values seen (capped by the sample, not the table). */
  distinct: number;
  /** Shortest/longest stringified non-null value — flags fixed-width codes. */
  minLength?: number;
  maxLength?: number;
  /** Lexical min/max of non-null values, useful for date-ish and code columns. */
  min?: string;
  max?: string;
}

export interface SemanticColumn {
  name: string;
  /** Lowercase concept tags, e.g. ["ownership","organization"]. */
  tags: string[];
  /** Words users actually say for this column, e.g. ["owner","CIO"]. */
  synonyms: string[];
  note?: string;
  /** LEVEL 1 — what the values actually ARE, when the declared type doesn't
   *  say: a varchar holding ISO-8601 dates, integers, JSON, a bit flag as
   *  'Y'/'N'. Set only when it differs meaningfully from the declared type, so
   *  its presence is itself the "declared type is not self-describing" signal. */
  effectiveType?: string;
  /** LEVEL 2 — what the column MEANS in business language, the way an analyst
   *  would describe it ("ISO country codes", "statuses: Active/Retired"). */
  contentSummary?: string;
  /** Measured, not inferred: null rate, cardinality, lengths. Lets the model
   *  (and the user) see "sparsely populated / mostly null" as fact. */
  profile?: ColumnProfile;
}

export interface SemanticTable {
  /** Qualified name exactly as in the catalog, e.g. "dbo.Applications". */
  table: string;
  purpose?: string;
  columns: SemanticColumn[];
  /** Table/view-level synopsis in business language — what this table holds
   *  and what a row represents, informed by the sampled content rather than
   *  the name alone (which is all `purpose` from the schema pass has). */
  synopsis?: string;
  /** Fingerprint of the CATALOG shape this entry was indexed against (see
   *  tableFingerprint). When the live catalog's fingerprint differs, the table's
   *  schema changed and the entry is stale — planIndexWork flags it for
   *  reprocessing even though its name is already in the index. */
  fingerprint?: string;
  /** Set once the content pass has described this table's values, so a resumed
   *  content run can skip it. Absent = never content-indexed. */
  contentIndexedAt?: string;
}

export interface SemanticIndex {
  indexedAt: string;
  modelId: string;
  tables: SemanticTable[];
  /** True when cancellation/parse failures stopped indexing before all
   *  batches ran. */
  partial?: boolean;
  /** Set when "Index Database Content Types" has run over this catalog. */
  contentIndexedAt?: string;
}

/** One PROBED relationship (ADR-0030): enterprise schemas rarely declare
 *  foreign keys, so relationships are established empirically — sample
 *  distinct values from one column and measure how many EXIST in the other
 *  (both directions). A high match rate, on top of what schema/content
 *  indexing says the columns mean, is a reliable join indicator. */
export interface ProbedRelationship {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  /** Share of sampled from-values found in to (0..1). */
  forwardRate: number;
  /** Share of sampled to-values found in from (0..1). */
  backwardRate: number;
  sampledForward: number;
  sampledBackward: number;
  /** True when the winning test covered EVERY distinct value (complete
   *  join, not a sample) — small tables, or escalation reached full. */
  complete?: boolean;
  /** "defined" = user-supplied join kept despite measuring below the
   *  automatic thresholds (chat's test_join, ADR-0030 amendment). */
  verdict: "strong" | "likely" | "defined";
  /** Measured via the cast comparison (mismatched/LOB types). */
  cast?: boolean;
  /** Containment reading — encodes the inner-vs-outer-join consequence
   *  ("from-side is a subset …"). */
  note?: string;
  /** Why this pair was tested ("name pattern: customer_id → Customers.id"). */
  reason: string;
}

/** Every probed pair, kept (capped) whether it confirmed or not — the
 *  "big picture" when a run finds little: near-misses with their MEASURED
 *  rates are how "zero relationships" becomes diagnosable. */
export interface TestedPair {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  forwardRate: number;
  backwardRate: number;
  sampledForward: number;
  sampledBackward: number;
  outcome: "strong" | "likely" | "defined" | "rejected" | "failed";
  reason: string;
  /** Measured via the cast comparison. */
  cast?: boolean;
}

/** Persisted ER model — travels with the schema (and reference exports). */
export interface ErModel {
  builtAt: string;
  /** Extension version whose CODE ran the build — torn installs made
   *  "which build produced this result?" unanswerable (pilot). */
  builtBy?: string;
  /** Baseline sample size; actual probes adapt per pair (row estimates,
   *  escalation while fast, complete joins on small tables). */
  sampleSize: number;
  candidatesTested: number;
  relationships: ProbedRelationship[];
  /** True when cancellation/per-pair failures stopped probing early. */
  partial?: boolean;
  /** "thorough" also tested every type-compatible pair across small tables;
   *  "max" ran every escalation automatically (casts, large tables). */
  mode?: "standard" | "ai" | "thorough" | "max";
  /** Approximate per-table row counts observed during the build. */
  rowEstimates?: Record<string, number>;
  /** When the latest run was scoped to a table subset, its size — the rest
   *  of the model's relationships were preserved from earlier runs. */
  scopeTables?: number;
  /** The user's data description, re-used to seed the next run's AI pass. */
  aiHint?: string;
  /** Probe report: outcome counts ride in `tested`; zero-sample probes
   *  signal a systemic sampling problem rather than absent relationships. */
  report?: {
    tested: TestedPair[];
    zeroSampleCount: number;
    aiProposed?: number;
    aiRefined?: number;
  };
}

export interface SourceSchema {
  catalog: SchemaCatalog;
  semantic?: SemanticIndex;
  /** "declined": the user said no — don't re-ask on every use. */
  semanticState: "none" | "indexed" | "declined";
  /** Content-type indexing state (sampled values described by Copilot). */
  contentState?: "none" | "indexed" | "declined";
  /** Probed entity-relationship model ("Build ER Diagram", ADR-0030). */
  er?: ErModel;
}

// Caps keep catalogs, prompts, and tool output bounded on huge databases.
export const SCHEMA_MAX_TABLES = 300;
export const SCHEMA_MAX_COLUMNS_PER_TABLE = 80;
export const MONGO_SAMPLE_DOCS = 5;
export const MONGO_MAX_COLLECTIONS = 100;
export const INDEX_TABLES_PER_BATCH = 40;
// Content indexing: one sample query per table; distincts computed locally.
export const CONTENT_SAMPLE_ROWS = 100;
export const CONTENT_DISTINCT_PER_COLUMN = 10;
export const CONTENT_VALUE_MAX_CHARS = 60;
export const CONTENT_TABLES_PER_BATCH = 8;
export const CONTENT_MAX_TABLES = 50;

export function qualifiedName(t: Pick<TableDef, "schema" | "name">): string {
  return t.schema ? `${t.schema}.${t.name}` : t.name;
}

/** Raw row off INFORMATION_SCHEMA.COLUMNS (key casing varies by engine). */
export type CatalogRow = Record<string, unknown>;

const rowVal = (r: CatalogRow, key: string): string | undefined => {
  const v = r[key] ?? r[key.toUpperCase()] ?? r[key.toLowerCase()];
  return v === null || v === undefined ? undefined : String(v);
};

/** Group INFORMATION_SCHEMA column rows into the catalog (rows must be
 *  ordered by schema, table, ordinal — the queries guarantee it). */
export function catalogFromRows(
  engine: ContextSourceType,
  database: string,
  rows: CatalogRow[],
  fetchedAt: string,
): SchemaCatalog {
  const tables: TableDef[] = [];
  let current: TableDef | undefined;
  let truncated = false;
  for (const r of rows) {
    const schema = rowVal(r, "table_schema");
    const name = rowVal(r, "table_name");
    const column = rowVal(r, "column_name");
    if (!name || !column) continue;
    if (!current || current.name !== name || current.schema !== schema) {
      if (tables.length >= SCHEMA_MAX_TABLES) {
        truncated = true;
        break;
      }
      current = {
        ...(schema ? { schema } : {}),
        name,
        kind: (rowVal(r, "table_type") ?? "").toUpperCase().includes("VIEW") ? "view" : "table",
        columns: [],
      };
      tables.push(current);
    }
    if (current.columns.length >= SCHEMA_MAX_COLUMNS_PER_TABLE) {
      truncated = true;
      continue;
    }
    current.columns.push({
      name: column,
      dataType: rowVal(r, "data_type") ?? "unknown",
      ...(rowVal(r, "is_nullable") !== undefined
        ? { nullable: rowVal(r, "is_nullable")?.toUpperCase() !== "NO" }
        : {}),
    });
  }
  return { fetchedAt, engine, database, tables, ...(truncated ? { truncated: true } : {}) };
}

/** Field-name/type inference over locally sampled MongoDB documents.
 *  Only NAMES and TYPES survive into the catalog — values are discarded. */
export function catalogFromMongoSamples(
  database: string,
  samples: Record<string, Array<Record<string, unknown>>>,
  fetchedAt: string,
): SchemaCatalog {
  const bsonType = (v: unknown): string => {
    if (v === null || v === undefined) return "null";
    if (Array.isArray(v)) return "array";
    if (v instanceof Date) return "date";
    if (typeof v === "object") {
      const ctor = (v as object).constructor?.name;
      return ctor && ctor !== "Object" ? ctor.toLowerCase() : "object";
    }
    return typeof v;
  };
  const tables: TableDef[] = [];
  let truncated = false;
  for (const [collection, docs] of Object.entries(samples)) {
    if (tables.length >= MONGO_MAX_COLLECTIONS) {
      truncated = true;
      break;
    }
    const fields = new Map<string, Set<string>>();
    const note = (path: string, v: unknown) => {
      if (!fields.has(path)) fields.set(path, new Set());
      fields.get(path)!.add(bsonType(v));
    };
    for (const doc of docs.slice(0, MONGO_SAMPLE_DOCS)) {
      for (const [k, v] of Object.entries(doc ?? {})) {
        note(k, v);
        // One nesting level: enough for address.city-style questions.
        if (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date)) {
          for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
            note(`${k}.${k2}`, v2);
          }
        }
      }
    }
    const columns = [...fields.entries()]
      .slice(0, SCHEMA_MAX_COLUMNS_PER_TABLE)
      .map(([name, types]) => ({
        name,
        dataType: [...types].filter((t) => t !== "null").join("|") || "null",
      }));
    if (fields.size > SCHEMA_MAX_COLUMNS_PER_TABLE) truncated = true;
    tables.push({ name: collection, kind: "collection", columns });
  }
  return { fetchedAt, engine: "mongodb", database, tables, ...(truncated ? { truncated: true } : {}) };
}

// --- AI indexing: prompt + response handling --------------------------------

export function chunkTables(tables: TableDef[], perBatch = INDEX_TABLES_PER_BATCH): TableDef[][] {
  const out: TableDef[][] = [];
  for (let i = 0; i < tables.length; i += perBatch) {
    out.push(tables.slice(i, i + perBatch));
  }
  return out;
}

const SUGGESTED_TAGS =
  "identifier, name, person, ownership, organization, email, phone, location, " +
  "date, status, category, description, money, quantity, application, host, " +
  "network, url, reference, flag, audit";

/** Build the indexing prompt for one batch. The input is the catalog only —
 *  names and types; row data cannot appear because it was never collected. */
export function buildIndexPrompt(catalog: SchemaCatalog, batch: TableDef[]): string {
  const tableBlock = batch
    .map(
      (t) =>
        `${qualifiedName(t)} (${t.kind}):\n${t.columns
          .map((c) => `  - ${c.name}: ${c.dataType}`)
          .join("\n")}`,
    )
    .join("\n\n");
  return [
    `You are indexing a ${catalog.engine} database schema ("${catalog.database}") so an`,
    "assistant can answer free-form questions about its records. For every table and",
    "column below, infer what it MEANS from its name and type — generalize abbreviations",
    "and org-specific prefixes.",
    "",
    "Return ONLY a JSON object, no prose, exactly this shape:",
    '{"tables":[{"table":"<qualified name exactly as given>","purpose":"<one line>",',
    '"columns":[{"name":"<column>","tags":["<concept>", ...],"synonyms":["<words users say>", ...],"note":"<optional one line>"}]}]}',
    "",
    `Tags are lowercase concepts; prefer these when they fit: ${SUGGESTED_TAGS}.`,
    "Tag EVERY column that carries meaning beyond its raw name. Examples of the level",
    "of inference expected:",
    '- "group_cio" → tags ["ownership","organization"], synonyms ["owner","owning group","CIO"]',
    "  (a question like 'records owned by X' must find this column);",
    '- "appl_id" → tags ["identifier","application"], synonyms ["application id","app"];',
    '- "lst_upd_dt" → tags ["date","audit"], synonyms ["last updated","modified"].',
    "Skip columns that are pure noise. Do not invent tables or columns.",
    "",
    "Schema:",
    tableBlock,
  ].join("\n");
}

/** Parse one model response: tolerate code fences/prose, validate against the
 *  catalog (unknown tables/columns are dropped), clamp + lowercase tags. */
export function parseSemanticResponse(
  text: string,
  catalog: SchemaCatalog,
): SemanticTable[] {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("The model returned no JSON object.");
  }
  let parsed: { tables?: unknown };
  try {
    parsed = JSON.parse(text.slice(start, end + 1)) as { tables?: unknown };
  } catch {
    throw new Error("The model's JSON did not parse.");
  }
  if (!Array.isArray(parsed.tables)) return [];

  const known = new Map<string, Set<string>>();
  for (const t of catalog.tables) {
    known.set(
      qualifiedName(t).toLowerCase(),
      new Set(t.columns.map((c) => c.name.toLowerCase())),
    );
  }
  const clampList = (v: unknown, max: number, lower: boolean): string[] =>
    (Array.isArray(v) ? v : [])
      .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      .map((x) => (lower ? x.trim().toLowerCase() : x.trim()).slice(0, 40))
      .slice(0, max);

  const out: SemanticTable[] = [];
  for (const raw of parsed.tables as Array<Record<string, unknown>>) {
    const tableName = typeof raw?.table === "string" ? raw.table.trim() : "";
    const columnsOf = known.get(tableName.toLowerCase());
    if (!columnsOf) continue; // hallucinated table
    const columns: SemanticColumn[] = [];
    for (const c of Array.isArray(raw.columns) ? (raw.columns as Array<Record<string, unknown>>) : []) {
      const name = typeof c?.name === "string" ? c.name.trim() : "";
      if (!columnsOf.has(name.toLowerCase())) continue; // hallucinated column
      const tags = clampList(c.tags, 6, true);
      const synonyms = clampList(c.synonyms, 8, false);
      const str = (v: unknown, max: number): string | undefined => {
        const t = typeof v === "string" ? v.trim() : "";
        return t ? t.slice(0, max) : undefined;
      };
      const contentSummary = str((c as { contentSummary?: unknown }).contentSummary, 200);
      const effectiveType = str((c as { effectiveType?: unknown }).effectiveType, 80);
      if (tags.length === 0 && synonyms.length === 0 && !contentSummary && !effectiveType) continue;
      columns.push({
        name,
        tags,
        synonyms,
        ...(str(c.note, 160) ? { note: str(c.note, 160)! } : {}),
        // LEVEL 1: only present when the declared type wasn't self-describing —
        // the prompt asks the model to OMIT it otherwise, so its presence is
        // itself the signal.
        ...(effectiveType ? { effectiveType } : {}),
        // LEVEL 2: the analyst's plain-language description.
        ...(contentSummary ? { contentSummary } : {}),
      });
    }
    const synopsis =
      typeof raw.synopsis === "string" && raw.synopsis.trim()
        ? raw.synopsis.trim().slice(0, 400)
        : undefined;
    out.push({
      table: tableName,
      ...(typeof raw.purpose === "string" && raw.purpose.trim()
        ? { purpose: raw.purpose.trim().slice(0, 200) }
        : {}),
      ...(synopsis ? { synopsis } : {}),
      columns,
    });
  }
  return out;
}

export function mergeSemantic(batches: SemanticTable[][]): SemanticTable[] {
  const byTable = new Map<string, SemanticTable>();
  for (const batch of batches) {
    for (const t of batch) {
      byTable.set(t.table.toLowerCase(), t); // later batches win (re-index)
    }
  }
  return [...byTable.values()];
}

// --- query-time schema search ------------------------------------------------

/** Words users say → concept tags, so "records owned by X" hits columns the
 *  index tagged "ownership" even when no synonym matches verbatim. */
const TAG_HINTS: Record<string, string[]> = {
  owned: ["ownership"],
  owner: ["ownership"],
  owners: ["ownership"],
  owns: ["ownership"],
  ownership: ["ownership"],
  belongs: ["ownership"],
  responsible: ["ownership"],
  who: ["person", "ownership"],
  person: ["person"],
  user: ["person"],
  email: ["email"],
  mail: ["email"],
  phone: ["phone"],
  where: ["location"],
  location: ["location"],
  when: ["date"],
  date: ["date"],
  created: ["date", "audit"],
  updated: ["date", "audit"],
  modified: ["date", "audit"],
  status: ["status"],
  state: ["status"],
  cost: ["money"],
  price: ["money"],
  amount: ["money", "quantity"],
  app: ["application"],
  application: ["application"],
  server: ["host"],
  host: ["host"],
  ip: ["network"],
};

interface ScoredTable {
  table: TableDef;
  semantic?: SemanticTable;
  score: number;
  matchedColumns: Set<string>;
}

/**
 * Rank tables/columns against a free-form topic ("ownership", "owned by
 * jdoe", "application servers"). Matches column/table names, semantic tags,
 * synonyms, purposes — names always work even without a semantic index.
 */
export function searchSchema(
  schema: SourceSchema,
  topic: string | undefined,
  maxTables = 12,
): ScoredTable[] {
  const semByTable = new Map<string, SemanticTable>(
    (schema.semantic?.tables ?? []).map((t) => [t.table.toLowerCase(), t]),
  );
  const all: ScoredTable[] = schema.catalog.tables.map((t) => ({
    table: t,
    semantic: semByTable.get(qualifiedName(t).toLowerCase()),
    score: 0,
    matchedColumns: new Set<string>(),
  }));
  if (!topic?.trim()) {
    return all.slice(0, maxTables);
  }
  const words = topic
    .toLowerCase()
    .split(/[^\p{L}\p{N}_.]+/u)
    .filter((w) => w.length >= 2);
  const wantedTags = new Set(words.flatMap((w) => TAG_HINTS[w] ?? []));

  for (const entry of all) {
    const tableName = qualifiedName(entry.table).toLowerCase();
    for (const w of words) {
      if (tableName.includes(w)) entry.score += 4;
      if (entry.semantic?.purpose?.toLowerCase().includes(w)) entry.score += 3;
      if (entry.semantic?.synopsis?.toLowerCase().includes(w)) entry.score += 3;
    }
    for (const col of entry.table.columns) {
      const colName = col.name.toLowerCase();
      const sem = entry.semantic?.columns.find((c) => c.name.toLowerCase() === colName);
      let hit = 0;
      for (const w of words) {
        if (colName.includes(w)) hit += 3;
        if (sem?.synonyms.some((s) => s.toLowerCase().includes(w) || w.includes(s.toLowerCase()))) hit += 4;
        if (sem?.note?.toLowerCase().includes(w)) hit += 2;
        if (sem?.contentSummary?.toLowerCase().includes(w)) hit += 3;
      }
      for (const tag of sem?.tags ?? []) {
        if (wantedTags.has(tag)) hit += 5;
        if (words.includes(tag)) hit += 4;
      }
      if (hit > 0) {
        entry.score += hit;
        entry.matchedColumns.add(col.name);
      }
    }
  }
  return all
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxTables);
}

/** Compact tool-facing rendering of a schema search (token-budgeted). */
export function renderSchemaForModel(
  schema: SourceSchema,
  topic: string | undefined,
  maxChars = 6_000,
): string {
  const ranked = searchSchema(schema, topic);
  if (ranked.length === 0) {
    return `No tables matched "${topic}". The catalog has ${schema.catalog.tables.length} tables — try a broader topic or omit it to list them.`;
  }
  const lines: string[] = [];
  const header = `${schema.catalog.engine} database "${schema.catalog.database}" — ${schema.catalog.tables.length} tables${schema.catalog.truncated ? " (catalog truncated by caps)" : ""}, semantic index: ${schema.semanticState}.`;
  lines.push(header);
  for (const e of ranked) {
    const q = qualifiedName(e.table);
    // The content pass's synopsis (informed by actual values) is the better
    // description when present; `purpose` is name-only inference.
    const headline = e.semantic?.synopsis || e.semantic?.purpose;
    lines.push(`\n${q}${headline ? ` — ${headline}` : ""} (${e.table.kind})`);
    const cols =
      e.matchedColumns.size > 0
        ? e.table.columns.filter((c) => e.matchedColumns.has(c.name))
        : e.table.columns.slice(0, 15);
    for (const c of cols) {
      const sem = e.semantic?.columns.find((x) => x.name.toLowerCase() === c.name.toLowerCase());
      const extra = sem
        ? `${sem.effectiveType ? ` (really ${sem.effectiveType})` : ""} [${sem.tags.join(",")}${sem.synonyms.length ? ` | aka: ${sem.synonyms.join(", ")}` : ""}]${sem.note ? ` — ${sem.note}` : ""}${sem.contentSummary ? ` — values: ${sem.contentSummary}` : ""}${sem.profile ? ` {${describeProfile(sem.profile)}}` : ""}`
        : "";
      lines.push(`  - ${c.name}: ${c.dataType}${extra}`);
    }
    if (e.matchedColumns.size === 0 && e.table.columns.length > 15) {
      lines.push(`  … ${e.table.columns.length - 15} more columns`);
    }
    if (lines.join("\n").length > maxChars) break;
  }
  return lines.join("\n").slice(0, maxChars);
}


// --- content-type indexing (sampled values → Copilot descriptions) ------------

/** One sample query per table (cheap); per-column distincts are computed
 *  locally from the row sample, never with N-per-column queries. */
/** The columns the SQL sample actually SELECTs — the same slice buildSampleQuery
 *  uses, exported so the profiler can seed an entry for every queried column
 *  (including ones that are null in every sampled row). */
export function sampledColumnNames(table: TableDef): string[] {
  return table.columns.slice(0, SAMPLE_COLUMN_CAP).map((c) => c.name);
}

/** Columns per table in the content sample. */
export const SAMPLE_COLUMN_CAP = 16;

/** What the sampler returns: value lists plus the measured profile. */
export interface TableValueSample {
  values: Record<string, string[]>;
  profile: Record<string, ColumnProfile>;
}

export function buildSampleQuery(
  engine: ContextSourceType,
  table: TableDef,
  rows = CONTENT_SAMPLE_ROWS,
): string {
  const cols = sampledColumnNames(table);
  const q = (c: string) =>
    engine === "mssql" ? `[${c}]` : engine === "mysql" ? `\`${c}\`` : `"${c}"`;
  const target = table.schema ? `${q(table.schema)}.${q(table.name)}` : q(table.name);
  const list = cols.map(q).join(", ");
  return engine === "mssql"
    ? `SELECT TOP ${rows} ${list} FROM ${target}`
    : `SELECT ${list} FROM ${target} LIMIT ${rows}`;
}

/** Sampled rows → the FIRST-SEEN distinct values per column (truncated, deduped,
 *  capped at CONTENT_DISTINCT_PER_COLUMN). Not "top" values: nothing here ranks
 *  by frequency — the cap is hit in row order, so a column whose common value
 *  happens to appear late may not be represented. `profileColumns` carries the
 *  measured counts that the value list deliberately does not. */
export function distinctValues(
  rows: Array<Record<string, unknown>>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const row of rows) {
    for (const [k, v] of Object.entries(row)) {
      if (v === null || v === undefined) continue;
      const s = String(v).replace(/\s+/g, " ").trim().slice(0, CONTENT_VALUE_MAX_CHARS);
      if (!s) continue;
      const seen = (out[k] ??= []);
      if (!seen.includes(s) && seen.length < CONTENT_DISTINCT_PER_COLUMN) seen.push(s);
    }
  }
  return out;
}

export interface TableSample {
  table: string;
  values: Record<string, string[]>;
  /** Measured per-column facts from the same sampled rows (null rate,
   *  cardinality, lengths). Optional so older callers/tests still typecheck. */
  profile?: Record<string, ColumnProfile>;
}

/**
 * Profile the sampled rows LOCALLY — no extra query, no data sent.
 *
 * `distinctValues` deliberately drops nulls (it is building a value list), which
 * made "sparsely populated / mostly null" unobservable and made a 100%-null
 * column VANISH from the payload entirely. This walks the same rows and counts
 * what the value list throws away, so an analyst-style description ("almost
 * always null", "5 distinct codes") rests on measurement rather than a guess.
 *
 * Keyed by the column names the ROWS actually carry, and seeded from
 * `columnNames` when given so a column that is null in every sampled row still
 * gets an entry (nulls = sampled) instead of disappearing.
 */
export function profileColumns(
  rows: Array<Record<string, unknown>>,
  columnNames?: readonly string[],
): Record<string, ColumnProfile> {
  const out: Record<string, ColumnProfile> = {};
  const ensure = (k: string): ColumnProfile =>
    (out[k] ??= { sampled: rows.length, nulls: 0, distinct: 0 });
  for (const name of columnNames ?? []) ensure(name);
  const distinct: Record<string, Set<string>> = {};
  for (const row of rows) {
    for (const [k, v] of Object.entries(row)) {
      const p = ensure(k);
      if (v === null || v === undefined) {
        p.nulls += 1;
        continue;
      }
      const str = String(v);
      const set = (distinct[k] ??= new Set());
      // Cap the distinct SET so a unique-per-row column can't grow it without
      // bound; the count then reads "at least N", which is what matters for
      // telling a code list from a free-text field.
      if (set.size < PROFILE_DISTINCT_CAP) set.add(str);
      const len = str.length;
      p.minLength = p.minLength === undefined ? len : Math.min(p.minLength, len);
      p.maxLength = p.maxLength === undefined ? len : Math.max(p.maxLength, len);
      const cmp = str.slice(0, CONTENT_VALUE_MAX_CHARS);
      p.min = p.min === undefined || cmp < p.min ? cmp : p.min;
      p.max = p.max === undefined || cmp > p.max ? cmp : p.max;
    }
  }
  // A column present in `columnNames` but absent from every row object still
  // counted zero nulls above; treat unseen as null so the rate is honest.
  for (const [k, p] of Object.entries(out)) {
    p.distinct = distinct[k]?.size ?? 0;
    const seen = p.nulls + p.distinct;
    if (seen === 0 && rows.length > 0) p.nulls = rows.length;
  }
  return out;
}

/** Beyond this many distinct values the column is "high cardinality" and the
 *  exact count stops being informative. */
export const PROFILE_DISTINCT_CAP = 50;

/** One-line, human rendering of a profile — used in the prompt and the guide
 *  so "mostly null" is stated as measured fact, not model opinion. */
export function describeProfile(p: ColumnProfile): string {
  const bits: string[] = [];
  if (p.sampled > 0) {
    const nullPct = Math.round((p.nulls / p.sampled) * 100);
    if (nullPct >= 95) bits.push(`${nullPct}% NULL (essentially unpopulated)`);
    else if (nullPct >= 50) bits.push(`${nullPct}% NULL (sparsely populated)`);
    else if (nullPct > 0) bits.push(`${nullPct}% NULL`);
    else bits.push("never NULL");
  }
  if (p.distinct > 0) {
    bits.push(p.distinct >= PROFILE_DISTINCT_CAP ? `${PROFILE_DISTINCT_CAP}+ distinct` : `${p.distinct} distinct`);
  }
  if (p.minLength !== undefined && p.maxLength !== undefined) {
    bits.push(p.minLength === p.maxLength ? `length ${p.minLength}` : `length ${p.minLength}-${p.maxLength}`);
  }
  return bits.join(", ");
}

/** Prompt for one batch of table samples: describe what the VALUES are so a
 *  search can route questions ("records owned by X" / "German customers"). */
export function buildContentPrompt(
  catalog: SchemaCatalog,
  samples: TableSample[],
): string {
  // Declared type + measured profile ride along with the values: without the
  // declared type the model cannot tell that a varchar is really holding dates,
  // and without the profile "mostly null" would be a guess rather than a fact.
  const declared = new Map<string, string>();
  for (const t of catalog.tables) {
    for (const c of t.columns) declared.set(`${qualifiedName(t).toLowerCase()}|${c.name.toLowerCase()}`, c.dataType);
  }
  const block = samples
    .map((s) => {
      const cols = [...new Set([...Object.keys(s.values), ...Object.keys(s.profile ?? {})])];
      const lines = cols.map((c) => {
        const type = declared.get(`${s.table.toLowerCase()}|${c.toLowerCase()}`) ?? "unknown";
        const prof = s.profile?.[c];
        const stats = prof ? ` {${describeProfile(prof)}}` : "";
        const vals = (s.values[c] ?? []).join(" | ");
        return `  - ${c} (declared ${type})${stats}: ${vals || "(no non-null values sampled)"}`;
      });
      return `${s.table}:\n${lines.join("\n")}`;
    })
    .join("\n\n");
  return [
    `You are profiling the CONTENT of a ${catalog.engine} database ("${catalog.database}") the way`,
    "a data analyst would, so a search assistant can route free-form questions to the right",
    "columns and know what it will get back.",
    "",
    "For each column below you are given its DECLARED type, MEASURED statistics in {braces}",
    "(computed locally from a sample — treat them as fact, do not contradict them), and up to",
    "10 distinct sampled values.",
    "",
    "Produce, per column:",
    '  - "effectiveType": what the values REALLY are when the declared type does not say —',
    '    e.g. declared varchar but holding "2024-03-01" → "date (ISO-8601, stored as text)";',
    '    varchar holding "1"/"0" → "boolean flag stored as text"; varchar holding JSON → "JSON".',
    "    OMIT this field entirely when the declared type already describes the values.",
    '  - "contentSummary": one plain-BUSINESS-language phrase an analyst would use for what the',
    '    column holds — e.g. "ISO country codes"; "lifecycle status: Active/Retired"; "owning',
    '    CIO organisation names". Mention sparseness when the stats show it (e.g. "free-text',
    '    close notes, populated on ~10% of rows"). Do NOT rely on the column name alone: if the',
    "    values contradict the name, describe the VALUES and say so.",
    '  - "tags"/"synonyms": refine only when the values clarify meaning.',
    "",
    "And per table, a \"synopsis\": one or two sentences saying what the table holds and what a",
    "single ROW represents (the grain), in business language.",
    "",
    "Return ONLY JSON, exactly:",
    '{"tables":[{"table":"<as given>","synopsis":"<1-2 sentences>","columns":[{"name":"<col>",',
    '"effectiveType":"<optional>","contentSummary":"<one phrase>","tags":["<concept>", ...],',
    '"synonyms":["<words>", ...]}]}]}',
    "",
    "Columns (declared type, {measured stats}, sampled values):",
    block,
  ].join("\n");
}

/**
 * Merge a content pass into the existing semantic index without losing the
 * schema pass: tags/synonyms union, and the content fields (contentSummary,
 * effectiveType, profile) added or refreshed.
 *
 * PURE — it copies rather than mutating. The caller hands it the STORED
 * `semantic.tables`, and with per-batch checkpointing this now runs many times
 * per run; mutating in place would edit the persisted objects underneath the
 * store and make each checkpoint depend on the last one's side effects.
 */
export function mergeContentIntoSemantic(
  existing: SemanticTable[],
  content: SemanticTable[],
): SemanticTable[] {
  const byTable = new Map<string, SemanticTable>(
    existing.map((t) => [t.table.toLowerCase(), { ...t, columns: t.columns.map((c) => ({ ...c })) }]),
  );
  for (const ct of content) {
    const key = ct.table.toLowerCase();
    const base = byTable.get(key);
    if (!base) {
      byTable.set(key, { ...ct, columns: ct.columns.map((c) => ({ ...c })) });
      continue;
    }
    // Table-level facts the content pass owns.
    const nextTable: SemanticTable = {
      ...base,
      ...(ct.synopsis ? { synopsis: ct.synopsis } : {}),
      ...(ct.contentIndexedAt ? { contentIndexedAt: ct.contentIndexedAt } : {}),
      ...(ct.fingerprint ? { fingerprint: ct.fingerprint } : {}),
      columns: base.columns.map((c) => ({ ...c })),
    };
    const byCol = new Map(nextTable.columns.map((c) => [c.name.toLowerCase(), c]));
    for (const cc of ct.columns) {
      const bc = byCol.get(cc.name.toLowerCase());
      if (!bc) {
        nextTable.columns.push({ ...cc });
        continue;
      }
      bc.tags = [...new Set([...bc.tags, ...cc.tags])].slice(0, 8);
      bc.synonyms = [...new Set([...bc.synonyms, ...cc.synonyms])].slice(0, 10);
      if (cc.contentSummary) bc.contentSummary = cc.contentSummary;
      if (cc.effectiveType) bc.effectiveType = cc.effectiveType;
      if (cc.profile) bc.profile = cc.profile;
      if (cc.note && !bc.note) bc.note = cc.note;
    }
    byTable.set(key, nextTable);
  }
  return [...byTable.values()];
}
