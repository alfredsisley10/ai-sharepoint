import {
  SourceSchema,
  TableDef,
  ErModel,
  TestedPair,
  ProbedRelationship,
  qualifiedName,
} from "./schemaIndex";

/**
 * ER probing (ADR-0030): establish table relationships EMPIRICALLY.
 *
 * Enterprise databases routinely ship without declared foreign keys, so the
 * only way to know "what joins to what" is to test it: propose candidate
 * column pairs from the indexed schema (names, types) and semantic index
 * (tags from schema/content indexing), then measure the JOIN MATCH RATE in
 * both directions — sample distinct values from one side and count how many
 * EXIST on the other. A high rate (≈100%) on a pair the indexes already say
 * means the same thing is a reliable join indicator; measuring BOTH
 * directions captures the inner-vs-outer consequence (a table holding an
 * intentional subset joins 100% one way and partially the other).
 *
 * Pure module: candidate selection, per-engine probe query construction,
 * count parsing, classification, and Mermaid rendering. Only match COUNTS
 * ever leave the database — no row data.
 */

export const ER_SAMPLE_SIZE = 100;
/** Floor of the dynamic candidate budget (the old fixed cap). */
export const ER_MAX_CANDIDATES = 40;
/** ≈100%: the rate at which a join reads as designed-in. */
export const ER_STRONG_RATE = 0.95;
/** Below this in BOTH directions, the pair is discarded as coincidence. */
export const ER_LIKELY_RATE = 0.7;

// --- adaptive strategy (ADR-0030 amendment) -----------------------------------
// Probing scales with the database instead of a fixed 40×100 plan: row
// estimates first (catalog statistics — cheap), complete joins where both
// tables are small, sampled probes that ESCALATE while the database answers
// fast and back off when it strains.

/** Both sides at or under this → test the COMPLETE join, not a sample. */
export const ER_FULL_JOIN_MAX_ROWS = 50_000;
/** A probe faster than this invites escalation toward completeness. */
export const ER_FAST_PROBE_MS = 1_500;
/** A probe slower than this pauses the run briefly and stops escalating. */
export const ER_SLOW_PROBE_MS = 5_000;
/** Sampled probes never exceed this many values per side. */
export const ER_MAX_SAMPLE = 10_000;
/** Ceiling on thorough-mode exhaustive pairs (still cancellable). */
export const ER_EXHAUSTIVE_PAIR_CAP = 500;
/** Scopes at or under this many tables are ALWAYS swept exhaustively, in
 *  every mode: "probe all tables for plausible join columns and measure"
 *  is the whole method when nothing else is known about a database. */
export const ER_AUTO_SWEEP_TABLES = 12;

/** Row estimates keyed by lowercase qualified table name. */
export type RowEstimates = Record<string, number>;

/** Dynamic candidate budget: grows with the catalog, never below the old
 *  fixed cap, bounded so a 300-table warehouse stays a bounded run. */
export function candidateBudget(catalog: Pick<SourceSchema["catalog"], "tables">): number {
  const tables = catalog.tables.length;
  const columns = catalog.tables.reduce((n, t) => n + t.columns.length, 0);
  return Math.min(300, Math.max(ER_MAX_CANDIDATES, tables * 3 + Math.floor(columns / 20)));
}

/** First-tier sample for a pair, from row estimates: "full" when both sides
 *  are small enough for a complete join; otherwise sized down as the target
 *  grows (each sampled value costs one indexed-at-best lookup there).
 *  Unknown sizes (0/absent estimate) probe conservatively. */
export function initialSampleSize(rowsFrom: number, rowsTo: number): number | "full" {
  if (rowsFrom > 0 && rowsTo > 0 && rowsFrom <= ER_FULL_JOIN_MAX_ROWS && rowsTo <= ER_FULL_JOIN_MAX_ROWS) {
    return "full";
  }
  if (rowsTo > 10_000_000) return 100;
  if (rowsTo > 1_000_000) return 250;
  if (rowsTo > 0 || rowsFrom > 0) return 500;
  return ER_SAMPLE_SIZE; // nothing known — the conservative classic
}

/** Escalation policy: while the database answers FAST, push the sample ×5
 *  toward completeness (the preference when performance allows); stop at
 *  the cap, at full coverage of the from-side, or the moment a probe is no
 *  longer fast. Returns the next sample, "full" when the from-side fits a
 *  complete pass, or undefined to stop. */
export function nextSampleSize(
  current: number,
  durationMs: number,
  rowsFrom: number,
): number | "full" | undefined {
  if (durationMs >= ER_FAST_PROBE_MS) return undefined;
  if (rowsFrom > 0 && current >= rowsFrom) return undefined; // already complete
  const next = current * 5;
  if (rowsFrom > 0 && (next >= rowsFrom || rowsFrom <= ER_FULL_JOIN_MAX_ROWS)) {
    return current >= rowsFrom ? undefined : "full";
  }
  if (current >= ER_MAX_SAMPLE) return undefined;
  return Math.min(next, ER_MAX_SAMPLE);
}

/** Stable dedupe key for a pair, direction-insensitive. */
export function pairKey(c: Pick<JoinCandidate, "fromTable" | "fromColumn" | "toTable" | "toColumn">): string {
  return [
    `${c.fromTable}.${c.fromColumn}`.toLowerCase(),
    `${c.toTable}.${c.toColumn}`.toLowerCase(),
  ]
    .sort()
    .join("‖");
}

export interface JoinCandidate {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  reason: string;
  priority: number;
  /** User-supplied join: persists as "defined" even when the measured rate
   *  falls below the automatic thresholds. */
  userDefined?: boolean;
  /** Probe by casting both sides to a common text type: joins mismatched
   *  type families AND rescues types `=` cannot compare at all (SQL Server
   *  ntext/text — the silent killer on legacy AD exports). */
  cast?: boolean;
}

export interface JoinProbeCounts {
  sampled: number;
  matched: number;
}

export interface JoinProbeEnd {
  schema?: string;
  table: string;
  column: string;
}

// --- candidate generation -----------------------------------------------------

const NUMERIC_TYPE = /int|numeric|decimal|number|float|double|real|serial/i;
const TEXTUAL_TYPE = /char|text|string|uuid|uniqueidentifier|objectid|sysname/i;

/** Joins only make sense within a type family; dates/bools/blobs never
 *  define relationships. */
export function joinFamily(dataType: string): "num" | "text" | undefined {
  if (NUMERIC_TYPE.test(dataType)) return "num";
  if (TEXTUAL_TYPE.test(dataType)) return "text";
  return undefined;
}

/** Column names too generic for "same name ⇒ related" ("id" exists in every
 *  table; "status" never links two of them). */
const GENERIC_NAMES = new Set([
  "id",
  "name",
  "code",
  "status",
  "type",
  "value",
  "description",
  "label",
  "key",
  "date",
  "created",
  "updated",
  "active",
  "flag",
  "title",
  "comment",
  "notes",
  "guid",
  "uuid",
]);

/** "customer_id" → "customer"; "applid" → "appl"; undefined when the name
 *  has no reference-suffix shape. */
export function fkStem(columnName: string): string | undefined {
  const m = columnName.toLowerCase().match(/^(.{2,})?(?:_id|_key|_code|_no|_num|id)$/);
  const stem = m?.[1]?.replace(/_$/, "");
  return stem && stem.length >= 2 ? stem : undefined;
}

const singular = (name: string): string => name.toLowerCase().replace(/s$/, "");

function keyColumnOf(table: TableDef, refName: string): string | undefined {
  const names = table.columns
    .filter((c) => joinFamily(c.dataType))
    .map((c) => c.name);
  const lower = names.map((n) => n.toLowerCase());
  // Same name as the referencing column, a plain "id", or "<table>_id".
  for (const want of [refName.toLowerCase(), "id", `${singular(table.name)}_id`, `${singular(table.name)}id`]) {
    const i = lower.indexOf(want);
    if (i >= 0) return names[i];
  }
  return undefined;
}

/**
 * Candidate pairs worth probing, prioritized:
 *  4 — FK-shaped name pointing at a table ("customer_id" → table Customers);
 *  3 — identical non-generic column names in two tables;
 *  2 — semantic-index agreement (both tagged "identifier" + a shared second
 *      tag) — this is where schema/content indexing feeds the ER pass.
 * Type families must match throughout; pairs are deduped; output capped.
 */
export function proposeJoinCandidates(
  schema: SourceSchema,
  maxCandidates = candidateBudget(schema.catalog),
): JoinCandidate[] {
  const tables = schema.catalog.tables;
  const out: JoinCandidate[] = [];
  const seen = new Set<string>();
  const add = (c: JoinCandidate) => {
    const key = pairKey(c);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(c);
  };

  // Indexes so the scan stays linear-ish on 300×80 catalogs.
  const byBaseName = new Map<string, TableDef[]>();
  for (const t of tables) {
    const base = singular(t.name);
    (byBaseName.get(base) ?? byBaseName.set(base, []).get(base)!).push(t);
  }
  const byColumnName = new Map<string, Array<{ table: TableDef; column: string; family: string }>>();
  for (const t of tables) {
    for (const c of t.columns) {
      const family = joinFamily(c.dataType);
      if (!family) continue;
      const k = c.name.toLowerCase();
      (byColumnName.get(k) ?? byColumnName.set(k, []).get(k)!).push({ table: t, column: c.name, family });
    }
  }

  // 1 — FK-shaped names: <stem>_id in one table, key column in a table whose
  //     name matches the stem.
  for (const t of tables) {
    for (const c of t.columns) {
      const family = joinFamily(c.dataType);
      if (!family) continue;
      const stem = fkStem(c.name);
      if (!stem) continue;
      const targets = byBaseName.get(stem) ?? byBaseName.get(`${stem}s`.replace(/ss$/, "s")) ?? [];
      for (const target of targets) {
        if (target === t) continue;
        const key = keyColumnOf(target, c.name);
        if (!key) continue;
        const keyFamily = joinFamily(target.columns.find((x) => x.name === key)?.dataType ?? "");
        if (keyFamily !== family) continue;
        add({
          fromTable: qualifiedName(t),
          fromColumn: c.name,
          toTable: qualifiedName(target),
          toColumn: key,
          reason: `name pattern: ${c.name} → ${qualifiedName(target)}.${key}`,
          priority: 4,
        });
      }
    }
  }

  // 2 — identical non-generic column names across tables.
  for (const [name, cols] of byColumnName) {
    if (GENERIC_NAMES.has(name) || cols.length < 2) continue;
    for (let i = 0; i < cols.length && i < 6; i++) {
      for (let j = i + 1; j < cols.length && j < 6; j++) {
        if (cols[i].family !== cols[j].family) continue;
        add({
          fromTable: qualifiedName(cols[i].table),
          fromColumn: cols[i].column,
          toTable: qualifiedName(cols[j].table),
          toColumn: cols[j].column,
          reason: `same column name: ${cols[i].column}`,
          priority: 3,
        });
      }
    }
  }

  // 3 — semantic agreement: identifier-tagged columns sharing a second tag
  //     (the schema/content indexes vote that these mean the same thing).
  const identifierCols: Array<{ table: string; column: string; tags: Set<string>; family: string }> = [];
  const catalogByName = new Map(tables.map((t) => [qualifiedName(t).toLowerCase(), t]));
  for (const st of schema.semantic?.tables ?? []) {
    const cat = catalogByName.get(st.table.toLowerCase());
    if (!cat) continue;
    for (const sc of st.columns) {
      if (!sc.tags.includes("identifier")) continue;
      const def = cat.columns.find((c) => c.name.toLowerCase() === sc.name.toLowerCase());
      const family = def ? joinFamily(def.dataType) : undefined;
      if (!family) continue;
      identifierCols.push({ table: st.table, column: sc.name, tags: new Set(sc.tags), family });
    }
  }
  for (let i = 0; i < identifierCols.length; i++) {
    for (let j = i + 1; j < identifierCols.length; j++) {
      const a = identifierCols[i];
      const b = identifierCols[j];
      if (a.table.toLowerCase() === b.table.toLowerCase() || a.family !== b.family) continue;
      const shared = [...a.tags].find((tag) => tag !== "identifier" && b.tags.has(tag));
      if (!shared) continue;
      add({
        fromTable: a.table,
        fromColumn: a.column,
        toTable: b.table,
        toColumn: b.column,
        reason: `shared tags: identifier+${shared}`,
        priority: 2,
      });
    }
  }

  return out
    .sort((a, b) => b.priority - a.priority || a.fromTable.localeCompare(b.fromTable))
    .slice(0, maxCandidates);
}

/**
 * Exhaustive sweep: EVERY type-compatible cross-table column pair — the
 * measurement-first method for databases where names carry no signal (a
 * junction table's member_dn → users.distinguishedName has no name overlap
 * at all). Tables with UNKNOWN row estimates are ELIGIBLE — sampled probes
 * bound the cost, and a sweep that silently skips statistics-less tables
 * reads as "zero joins" on exactly the databases that need it (pilot: a
 * fresh 3-table AD export produced nothing). Only tables KNOWN to exceed
 * `maxRows` are excluded; pairs are deduped against the heuristic set,
 * capped, lowest priority.
 */
export function proposeExhaustivePairs(
  schema: SourceSchema,
  rowEstimates: RowEstimates,
  exclude: Set<string>,
  maxRows = ER_FULL_JOIN_MAX_ROWS,
  cap = ER_EXHAUSTIVE_PAIR_CAP,
  opts: {
    /** Also pair across type families (probed with casts). */
    crossFamily?: boolean;
    /** Also include tables KNOWN to exceed maxRows (bounded samples). */
    includeLarge?: boolean;
  } = {},
): JoinCandidate[] {
  const rowsOf = (t: TableDef) => rowEstimates[qualifiedName(t).toLowerCase()] ?? 0;
  const eligible = schema.catalog.tables.filter((t) => {
    const rows = rowsOf(t);
    return opts.includeLarge || rows === 0 || rows <= maxRows;
  });
  // Cheapest pairs first: small×small before anything touching a giant.
  const tables = [...eligible].sort((a, b) => rowsOf(a) - rowsOf(b));
  const out: JoinCandidate[] = [];
  for (let i = 0; i < tables.length && out.length < cap; i++) {
    for (let j = i + 1; j < tables.length && out.length < cap; j++) {
      for (const a of tables[i].columns) {
        const famA = joinFamily(a.dataType);
        if (!famA && !opts.crossFamily) continue;
        for (const b of tables[j].columns) {
          if (out.length >= cap) break;
          const famB = joinFamily(b.dataType);
          const sameFamily = famA !== undefined && famA === famB;
          // Cross-family sweep still requires both sides to be key-shaped
          // (numbers or text) — casting dates/blobs to text only makes noise.
          const castable = opts.crossFamily && famA !== undefined && famB !== undefined;
          if (!sameFamily && !castable) continue;
          const candidate: JoinCandidate = {
            fromTable: qualifiedName(tables[i]),
            fromColumn: a.name,
            toTable: qualifiedName(tables[j]),
            toColumn: b.name,
            reason: sameFamily
              ? opts.includeLarge
                ? "exhaustive (incl. large tables)"
                : "exhaustive (small tables)"
              : "cast sweep (cross-type)",
            priority: 1,
            ...(sameFamily ? {} : { cast: true }),
          };
          const key = pairKey(candidate);
          if (exclude.has(key)) continue;
          exclude.add(key);
          out.push(candidate);
        }
      }
    }
  }
  return out;
}

/** Escalation: re-probe pairs that FAILED (or sampled nothing) with the
 *  cast comparison — `=` rejecting a type (ntext/text) looks identical to
 *  "no relationship" until retried with CAST. Pure. */
export function buildCastRetryCandidates(
  tested: TestedPair[],
  exclude: Set<string>,
): JoinCandidate[] {
  const out: JoinCandidate[] = [];
  for (const t of tested) {
    if (t.outcome !== "failed" && !(t.sampledForward === 0 && t.sampledBackward === 0)) continue;
    const candidate: JoinCandidate = {
      fromTable: t.fromTable,
      fromColumn: t.fromColumn,
      toTable: t.toTable,
      toColumn: t.toColumn,
      reason: `cast retry (${t.outcome === "failed" ? "probe failed natively" : "sampled no values"})`,
      priority: 2,
      cast: true,
    };
    const key = `cast‖${pairKey(candidate)}`;
    if (exclude.has(key)) continue;
    exclude.add(key);
    out.push(candidate);
  }
  return out;
}

// --- probe queries --------------------------------------------------------------

type SqlEngine = "mssql" | "postgres" | "mysql";

/**
 * One probe = one direction: DISTINCT non-null values of from.column —
 * capped at `sample`, or ALL of them when sample is "full" (the complete
 * join test for small tables) — counting how many EXIST in to.column.
 * Returns columns `sampled` and `matched` — counts only, no data.
 */
export function buildJoinProbeSql(
  engine: SqlEngine,
  from: JoinProbeEnd,
  to: JoinProbeEnd,
  sample: number | "full" = ER_SAMPLE_SIZE,
  cast = false,
): string {
  const q = (c: string) => (engine === "mssql" ? `[${c}]` : engine === "mysql" ? `\`${c}\`` : `"${c}"`);
  // Cast mode: compare on a common text type. Joins mismatched families
  // (int ↔ varchar keys) and types `=` rejects outright (ntext/text).
  const castExpr = (expr: string) =>
    !cast
      ? expr
      : engine === "mssql"
        ? `CAST(${expr} AS NVARCHAR(MAX))`
        : engine === "mysql"
          ? `CAST(${expr} AS CHAR)`
          : `(${expr})::text`;
  const fromTarget = from.schema ? `${q(from.schema)}.${q(from.table)}` : q(from.table);
  const toTarget = to.schema ? `${q(to.schema)}.${q(to.table)}` : q(to.table);
  const top = sample === "full" ? "" : engine === "mssql" ? `TOP ${sample} ` : "";
  const limit = sample === "full" || engine === "mssql" ? "" : ` LIMIT ${sample}`;
  const sub = `SELECT DISTINCT ${top}${castExpr(q(from.column))} AS v FROM ${fromTarget} WHERE ${q(from.column)} IS NOT NULL${limit}`;
  return (
    `SELECT COUNT(*) AS sampled, ` +
    `SUM(CASE WHEN EXISTS (SELECT 1 FROM ${toTarget} t WHERE ${castExpr(`t.${q(to.column)}`)} = s.v) THEN 1 ELSE 0 END) AS matched ` +
    `FROM (${sub}) s`
  );
}

/** MongoDB variant: distinct sample via $group, existence via $lookup;
 *  "full" omits the $limit stage (complete join test). Cast mode compares
 *  $toString on both sides (numbers ↔ strings, ObjectIds ↔ hex strings). */
export function buildJoinProbeMongo(
  from: JoinProbeEnd,
  to: JoinProbeEnd,
  sample: number | "full" = ER_SAMPLE_SIZE,
  cast = false,
): { collection: string; pipeline: object[] } {
  const lookup = cast
    ? {
        $lookup: {
          from: to.table,
          let: { v: { $toString: "$_id" } },
          pipeline: [
            { $match: { $expr: { $eq: [{ $toString: `$${to.column}` }, "$$v"] } } },
            { $limit: 1 },
          ],
          as: "m",
        },
      }
    : { $lookup: { from: to.table, localField: "_id", foreignField: to.column, as: "m" } };
  return {
    collection: from.table,
    pipeline: [
      { $match: { [from.column]: { $ne: null } } },
      { $group: { _id: `$${from.column}` } },
      ...(sample === "full" ? [] : [{ $limit: sample }]),
      lookup,
      {
        $group: {
          _id: null,
          sampled: { $sum: 1 },
          matched: { $sum: { $cond: [{ $gt: [{ $size: "$m" }, 0] }, 1, 0] } },
        },
      },
    ],
  };
}

/** One catalog-statistics query per engine: APPROXIMATE row counts for every
 *  table — statistics, not COUNT(*), so sizing a 1B-row warehouse costs the
 *  same as a 1k-row one. Columns: table_schema, table_name, row_estimate. */
export function buildRowEstimateSql(engine: SqlEngine): string {
  switch (engine) {
    case "mssql":
      return (
        "SELECT s.name AS table_schema, t.name AS table_name, SUM(p.rows) AS row_estimate " +
        "FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id " +
        "JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0, 1) " +
        "GROUP BY s.name, t.name"
      );
    case "postgres":
      return (
        "SELECT n.nspname AS table_schema, c.relname AS table_name, GREATEST(c.reltuples, 0)::bigint AS row_estimate " +
        "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace " +
        "WHERE c.relkind IN ('r', 'm', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema')"
      );
    case "mysql":
      return (
        "SELECT table_schema, table_name, table_rows AS row_estimate " +
        "FROM information_schema.tables WHERE table_type = 'BASE TABLE' AND table_schema = DATABASE()"
      );
  }
}

/** Estimate rows → map keyed by lowercase qualified name. */
export function parseRowEstimates(rows: Array<Record<string, unknown>>): RowEstimates {
  const out: RowEstimates = {};
  for (const r of rows) {
    const val = (k: string) => r[k] ?? r[k.toUpperCase()] ?? r[k.toLowerCase()];
    const schema = val("table_schema");
    const name = val("table_name");
    if (!name) continue;
    const key = `${schema ? `${String(schema)}.` : ""}${String(name)}`.toLowerCase();
    out[key] = Math.max(0, Number(val("row_estimate")) || 0);
  }
  return out;
}

/** Tolerant of engine casing and string counts; SUM over zero rows is NULL. */
export function parseProbeCounts(rows: Array<Record<string, unknown>>): JoinProbeCounts {
  const row = rows[0] ?? {};
  const val = (k: string) => row[k] ?? row[k.toUpperCase()] ?? row[k.toLowerCase()];
  return {
    sampled: Number(val("sampled")) || 0,
    matched: Number(val("matched")) || 0,
  };
}

// --- classification --------------------------------------------------------------

export function classifyJoin(
  forward: JoinProbeCounts,
  backward: JoinProbeCounts,
): { forwardRate: number; backwardRate: number; verdict?: "strong" | "likely"; note?: string } {
  const rate = (c: JoinProbeCounts) => (c.sampled > 0 ? c.matched / c.sampled : 0);
  const f = rate(forward);
  const b = rate(backward);
  const best = Math.max(f, b);
  const verdict = best >= ER_STRONG_RATE ? "strong" : best >= ER_LIKELY_RATE ? "likely" : undefined;
  let note: string | undefined;
  if (verdict) {
    // The inner-vs-outer reading: full containment one way + partial the
    // other = an intentional subset, so the wider side needs an outer join
    // to keep its unmatched rows.
    if (f >= ER_STRONG_RATE && b >= ER_STRONG_RATE) {
      note = "bidirectional — same key domain (1:1 or shared dimension)";
    } else if (f >= ER_STRONG_RATE && b < ER_LIKELY_RATE) {
      note = "from-side is a subset: every sampled value resolves in the target; LEFT JOIN from the target side to keep its unmatched rows";
    } else if (b >= ER_STRONG_RATE && f < ER_LIKELY_RATE) {
      note = "target-side is a subset of the from-side; LEFT JOIN from the from-side to keep unmatched rows";
    }
    // A 98–99% join is a DESIGNED join with a residue: the unmatched keys
    // are usually an upstream data-quality problem (orphans) to fix in the
    // source system, not evidence of a different relationship.
    if (best >= 0.98 && best < 1) {
      const dq =
        "≈98–99% match: treat as a designed join — the unmatched remainder usually indicates an upstream data-quality issue (orphaned keys) worth resolving, not a different relationship.";
      note = note ? `${note}. ${dq}` : dq;
    }
  }
  return { forwardRate: f, backwardRate: b, verdict, note };
}

// --- AI-assisted candidates (consent posture of ADR-0024 indexing: names,
// types, tags, and content SUMMARIES go to Copilot — never row data) ---------

export const ER_AI_MAX_PAIRS = 40;

export interface JoinPromptOptions {
  /** Refinement round: the model sees what was measured and how it failed. */
  rejected?: TestedPair[];
  maxPairs?: number;
  /** The user's description of the data — domain knowledge the catalog
   *  cannot carry ("SAP FI tables; MANDT is the client key everywhere"). */
  hint?: string;
}

/** Prompt Copilot for join hypotheses from everything the indexes know —
 *  names, types, semantic tags/synonyms, content-type summaries — plus the
 *  user's own description of the data when given. With `rejected` present
 *  this is the REFINEMENT round. */
export function buildJoinCandidatePrompt(
  schema: SourceSchema,
  opts: JoinPromptOptions = {},
): string {
  const rejected = opts.rejected;
  const maxPairs = opts.maxPairs ?? ER_AI_MAX_PAIRS;
  const semBy = new Map((schema.semantic?.tables ?? []).map((t) => [t.table.toLowerCase(), t]));
  const tableLines: string[] = [];
  for (const t of schema.catalog.tables) {
    const sem = semBy.get(qualifiedName(t).toLowerCase());
    const cols = t.columns
      .filter((c) => joinFamily(c.dataType))
      .map((c) => {
        const sc = sem?.columns.find((x) => x.name.toLowerCase() === c.name.toLowerCase());
        const extra = sc
          ? ` [${sc.tags.join(",")}${sc.contentSummary ? ` | values: ${sc.contentSummary}` : ""}]`
          : "";
        return `  - ${c.name}: ${c.dataType}${extra}`;
      });
    tableLines.push(`${qualifiedName(t)}:\n${cols.join("\n")}`);
    if (tableLines.join("\n").length > 6_000) break;
  }
  const rejectedBlock =
    rejected && rejected.length > 0
      ? [
          "",
          "These candidate pairs were ALREADY probed and fell below the relationship thresholds (match rate forward/backward shown) — propose DIFFERENT hypotheses, informed by why these failed:",
          ...rejected
            .slice(0, 20)
            .map(
              (r) =>
                `- ${r.fromTable}.${r.fromColumn} = ${r.toTable}.${r.toColumn}: ${Math.round(r.forwardRate * 100)}%/${Math.round(r.backwardRate * 100)}%`,
            ),
        ]
      : [];
  return [
    `You are inferring JOIN relationships for a ${schema.catalog.engine} database ("${schema.catalog.database}") that declares no foreign keys.`,
    "From the tables below (column types, semantic tags, and content-type summaries of actual values), propose the column pairs MOST LIKELY to join — keys referencing other tables, shared business identifiers, matching code domains. Only pairs whose types can join. No same-table pairs.",
    "Pay special attention to ASSOCIATION/JUNCTION tables (names like *_association, *_map, *_member, *_link, or two reference-shaped columns): their columns reference the entity tables' key-like columns even when the NAMES share nothing — e.g. member_dn → users.distinguishedName, group_dn → groups.distinguishedName, account_sid → objectSid. Common key domains: numeric ids, GUIDs/UUIDs, SIDs, LDAP DNs, UPNs/sAMAccountNames, emails, natural codes.",
    ...(opts.hint?.trim()
      ? [
          "",
          `The user describes this data as follows — weight this domain knowledge heavily: ${opts.hint.trim().slice(0, 800)}`,
        ]
      : []),
    "",
    `Return ONLY JSON, exactly: {"pairs":[{"fromTable":"<qualified table>","fromColumn":"<col>","toTable":"<qualified table>","toColumn":"<col>","why":"<one short line>"}]} — at most ${maxPairs} pairs, most confident first.`,
    ...rejectedBlock,
    "",
    "Tables:",
    tableLines.join("\n\n"),
  ].join("\n");
}

/** Merge a (possibly scoped) run into the previous model's relationships:
 *  re-probed pairs take the new measurement, everything else survives — a
 *  run scoped to 10 of 100 tables must not erase the other 90's findings. */
export function mergeRelationships(
  previous: ProbedRelationship[],
  next: ProbedRelationship[],
): ProbedRelationship[] {
  const nextKeys = new Set(next.map((r) => pairKey(r)));
  return [...previous.filter((r) => !nextKeys.has(pairKey(r))), ...next].sort(
    (a, b) => Math.max(b.forwardRate, b.backwardRate) - Math.max(a.forwardRate, a.backwardRate),
  );
}

/** Validate the model's proposals against the catalog: hallucinated tables/
 *  columns are dropped, join-incompatible types are dropped, duplicates are
 *  deduped. Survivors become top-priority candidates ("AI: <why>"). */
export function parseJoinCandidateResponse(
  text: string,
  schema: SourceSchema,
  maxPairs = ER_AI_MAX_PAIRS,
): JoinCandidate[] {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  let parsed: { pairs?: unknown };
  try {
    parsed = JSON.parse(text.slice(start, end + 1)) as { pairs?: unknown };
  } catch {
    return [];
  }
  if (!Array.isArray(parsed.pairs)) return [];
  const byName = new Map(
    schema.catalog.tables.map((t) => [qualifiedName(t).toLowerCase(), t]),
  );
  const out: JoinCandidate[] = [];
  const seen = new Set<string>();
  for (const raw of parsed.pairs as Array<Record<string, unknown>>) {
    if (out.length >= maxPairs) break;
    const ft = typeof raw?.fromTable === "string" ? raw.fromTable.trim() : "";
    const fc = typeof raw?.fromColumn === "string" ? raw.fromColumn.trim() : "";
    const tt = typeof raw?.toTable === "string" ? raw.toTable.trim() : "";
    const tc = typeof raw?.toColumn === "string" ? raw.toColumn.trim() : "";
    const fromDef = byName.get(ft.toLowerCase());
    const toDef = byName.get(tt.toLowerCase());
    if (!fromDef || !toDef || fromDef === toDef) continue;
    const fromCol = fromDef.columns.find((c) => c.name.toLowerCase() === fc.toLowerCase());
    const toCol = toDef.columns.find((c) => c.name.toLowerCase() === tc.toLowerCase());
    if (!fromCol || !toCol) continue;
    const famA = joinFamily(fromCol.dataType);
    if (!famA || famA !== joinFamily(toCol.dataType)) continue;
    const candidate: JoinCandidate = {
      fromTable: qualifiedName(fromDef),
      fromColumn: fromCol.name,
      toTable: qualifiedName(toDef),
      toColumn: toCol.name,
      reason: `AI: ${typeof raw.why === "string" && raw.why.trim() ? raw.why.trim().slice(0, 120) : "proposed join"}`,
      priority: 5,
    };
    const key = pairKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}

// --- user-defined joins from chat (incremental refinement) ---------------------

export interface ParsedJoinSpec {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  /** Non-fatal caveat (e.g. join across type families relies on casts). */
  warning?: string;
}

const stripIdent = (s: string) => s.replace(/[[\]"`]/g, "").trim();

const SQL_KEYWORDS = new Set([
  "on", "inner", "left", "right", "full", "outer", "cross", "join", "where",
  "group", "order", "select", "and", "or", "as", "using",
]);

/**
 * Parse a user-supplied join — SQL syntax ("FROM Orders o JOIN Customers c
 * ON o.customer_id = c.id") or a bare equality ("dbo.Orders.customer_id =
 * dbo.Customers.id") — and resolve it against the catalog. Aliases from
 * FROM/JOIN clauses are honored; unqualified table names resolve when
 * unique; brackets/quotes/backticks are stripped. Returns an `issue` when
 * the text doesn't resolve, with enough detail to fix the input.
 */
export function parseJoinSpec(
  text: string,
  schema: SourceSchema,
): ParsedJoinSpec | { issue: string } {
  const t = text.trim();
  // Alias map from FROM/JOIN clauses (when SQL was pasted).
  const aliases = new Map<string, string>();
  for (const m of t.matchAll(/\b(?:from|join)\s+([A-Za-z0-9_.[\]"`]+)(?:\s+(?:as\s+)?([A-Za-z_][A-Za-z0-9_]*))?/gi)) {
    const tableRef = stripIdent(m[1]);
    aliases.set(tableRef.toLowerCase(), tableRef);
    if (m[2] && !SQL_KEYWORDS.has(m[2].toLowerCase())) {
      aliases.set(m[2].toLowerCase(), tableRef);
    }
  }
  const eq = t.match(/([A-Za-z0-9_.[\]"`]+)\.([A-Za-z0-9_[\]"`]+)\s*=\s*([A-Za-z0-9_.[\]"`]+)\.([A-Za-z0-9_[\]"`]+)/);
  if (!eq) {
    return {
      issue:
        'Provide the join as SQL ("FROM Orders o JOIN Customers c ON o.customer_id = c.id") or a bare equality ("dbo.Orders.customer_id = dbo.Customers.id").',
    };
  }
  const resolveTable = (rawRef: string): TableDef | { issue: string } => {
    const ref = stripIdent(rawRef).toLowerCase();
    const target = (aliases.get(ref) ?? rawRef).toLowerCase();
    const cleaned = stripIdent(target);
    const matches = schema.catalog.tables.filter(
      (x) => qualifiedName(x).toLowerCase() === cleaned || x.name.toLowerCase() === cleaned,
    );
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      return { issue: `"${stripIdent(rawRef)}" is ambiguous (${matches.map((x) => qualifiedName(x)).join(", ")}) — qualify it with the schema.` };
    }
    return { issue: `Table "${stripIdent(rawRef)}" is not in the catalog (load/refresh the schema first?).` };
  };
  const sides: Array<{ table: TableDef; column: string }> = [];
  for (const [refIdx, colIdx] of [
    [1, 2],
    [3, 4],
  ] as const) {
    const table = resolveTable(eq[refIdx]);
    if ("issue" in table) return table;
    const colName = stripIdent(eq[colIdx]);
    const column = table.columns.find((c) => c.name.toLowerCase() === colName.toLowerCase());
    if (!column) {
      return {
        issue: `Column "${colName}" is not in ${qualifiedName(table)} (has: ${table.columns
          .slice(0, 12)
          .map((c) => c.name)
          .join(", ")}${table.columns.length > 12 ? ", …" : ""}).`,
      };
    }
    sides.push({ table, column: column.name });
  }
  if (sides[0].table === sides[1].table) {
    return { issue: "Both sides resolve to the same table — a relationship needs two tables." };
  }
  const famA = joinFamily(sides[0].table.columns.find((c) => c.name === sides[0].column)!.dataType);
  const famB = joinFamily(sides[1].table.columns.find((c) => c.name === sides[1].column)!.dataType);
  return {
    fromTable: qualifiedName(sides[0].table),
    fromColumn: sides[0].column,
    toTable: qualifiedName(sides[1].table),
    toColumn: sides[1].column,
    ...(famA && famB && famA === famB
      ? {}
      : {
          warning:
            "The column types are in different join families — the probe (and real joins) will rely on implicit casts, which some engines reject.",
        }),
  };
}

/** Add/replace one relationship in the persisted model (user-defined joins
 *  from chat extend the diagram incrementally). Pure. */
export function upsertRelationship(
  er: ErModel | undefined,
  rel: ProbedRelationship,
  builtAt: string,
): ErModel {
  const base: ErModel = er ?? {
    builtAt,
    sampleSize: ER_SAMPLE_SIZE,
    candidatesTested: 0,
    relationships: [],
  };
  const key = pairKey(rel);
  const relationships = [...base.relationships.filter((r) => pairKey(r) !== key), rel].sort(
    (a, b) => Math.max(b.forwardRate, b.backwardRate) - Math.max(a.forwardRate, a.backwardRate),
  );
  return { ...base, relationships };
}

// --- rendering --------------------------------------------------------------------

const pct = (r: number) => `${Math.round(r * 100)}%`;

/** Repaint cadence for the probe toast: frequent enough to feel alive,
 *  slow enough to be readable (pilot: per-pair repaints drowned the big
 *  picture). */
export const ER_STATUS_REFRESH_MS = 2_000;

/** ETA from measured pace; coarse on purpose (a toast, not a stopwatch). */
export function formatEta(ms: number): string {
  if (ms < 50_000) return `~${Math.max(5, Math.round(ms / 5_000) * 5)}s`;
  const min = Math.round(ms / 60_000);
  return min <= 1 ? "~1 min" : `~${min} min`;
}

/** Big-picture status line for the probe run: "37/220 · ~3 min left · 12
 *  found · dbo.Orders…". VS Code renders the toast's title and message on
 *  ONE truncating line, so the vitals (x of y, ETA) come FIRST in compact
 *  form and the current pair is a short trailer (pilot: a long title plus
 *  verbose message meant users saw neither counts nor minutes). The ETA
 *  appears once enough pairs have completed for the pace to mean something.
 *  Pure — the caller throttles repaints to ER_STATUS_REFRESH_MS. */
export function renderProbeStatus(p: {
  /** Pairs fully completed. */
  done: number;
  total: number;
  found: number;
  elapsedMs: number;
  current?: string;
}): string {
  const head = `${Math.min(p.done + 1, p.total)}/${p.total}`;
  const eta =
    p.done >= 3 && p.elapsedMs >= 5_000
      ? ` · ${formatEta((p.elapsedMs / p.done) * (p.total - p.done))} left`
      : p.done < p.total
        ? " · estimating…"
        : "";
  const current = p.current
    ? ` · ${p.current.length > 40 ? `${p.current.slice(0, 40)}…` : p.current}`
    : "";
  return `${head}${eta} · ${p.found} found${current}`;
}

/** Mermaid erDiagram (renders natively in VS Code's markdown preview). */
export function renderErMermaid(model: ErModel): string {
  const lines = ["erDiagram"];
  if (model.relationships.length === 0) {
    lines.push("  %% no relationships passed the probe thresholds");
  }
  for (const r of model.relationships) {
    const card =
      r.forwardRate >= ER_STRONG_RATE && r.backwardRate >= ER_STRONG_RATE ? "||--||" : "}o--||";
    const safe = (s: string) => s.replace(/"/g, "'");
    lines.push(
      `  "${safe(r.fromTable)}" ${card} "${safe(r.toTable)}" : "${safe(r.fromColumn)} -> ${safe(r.toColumn)} (${pct(r.forwardRate)}/${pct(r.backwardRate)}${r.complete ? ", complete" : ""}${r.cast ? ", cast" : ""})"`,
    );
  }
  return lines.join("\n");
}

/** Tool-facing lines so the model writes correct multi-table JOINs. */
export function renderErForModel(model: ErModel, maxLines = 25): string[] {
  if (model.relationships.length === 0) return [];
  const lines = [
    "",
    "Probed JOIN paths (match rate forward/backward; 'complete' = the entire join was tested, otherwise an adaptive sample; high rate = intended relationship — no foreign keys are declared):",
  ];
  for (const r of model.relationships.slice(0, maxLines)) {
    lines.push(
      `- JOIN ${r.fromTable}.${r.fromColumn} = ${r.toTable}.${r.toColumn} (${pct(r.forwardRate)}/${pct(r.backwardRate)}${r.complete ? ", complete" : ""}${r.cast ? ", cast — CAST both sides to text in queries" : ""}, ${r.verdict}${r.note ? ` — ${r.note}` : ""})`,
    );
  }
  lines.push("Use these columns when querying across tables; honor the subset notes when choosing INNER vs LEFT JOIN.");
  return lines;
}

/** Markdown probe report for the schema view — the big picture, ESPECIALLY
 *  when a run confirms little: outcome counts, near-misses with their
 *  measured rates, and a systemic-failure warning when sampling itself
 *  returned nothing (which means "fix the probe", not "no relationships"). */
export function renderProbeReport(model: ErModel): string[] {
  const report = model.report;
  if (!report) return [];
  const counts = { strong: 0, likely: 0, defined: 0, rejected: 0, failed: 0 };
  for (const t of report.tested) counts[t.outcome] += 1;
  const lines = [
    "",
    "### Probe report",
    "",
    `_${model.candidatesTested} pair(s) probed${model.mode ? ` (${model.mode} mode)` : ""}${model.scopeTables ? `, scoped to ${model.scopeTables} table(s)` : ""}: **${counts.strong} strong**, **${counts.likely} likely**${counts.defined > 0 ? `, **${counts.defined} user-defined** (kept despite the measured rate)` : ""}, ${counts.rejected} below thresholds, ${counts.failed} failed${report.aiProposed !== undefined ? ` · ${report.aiProposed} pair(s) proposed by Copilot${report.aiRefined ? ` + ${report.aiRefined} in the refinement round` : ""}` : ""}._`,
  ];
  if (report.zeroSampleCount > 0 && report.zeroSampleCount >= Math.max(3, model.candidatesTested / 2)) {
    lines.push(
      "",
      `> ⚠️ **${report.zeroSampleCount} probe(s) sampled zero values.** That is a systemic signal — the sampling query may not fit this database (permissions on the tables? unusual identifiers?) — and would make every pair look unrelated. Check the extension log (wire logging shows the exact SQL) before concluding there are no relationships.`,
    );
  }
  const nearMisses = report.tested
    .filter((t) => t.outcome === "rejected")
    .sort((a, b) => Math.max(b.forwardRate, b.backwardRate) - Math.max(a.forwardRate, a.backwardRate))
    .slice(0, 15);
  if (nearMisses.length > 0) {
    lines.push(
      "",
      "Closest misses (measured rates below the 70% threshold — judge for yourself whether any is a real join with poor data quality):",
      "",
      "| Pair | Match fwd | Match back | Proposed by |",
      "|---|---|---|---|",
      ...nearMisses.map(
        (t) =>
          `| \`${t.fromTable}.${t.fromColumn} = ${t.toTable}.${t.toColumn}\` | ${Math.round(t.forwardRate * 100)}% | ${Math.round(t.backwardRate * 100)}% | ${t.reason} |`,
      ),
    );
  }
  return lines;
}
