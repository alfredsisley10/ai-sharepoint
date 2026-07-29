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

/** The Entra scope for a SQL Server / Azure SQL access token. */
export const MSSQL_AAD_SCOPES = ["https://database.windows.net/.default"];

export type TediousAuthentication =
  | { type: "default"; options: { userName: string; password: string } }
  | { type: "ntlm"; options: { userName: string; password: string; domain: string } }
  | { type: "azure-active-directory-access-token"; options: { token: string } };

/**
 * Pick the tedious authentication config:
 *  - method "aad-sso" → the SIGNED-IN Microsoft user. `accessToken` is minted on
 *    demand from the extension's existing Microsoft 365 sign-in, so no database
 *    credential is ever stored for this source (the keychain entry holds only
 *    the provider/cache handles). Works against Azure SQL / SQL MI and any
 *    Entra-enabled SQL Server;
 *  - method "ntlm" → Windows Authentication (NTLM), domain parsed from the
 *    account (falls back to plain user + empty domain if unparseable);
 *  - method "basic" with a Windows-shaped account (DOMAIN\\user / UPN) →
 *    NTLM too — SQL logins cannot contain "\\", so this inference is safe
 *    and rescues users who picked the wrong mode;
 *  - otherwise → SQL Server Authentication.
 *
 * Note on passwordless ON-PREM Windows auth: integrated SSPI/Kerberos needs
 * native bindings, which the one-VSIX portability rule forbids (ADR-0016), so
 * on-prem still needs NTLM with a password. `aad-sso` covers the cloud/Entra
 * case, which is where "don't store another credential" actually applies.
 */
export function buildMssqlAuthentication(
  credential: ContextCredential,
  /** Token minted from the signed-in Microsoft account (method "aad-sso"). */
  accessToken?: string,
): TediousAuthentication {
  if (credential.method === "aad-sso") {
    if (!accessToken) {
      // Fail loudly: silently falling back to SQL auth here would send the
      // credential JSON (provider handles, not a password) as a password.
      throw new Error(
        "This SQL Server source signs in with your Microsoft account, but no access token was available. Sign in to Microsoft 365 and try again.",
      );
    }
    return { type: "azure-active-directory-access-token", options: { token: accessToken } };
  }
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
  /** SSMS "Trust server certificate" equivalent — the URL parameter is honored
   *  only behind the machine-scoped aiSharePoint.db.allowTrustServerCertificate
   *  opt-in (a per-source URL must never switch cert validation off alone). */
  trustServerCertificate: boolean;
  /** True when ?trustServerCertificate=true was present but the machine-scoped
   *  allowance is off — the parameter was ignored, validation stays ON. */
  trustServerCertificateIgnored?: boolean;
}

/** Parse mssql:// URL query params: ?instance=PROD&encrypt=true|false&trustServerCertificate=true.
 *  Disabling certificate validation is a machine-level decision, not a per-URL
 *  one: `allowTrustServerCertificate` carries the machine-scoped setting
 *  (aiSharePoint.db.allowTrustServerCertificate, same pattern as
 *  ldap.allowRawFilters); without it the parameter is ignored and flagged. */
export function parseMssqlParams(
  params: URLSearchParams,
  allowTrustServerCertificate = false,
): MssqlConnectParams {
  const instance = params.get("instance")?.trim();
  const wantsTrust = params.get("trustServerCertificate") === "true";
  return {
    ...(instance ? { instanceName: instance } : {}),
    encrypt: params.get("encrypt") !== "false",
    trustServerCertificate: wantsTrust && allowTrustServerCertificate,
    ...(wantsTrust && !allowTrustServerCertificate ? { trustServerCertificateIgnored: true } : {}),
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

export interface MssqlParts {
  host: string;
  instance?: string;
  port?: number;
  database: string;
  trustServerCertificate?: boolean;
}

/** Build the stored mssql:// URL from individually-prompted parts. Both
 *  instance and port are preserved when given (port wins at connect time —
 *  SqlClient precedence); the URL stays a faithful record of user input. */
export function buildMssqlUrl(parts: MssqlParts): string {
  let url = `mssql://${parts.host.trim()}`;
  if (parts.port !== undefined) {
    url += `:${parts.port}`;
  }
  url += `/${encodeURIComponent(parts.database.trim())}`;
  const q = new URLSearchParams();
  if (parts.instance?.trim()) q.set("instance", parts.instance.trim());
  if (parts.trustServerCertificate) q.set("trustServerCertificate", "true");
  const qs = q.toString();
  return qs ? `${url}?${qs}` : url;
}
