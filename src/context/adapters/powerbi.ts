import { execFile } from "node:child_process";
import {
  ContextSource,
  ContextSearchHit,
  ReadCaps,
} from "../types";
import { rowsToHits } from "../db/readSafe";
import { AppError } from "../../core/errors";
import { wireEnabled, emitWire, safeJson, safeUrl } from "../../core/wireLog";

/**
 * Power BI (cloud) connector (ADR-0027, amended): list workspaces/datasets
 * and run read-only DAX queries (executeQueries) for analysis. Three sign-in
 * paths, all delegated (the user's own Power BI access, never more):
 *  - "az-sso": a live token from the workstation's Azure CLI session
 *    (`az login`). The Azure CLI is a Microsoft first-party app already
 *    authorized for the Power BI service, so NO per-app admin approval is
 *    involved — the recommended path when the tenant gates the shared
 *    sign-in app ("Graph Command Line Tools needs admin approval", pilot).
 *    Nothing is stored; every call asks the CLI for a live token.
 *  - "aad-sso": the SAME Microsoft 365 sign-in used for SharePoint — an AAD
 *    token for the Power BI audience through the existing MSAL provider.
 *  - "pat": a pasted access token (~1 h lifetime).
 */

export const POWERBI_BASE = "https://api.powerbi.com/v1.0/myorg";

/** Resource audience for Power BI delegated tokens. */
export const POWERBI_RESOURCE = "https://analysis.windows.net/powerbi/api";

/** The Microsoft Azure CLI's well-known first-party public client id. The
 *  no-install sign-in authenticates AS this app via MSAL (browser or device
 *  code): identical consent posture to running `az login` — pre-authorized
 *  for the Power BI service, no app registration, no per-app admin approval
 *  — without requiring the CLI on the machine. Sign-in logs show
 *  "Microsoft Azure CLI" (documented in the admin guide), mirroring how the
 *  extension's Graph sign-in uses the Graph PowerShell first-party app. */
export const AZURE_CLI_CLIENT_ID = "04b07795-8ddb-461a-bbee-02f9e1bf7b46";

/** Keychain prefix for the Power BI no-install sign-in's MSAL cache —
 *  deleted with the source (it's not shared with site sign-ins). */
export const POWERBI_AZCLI_CACHE_PREFIX = "msal-cache:powerbi-azcli:";

/** Delegated Power BI scopes (resource: analysis.windows.net/powerbi/api). */
export const POWERBI_SCOPES = [
  `${POWERBI_RESOURCE}/Workspace.Read.All`,
  `${POWERBI_RESOURCE}/Dataset.Read.All`,
];

/** Token access is injected: the MSAL provider lives in the extension layer. */
export type PowerBiTokenGetter = (interactive: boolean) => Promise<string>;

/** How to invoke the Azure CLI. On Windows az is `az.cmd` — Node's
 *  batch-file hardening (CVE-2024-27980) requires shell:true for .cmd shims.
 *  Only fixed, hard-coded argument lists are ever passed, so the shell never
 *  sees untrusted input. */
export function azInvocation(platform: NodeJS.Platform): { bin: string; shell: boolean } {
  return platform === "win32" ? { bin: "az.cmd", shell: true } : { bin: "az", shell: false };
}

/** Pure parser for `az account get-access-token --output json`. */
export function parseAzTokenOutput(stdout: string): string {
  let token = "";
  try {
    token = String((JSON.parse(stdout) as { accessToken?: unknown }).accessToken ?? "");
  } catch {
    // non-JSON → handled below
  }
  if (!token) {
    throw new AppError(
      "The Azure CLI returned no access token.",
      "auth.failed",
      "Run `az login` (your corporate Microsoft SSO) and retry.",
    );
  }
  return token;
}

/** Power BI token from the workstation's existing `az login` session. */
export function getAzPowerBiToken(timeoutMs = 20_000): Promise<string> {
  const { bin, shell } = azInvocation(process.platform);
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      ["account", "get-access-token", "--resource", POWERBI_RESOURCE, "--output", "json"],
      { timeout: timeoutMs, windowsHide: true, shell },
      (err, stdout, stderr) => {
        if (err) {
          const notFound =
            (err as NodeJS.ErrnoException).code === "ENOENT" || /not recognized|not found/i.test(stderr ?? "");
          reject(
            new AppError(
              `Could not obtain a Power BI token from the Azure CLI: ${stderr?.trim() || err.message}`,
              notFound ? "config" : "auth.failed",
              notFound
                ? "The Azure CLI (az) is not installed on this machine. No install needed: re-run Test Context Source and pick “Microsoft sign-in — nothing to install” (signs in as the same Azure CLI app via your browser), or run `az account get-access-token --resource https://analysis.windows.net/powerbi/api --query accessToken -o tsv` at shell.azure.com and paste the token."
                : "Sign in once with `az login` (your corporate Microsoft SSO), then retry. Tokens are never stored — each call asks the CLI.",
            ),
          );
          return;
        }
        try {
          resolve(parseAzTokenOutput(stdout));
        } catch (parseErr) {
          reject(parseErr);
        }
      },
    );
  });
}

export interface PowerBiSpec {
  /** Dataset id (GUID) or name (resolved against the visible datasets). */
  dataset: string;
  /** A DAX query — executeQueries evaluates read-only table expressions. */
  dax: string;
}

/** Parse the chat/bookmark query format: {"dataset": "...", "dax": "EVALUATE ..."}.
 *  Bare DAX is accepted when a default dataset is configured on the source. */
export function parsePowerBiSpec(query: string, defaultDataset?: string): PowerBiSpec {
  const trimmed = query.trim();
  if (trimmed.startsWith("{")) {
    let raw: { dataset?: unknown; dax?: unknown };
    try {
      raw = JSON.parse(trimmed) as { dataset?: unknown; dax?: unknown };
    } catch {
      throw new AppError(
        'Power BI queries are JSON: {"dataset": "<id or name>", "dax": "EVALUATE …"}.',
        "config",
      );
    }
    const dataset = typeof raw.dataset === "string" ? raw.dataset.trim() : defaultDataset;
    const dax = typeof raw.dax === "string" ? raw.dax.trim() : "";
    if (!dataset) throw new AppError("Spec needs a dataset (id or name).", "config");
    if (!dax) throw new AppError("Spec needs a dax expression (EVALUATE …).", "config");
    return { dataset, dax };
  }
  if (!defaultDataset) {
    throw new AppError(
      'Provide JSON {"dataset": "<id or name>", "dax": "EVALUATE …"} — this source has no default dataset for bare DAX.',
      "config",
    );
  }
  if (!trimmed) throw new AppError("Empty DAX query.", "config");
  return { dataset: defaultDataset, dax: trimmed };
}

/** executeQueries evaluates DAX (read-only by API design); still refuse the
 *  one mutating surface that exists in DAX strings: nothing — but cap size. */
export function daxIssue(dax: string): string | undefined {
  if (!/^\s*(EVALUATE|DEFINE)\b/i.test(dax)) {
    return "DAX queries start with EVALUATE (or DEFINE … EVALUATE).";
  }
  if (dax.length > 8_000) return "DAX query too long (max 8000 chars).";
  return undefined;
}

async function pbiFetch<T>(
  path: string,
  token: string,
  timeoutMs: number,
  init?: { method?: "GET" | "POST"; body?: unknown },
): Promise<T> {
  const method = init?.method ?? "GET";
  const started = Date.now();
  if (wireEnabled()) {
    emitWire(
      "powerbi",
      "→",
      `${method} ${safeUrl(path)}`,
      `Authorization: Bearer ***${init?.body !== undefined ? `\n${safeJson(init.body)}` : ""}`,
    );
  }
  let res: Response;
  try {
    res = await fetch(`${POWERBI_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    emitWire(
      "powerbi",
      "✗",
      `${method} ${safeUrl(path)} — ${err instanceof Error ? err.message : String(err)} (${Date.now() - started}ms)`,
    );
    throw new AppError(
      `Power BI request failed: ${err instanceof Error ? err.message : String(err)}`,
      "network",
    );
  }
  if (!res.ok) {
    emitWire("powerbi", "✗", `${method} ${safeUrl(path)} ${res.status} (${Date.now() - started}ms)`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new AppError(
      `Power BI rejected the sign-in (${res.status}).`,
      "auth.failed",
      "Your Microsoft 365 account needs Power BI access (a Pro/PPU license or workspace membership). Run “Test Context Source” to re-consent.",
    );
  }
  if (res.status === 404) {
    throw new AppError("Power BI resource not found (404) — check the dataset/workspace.", "config");
  }
  if (res.status === 429) {
    throw new AppError("Power BI is throttling requests (429).", "graph.throttled");
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new AppError(`Power BI request failed (${res.status}): ${text.slice(0, 300)}`, "unknown");
  }
  const parsed = (await res.json()) as T;
  if (wireEnabled()) {
    emitWire("powerbi", "←", `${method} ${safeUrl(path)} ${res.status} (${Date.now() - started}ms)`, safeJson(parsed));
  }
  return parsed;
}

interface PbiDataset {
  id: string;
  name: string;
  isEffectiveIdentityRequired?: boolean;
}
interface PbiGroup {
  id: string;
  name: string;
}

/** All datasets the account can see: My workspace + each group (capped). */
async function listDatasets(
  token: string,
  caps: ReadCaps,
): Promise<Array<PbiDataset & { workspace: string; groupId?: string }>> {
  const out: Array<PbiDataset & { workspace: string; groupId?: string }> = [];
  const mine = await pbiFetch<{ value?: PbiDataset[] }>("/datasets", token, caps.timeoutMs);
  for (const d of mine.value ?? []) {
    out.push({ ...d, workspace: "My workspace" });
  }
  const groups = await pbiFetch<{ value?: PbiGroup[] }>("/groups?$top=50", token, caps.timeoutMs);
  for (const g of (groups.value ?? []).slice(0, 50)) {
    try {
      const ds = await pbiFetch<{ value?: PbiDataset[] }>(
        `/groups/${encodeURIComponent(g.id)}/datasets`,
        token,
        caps.timeoutMs,
      );
      for (const d of ds.value ?? []) {
        out.push({ ...d, workspace: g.name, groupId: g.id });
      }
    } catch {
      // No dataset access in this workspace — skip it.
    }
    if (out.length >= 200) break;
  }
  return out;
}

async function resolveDataset(
  token: string,
  ref: string,
  caps: ReadCaps,
): Promise<{ id: string; groupId?: string; name: string }> {
  const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const all = await listDatasets(token, caps);
  const match = GUID.test(ref)
    ? all.find((d) => d.id.toLowerCase() === ref.toLowerCase())
    : (all.find((d) => d.name.toLowerCase() === ref.toLowerCase()) ??
      all.find((d) => d.name.toLowerCase().includes(ref.toLowerCase())));
  if (!match) {
    throw new AppError(
      `No visible Power BI dataset matches "${ref}". Visible: ${all
        .slice(0, 15)
        .map((d) => `${d.name} (${d.workspace})`)
        .join("; ")}${all.length > 15 ? "; …" : ""}`,
      "config",
    );
  }
  return { id: match.id, groupId: match.groupId, name: match.name };
}

export async function verifyPowerBi(
  getToken: PowerBiTokenGetter,
  caps: ReadCaps,
  accountLabel = "Microsoft 365 (Power BI)",
): Promise<{ account: string }> {
  const token = await getToken(true);
  await pbiFetch<{ value?: PbiGroup[] }>("/groups?$top=1", token, caps.timeoutMs);
  return { account: accountLabel };
}

/** Run a DAX query against a dataset (executeQueries — read-only API). */
export async function searchPowerBi(
  source: ContextSource,
  getToken: PowerBiTokenGetter,
  query: string,
  caps: ReadCaps,
): Promise<ContextSearchHit[]> {
  const spec = parsePowerBiSpec(query, new URL(source.baseUrl).searchParams.get("dataset") ?? undefined);
  const issue = daxIssue(spec.dax);
  if (issue) throw new AppError(issue, "config");
  const token = await getToken(false);
  const ds = await resolveDataset(token, spec.dataset, caps);
  const path = ds.groupId
    ? `/groups/${encodeURIComponent(ds.groupId)}/datasets/${encodeURIComponent(ds.id)}/executeQueries`
    : `/datasets/${encodeURIComponent(ds.id)}/executeQueries`;
  const res = await pbiFetch<{
    results?: Array<{ tables?: Array<{ rows?: Array<Record<string, unknown>> }> }>;
  }>(path, token, caps.timeoutMs, {
    method: "POST",
    body: {
      queries: [{ query: spec.dax }],
      serializerSettings: { includeNulls: false },
    },
  });
  const rows = res.results?.[0]?.tables?.[0]?.rows ?? [];
  return rowsToHits(
    rows.slice(0, caps.maxResults),
    caps.maxResults,
    `powerbi:${ds.name}`,
  );
}

export interface PowerBiBrowseCandidate {
  name: string;
  locator: string;
  kind: "query";
  detail: string;
}

/** Wizard enumeration: every dataset the signed-in account can reach —
 *  so setup is "sign in and pick", no names/GUIDs to know (pilot). */
export async function enumeratePowerBiDatasets(
  getToken: PowerBiTokenGetter,
  caps: ReadCaps,
): Promise<Array<{ id: string; name: string; workspace: string }>> {
  const token = await getToken(true);
  return (await listDatasets(token, caps)).map((d) => ({
    id: d.id,
    name: d.name,
    workspace: d.workspace,
  }));
}

/** Datasets → starter DAX bookmarks (INFO.TABLES lists the model's tables). */
export async function browsePowerBi(
  getToken: PowerBiTokenGetter,
  caps: ReadCaps,
): Promise<PowerBiBrowseCandidate[]> {
  const token = await getToken(false);
  const datasets = await listDatasets(token, caps);
  return datasets.slice(0, caps.maxResults * 2).map((d) => ({
    name: `${d.name} (${d.workspace})`,
    locator: JSON.stringify({ dataset: d.id, dax: "EVALUATE INFO.TABLES()" }),
    kind: "query",
    detail: "Power BI dataset — starter query lists its tables",
  }));
}
