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
 * supported (mssql://host:14330/db); a port combined with ?instance= is
 * rejected because TDS treats them as mutually exclusive — the named
 * instance's port is resolved via SQL Browser.
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
  if (u.port && u.searchParams.get("instance")) {
    return "Use either :port or ?instance=NAME, not both — a named instance resolves its own port via SQL Browser";
  }
  return undefined;
}
