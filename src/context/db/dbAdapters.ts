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
  catalogFromRows,
  catalogFromMongoSamples,
  SCHEMA_MAX_TABLES,
  SCHEMA_MAX_COLUMNS_PER_TABLE,
  MONGO_MAX_COLLECTIONS,
  MONGO_SAMPLE_DOCS,
} from "./schemaIndex";
import { loadTrustedCAs } from "../ldap/osTrust";
import { AppError } from "../../core/errors";

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
  try {
    await new Promise<void>((resolve, reject) => {
      connection.connect((err) => (err ? reject(withServerDetail(err)) : resolve()));
    });
    return await new Promise((resolve, reject) => {
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
  } catch (err) {
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
  try {
    await client.connect();
    // Server-side read-only + statement timeout (ADR-0012).
    await client.query("SET default_transaction_read_only = on");
    await client.query(`SET statement_timeout = ${Math.floor(caps.timeoutMs)}`);
    const res = await client.query(sql);
    return (res.rows as Array<Record<string, unknown>>).slice(0, caps.maxResults);
  } catch (err) {
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
    const [rows] = await connection.query({ sql, timeout: caps.timeoutMs });
    return (rows as Array<Record<string, unknown>>).slice(0, caps.maxResults);
  } catch (err) {
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

export async function searchDb(
  source: ContextSource,
  credential: ContextCredential,
  query: string,
  tls: DbTlsOptions,
  caps: ReadCaps,
): Promise<ContextSearchHit[]> {
  const label = `${source.type}:${source.displayName}`;
  if (source.type === "mongodb") {
    const spec = parseMongoSpec(query);
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
    return rowsToHits(docs as Array<Record<string, unknown>>, caps.maxResults, label);
  }
  const rows = await SQL_RUNNERS[source.type as SqlEngine](
    source,
    credential,
    tls,
    caps,
    guardSql(query),
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
