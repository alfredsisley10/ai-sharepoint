/**
 * Database context adapters (ADR-0022): SQL Server (tedious), PostgreSQL
 * (pg), MySQL (mysql2), MongoDB — read-only by layered construction:
 * the SQL guard (readSafe) + server-side read-only sessions where the engine
 * supports them (PG/MySQL) + client-side row caps + timeouts. TLS trusts the
 * OS store / pinned bundle like LDAP (raw sockets bypass VS Code's fetch).
 * Oracle is excluded: its driver requires native binaries (ADR-0016).
 */

import { Connection as TdsConnection, Request as TdsRequest } from "tedious";
import { Client as PgClient } from "pg";
import * as mysql2 from "mysql2/promise";
import { MongoClient } from "mongodb";
import { ContextSource, ContextCredential, ContextSearchHit, ReadCaps } from "../types";
import { assertReadOnlySql, rowsToHits, parseMongoSpec } from "./readSafe";
import { buildMssqlAuthentication, parseMssqlParams, resolveMssqlEndpoint } from "./mssqlAuth";
import {
  SchemaCatalog,
  TableDef,
  catalogFromRows,
  catalogFromMongoSamples,
  buildSampleQuery,
  distinctValues,
  SCHEMA_MAX_TABLES,
  SCHEMA_MAX_COLUMNS_PER_TABLE,
  MONGO_MAX_COLLECTIONS,
  MONGO_SAMPLE_DOCS,
  CONTENT_SAMPLE_ROWS,
} from "./schemaIndex";
import {
  extractMssqlTables,
  buildStatsProbeSql,
  parseTableStats,
  assessMssqlQueryCost,
  rewriteWithSubset,
  CostVerdict,
  SUBSET_TOP_ROWS,
} from "./queryCost";
import { loadTrustedCAs } from "../ldap/osTrust";
import { AppError } from "../../core/errors";
import { wireEnabled, emitWire, capDetail, safeJson } from "../../core/wireLog";

/** Wire-log helper shared by the SQL runners: the statement is logged in
 *  full (it IS what was sent); returned row VALUES are withheld — counts
 *  and column names only, since result data is the user's enterprise data
 *  and already visible where it was requested. */
function wireSqlResult(
  engine: string,
  target: string,
  rows: Array<Record<string, unknown>>,
  startedMs: number,
): void {
  if (!wireEnabled()) return;
  emitWire(
    engine,
    "←",
    `${target} — ${rows.length} row(s) (${Date.now() - startedMs}ms)`,
    rows.length > 0
      ? `columns: ${Object.keys(rows[0]).join(", ")} — row values withheld (data)`
      : undefined,
  );
}

export interface DbTlsOptions {
  caBundlePath?: string;
}

export interface BrowseCandidate {
  name: string;
  locator: string;
  kind: "query";
  detail: string;
}

export function parseDbUrl(source: Pick<ContextSource, "baseUrl">): {
  host: string;
  port?: number;
  database: string;
  params: URLSearchParams;
} {
  let u: URL;
  try {
    u = new URL(source.baseUrl);
  } catch {
    throw new AppError(`Invalid database URL: ${source.baseUrl}`, "config");
  }
  const database = u.pathname.replace(/^\/+/, "");
  if (!database) {
    throw new AppError("The connection URL must include a database name (…/dbname).", "config");
  }
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : undefined,
    database,
    params: u.searchParams,
  };
}

function guardSql(query: string): string {
  const verdict = assertReadOnlySql(query);
  if (!verdict.ok) {
    throw new AppError(verdict.reason ?? "Statement rejected.", "config",
      "Only read-only SELECT statements are allowed against reference databases.");
  }
  return query;
}

function mapDbError(err: unknown, engine: string): AppError {
  if (err instanceof AppError) return err;
  const e = err as { code?: string | number; errno?: number; message?: string };
  const msg = e?.message ?? String(err);
  const code = String(e?.code ?? "");
  const authPatterns =
    /ELOGIN|28P01|28000|ER_ACCESS_DENIED|1045|Authentication ?failed|auth failed|SCRAM/i;
  if (authPatterns.test(code) || authPatterns.test(msg) || e?.errno === 1045 || e?.code === 18) {
    if (engine === "SQL Server" && /cannot open database/i.test(msg)) {
      return new AppError(
        `SQL Server login succeeded but the database is inaccessible: ${msg}`,
        "config",
        "The login cannot open the database named in the connection URL — check the …/dbname segment and the login's database access.",
      );
    }
    return new AppError(
      `${engine} authentication rejected: ${msg}`,
      "auth.failed",
      engine === "SQL Server"
        ? "SQL Server rejected the sign-in. If this login works in SSMS, check: (1) named instance — SSMS \"host\\INSTANCE\" needs ?instance=INSTANCE in the connection URL (the login may not exist on the default instance at 1433); (2) authentication mode — Windows accounts (DOMAIN\\user) need Windows Authentication; (3) the database name in the URL."
        : "The database rejected these credentials.",
    );
  }
  if (/unable to get local issuer|self.signed|certificate/i.test(msg)) {
    return new AppError(
      `${engine} TLS certificate validation failed: ${msg}`,
      "config",
      "Database TLS certificate not trusted — deploy the corporate CA to the OS store, set aiSharePoint.ldap.caCertificatesFile (shared pinned bundle), or for SQL Server with a self-signed certificate append ?trustServerCertificate=true to the connection URL (the SSMS checkbox equivalent).",
    );
  }
  // A query that ran out of time is NOT a connection problem — say so, with
  // the way out (pilot: "connection failed: Timeout: Request failed to
  // complete in 30000ms" sent people chasing network issues).
  if (
    /request failed to complete|statement timeout|query_timeout|max_execution_time|ER_QUERY_TIMEOUT|operation exceeded time limit/i.test(
      msg,
    )
  ) {
    return new AppError(
      `${engine} query timed out: ${msg}`,
      "config",
      "The statement exceeded the query timeout — it scans more data than the server can read in time. Narrow it with a WHERE on an indexed column or TOP n; for SQL Server the cost guard estimates this from catalog stats first and answers expensive queries from a bounded sample instead.",
    );
  }
  if (/timeout|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|socket|getaddrinfo/i.test(msg)) {
    return new AppError(`${engine} connection failed: ${msg}`, "network");
  }
  return new AppError(`${engine} error: ${msg}`, "unknown");
}

// --- SQL Server (tedious) ---------------------------------------------------

async function mssqlRows(
  source: ContextSource,
  credential: ContextCredential,
  tls: DbTlsOptions,
  caps: ReadCaps,
  sql: string,
): Promise<Array<Record<string, unknown>>> {
  const { host, port, database, params } = parseDbUrl(source);
  const ca = loadTrustedCAs(tls.caBundlePath);
  const mp = parseMssqlParams(params);
  const connection = new TdsConnection({
    server: host,
    // SQL Server Authentication or Windows Authentication (NTLM) — selected
    // by the stored method, with safe inference for DOMAIN\user accounts.
    authentication: buildMssqlAuthentication(credential),
    options: {
      database,
      // SqlClient precedence: an explicit port connects directly (instance
      // name ignored); instance-only resolves the port via SQL Browser.
      ...resolveMssqlEndpoint(port, mp),
      encrypt: mp.encrypt,
      trustServerCertificate: mp.trustServerCertificate,
      readOnlyIntent: true, // routes to readable replicas in AG setups
      connectTimeout: caps.timeoutMs,
      requestTimeout: caps.timeoutMs,
      rowCollectionOnRequestCompletion: false,
      ...(ca ? { cryptoCredentialsDetails: { ca } } : {}),
    },
  });

  // SQL Server sends its real reason (error number/state) in errorMessage
  // frames during the handshake — capture them so rejections are diagnosable.
  const serverMessages: string[] = [];
  connection.on("errorMessage", (m: { message?: string; number?: number; state?: number }) => {
    serverMessages.push(
      `${m.message ?? ""}${m.number !== undefined ? ` (error ${m.number}, state ${m.state ?? "?"})` : ""}`.trim(),
    );
  });
  const withServerDetail = (err: unknown): unknown => {
    if (err instanceof Error && serverMessages.length > 0) {
      err.message = `${err.message} — server said: ${serverMessages.slice(-2).join(" | ")}`;
    }
    return err;
  };
  const target = `${host}${port ? `:${port}` : mp.instanceName ? `\\${mp.instanceName}` : ""}/${database}`;
  const started = Date.now();
  if (wireEnabled()) {
    emitWire("mssql", "→", target, capDetail(`SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;\n${sql}`));
  }
  try {
    await new Promise<void>((resolve, reject) => {
      connection.connect((err) => (err ? reject(withServerDetail(err)) : resolve()));
    });
    const result = await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
      const rows: Array<Record<string, unknown>> = [];
      // READ UNCOMMITTED (NOLOCK semantics) so reads never block writers.
      const request = new TdsRequest(
        `SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;\n${sql}`,
        (err) => (err ? reject(err) : resolve(rows)),
      );
      request.on("row", (columns: Array<{ value: unknown; metadata: { colName: string } }>) => {
        if (rows.length >= caps.maxResults) return; // client-side cap
        const row: Record<string, unknown> = {};
        for (const col of columns) {
          row[col.metadata.colName || `col${Object.keys(row).length}`] = col.value;
        }
        rows.push(row);
      });
      connection.execSql(request);
    });
    wireSqlResult("mssql", target, result, started);
    return result;
  } catch (err) {
    emitWire("mssql", "✗", `${target} — ${err instanceof Error ? err.message : String(err)} (${Date.now() - started}ms)`);
    throw mapDbError(err, "SQL Server");
  } finally {
    connection.close();
  }
}

// --- PostgreSQL ---------------------------------------------------------------

async function pgRows(
  source: ContextSource,
  credential: ContextCredential,
  tls: DbTlsOptions,
  caps: ReadCaps,
  sql: string,
): Promise<Array<Record<string, unknown>>> {
  const { host, port, database, params } = parseDbUrl(source);
  const ca = loadTrustedCAs(tls.caBundlePath);
  const wantSsl = params.get("ssl") !== "false" && params.get("sslmode") !== "disable";
  const client = new PgClient({
    host,
    port: port ?? 5432,
    database,
    user: credential.username,
    password: credential.secret,
    connectionTimeoutMillis: caps.timeoutMs,
    query_timeout: caps.timeoutMs,
    ...(wantSsl ? { ssl: { rejectUnauthorized: true, ...(ca ? { ca } : {}) } } : {}),
  });
  const target = `${host}:${port ?? 5432}/${database}`;
  const started = Date.now();
  if (wireEnabled()) emitWire("postgres", "→", target, capDetail(sql));
  try {
    await client.connect();
    // Server-side read-only + statement timeout (ADR-0012).
    await client.query("SET default_transaction_read_only = on");
    await client.query(`SET statement_timeout = ${Math.floor(caps.timeoutMs)}`);
    const res = await client.query(sql);
    const rows = (res.rows as Array<Record<string, unknown>>).slice(0, caps.maxResults);
    wireSqlResult("postgres", target, rows, started);
    return rows;
  } catch (err) {
    emitWire("postgres", "✗", `${target} — ${err instanceof Error ? err.message : String(err)} (${Date.now() - started}ms)`);
    throw mapDbError(err, "PostgreSQL");
  } finally {
    await client.end().catch(() => undefined);
  }
}

// --- MySQL ----------------------------------------------------------------------

async function mysqlRows(
  source: ContextSource,
  credential: ContextCredential,
  tls: DbTlsOptions,
  caps: ReadCaps,
  sql: string,
): Promise<Array<Record<string, unknown>>> {
  const { host, port, database, params } = parseDbUrl(source);
  const ca = loadTrustedCAs(tls.caBundlePath);
  let connection: mysql2.Connection | undefined;
  try {
    connection = await mysql2.createConnection({
      host,
      port: port ?? 3306,
      database,
      user: credential.username,
      password: credential.secret,
      connectTimeout: caps.timeoutMs,
      ...(params.get("ssl") === "true"
        ? { ssl: { rejectUnauthorized: true, ...(ca ? { ca: ca.join("\n") } : {}) } }
        : {}),
    });
    await connection.query("SET SESSION TRANSACTION READ ONLY");
    await connection.query(`SET SESSION max_execution_time = ${Math.floor(caps.timeoutMs)}`);
    if (wireEnabled()) emitWire("mysql", "→", `${host}:${port ?? 3306}/${database}`, capDetail(sql));
    const startedQuery = Date.now();
    const [rows] = await connection.query({ sql, timeout: caps.timeoutMs });
    const capped = (rows as Array<Record<string, unknown>>).slice(0, caps.maxResults);
    wireSqlResult("mysql", `${host}:${port ?? 3306}/${database}`, capped, startedQuery);
    return capped;
  } catch (err) {
    emitWire("mysql", "✗", `${host}:${port ?? 3306}/${database} — ${err instanceof Error ? err.message : String(err)}`);
    throw mapDbError(err, "MySQL");
  } finally {
    await connection?.end().catch(() => undefined);
  }
}

// --- MongoDB ----------------------------------------------------------------------

async function withMongo<T>(
  source: ContextSource,
  credential: ContextCredential,
  tls: DbTlsOptions,
  caps: ReadCaps,
  run: (client: MongoClient, dbName: string) => Promise<T>,
): Promise<T> {
  const { database } = parseDbUrl(source);
  const ca = loadTrustedCAs(tls.caBundlePath);
  const client = new MongoClient(source.baseUrl, {
    auth: { username: credential.username ?? "", password: credential.secret },
    serverSelectionTimeoutMS: caps.timeoutMs,
    connectTimeoutMS: caps.timeoutMs,
    readPreference: "secondaryPreferred",
    ...(ca ? { ca: ca.join("\n") } : {}),
  });
  try {
    await client.connect();
    return await run(client, database);
  } catch (err) {
    throw mapDbError(err, "MongoDB");
  } finally {
    await client.close().catch(() => undefined);
  }
}

// --- public adapter surface --------------------------------------------------------

export type SqlEngine = "mssql" | "postgres" | "mysql";

const SQL_RUNNERS: Record<
  SqlEngine,
  (
    s: ContextSource,
    c: ContextCredential,
    t: DbTlsOptions,
    caps: ReadCaps,
    sql: string,
  ) => Promise<Array<Record<string, unknown>>>
> = { mssql: mssqlRows, postgres: pgRows, mysql: mysqlRows };

export async function verifyDb(
  source: ContextSource,
  credential: ContextCredential,
  tls: DbTlsOptions,
  caps: ReadCaps,
): Promise<{ account: string }> {
  if (source.type === "mongodb") {
    await withMongo(source, credential, tls, caps, async (client, dbName) => {
      await client.db(dbName).command({ ping: 1 });
    });
  } else {
    await SQL_RUNNERS[source.type as SqlEngine](source, credential, tls, caps, "SELECT 1 AS ok");
  }
  return { account: credential.username ?? "verified" };
}

export interface DbSearchOptions {
  /** True ONLY when the user explicitly accepted a slow full-table run. */
  allowExpensive?: boolean;
}

/** Catalog-stat preflight for SQL Server (ADR-0030). Fails OPEN: any probe
 *  problem (permissions, exotic names, timeout) and the query runs as-is. */
async function mssqlCostGuard(
  source: ContextSource,
  credential: ContextCredential,
  tls: DbTlsOptions,
  caps: ReadCaps,
  sql: string,
): Promise<{ verdict: CostVerdict; subsetSql?: string } | undefined> {
  try {
    const refs = extractMssqlTables(sql);
    if (refs.length === 0) return undefined;
    const probe = buildStatsProbeSql(refs);
    if (!probe) return undefined;
    const probeCaps: ReadCaps = {
      ...caps,
      maxResults: 1_000,
      timeoutMs: Math.min(caps.timeoutMs, 15_000),
    };
    const stats = parseTableStats(
      await mssqlRows(source, credential, tls, probeCaps, probe),
      refs,
    );
    if (stats.length === 0) return undefined;
    const verdict = assessMssqlQueryCost(sql, stats);
    if (!verdict.expensive) return { verdict };
    const subsetSql = rewriteWithSubset(sql, verdict.bigTables);
    return { verdict, ...(subsetSql ? { subsetSql } : {}) };
  } catch {
    return undefined;
  }
}

export async function searchDb(
  source: ContextSource,
  credential: ContextCredential,
  query: string,
  tls: DbTlsOptions,
  caps: ReadCaps,
  opts: DbSearchOptions = {},
): Promise<ContextSearchHit[]> {
  const label = `${source.type}:${source.displayName}`;
  if (source.type === "mongodb") {
    const spec = parseMongoSpec(query);
    const started = Date.now();
    if (wireEnabled()) {
      emitWire("mongodb", "→", `${parseDbUrl(source).host}/${parseDbUrl(source).database}`, safeJson(spec));
    }
    const docs = await withMongo(source, credential, tls, caps, (client, dbName) =>
      client
        .db(dbName)
        .collection(spec.collection)
        .find(spec.filter, {
          ...(spec.projection ? { projection: spec.projection } : {}),
          limit: Math.min(spec.limit ?? caps.maxResults, caps.maxResults),
          maxTimeMS: caps.timeoutMs,
        })
        .toArray(),
    );
    emitWire(
      "mongodb",
      "←",
      `${spec.collection} — ${docs.length} document(s) (${Date.now() - started}ms) — values withheld (data)`,
    );
    return rowsToHits(docs as Array<Record<string, unknown>>, caps.maxResults, label);
  }
  const sql = guardSql(query);
  if (source.type === "mssql" && !opts.allowExpensive) {
    const guard = await mssqlCostGuard(source, credential, tls, caps, sql);
    if (guard?.verdict.expensive) {
      if (!guard.subsetSql) {
        throw new AppError(
          `Query not run — estimated too expensive from catalog stats: ${guard.verdict.reasons.join("; ")}.`,
          "config",
          `Cost guard (table sizes read from the catalog, no scan): ${guard.verdict.statsNote}. Add a WHERE on an indexed lead column or TOP n, or explicitly accept a full run (allowExpensive) — full scans can exceed the ${Math.round(caps.timeoutMs / 1000)}s query timeout.`,
        );
      }
      const rows = await SQL_RUNNERS.mssql(source, credential, tls, caps, guard.subsetSql);
      return [
        {
          title: `⚠ Cost guard: computed on a TOP ${SUBSET_TOP_ROWS.toLocaleString("en-US")} sample per big table — NOT full-table results`,
          url: "cost-guard:sample",
          excerpt:
            `Estimated expensive: ${guard.verdict.reasons.join("; ")}. Catalog sizes: ${guard.verdict.statsNote}. ` +
            "Counts/aggregates below reflect the sample only. For exact results, refine the query (indexed WHERE / TOP n) — or re-run with allowExpensive=true once the user accepts that a full scan may be slow.",
        },
        ...rowsToHits(rows, caps.maxResults, label),
      ];
    }
  }
  const rows = await SQL_RUNNERS[source.type as SqlEngine](
    source,
    credential,
    tls,
    caps,
    sql,
  );
  return rowsToHits(rows, caps.maxResults, label);
}

// --- schema catalog (ADR-0024) ------------------------------------------------

/** Column-level INFORMATION_SCHEMA queries, ordered so catalogFromRows can
 *  group sequentially. Views are included — read-only access anyway. */
const DESCRIBE_SQL: Record<SqlEngine, string> = {
  mssql:
    "SELECT t.TABLE_SCHEMA AS table_schema, t.TABLE_NAME AS table_name, t.TABLE_TYPE AS table_type, " +
    "c.COLUMN_NAME AS column_name, c.DATA_TYPE AS data_type, c.IS_NULLABLE AS is_nullable " +
    "FROM INFORMATION_SCHEMA.TABLES t JOIN INFORMATION_SCHEMA.COLUMNS c " +
    "ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME " +
    "WHERE t.TABLE_TYPE IN ('BASE TABLE','VIEW') " +
    "ORDER BY t.TABLE_SCHEMA, t.TABLE_NAME, c.ORDINAL_POSITION",
  postgres:
    "SELECT t.table_schema, t.table_name, t.table_type, c.column_name, c.data_type, c.is_nullable " +
    "FROM information_schema.tables t JOIN information_schema.columns c " +
    "ON t.table_schema = c.table_schema AND t.table_name = c.table_name " +
    "WHERE t.table_type IN ('BASE TABLE','VIEW') " +
    "AND t.table_schema NOT IN ('pg_catalog','information_schema') " +
    "ORDER BY t.table_schema, t.table_name, c.ordinal_position",
  mysql:
    "SELECT t.table_schema, t.table_name, t.table_type, c.column_name, c.data_type, c.is_nullable " +
    "FROM information_schema.tables t JOIN information_schema.columns c " +
    "ON t.table_schema = c.table_schema AND t.table_name = c.table_name " +
    "WHERE t.table_type IN ('BASE TABLE','VIEW') AND t.table_schema = DATABASE() " +
    "ORDER BY t.table_schema, t.table_name, c.ordinal_position",
};

/** Read the full schema catalog the connection can see — metadata only
 *  (table/column names and types; for MongoDB, field names inferred from a
 *  small local sample whose values are immediately discarded). */
export async function describeDb(
  source: ContextSource,
  credential: ContextCredential,
  tls: DbTlsOptions,
  caps: ReadCaps,
  fetchedAt: string,
): Promise<SchemaCatalog> {
  const { database } = parseDbUrl(source);
  if (source.type === "mongodb") {
    const samples = await withMongo(source, credential, tls, caps, async (client, dbName) => {
      const names = (
        await client.db(dbName).listCollections(undefined, { nameOnly: true }).toArray()
      )
        .map((c) => c.name)
        .filter((n) => !n.startsWith("system."))
        .slice(0, MONGO_MAX_COLLECTIONS);
      const out: Record<string, Array<Record<string, unknown>>> = {};
      for (const name of names) {
        out[name] = (await client
          .db(dbName)
          .collection(name)
          .find({}, { limit: MONGO_SAMPLE_DOCS, maxTimeMS: caps.timeoutMs })
          .toArray()) as Array<Record<string, unknown>>;
      }
      return out;
    });
    return catalogFromMongoSamples(database, samples, fetchedAt);
  }
  // Metadata queries need a row cap sized for catalogs, not result sets.
  const schemaCaps: ReadCaps = {
    ...caps,
    maxResults: SCHEMA_MAX_TABLES * SCHEMA_MAX_COLUMNS_PER_TABLE,
  };
  const rows = await SQL_RUNNERS[source.type as SqlEngine](
    source,
    credential,
    tls,
    schemaCaps,
    DESCRIBE_SQL[source.type as SqlEngine],
  );
  return catalogFromRows(source.type, database, rows, fetchedAt);
}

/** Content-type indexing sample: one bounded row sample per table, reduced
 *  to top distinct values per column LOCALLY — only the distinct value
 *  strings (already truncated) survive into the caller's hands. */
export async function sampleTableValues(
  source: ContextSource,
  credential: ContextCredential,
  tls: DbTlsOptions,
  caps: ReadCaps,
  table: TableDef,
): Promise<Record<string, string[]>> {
  if (source.type === "mongodb") {
    const docs = await withMongo(source, credential, tls, caps, (client, dbName) =>
      client
        .db(dbName)
        .collection(table.name)
        .find({}, { limit: CONTENT_SAMPLE_ROWS, maxTimeMS: caps.timeoutMs })
        .toArray(),
    );
    return distinctValues(docs as Array<Record<string, unknown>>);
  }
  const rows = await SQL_RUNNERS[source.type as SqlEngine](
    source,
    credential,
    tls,
    { ...caps, maxResults: CONTENT_SAMPLE_ROWS },
    buildSampleQuery(source.type, table),
  );
  return distinctValues(rows);
}

/** Tables/collections → ready-made sample-query bookmark candidates. */
export async function browseDb(
  source: ContextSource,
  credential: ContextCredential,
  tls: DbTlsOptions,
  caps: ReadCaps,
): Promise<BrowseCandidate[]> {
  if (source.type === "mongodb") {
    const names = await withMongo(source, credential, tls, caps, async (client, dbName) =>
      (await client.db(dbName).listCollections(undefined, { nameOnly: true }).toArray()).map(
        (c) => c.name,
      ),
    );
    return names.slice(0, caps.maxResults).map((name) => ({
      name: `${name} — sample documents`,
      locator: JSON.stringify({ collection: name, filter: {}, limit: 10 }),
      kind: "query",
      detail: "MongoDB collection",
    }));
  }
  const catalogSql =
    source.type === "mysql"
      ? "SELECT table_schema, table_name FROM information_schema.tables WHERE table_type = 'BASE TABLE' AND table_schema = DATABASE() ORDER BY 1, 2"
      : source.type === "postgres"
        ? "SELECT table_schema, table_name FROM information_schema.tables WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog','information_schema') ORDER BY 1, 2"
        : "SELECT TABLE_SCHEMA AS table_schema, TABLE_NAME AS table_name FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE' ORDER BY 1, 2";
  const rows = await SQL_RUNNERS[source.type as SqlEngine](
    source,
    credential,
    tls,
    caps,
    catalogSql,
  );
  return rows.slice(0, caps.maxResults).map((r) => {
    const schema = String(r.table_schema ?? r.TABLE_SCHEMA ?? "");
    const table = String(r.table_name ?? r.TABLE_NAME ?? "");
    const qualified = schema ? `${schema}.${table}` : table;
    const sample =
      source.type === "mssql"
        ? `SELECT TOP 25 * FROM ${qualified}`
        : `SELECT * FROM ${qualified} LIMIT 25`;
    return { name: `${qualified} — sample rows`, locator: sample, kind: "query", detail: "Table" };
  });
}
