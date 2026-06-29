/**
 * Read-only SQL guard (ADR-0022). For PostgreSQL/MySQL the session itself is
 * set read-only server-side; SQL Server has no such session switch, so THIS
 * VALIDATOR IS THE WRITE-GUARD there — it must fail closed. Strategy: strip
 * comments and string literals, then require a single SELECT/WITH statement
 * and reject any write/DDL/exec keyword at word boundaries. Pure + tested.
 */

import { ContextSearchHit } from "../types";

const FORBIDDEN =
  /\b(insert|update|delete|merge|drop|alter|create|truncate|grant|revoke|exec|execute|call|backup|restore|bulk|dbcc|shutdown|use|into|waitfor|openrowset|opendatasource|openquery|dblink\w*|lo_export|lo_import|pg_read_\w+|pg_ls_dir|pg_sleep|xp_\w+|sp_\w+)\b/i;

/** Remove string literals and comments so keywords inside them don't count. */
export function stripSqlNoise(sql: string): string {
  return sql
    .replace(/'(?:[^']|'')*'/g, "''") // single-quoted strings (incl. '' escapes)
    .replace(/"(?:[^"]|"")*"/g, '""') // quoted identifiers
    .replace(/\[(?:[^\]])*\]/g, "[]") // bracket identifiers (T-SQL)
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
}

export interface SqlVerdict {
  ok: boolean;
  reason?: string;
}

export function assertReadOnlySql(sql: string): SqlVerdict {
  const stripped = stripSqlNoise(sql).trim();
  if (!stripped) {
    return { ok: false, reason: "Empty statement." };
  }
  // Single statement only: a semicolon may end it, but nothing may follow.
  const semi = stripped.indexOf(";");
  if (semi !== -1 && stripped.slice(semi + 1).trim().length > 0) {
    return { ok: false, reason: "Multiple statements are not allowed." };
  }
  const body = (semi === -1 ? stripped : stripped.slice(0, semi)).trim();
  if (!/^(select|with)\b/i.test(body)) {
    return { ok: false, reason: "Only SELECT (or WITH … SELECT) statements are allowed." };
  }
  const hit = body.match(FORBIDDEN);
  if (hit) {
    return {
      ok: false,
      reason: `Forbidden keyword "${hit[1].toUpperCase()}" — reference sources are strictly read-only (SELECT INTO, EXEC, DML and DDL are blocked).`,
    };
  }
  return { ok: true };
}

/** Map result rows (objects) to model-facing hits, capped and truncated. */
export function rowsToHits(
  rows: Array<Record<string, unknown>>,
  maxRows: number,
  label: string,
): ContextSearchHit[] {
  const valueOf = (v: unknown): string => {
    if (v === null || v === undefined) return "NULL";
    if (v instanceof Date) return v.toISOString();
    if (Buffer.isBuffer(v)) return `<binary ${v.length}B>`;
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    return s.length > 120 ? `${s.slice(0, 120)}…` : s;
  };
  return rows.slice(0, maxRows).map((row, i) => {
    const entries = Object.entries(row);
    const meta: Record<string, string> = {};
    for (const [k, v] of entries.slice(0, 8)) {
      meta[k] = valueOf(v);
    }
    const title =
      entries.length > 0
        ? entries
            .slice(0, 3)
            .map(([, v]) => valueOf(v))
            .join(" · ")
        : `(row ${i + 1})`;
    return { title: title.slice(0, 120), url: label, meta };
  });
}

/** Parse a Mongo read spec: JSON {collection, filter?, projection?, limit?}. */
export interface MongoReadSpec {
  collection: string;
  filter: Record<string, unknown>;
  projection?: Record<string, unknown>;
  limit?: number;
}

/** MongoDB operators that run server-side JavaScript or write — never allowed
 *  on a read path (the model/agent controls the filter JSON, so this is the
 *  write/exec guard, analogous to assertReadOnlySql). Case-sensitive, as Mongo. */
const DANGEROUS_MONGO_OPS = new Set(["$where", "$function", "$accumulator", "$out", "$merge"]);

/** Recursively reject server-side-JS / write operators anywhere in a Mongo
 *  filter or projection. Throws (fails closed) on the first hit. */
export function assertSafeMongoQuery(value: unknown): void {
  if (Array.isArray(value)) {
    for (const v of value) assertSafeMongoQuery(v);
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (DANGEROUS_MONGO_OPS.has(k)) {
        throw new Error(
          `MongoDB operator "${k}" is not allowed — reference sources are strictly read-only (server-side JavaScript and write stages are blocked).`,
        );
      }
      assertSafeMongoQuery(v);
    }
  }
}

export function parseMongoSpec(query: string): MongoReadSpec {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(query) as Record<string, unknown>;
  } catch {
    throw new Error(
      'MongoDB queries must be JSON: {"collection": "name", "filter": {…}, "projection": {…}, "limit": n}.',
    );
  }
  if (!raw || typeof raw.collection !== "string" || !raw.collection.trim()) {
    throw new Error('MongoDB query JSON needs a "collection" string.');
  }
  const collection = raw.collection.trim();
  // Collection names can't contain "$"/NUL; refuse the internal system.* namespaces.
  if (/[$\0]/.test(collection) || /^system\./i.test(collection)) {
    throw new Error(`MongoDB collection "${collection}" is not a valid read target.`);
  }
  const filter =
    raw.filter && typeof raw.filter === "object" && !Array.isArray(raw.filter)
      ? (raw.filter as Record<string, unknown>)
      : {};
  const projection =
    raw.projection && typeof raw.projection === "object"
      ? (raw.projection as Record<string, unknown>)
      : undefined;
  assertSafeMongoQuery(filter);
  if (projection) assertSafeMongoQuery(projection);
  return {
    collection,
    filter,
    projection,
    limit: typeof raw.limit === "number" && raw.limit > 0 ? Math.floor(raw.limit) : undefined,
  };
}
