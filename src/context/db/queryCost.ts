/**
 * Cost-gated SQL Server queries (ADR-0030). Pilot: free-form discovery
 * (e.g. ER-diagram exploration) ran aggregates over multi-million-row
 * tables and died at the 30s request timeout. Before running a SQL Server
 * statement we now (1) read table sizes and leading index columns from the
 * catalog (instant, metadata-only), (2) estimate whether the statement can
 * avoid a big scan, and (3) when it cannot, run it against a bounded
 * TOP-sample of the big tables instead — clearly labeled — or decline with
 * sizing guidance. Everything here is pure; probes fail OPEN (no stats →
 * the query runs exactly as before).
 */

/** Tables at or above this size make an unindexed scan/aggregate "expensive". */
export const BIG_TABLE_ROWS = 500_000;

/** Per-table sample size when an expensive query is downgraded to a subset. */
export const SUBSET_TOP_ROWS = 10_000;

export interface MssqlTableRef {
  schema?: string;
  name: string;
  /** Exactly as written in the statement (brackets and all). */
  raw: string;
  alias?: string;
  /** Found as `FROM a, b` continuation — probed, but never rewritten. */
  viaCommaList?: boolean;
}

export interface TableStat {
  schema?: string;
  name: string;
  /** undefined = unknown (views have no partition rows) — treated as small. */
  rowCount?: number;
  /** Leading (key_ordinal = 1) columns of any index on the table. */
  leadColumns: string[];
}

export interface CostVerdict {
  expensive: boolean;
  reasons: string[];
  /** The referenced tables whose size triggered the verdict. */
  bigTables: TableStat[];
  /** Human/model-readable sizing of every probed table — answers "how big
   *  is X" without a COUNT(*) scan. */
  statsNote: string;
}

const IDENT = String.raw`(?:\[[^\]]+\]|[A-Za-z_][\w$#@]*)`;
const KEYWORDS = new Set([
  "select", "where", "on", "inner", "outer", "left", "right", "full", "cross",
  "join", "group", "order", "having", "union", "except", "intersect", "as",
  "with", "apply", "pivot", "unpivot", "option", "for", "set", "and", "or", "not",
]);

const unbracket = (s: string): string => s.replace(/^\[|\]$/g, "").trim();

/** Strip string literals and comments so detection never fires inside them. */
function bareSql(sql: string): string {
  return sql
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
}

/** Base tables referenced in FROM/JOIN clauses (derived tables excluded),
 *  including old-style comma lists (`FROM a, b`). */
export function extractMssqlTables(sql: string): MssqlTableRef[] {
  const text = bareSql(sql);
  const head = /\b(?:from|join)\s+/gi;
  const target = new RegExp(
    String.raw`(${IDENT}(?:\s*\.\s*${IDENT}){0,2})(?:\s+(?:as\s+)?(${IDENT}))?`,
    "iy",
  );
  const comma = /\s*,\s*/y;
  const out: MssqlTableRef[] = [];
  const push = (targetRaw: string, aliasCapture: string | undefined, viaCommaList: boolean) => {
    const parts = targetRaw.split(".").map((p) => unbracket(p));
    const name = parts[parts.length - 1];
    if (!name || KEYWORDS.has(name.toLowerCase())) return;
    const aliasRaw = aliasCapture ? unbracket(aliasCapture) : undefined;
    const alias = aliasRaw && !KEYWORDS.has(aliasRaw.toLowerCase()) ? aliasRaw : undefined;
    const schema = parts.length >= 2 ? parts[parts.length - 2] : undefined;
    const existing = out.find(
      (t) => t.name.toLowerCase() === name.toLowerCase() && (t.schema ?? "") === (schema ?? ""),
    );
    if (existing) {
      existing.viaCommaList = existing.viaCommaList || viaCommaList;
      return;
    }
    out.push({
      ...(schema ? { schema } : {}),
      name,
      raw: targetRaw,
      ...(alias ? { alias } : {}),
      ...(viaCommaList ? { viaCommaList } : {}),
    });
  };
  let m: RegExpExecArray | null;
  while ((m = head.exec(text))) {
    let idx = m.index + m[0].length;
    let viaCommaList = false;
    for (;;) {
      target.lastIndex = idx;
      const t = target.exec(text);
      if (!t) break;
      push(t[1], t[2], viaCommaList);
      idx = target.lastIndex;
      comma.lastIndex = idx;
      if (!comma.exec(text)) break;
      idx = comma.lastIndex;
      viaCommaList = true;
    }
    head.lastIndex = Math.max(head.lastIndex, idx);
  }
  return out;
}

/** One cheap catalog read: size + leading index columns for the referenced
 *  tables. Names are validated to plain identifiers (injection-safe); exotic
 *  names are simply not probed — the guard fails open. */
export function buildStatsProbeSql(tables: MssqlTableRef[]): string | undefined {
  const names = [
    ...new Set(
      tables.map((t) => t.name).filter((n) => /^[A-Za-z_][\w$#@]*$/.test(n)),
    ),
  ];
  if (names.length === 0) return undefined;
  const inList = names.map((n) => `N'${n}'`).join(", ");
  return (
    "SELECT s.name AS schema_name, o.name AS table_name, " +
    "(SELECT SUM(p.rows) FROM sys.partitions p WHERE p.object_id = o.object_id AND p.index_id IN (0,1)) AS row_count, " +
    "c.name AS lead_column " +
    "FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id " +
    "LEFT JOIN sys.indexes i ON i.object_id = o.object_id " +
    "LEFT JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.key_ordinal = 1 " +
    "LEFT JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id " +
    `WHERE o.type IN ('U','V') AND o.name IN (${inList})`
  );
}

/** Probe rows → per-table stats, keyed to the tables the query referenced
 *  (schema honored when the query qualified it; bare names match any). */
export function parseTableStats(
  rows: Array<Record<string, unknown>>,
  refs: MssqlTableRef[],
): TableStat[] {
  const bySchemaTable = new Map<string, TableStat>();
  for (const row of rows) {
    const schema = String(row.schema_name ?? "");
    const name = String(row.table_name ?? "");
    if (!name) continue;
    const key = `${schema.toLowerCase()}.${name.toLowerCase()}`;
    const entry =
      bySchemaTable.get(key) ??
      bySchemaTable
        .set(key, {
          schema,
          name,
          ...(row.row_count !== null && row.row_count !== undefined
            ? { rowCount: Number(row.row_count) }
            : {}),
          leadColumns: [],
        })
        .get(key)!;
    const lead = row.lead_column;
    if (typeof lead === "string" && lead && !entry.leadColumns.includes(lead)) {
      entry.leadColumns.push(lead);
    }
  }
  const all = [...bySchemaTable.values()];
  return refs
    .map((ref) =>
      all.find(
        (s) =>
          s.name.toLowerCase() === ref.name.toLowerCase() &&
          (!ref.schema || (s.schema ?? "").toLowerCase() === ref.schema.toLowerCase()),
      ),
    )
    .filter((s): s is TableStat => s !== undefined);
}

const fmtRows = (n?: number): string =>
  n === undefined ? "size unknown" : `≈${n.toLocaleString("en-US")} rows`;

/** Columns compared in the WHERE clause (alias prefixes stripped). */
function whereColumns(text: string): Set<string> {
  const m = /\bwhere\b([\s\S]*?)(?:\bgroup\s+by\b|\border\s+by\b|\bhaving\b|\boption\b|$)/i.exec(text);
  const out = new Set<string>();
  if (!m) return out;
  const colRe = new RegExp(
    String.raw`(${IDENT}(?:\s*\.\s*${IDENT})?)\s*(?:=|<>|!=|>=|<=|>|<|\s+in\b|\s+like\b|\s+between\b)`,
    "gi",
  );
  for (const c of m[1].matchAll(colRe)) {
    const parts = c[1].split(".").map((p) => unbracket(p));
    const col = parts[parts.length - 1].toLowerCase();
    if (!KEYWORDS.has(col)) out.add(col);
  }
  return out;
}

/** Estimate whether the statement avoids scanning its big tables. Catalog
 *  stats only — deliberately conservative, and the caller fails open. */
export function assessMssqlQueryCost(sql: string, stats: TableStat[]): CostVerdict {
  const text = bareSql(sql);
  const statsNote = stats
    .map((s) => `${s.schema ? `${s.schema}.` : ""}${s.name} ${fmtRows(s.rowCount)}${
      s.leadColumns.length ? ` (indexed lead columns: ${s.leadColumns.join(", ")})` : " (no indexes)"
    }`)
    .join("; ");
  const big = stats.filter((s) => (s.rowCount ?? 0) >= BIG_TABLE_ROWS);
  if (big.length === 0) {
    return { expensive: false, reasons: [], bigTables: [], statsNote };
  }
  const top = /\bselect\s+(?:distinct\s+)?top\s*\(?\s*(\d+)/i.exec(text);
  const hasDistinct = /\bdistinct\b/i.test(text);
  const hasGroupBy = /\bgroup\s+by\b/i.test(text);
  const hasOrderBy = /\border\s+by\b/i.test(text);
  const hasAggregate = /\b(count|count_big|sum|avg|min|max|string_agg)\s*\(/i.test(text);
  // TOP n with no sort/dedup/aggregate stops the scan after n rows — cheap
  // no matter the table size.
  if (top && Number(top[1]) <= SUBSET_TOP_ROWS && !hasDistinct && !hasGroupBy && !hasOrderBy && !hasAggregate) {
    return { expensive: false, reasons: [], bigTables: [], statsNote };
  }
  const where = whereColumns(text);
  const reasons: string[] = [];
  const offenders: TableStat[] = [];
  for (const s of big) {
    const seekable = s.leadColumns.some((c) => where.has(c.toLowerCase()));
    if (seekable) continue; // an indexed predicate can seek — let it run
    offenders.push(s);
    const shape =
      [
        hasAggregate ? "aggregates" : "",
        hasDistinct ? "DISTINCT" : "",
        hasGroupBy ? "GROUP BY" : "",
        hasOrderBy ? "ORDER BY" : "",
      ]
        .filter(Boolean)
        .join("/") || "a full read";
    reasons.push(
      `${s.schema ? `${s.schema}.` : ""}${s.name} (${fmtRows(s.rowCount)}) would need ${shape} without an indexed WHERE${
        s.leadColumns.length ? ` (its indexed lead columns: ${s.leadColumns.join(", ")})` : " (it has no indexes)"
      }`,
    );
  }
  return { expensive: offenders.length > 0, reasons, bigTables: offenders, statsNote };
}

/** Rewrite the statement so each BIG table is read through a bounded
 *  `(SELECT TOP n * FROM t)` derived table — the "test on a performant
 *  subset" downgrade. Small tables keep their full data. Returns undefined
 *  when the statement uses shapes we cannot rewrite confidently. */
export function rewriteWithSubset(
  sql: string,
  bigTables: TableStat[],
  n = SUBSET_TOP_ROWS,
): string | undefined {
  const text = bareSql(sql);
  if (/\bwith\b[\s\S]{0,200}?\bas\s*\(/i.test(text)) return undefined; // CTEs
  if (/\b(?:from|join)\s*\(/i.test(text)) return undefined; // derived tables
  if (/\b(?:cross|outer)\s+apply\b|\bpivot\b|\bunpivot\b/i.test(text)) return undefined;
  const bigNames = new Set(bigTables.map((t) => t.name.toLowerCase()));
  // Comma-list references (`FROM a, b`) are probed but not rewritten — the
  // FROM/JOIN replacement below would miss them, silently leaving the big
  // table unbounded. Decline instead; the caller falls back to guidance.
  if (
    extractMssqlTables(sql).some((r) => r.viaCommaList && bigNames.has(r.name.toLowerCase()))
  ) {
    return undefined;
  }
  // Literal/comment spans in the ORIGINAL text — matches inside them are
  // data, not syntax, and must never be rewritten.
  const opaque: Array<[number, number]> = [];
  for (const m of sql.matchAll(/'(?:[^']|'')*'|--[^\n]*|\/\*[\s\S]*?\*\//g)) {
    opaque.push([m.index!, m.index! + m[0].length]);
  }
  const inOpaque = (i: number): boolean => opaque.some(([a, b]) => i >= a && i < b);
  let rewrites = 0;
  const re = new RegExp(
    String.raw`\b(from|join)(\s+)(${IDENT}(?:\s*\.\s*${IDENT}){0,2})((?:\s+(?:as\s+)?${IDENT})?)`,
    "gi",
  );
  const out = sql.replace(
    re,
    (whole, kw: string, sp: string, target: string, aliasPart: string, offset: number) => {
      if (inOpaque(offset)) return whole;
      const parts = target.split(".").map((p) => unbracket(p));
      const name = parts[parts.length - 1];
      if (!bigNames.has(name.toLowerCase())) return whole;
      const aliasMatch = /\s+(?:as\s+)?(\S+)\s*$/i.exec(aliasPart);
      const aliasRaw = aliasMatch ? unbracket(aliasMatch[1]) : undefined;
      const aliasOk = aliasRaw !== undefined && !KEYWORDS.has(aliasRaw.toLowerCase());
      const alias = aliasOk ? aliasMatch![1].trim() : `[${name}]`;
      const keepTail = aliasOk ? "" : aliasPart;
      rewrites += 1;
      return `${kw}${sp}(SELECT TOP ${n} * FROM ${target}) AS ${alias}${keepTail}`;
    },
  );
  return rewrites > 0 ? out : undefined;
}
