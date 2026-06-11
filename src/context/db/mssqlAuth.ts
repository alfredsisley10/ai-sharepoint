/**
 * SQL Server authentication selection (ADR-0022 amendment): supports both
 * SQL Server Authentication (database logins) and Windows Authentication via
 * NTLM (DOMAIN\\user or user@domain + password — tedious's pure-JS NTLM).
 * Passwordless integrated SSPI/Kerberos needs native bindings and is excluded
 * by the portability rule (ADR-0016). Pure module — unit-tested.
 */

import { ContextCredential } from "../types";

export interface WindowsAccount {
  domain: string;
  user: string;
}

/** Parse DOMAIN\\user or user@domain.tld; null for plain SQL logins. */
export function parseWindowsAccount(username: string): WindowsAccount | null {
  const trimmed = username.trim();
  const slash = trimmed.match(/^([^\\@\s]+)\\(.+)$/);
  if (slash) {
    return { domain: slash[1], user: slash[2] };
  }
  const upn = trimmed.match(/^([^\\@\s]+)@([^\\@\s]+\.[^\\@\s]+)$/);
  if (upn) {
    // NTLM wants the NetBIOS-ish domain; the DNS domain works on AD too —
    // use the first label uppercased (CORP from corp.example.com).
    return { domain: upn[2].split(".")[0].toUpperCase(), user: upn[1] };
  }
  return null;
}

export type TediousAuthentication =
  | { type: "default"; options: { userName: string; password: string } }
  | { type: "ntlm"; options: { userName: string; password: string; domain: string } };

/**
 * Pick the tedious authentication config:
 *  - method "ntlm" → Windows Authentication (NTLM), domain parsed from the
 *    account (falls back to plain user + empty domain if unparseable);
 *  - method "basic" with a Windows-shaped account (DOMAIN\\user / UPN) →
 *    NTLM too — SQL logins cannot contain "\\", so this inference is safe
 *    and rescues users who picked the wrong mode;
 *  - otherwise → SQL Server Authentication.
 */
export function buildMssqlAuthentication(
  credential: ContextCredential,
): TediousAuthentication {
  const username = credential.username ?? "";
  const win = parseWindowsAccount(username);
  if (credential.method === "ntlm" || win) {
    return {
      type: "ntlm",
      options: {
        userName: win?.user ?? username,
        password: credential.secret,
        domain: win?.domain ?? "",
      },
    };
  }
  return {
    type: "default",
    options: { userName: username, password: credential.secret },
  };
}

export interface MssqlConnectParams {
  /** Named instance (SSMS "host\\INSTANCE") — resolved via SQL Browser;
   *  when set, the port is omitted (mutually exclusive in TDS). */
  instanceName?: string;
  encrypt: boolean;
  /** SSMS "Trust server certificate" equivalent — explicit opt-in only. */
  trustServerCertificate: boolean;
}

/** Parse mssql:// URL query params: ?instance=PROD&encrypt=true|false&trustServerCertificate=true */
export function parseMssqlParams(params: URLSearchParams): MssqlConnectParams {
  const instance = params.get("instance")?.trim();
  return {
    ...(instance ? { instanceName: instance } : {}),
    encrypt: params.get("encrypt") !== "false",
    trustServerCertificate: params.get("trustServerCertificate") === "true",
  };
}

/**
 * Wizard-time validation for mssql:// URLs. Alternate ports are fully
 * supported (mssql://host:14330/db). Port + ?instance= together is legal —
 * SqlClient/SSMS semantics apply: the port wins and the instance name is
 * ignored for routing (no SQL Browser lookup).
 */
export function mssqlUrlIssue(url: string): string | undefined {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return "Enter a valid connection URL (mssql://host[:port]/database)";
  }
  if (!u.pathname.replace(/^\/+/, "")) {
    return "Include the database name: …/dbname";
  }
  return undefined;
}

/** True when the URL carries both :port and ?instance= (informational). */
export function mssqlPortAndInstance(url: string): boolean {
  try {
    const u = new URL(url.trim());
    return Boolean(u.port && u.searchParams.get("instance"));
  } catch {
    return false;
  }
}

export interface SsmsServerName {
  host: string;
  instance?: string;
  port?: number;
}

/**
 * Parse the native SSMS "Server name" forms DBAs hand out:
 *   server.corp.com\\INSTANCE,14330  ·  server,14330  ·  server\\INSTANCE  ·  server
 * Returns null when the input looks like a URL or is unusable.
 */
export function parseSsmsServerName(input: string): SsmsServerName | null {
  const trimmed = input.trim();
  if (!trimmed || trimmed.includes("://")) return null;
  const m = trimmed.match(/^([A-Za-z0-9_.-]+)(?:\\([^,\s]+))?(?:,\s*(\d{1,5}))?$/);
  if (!m) return null;
  const port = m[3] ? Number(m[3]) : undefined;
  if (port !== undefined && (port < 1 || port > 65535)) return null;
  return {
    host: m[1],
    ...(m[2] ? { instance: m[2] } : {}),
    ...(port !== undefined ? { port } : {}),
  };
}

/** Build the mssql:// URL from an SSMS server name + database. SqlClient
 *  precedence: an explicit port wins; the instance is kept only as the
 *  SQL Browser fallback when no port is given. */
export function ssmsToUrl(server: SsmsServerName, database: string): string {
  if (server.port !== undefined) {
    return `mssql://${server.host}:${server.port}/${encodeURIComponent(database)}`;
  }
  const base = `mssql://${server.host}/${encodeURIComponent(database)}`;
  return server.instance ? `${base}?instance=${encodeURIComponent(server.instance)}` : base;
}

/** TDS endpoint selection with SqlClient precedence: explicit port → direct
 *  TCP (instance ignored); else instance → SQL Browser; else default 1433. */
export function resolveMssqlEndpoint(
  port: number | undefined,
  params: MssqlConnectParams,
): { port: number } | { instanceName: string } {
  if (port !== undefined) return { port };
  if (params.instanceName) return { instanceName: params.instanceName };
  return { port: 1433 };
}
