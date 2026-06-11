import * as vscode from "vscode";
import { AppError } from "../core/errors";

/** Microsoft Graph PowerShell first-party app — public client, broad
 *  pre-consented delegated scopes, no app registration required (PLAN §5). */
export const GRAPH_POWERSHELL_CLIENT_ID = "14d82eec-204b-4c2f-b7e8-296a70dab67e";

/** Authority hosts trusted out of the box (commercial + sovereign clouds). */
const KNOWN_AUTHORITY_HOSTS = [
  "login.microsoftonline.com",
  "login.microsoftonline.us", // GCC High / DoD
  "login.partner.microsoftonline.cn", // 21Vianet
  "login.chinacloudapi.cn",
  "login.microsoftonline.de", // legacy German cloud
];

export interface AuthSettings {
  authority: string;
  clientId: string;
}

/**
 * Resolve and validate the auth settings (machine-scoped — see REVIEW S1 and
 * `capabilities.untrustedWorkspaces`). The authority must be HTTPS and its
 * host must be a known Microsoft login endpoint or explicitly allowlisted via
 * `aiSharePoint.auth.additionalAuthorityHosts`, so a tampered setting cannot
 * silently redirect sign-in to a hostile authority.
 */
export function resolveAuthSettings(): AuthSettings {
  const cfg = vscode.workspace.getConfiguration("aiSharePoint");
  const authority = cfg
    .get<string>("auth.tenantAuthority", "https://login.microsoftonline.com/common")
    .trim();
  const clientId =
    cfg.get<string>("auth.clientId", "").trim() || GRAPH_POWERSHELL_CLIENT_ID;
  const extraHosts = cfg
    .get<string[]>("auth.additionalAuthorityHosts", [])
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);

  let url: URL;
  try {
    url = new URL(authority);
  } catch {
    throw new AppError(
      `Invalid auth.tenantAuthority: not a URL.`,
      "config",
      "The configured sign-in authority is not a valid URL.",
    );
  }
  if (url.protocol !== "https:") {
    throw new AppError(
      "auth.tenantAuthority must use https.",
      "config",
      "The configured sign-in authority must use HTTPS.",
    );
  }
  const host = url.hostname.toLowerCase();
  if (!KNOWN_AUTHORITY_HOSTS.includes(host) && !extraHosts.includes(host)) {
    throw new AppError(
      `Authority host "${host}" is not a known Microsoft login endpoint. Add it to aiSharePoint.auth.additionalAuthorityHosts (machine setting) if it is legitimate.`,
      "config",
      "The configured sign-in authority host is not trusted.",
    );
  }
  if (!/^[0-9a-fA-F-]{36}$|^$/.test(cfg.get<string>("auth.clientId", "").trim())) {
    throw new AppError(
      "auth.clientId must be an Entra application (client) ID GUID.",
      "config",
      "The configured client ID is not a valid application ID.",
    );
  }
  return { authority: url.toString().replace(/\/$/, ""), clientId };
}
