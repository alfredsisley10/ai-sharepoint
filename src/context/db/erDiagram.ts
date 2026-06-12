import {
  SourceSchema,
  TableDef,
  ErModel,
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
const TEXTUAL_TYPE = /char|text|string|uuid|uniqueidentifier|objectid/i;

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
 * Thorough mode: EVERY type-compatible cross-table column pair — but only
 * between tables small enough (per row estimates) that complete testing is
 * cheap, deduped against the heuristic set, capped, lowest priority. This is
 * the "every permutation and combination for completeness" pass, kept
 * performance-sensitive by the size gate + cap + cancellable runner.
 */
export function proposeExhaustivePairs(
  schema: SourceSchema,
  rowEstimates: RowEstimates,
  exclude: Set<string>,
  maxRows = ER_FULL_JOIN_MAX_ROWS,
  cap = ER_EXHAUSTIVE_PAIR_CAP,
): JoinCandidate[] {
  const small = schema.catalog.tables.filter((t) => {
    const rows = rowEstimates[qualifiedName(t).toLowerCase()];
    return rows !== undefined && rows > 0 && rows <= maxRows;
  });
  const out: JoinCandidate[] = [];
  for (let i = 0; i < small.length && out.length < cap; i++) {
    for (let j = i + 1; j < small.length && out.length < cap; j++) {
      for (const a of small[i].columns) {
        const famA = joinFamily(a.dataType);
        if (!famA) continue;
        for (const b of small[j].columns) {
          if (out.length >= cap) break;
          if (joinFamily(b.dataType) !== famA) continue;
          const candidate: JoinCandidate = {
            fromTable: qualifiedName(small[i]),
            fromColumn: a.name,
            toTable: qualifiedName(small[j]),
            toColumn: b.name,
            reason: "exhaustive (small tables)",
            priority: 1,
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
): string {
  const q = (c: string) => (engine === "mssql" ? `[${c}]` : engine === "mysql" ? `\`${c}\`` : `"${c}"`);
  const fromTarget = from.schema ? `${q(from.schema)}.${q(from.table)}` : q(from.table);
  const toTarget = to.schema ? `${q(to.schema)}.${q(to.table)}` : q(to.table);
  const top = sample === "full" ? "" : engine === "mssql" ? `TOP ${sample} ` : "";
  const limit = sample === "full" || engine === "mssql" ? "" : ` LIMIT ${sample}`;
  const sub = `SELECT DISTINCT ${top}${q(from.column)} AS v FROM ${fromTarget} WHERE ${q(from.column)} IS NOT NULL${limit}`;
  return (
    `SELECT COUNT(*) AS sampled, ` +
    `SUM(CASE WHEN EXISTS (SELECT 1 FROM ${toTarget} t WHERE t.${q(to.column)} = s.v) THEN 1 ELSE 0 END) AS matched ` +
    `FROM (${sub}) s`
  );
}

/** MongoDB variant: distinct sample via $group, existence via $lookup;
 *  "full" omits the $limit stage (complete join test). */
export function buildJoinProbeMongo(
  from: JoinProbeEnd,
  to: JoinProbeEnd,
  sample: number | "full" = ER_SAMPLE_SIZE,
): { collection: string; pipeline: object[] } {
  return {
    collection: from.table,
    pipeline: [
      { $match: { [from.column]: { $ne: null } } },
      { $group: { _id: `$${from.column}` } },
      ...(sample === "full" ? [] : [{ $limit: sample }]),
      { $lookup: { from: to.table, localField: "_id", foreignField: to.column, as: "m" } },
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
  }
  return { forwardRate: f, backwardRate: b, verdict, note };
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

/** Big-picture status line for the probe run: "pair 37 of 220 · 12
 *  relationship(s) · ~3 min left · now: …". The ETA appears once enough
 *  pairs have completed for the pace to mean something; the current pair
 *  is a truncated trailer, never the headline. Pure — the caller throttles
 *  repaints to ER_STATUS_REFRESH_MS. */
export function renderProbeStatus(p: {
  /** Pairs fully completed. */
  done: number;
  total: number;
  found: number;
  elapsedMs: number;
  current?: string;
}): string {
  const head = `pair ${Math.min(p.done + 1, p.total)} of ${p.total}`;
  const found = `${p.found} relationship(s)`;
  const eta =
    p.done >= 3 && p.elapsedMs >= 5_000
      ? ` · ${formatEta((p.elapsedMs / p.done) * (p.total - p.done))} left`
      : p.done < p.total
        ? " · estimating time…"
        : "";
  const current = p.current
    ? ` · now: ${p.current.length > 70 ? `${p.current.slice(0, 70)}…` : p.current}`
    : "";
  return `${head} · ${found}${eta}${current}`;
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
      `  "${safe(r.fromTable)}" ${card} "${safe(r.toTable)}" : "${safe(r.fromColumn)} -> ${safe(r.toColumn)} (${pct(r.forwardRate)}/${pct(r.backwardRate)}${r.complete ? ", complete" : ""})"`,
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
      `- JOIN ${r.fromTable}.${r.fromColumn} = ${r.toTable}.${r.toColumn} (${pct(r.forwardRate)}/${pct(r.backwardRate)}${r.complete ? ", complete" : ""}, ${r.verdict}${r.note ? ` — ${r.note}` : ""})`,
    );
  }
  lines.push("Use these columns when querying across tables; honor the subset notes when choosing INNER vs LEFT JOIN.");
  return lines;
}
