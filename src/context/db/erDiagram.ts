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
export const ER_MAX_CANDIDATES = 40;
/** ≈100%: the rate at which a join reads as designed-in. */
export const ER_STRONG_RATE = 0.95;
/** Below this in BOTH directions, the pair is discarded as coincidence. */
export const ER_LIKELY_RATE = 0.7;

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
  maxCandidates = ER_MAX_CANDIDATES,
): JoinCandidate[] {
  const tables = schema.catalog.tables;
  const out: JoinCandidate[] = [];
  const seen = new Set<string>();
  const add = (c: JoinCandidate) => {
    const key = [
      `${c.fromTable}.${c.fromColumn}`.toLowerCase(),
      `${c.toTable}.${c.toColumn}`.toLowerCase(),
    ]
      .sort()
      .join("‖");
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

// --- probe queries --------------------------------------------------------------

type SqlEngine = "mssql" | "postgres" | "mysql";

/**
 * One probe = one direction: sample up to `sample` DISTINCT non-null values
 * of from.column and count how many EXIST in to.column. Returns columns
 * `sampled` and `matched` — counts only, no data.
 */
export function buildJoinProbeSql(
  engine: SqlEngine,
  from: JoinProbeEnd,
  to: JoinProbeEnd,
  sample = ER_SAMPLE_SIZE,
): string {
  const q = (c: string) => (engine === "mssql" ? `[${c}]` : engine === "mysql" ? `\`${c}\`` : `"${c}"`);
  const fromTarget = from.schema ? `${q(from.schema)}.${q(from.table)}` : q(from.table);
  const toTarget = to.schema ? `${q(to.schema)}.${q(to.table)}` : q(to.table);
  const sub =
    engine === "mssql"
      ? `SELECT DISTINCT TOP ${sample} ${q(from.column)} AS v FROM ${fromTarget} WHERE ${q(from.column)} IS NOT NULL`
      : `SELECT DISTINCT ${q(from.column)} AS v FROM ${fromTarget} WHERE ${q(from.column)} IS NOT NULL LIMIT ${sample}`;
  return (
    `SELECT COUNT(*) AS sampled, ` +
    `SUM(CASE WHEN EXISTS (SELECT 1 FROM ${toTarget} t WHERE t.${q(to.column)} = s.v) THEN 1 ELSE 0 END) AS matched ` +
    `FROM (${sub}) s`
  );
}

/** MongoDB variant: distinct sample via $group, existence via $lookup. */
export function buildJoinProbeMongo(
  from: JoinProbeEnd,
  to: JoinProbeEnd,
  sample = ER_SAMPLE_SIZE,
): { collection: string; pipeline: object[] } {
  return {
    collection: from.table,
    pipeline: [
      { $match: { [from.column]: { $ne: null } } },
      { $group: { _id: `$${from.column}` } },
      { $limit: sample },
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
      `  "${safe(r.fromTable)}" ${card} "${safe(r.toTable)}" : "${safe(r.fromColumn)} -> ${safe(r.toColumn)} (${pct(r.forwardRate)}/${pct(r.backwardRate)})"`,
    );
  }
  return lines.join("\n");
}

/** Tool-facing lines so the model writes correct multi-table JOINs. */
export function renderErForModel(model: ErModel, maxLines = 25): string[] {
  if (model.relationships.length === 0) return [];
  const lines = [
    "",
    `Probed JOIN paths (match rate forward/backward over ${model.sampleSize}-value samples; high rate = intended relationship — no foreign keys are declared):`,
  ];
  for (const r of model.relationships.slice(0, maxLines)) {
    lines.push(
      `- JOIN ${r.fromTable}.${r.fromColumn} = ${r.toTable}.${r.toColumn} (${pct(r.forwardRate)}/${pct(r.backwardRate)}, ${r.verdict}${r.note ? ` — ${r.note}` : ""})`,
    );
  }
  lines.push("Use these columns when querying across tables; honor the subset notes when choosing INNER vs LEFT JOIN.");
  return lines;
}
