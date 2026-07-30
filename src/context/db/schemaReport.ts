/**
 * Reporting over a database schema + semantic index (pure).
 *
 * Three questions this answers that the raw catalog cannot:
 *
 *  1. WHICH TABLES ARE BIG. A per-table inventory sorted by size, so the
 *     handful of tables that matter are visible without scrolling a
 *     thousand-table document.
 *  2. WHICH TABLES ARE STILL ALIVE. Age bands over the measured last-updated
 *     date — and weighted by rows and bytes, because "40 of 120 tables are
 *     dormant" and "the dormant tables hold 92% of the rows" are different
 *     findings and only the second one changes what you do next.
 *  3. WHETHER THE CATALOG EVEN FITS. The read caps are user-settable, so the
 *     useful thing is not "you hit a cap" but "this database needs 1,900 and
 *     450; you have 1,000 and 300."
 *
 * Everything here is pure and takes `nowIso` rather than reading a clock, so
 * age bands are testable at a fixed instant.
 */

import { SourceSchema, SchemaCatalog, SemanticTable, qualifiedName } from "./schemaIndex";
import { TableStats, TableStatsIndex, formatBytes, formatRows, normalizeRecencyFailures } from "./tableStats";
import { Sheet } from "../files/sheet";

// --- aging -------------------------------------------------------------------

export type AgeBand = "current" | "recent" | "aging" | "stale" | "dormant" | "unknown";

/**
 * Bands, widest-first in recency terms. The boundaries are the ones people
 * already reason in — a month, a quarter, a year, three years — rather than
 * anything derived, because the point is to make a judgement call easy, not to
 * be precise about a number that is itself an approximation.
 */
export const AGE_BANDS: ReadonlyArray<{ band: Exclude<AgeBand, "unknown">; maxDays: number; label: string }> = [
  { band: "current", maxDays: 30, label: "Current (≤ 30 days)" },
  { band: "recent", maxDays: 90, label: "Recent (≤ 90 days)" },
  { band: "aging", maxDays: 365, label: "Aging (≤ 1 year)" },
  { band: "stale", maxDays: 365 * 3, label: "Stale (1–3 years)" },
  { band: "dormant", maxDays: Number.POSITIVE_INFINITY, label: "Dormant (> 3 years)" },
];

export const AGE_BAND_LABEL: Record<AgeBand, string> = {
  ...Object.fromEntries(AGE_BANDS.map((b) => [b.band, b.label])),
  unknown: "Unknown (not measured)",
} as Record<AgeBand, string>;

/** Whole days between two ISO instants; undefined when either is unusable. */
export function ageInDays(lastUpdated: string | undefined, nowIso: string): number | undefined {
  if (!lastUpdated) return undefined;
  const then = Date.parse(lastUpdated);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(then) || !Number.isFinite(now)) return undefined;
  // A future timestamp is a clock skew or a business date that slipped through,
  // not negative age — clamp rather than report "-40 days".
  return Math.max(0, Math.floor((now - then) / 86_400_000));
}

export function classifyAge(lastUpdated: string | undefined, nowIso: string): AgeBand {
  const days = ageInDays(lastUpdated, nowIso);
  if (days === undefined) return "unknown";
  return AGE_BANDS.find((b) => days <= b.maxDays)?.band ?? "dormant";
}

export interface AgingBandSummary {
  band: AgeBand;
  label: string;
  tables: number;
  rows?: number;
  bytes?: number;
  /** A few table names, so a band is inspectable without opening the export. */
  examples: string[];
}

export interface AgingSummary {
  bands: AgingBandSummary[];
  /** Tables with a measured last-updated date. */
  measured: number;
  /** Tables with none — no probe run, or no honest audit-date column. */
  unmeasured: number;
  total: number;
  /** One sentence naming the finding, not just the counts. */
  headline: string;
}

/**
 * Age profile of a whole database.
 *
 * Bands are reported with their ROW and BYTE totals as well as table counts
 * because that is where the finding usually is: a schema whose dormant tables
 * are all tiny lookup tables is healthy, and one whose dormant tables hold most
 * of the data is a migration nobody finished.
 */
export function summarizeAging(
  catalog: SchemaCatalog,
  stats: TableStatsIndex | undefined,
  nowIso: string,
): AgingSummary {
  const order: AgeBand[] = [...AGE_BANDS.map((b) => b.band), "unknown"];
  const acc = new Map<AgeBand, AgingBandSummary>(
    order.map((band) => [band, { band, label: AGE_BAND_LABEL[band], tables: 0, examples: [] }]),
  );
  let measured = 0;
  for (const t of catalog.tables) {
    const q = qualifiedName(t);
    const s = stats?.tables[q.toLowerCase()];
    const band = classifyAge(s?.lastUpdated, nowIso);
    if (band !== "unknown") measured += 1;
    const entry = acc.get(band)!;
    entry.tables += 1;
    if (s?.rows !== undefined) entry.rows = (entry.rows ?? 0) + s.rows;
    if (s?.bytes !== undefined) entry.bytes = (entry.bytes ?? 0) + s.bytes;
    if (entry.examples.length < 5) entry.examples.push(q);
  }
  const bands = order.map((b) => acc.get(b)!).filter((b) => b.tables > 0);
  const total = catalog.tables.length;
  return {
    bands,
    measured,
    unmeasured: total - measured,
    total,
    headline: agingHeadline(bands, measured, total),
  };
}

/** A share that never claims more than it has: 99.99% is not "100% of the
 *  rows" while other tables still hold some, and 0.4% is not "0%". */
function rowShare(part: number, whole: number): string {
  const pct = (part / whole) * 100;
  if (part >= whole) return "100%";
  if (pct > 99) return ">99%";
  if (part > 0 && pct < 1) return "<1%";
  return `${Math.round(pct)}%`;
}

function agingHeadline(bands: AgingBandSummary[], measured: number, total: number): string {
  if (total === 0) return "No tables in the catalog.";
  if (measured === 0) {
    return "No table has a measured last-updated date yet — run “Refresh Database Table Statistics” and choose to probe last-updated.";
  }
  const live = bands
    .filter((b) => b.band === "current" || b.band === "recent")
    .reduce((n, b) => n + b.tables, 0);
  const cold = bands.filter((b) => b.band === "stale" || b.band === "dormant");
  const coldTables = cold.reduce((n, b) => n + b.tables, 0);
  const coldRows = cold.reduce((n, b) => n + (b.rows ?? 0), 0);
  const allRows = bands.reduce((n, b) => n + (b.rows ?? 0), 0);
  const parts = [`${live} of ${measured} measured table(s) were written to in the last 90 days`];
  if (coldTables > 0) {
    // The row share is the part that decides whether "stale" means "safe to
    // ignore" or "most of the database is a dead migration".
    parts.push(
      `${coldTables} ${coldTables === 1 ? "has" : "have"} not changed in over a year${
        allRows > 0 ? ` and hold ${rowShare(coldRows, allRows)} of the rows` : ""
      }`,
    );
  }
  if (measured < total) parts.push(`${total - measured} could not be measured`);
  return `${parts.join("; ")}.`;
}

// --- per-table inventory -----------------------------------------------------

export interface InventoryRow {
  table: string;
  kind: string;
  columns: number;
  /** True when the catalog holds fewer columns than the database reports. */
  columnsTruncated: boolean;
  rows?: number;
  bytes?: number;
  lastUpdated?: string;
  lastUpdatedBasis?: string;
  age: AgeBand;
  ageDays?: number;
  /** Why there is no date, when there isn't one. */
  recencyNote?: string;
  indexed: boolean;
  contentIndexed: boolean;
  synopsis?: string;
  purpose?: string;
}

/**
 * Every table with its measured facts and index state, biggest first.
 *
 * Sorted by bytes (then rows, then name) rather than alphabetically: on a
 * thousand-table schema the alphabetical order buries the ten tables that hold
 * the data, and those are what a reader is looking for.
 */
export function buildInventory(schema: SourceSchema, nowIso: string): InventoryRow[] {
  const sem = new Map<string, SemanticTable>(
    (schema.semantic?.tables ?? []).map((t) => [t.table.toLowerCase(), t]),
  );
  const rows = schema.catalog.tables.map((t): InventoryRow => {
    const q = qualifiedName(t);
    const s: TableStats | undefined = schema.stats?.tables[q.toLowerCase()];
    const entry = sem.get(q.toLowerCase());
    return {
      table: q,
      kind: t.kind,
      columns: s?.columns ?? t.columns.length,
      columnsTruncated: s?.columns !== undefined && s.columns > t.columns.length,
      ...(s?.rows !== undefined ? { rows: s.rows } : {}),
      ...(s?.bytes !== undefined ? { bytes: s.bytes } : {}),
      ...(s?.lastUpdated ? { lastUpdated: s.lastUpdated } : {}),
      ...(s?.lastUpdatedBasis ? { lastUpdatedBasis: s.lastUpdatedBasis } : {}),
      age: classifyAge(s?.lastUpdated, nowIso),
      ...(ageInDays(s?.lastUpdated, nowIso) !== undefined
        ? { ageDays: ageInDays(s?.lastUpdated, nowIso) }
        : {}),
      ...(s?.recencyNote ? { recencyNote: s.recencyNote } : {}),
      indexed: entry !== undefined,
      contentIndexed: entry?.contentIndexedAt !== undefined,
      ...(entry?.synopsis ? { synopsis: entry.synopsis } : {}),
      ...(entry?.purpose ? { purpose: entry.purpose } : {}),
    };
  });
  return rows.sort(
    (a, b) => (b.bytes ?? -1) - (a.bytes ?? -1) || (b.rows ?? -1) - (a.rows ?? -1) || a.table.localeCompare(b.table),
  );
}

/** A view has no storage of its own — an empty size cell would read as
 *  "not measured" when the truth is "not applicable". */
function sizeCell(r: InventoryRow): string {
  if (r.bytes !== undefined) return formatBytes(r.bytes);
  return r.kind === "view" ? "n/a (view)" : "—";
}

function rowsCell(r: InventoryRow): string {
  if (r.rows !== undefined) return formatRows(r.rows);
  return r.kind === "view" ? "n/a (view)" : "—";
}

function ageCell(r: InventoryRow): string {
  if (r.lastUpdated) {
    return `${r.lastUpdated.slice(0, 10)}${r.ageDays !== undefined ? ` (${r.ageDays}d)` : ""}`;
  }
  return r.recencyNote ? `— (${r.recencyNote})` : "—";
}

/** Markdown inventory for the schema view. */
export function inventoryMarkdown(rows: InventoryRow[], limit = 200): string[] {
  if (rows.length === 0) return [];
  const out = [
    "| Table | Rows | Size | Cols | Last updated | Age | Indexed |",
    "|---|---:|---:|---:|---|---|---|",
  ];
  for (const r of rows.slice(0, limit)) {
    out.push(
      `| \`${r.table}\`${r.kind === "view" ? " _(view)_" : ""} | ${rowsCell(r)} | ${sizeCell(r)} | ${
        r.columns
      }${r.columnsTruncated ? " ⚠️" : ""} | ${ageCell(r)} | ${AGE_BAND_LABEL[r.age].replace(/ \(.*\)$/, "")} | ${
        r.contentIndexed ? "schema+content" : r.indexed ? "schema" : "no"
      } |`,
    );
  }
  if (rows.length > limit) {
    out.push("", `_… ${rows.length - limit} more — export the XLSX report for the full list._`);
  }
  return out;
}

/** Aging block for the schema view. */
export function agingMarkdown(aging: AgingSummary): string[] {
  if (aging.total === 0) return [];
  const out = [
    `**${aging.headline}**`,
    "",
    "| Age | Tables | Rows | Size | Examples |",
    "|---|---:|---:|---:|---|",
  ];
  for (const b of aging.bands) {
    out.push(
      `| ${b.label} | ${b.tables} | ${b.rows !== undefined ? formatRows(b.rows) : "—"} | ${
        b.bytes !== undefined ? formatBytes(b.bytes) : "—"
      } | ${b.examples.map((e) => `\`${e}\``).join(", ")} |`,
    );
  }
  return out;
}

// --- catalog capacity --------------------------------------------------------

/** What a database would need to be catalogued completely. */
export interface CatalogCapacity {
  /** Tables + views the account can see. */
  tables: number;
  /** Columns in the widest one. */
  maxColumns: number;
  widestTable?: string;
  totalColumns: number;
  /** True when the engine can't answer cheaply (MongoDB has no catalog). */
  estimated?: boolean;
}

/**
 * One row per table with its column count — cheap metadata, and enough to
 * derive every capacity figure in JS rather than in three dialects of
 * aggregate SQL. It also yields the widest table's NAME for free, which is the
 * thing a person needs in order to believe the recommendation.
 */
export function buildCapacityProbeSql(engine: "mssql" | "postgres" | "mysql"): string {
  switch (engine) {
    case "mssql":
      return (
        "SELECT s.name AS table_schema, o.name AS table_name, COUNT(c.column_id) AS column_count " +
        "FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id " +
        "JOIN sys.columns c ON c.object_id = o.object_id " +
        "WHERE o.type IN ('U','V') GROUP BY s.name, o.name"
      );
    case "postgres":
      return (
        "SELECT table_schema, table_name, COUNT(*) AS column_count FROM information_schema.columns " +
        "WHERE table_schema NOT IN ('pg_catalog','information_schema') GROUP BY table_schema, table_name"
      );
    case "mysql":
      return (
        "SELECT table_schema, table_name, COUNT(*) AS column_count FROM information_schema.columns " +
        "WHERE table_schema = DATABASE() GROUP BY table_schema, table_name"
      );
  }
}

export function parseCapacity(rows: Array<Record<string, unknown>>): CatalogCapacity {
  const val = (r: Record<string, unknown>, k: string) => r[k] ?? r[k.toUpperCase()] ?? r[k.toLowerCase()];
  let maxColumns = 0;
  let widestTable: string | undefined;
  let totalColumns = 0;
  let tables = 0;
  for (const r of rows) {
    const name = val(r, "table_name");
    if (!name) continue;
    tables += 1;
    const n = Number(val(r, "column_count")) || 0;
    totalColumns += n;
    if (n > maxColumns) {
      maxColumns = n;
      const schema = val(r, "table_schema");
      widestTable = `${schema ? `${String(schema)}.` : ""}${String(name)}`;
    }
  }
  return { tables, maxColumns, totalColumns, ...(widestTable ? { widestTable } : {}) };
}

export interface LimitRecommendation {
  /** What the settings should be. */
  maxTables: number;
  maxColumnsPerTable: number;
  /** Tables that the CURRENT table cap would leave out entirely. */
  tablesMissed: number;
  /** Tables the CURRENT column cap would describe incompletely. */
  tablesTruncated: number;
  /** True when the current settings already cover the database. */
  adequate: boolean;
  /** True when the database exceeds what the hard ceilings allow. */
  exceedsCeiling: boolean;
  summary: string;
}

/** Round up to something a person would type. */
function niceCeil(n: number): number {
  if (n <= 100) return Math.ceil(n / 10) * 10;
  if (n <= 1_000) return Math.ceil(n / 50) * 50;
  return Math.ceil(n / 100) * 100;
}

/**
 * What the caps must be for this database, with headroom.
 *
 * Recommends ~15% above what the database needs today, rounded up, so a schema
 * that grows by a few tables doesn't silently start truncating again a month
 * later — the failure mode being avoided is the quiet one, where a table
 * vanishes from the catalog and nothing says so until someone notices an answer
 * is wrong.
 */
export function recommendLimits(
  cap: CatalogCapacity,
  current: { maxTables: number; maxColumnsPerTable: number },
  ceilings: { maxTables: number; maxColumnsPerTable: number },
  columnCountsPerTable?: readonly number[],
): LimitRecommendation {
  const wantTables = Math.min(ceilings.maxTables, Math.max(current.maxTables, niceCeil(cap.tables * 1.15)));
  const wantColumns = Math.min(
    ceilings.maxColumnsPerTable,
    Math.max(current.maxColumnsPerTable, niceCeil(cap.maxColumns * 1.15)),
  );
  const tablesMissed = Math.max(0, cap.tables - current.maxTables);
  const tablesTruncated = columnCountsPerTable
    ? columnCountsPerTable.filter((n) => n > current.maxColumnsPerTable).length
    : cap.maxColumns > current.maxColumnsPerTable
      ? 1
      : 0;
  const adequate = tablesMissed === 0 && cap.maxColumns <= current.maxColumnsPerTable;
  const exceedsCeiling = cap.tables > ceilings.maxTables || cap.maxColumns > ceilings.maxColumnsPerTable;
  const bits: string[] = [
    `${cap.tables.toLocaleString("en-US")} table(s)/view(s), widest has ${cap.maxColumns} column(s)${
      cap.widestTable ? ` (${cap.widestTable})` : ""
    }`,
  ];
  if (adequate) {
    bits.push(`current limits (${current.maxTables}/${current.maxColumnsPerTable}) already cover it`);
  } else {
    if (tablesMissed > 0) bits.push(`${tablesMissed} table(s) would be MISSING at the current cap of ${current.maxTables}`);
    if (tablesTruncated > 0) {
      bits.push(
        `${tablesTruncated} table(s) would be described INCOMPLETELY at the current ${current.maxColumnsPerTable}-column cap`,
      );
    }
    bits.push(`recommended: ${wantTables} tables / ${wantColumns} columns (≈15% headroom)`);
  }
  if (exceedsCeiling) {
    bits.push(
      `NOTE: this database exceeds the supported maximum (${ceilings.maxTables} tables / ${ceilings.maxColumnsPerTable} columns) — catalog it in parts, or accept a partial catalog`,
    );
  }
  return {
    maxTables: wantTables,
    maxColumnsPerTable: wantColumns,
    tablesMissed,
    tablesTruncated,
    adequate,
    exceedsCeiling,
    summary: bits.join("; ") + ".",
  };
}

// --- XLSX report -------------------------------------------------------------

const YES_NO = (b: boolean) => (b ? "yes" : "no");

/**
 * The whole schema + semantic index as workbook sheets.
 *
 * Six sheets rather than one, because these are different grains and mixing
 * them makes all of them unfilterable: one row per table, one row per COLUMN,
 * one row per age band, one per relationship, and one per thing that went
 * wrong. The Summary sheet exists so the file is readable without knowing
 * which tab to open first.
 */
export function schemaReportSheets(
  schema: SourceSchema,
  meta: { sourceName: string; generatedAt: string; version?: string },
): Sheet[] {
  const inventory = buildInventory(schema, meta.generatedAt);
  const aging = summarizeAging(schema.catalog, schema.stats, meta.generatedAt);
  const totalRows = inventory.reduce((n, r) => n + (r.rows ?? 0), 0);
  const totalBytes = inventory.reduce((n, r) => n + (r.bytes ?? 0), 0);
  const totalColumns = inventory.reduce((n, r) => n + r.columns, 0);

  const summary: string[][] = [
    ["Field", "Value"],
    ["Source", meta.sourceName],
    ["Engine", schema.catalog.engine],
    ["Database", schema.catalog.database],
    ["Catalog fetched", schema.catalog.fetchedAt],
    ["Report generated", meta.generatedAt],
    ...(meta.version ? [["Extension version", meta.version]] : []),
    ["Tables/collections", String(schema.catalog.tables.length)],
    ["Columns", totalColumns.toLocaleString("en-US")],
    ["Rows (approx.)", schema.stats ? totalRows.toLocaleString("en-US") : "not measured"],
    ["Size", schema.stats ? formatBytes(totalBytes) : "not measured"],
    ["Statistics measured", schema.stats?.measuredAt ?? "never — run Refresh Database Table Statistics"],
    ["Semantic index", schema.semanticState],
    ["Tables indexed", String(schema.semantic?.tables.length ?? 0)],
    ["Index model", schema.semantic?.modelId ?? "—"],
    ["Index partial", YES_NO(schema.semantic?.partial === true)],
    ["Content types indexed", schema.contentState ?? "none"],
    ["ER relationships", String(schema.er?.relationships.length ?? 0)],
    ["Catalog truncated", YES_NO(schema.catalog.truncated === true)],
    ["Aging", aging.headline],
  ];

  const tables: string[][] = [
    [
      "Table", "Kind", "Rows", "Size", "Bytes", "Columns", "Columns in catalog",
      "Last updated", "Age (days)", "Age band", "Basis", "Schema indexed",
      "Content indexed", "Synopsis / purpose",
    ],
    ...inventory.map((r) => [
      r.table,
      r.kind,
      r.rows !== undefined ? String(r.rows) : "",
      r.bytes !== undefined ? formatBytes(r.bytes) : "",
      r.bytes !== undefined ? String(r.bytes) : "",
      String(r.columns),
      // The catalog may hold fewer than the database has; the gap is the point.
      String(schema.catalog.tables.find((t) => qualifiedName(t) === r.table)?.columns.length ?? r.columns),
      r.lastUpdated ?? "",
      r.ageDays !== undefined ? String(r.ageDays) : "",
      AGE_BAND_LABEL[r.age],
      r.lastUpdatedBasis ?? r.recencyNote ?? "",
      YES_NO(r.indexed),
      YES_NO(r.contentIndexed),
      r.synopsis ?? r.purpose ?? "",
    ]),
  ];

  const sem = new Map<string, SemanticTable>(
    (schema.semantic?.tables ?? []).map((t) => [t.table.toLowerCase(), t]),
  );
  const columns: string[][] = [
    [
      "Table", "Column", "Declared type", "Effective type", "Nullable", "Tags",
      "Also known as", "Content summary", "Note", "Sampled", "% NULL", "Distinct",
      "Min length", "Max length",
    ],
  ];
  for (const t of schema.catalog.tables) {
    const q = qualifiedName(t);
    const entry = sem.get(q.toLowerCase());
    for (const c of t.columns) {
      const sc = entry?.columns.find((x) => x.name.toLowerCase() === c.name.toLowerCase());
      const p = sc?.profile;
      columns.push([
        q,
        c.name,
        c.dataType,
        sc?.effectiveType ?? "",
        c.nullable === undefined ? "" : YES_NO(c.nullable),
        sc?.tags.join(", ") ?? "",
        sc?.synonyms.join(", ") ?? "",
        sc?.contentSummary ?? "",
        sc?.note ?? "",
        p ? String(p.sampled) : "",
        p && p.sampled > 0 ? String(Math.round((p.nulls / p.sampled) * 100)) : "",
        p ? String(p.distinct) : "",
        p?.minLength !== undefined ? String(p.minLength) : "",
        p?.maxLength !== undefined ? String(p.maxLength) : "",
      ]);
    }
  }

  const agingSheet: string[][] = [
    ["Age band", "Tables", "Rows", "Size", "Bytes", "Examples"],
    ...aging.bands.map((b) => [
      b.label,
      String(b.tables),
      b.rows !== undefined ? String(b.rows) : "",
      b.bytes !== undefined ? formatBytes(b.bytes) : "",
      b.bytes !== undefined ? String(b.bytes) : "",
      b.examples.join(", "),
    ]),
  ];

  const relationships: string[][] = [
    ["From", "From column", "To", "To column", "Match fwd %", "Match back %", "Verdict", "Complete", "Reading", "Why tested"],
    ...(schema.er?.relationships ?? []).map((r) => [
      r.fromTable,
      r.fromColumn,
      r.toTable,
      r.toColumn,
      String(Math.round(r.forwardRate * 100)),
      String(Math.round(r.backwardRate * 100)),
      r.verdict,
      YES_NO(r.complete === true),
      r.note ?? "",
      r.reason,
    ]),
  ];

  const issues: string[][] = [["Kind", "Subject", "Detail"]];
  if (schema.catalog.truncation?.tableCap !== undefined) {
    issues.push([
      "Catalog truncated",
      `${schema.catalog.truncation.tableCap}-table cap`,
      "Tables beyond the cap are MISSING from this report. Raise aiSharePoint.context.maxTables and reload the schema.",
    ]);
  }
  for (const t of schema.catalog.truncation?.columnCapped ?? []) {
    issues.push([
      "Columns truncated",
      t,
      `Columns beyond the ${schema.catalog.truncation?.columnCap ?? "?"}-column cap were dropped — this table is listed but not fully described.`,
    ]);
  }
  for (const f of normalizeRecencyFailures(schema.stats?.recencyFailed)) {
    issues.push(["Last-updated probe failed", f.table, f.reason]);
  }
  if (schema.semantic?.partial) {
    issues.push([
      "Semantic index partial",
      schema.catalog.database,
      "A previous indexing run stopped early. Run Index Database Schema and choose Continue to finish it.",
    ]);
  }
  if (issues.length === 1) issues.push(["—", "—", "No issues detected."]);

  return [
    { name: "Summary", rows: summary },
    { name: "Tables", rows: tables },
    { name: "Columns", rows: columns },
    { name: "Aging", rows: agingSheet },
    { name: "Relationships", rows: relationships },
    { name: "Issues", rows: issues },
  ];
}
