import * as vscode from "vscode";
import { DeviceCodePrompt } from "./auth/deviceCodeProvider";
import { SitesStore, SiteConnection } from "./auth/sitesStore";
import { ContextSourcesStore } from "./context/sourcesStore";
import {
  ContextSource,
  ContextSourceType,
  ContextDeployment,
  ContextBookmark,
} from "./context/types";
import { assertReadOnlySql, parseMongoSpec } from "./context/db/readSafe";
import { aliasIssue, normalizeAlias, DESCRIPTION_MAX_LENGTH } from "./context/sourceRef";
import { SiteSyncConfig } from "./sync/syncConfigStore";
import {
  classifyTlsFailure,
  parseCertAltNames,
  suggestConnectionNames,
  withMssqlHost,
  withTrustServerCertificate,
  mssqlHostOf,
  describeTlsFailure,
} from "./context/db/mssqlCertRecovery";
import { ChangeReport } from "./sync/changeReport";

/**
 * Self-contained command/UI helpers lifted out of the extension entrypoint.
 * These are module-level functions that depend only on their arguments and
 * imports (no `activate()`-scoped state), so relocating them here is pure
 * motion — and it lets the pure ones (renderPullPreview) be unit-tested.
 */

/** The device-code sign-in notification, with a Cancel that stops MSAL's poll. */
export async function showDeviceCodePrompt(info: DeviceCodePrompt): Promise<void> {
  const { userCode, verificationUri } = info;
  const pick = await vscode.window.showInformationMessage(
    `Device-code sign-in: enter code ${userCode} at ${verificationUri}`,
    "Copy Code & Open Browser",
    "Copy Code",
    "Cancel Sign-in",
  );
  if (pick === "Copy Code & Open Browser") {
    await vscode.env.clipboard.writeText(userCode);
    await vscode.env.openExternal(vscode.Uri.parse(verificationUri));
  } else if (pick === "Copy Code") {
    await vscode.env.clipboard.writeText(userCode);
  } else if (pick === "Cancel Sign-in") {
    // Stop MSAL's background polling instead of leaving it to run until the
    // code expires (~15 min).
    info.cancel();
  }
}

/** Resolve a SharePoint connection from a command arg, else pick one (offering
 *  to connect when none exist). */
export async function resolveConnArg(
  arg: unknown,
  sites: SitesStore,
  title: string,
): Promise<SiteConnection | undefined> {
  if (
    arg &&
    typeof arg === "object" &&
    "siteUrl" in arg &&
    typeof (arg as SiteConnection).siteUrl === "string"
  ) {
    return sites.get((arg as SiteConnection).siteUrl) ?? (arg as SiteConnection);
  }
  const all = sites.list();
  if (all.length === 0) {
    const connect = await vscode.window.showInformationMessage(
      "No SharePoint connections yet.",
      "Connect a Site",
    );
    if (connect) {
      await vscode.commands.executeCommand("aiSharePoint.connectSite");
    }
    return undefined;
  }
  if (all.length === 1) {
    return all[0];
  }
  const pick = await vscode.window.showQuickPick(
    all.map((c) => ({
      label: c.displayName,
      description: c.role,
      detail: c.siteUrl,
      conn: c,
    })),
    { title },
  );
  return pick?.conn;
}

/** Validate a bookmark locator at edit/save time. SQL bookmarks must stay
 *  read-only SELECTs (the runtime guard re-checks — this is early feedback);
 *  MongoDB bookmarks must be a valid query spec. */
export function bookmarkLocatorIssue(
  type: ContextSourceType | undefined,
  kind: ContextBookmark["kind"],
  value: string,
): string | undefined {
  if (!value.trim()) return "Enter a locator";
  if (kind !== "query") return undefined;
  if (type === "mssql" || type === "postgres" || type === "mysql") {
    const verdict = assertReadOnlySql(value);
    return verdict.ok ? undefined : verdict.reason;
  }
  if (type === "mongodb") {
    try {
      parseMongoSpec(value);
      return undefined;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }
  return undefined;
}

/** Wizard-scoped facts an add-flow branch already collected, threaded into
 *  the identity seed so the suggested name/alias/description reflect what was
 *  actually connected instead of a bare hostname. All optional — the seed
 *  degrades to host/type when a fact is unknown. */
export interface SourceIdentityExtras {
  /** Confluence: the space key (from the write scope or the pasted URL). */
  spaceKey?: string;
  /** Managed Jira: the write-scope project key. */
  projectKey?: string;
  /** SQL Server wizard fields (its mssql:// URL carries instance/port noise). */
  host?: string;
  database?: string;
  /** ServiceNow: the default table chosen during onboarding. */
  defaultTable?: string;
  /** Splunk: the search app and default index chosen during onboarding. */
  app?: string;
  index?: string;
  /** Power BI: the picked default dataset and its workspace. */
  datasetName?: string;
  workspaceName?: string;
  /** Microsoft 365 Copilot: the surfaces enabled for grounding. */
  surfaces?: string[];
  /** LDAP: the directory base DN. */
  baseDn?: string;
  /** Cloud vs Data Center — colors the GitHub/Grafana description. */
  deployment?: ContextDeployment;
}

/** The smart identity defaults for one source: shown as ONE editable name
 *  prompt on add, with the alias/description applied silently. */
export interface SourceIdentitySeed {
  typeLabel: string;
  displayName: string;
  aliasSuggestion?: string;
  description?: string;
}

const SOURCE_TYPE_LABELS: Record<ContextSourceType, string> = {
  confluence: "Confluence",
  jira: "Jira",
  github: "GitHub",
  ldap: "LDAP / Active Directory",
  mssql: "SQL Server",
  postgres: "PostgreSQL",
  mysql: "MySQL",
  mongodb: "MongoDB",
  powerbi: "Power BI",
  servicenow: "ServiceNow",
  splunk: "Splunk",
  splunkobs: "Splunk Observability Cloud",
  grafana: "Grafana",
  m365copilot: "Microsoft 365 Copilot",
};

const hostnameOf = (baseUrl: string): string => {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return "";
  }
};

/** First path segment of a connection URL — the database name for the
 *  postgres/mysql/mongodb/mssql URL shapes. */
const dbNameOf = (baseUrl: string): string => {
  try {
    const u = new URL(baseUrl);
    return decodeURIComponent(u.pathname.replace(/^\/+/, "").split("/")[0] ?? "");
  } catch {
    return "";
  }
};

/** A query param riding on the stored baseUrl (?table=…, ?app=…, ?index=…). */
const paramOf = (baseUrl: string, key: string): string | undefined => {
  try {
    return new URL(baseUrl).searchParams.get(key) ?? undefined;
  } catch {
    return undefined;
  }
};

/** Join description fragments with " · ", capped at the persisted limit. */
const composeDescription = (...parts: Array<string | undefined>): string | undefined => {
  const text = parts
    .map((p) => p?.trim())
    .filter((p): p is string => !!p)
    .join(" · ");
  return text ? text.slice(0, DESCRIPTION_MAX_LENGTH) : undefined;
};

/** An alias is only suggested when the token would survive the same
 *  validation the manual alias box applies (uniqueness against the live
 *  source list is re-checked at prompt time). */
const aliasCandidate = (token: string | undefined): string | undefined => {
  const t = token?.trim();
  return t && !aliasIssue(t, []) ? normalizeAlias(t) : undefined;
};

/**
 * Smart identity defaults for the add/edit flows — the space/project/database/
 * dataset the user just connected becomes the name and alias suggestion, and
 * the description tells Copilot what the source is. Pure.
 */
export function buildSourceIdentitySeed(
  type: ContextSourceType,
  baseUrl: string,
  extras: SourceIdentityExtras = {},
): SourceIdentitySeed {
  const typeLabel = SOURCE_TYPE_LABELS[type];
  const host = hostnameOf(baseUrl);
  const at = host ? ` at ${host}` : "";
  /** `<token> · <Type>`, falling back to the host, then the bare type. */
  const named = (token?: string): string => {
    const t = token?.trim();
    return t ? `${t} · ${typeLabel}` : host ? `${host} · ${typeLabel}` : typeLabel;
  };

  switch (type) {
    case "confluence": {
      const space = extras.spaceKey?.trim();
      return {
        typeLabel,
        displayName: named(space),
        aliasSuggestion: aliasCandidate(space),
        description: composeDescription(space ? `Confluence space ${space}${at}` : `Confluence${at}`),
      };
    }
    case "jira": {
      const project = extras.projectKey?.trim();
      return {
        typeLabel,
        displayName: named(project),
        aliasSuggestion: aliasCandidate(project),
        description: composeDescription(project ? `Jira project ${project}${at}` : `Jira${at}`),
      };
    }
    case "mssql":
    case "postgres":
    case "mysql":
    case "mongodb": {
      const db = extras.database?.trim() || dbNameOf(baseUrl);
      const dbHost = extras.host?.trim() || host;
      return {
        typeLabel,
        displayName: db && dbHost ? `${db} @ ${dbHost}` : named(db),
        aliasSuggestion: aliasCandidate(db),
        description: composeDescription(
          db ? `${typeLabel} database ${db}${dbHost ? ` on ${dbHost}` : ""}` : `${typeLabel}${at}`,
        ),
      };
    }
    case "servicenow": {
      const instance = host.split(".")[0] || undefined;
      const table = extras.defaultTable?.trim() || paramOf(baseUrl, "table");
      return {
        typeLabel,
        displayName: named(instance),
        description: composeDescription(
          `ServiceNow instance${at}`,
          table ? `default table: ${table}` : undefined,
        ),
      };
    }
    case "splunk": {
      const app = extras.app?.trim() || paramOf(baseUrl, "app");
      const index = extras.index?.trim() || paramOf(baseUrl, "index");
      return {
        typeLabel,
        displayName: named(undefined),
        description: composeDescription(
          `Splunk${at}`,
          app ? `app: ${app}` : undefined,
          index ? `default index: ${index}` : undefined,
        ),
      };
    }
    case "powerbi": {
      const dataset = extras.datasetName?.trim();
      const workspace = extras.workspaceName?.trim();
      return {
        typeLabel,
        displayName: dataset ? `${dataset}${workspace ? ` (${workspace})` : ""} · Power BI` : typeLabel,
        aliasSuggestion: aliasCandidate(dataset),
        description: dataset
          ? composeDescription(
              `Power BI dataset "${dataset}"${workspace ? ` in workspace "${workspace}"` : ""}`,
            )
          : undefined,
      };
    }
    case "splunkobs": {
      const realm = host.match(/^api\.([a-z]{2}\d+)\./i)?.[1]?.toLowerCase();
      return {
        typeLabel,
        displayName: named(realm),
        description: composeDescription(realm ? `Splunk Observability Cloud realm ${realm}` : undefined),
      };
    }
    case "m365copilot": {
      const surfaces = extras.surfaces ?? paramOf(baseUrl, "surfaces")?.split(",").filter((s) => s);
      return {
        typeLabel,
        displayName: typeLabel,
        description: composeDescription(
          "Microsoft 365 Copilot retrieval",
          surfaces?.length ? `surfaces: ${surfaces.join(", ")}` : undefined,
        ),
      };
    }
    case "github":
      return {
        typeLabel,
        displayName: named(undefined),
        description: composeDescription(
          `${extras.deployment === "datacenter" ? "GitHub Enterprise Server" : "GitHub"}${at}`,
        ),
      };
    case "grafana":
      return {
        typeLabel,
        displayName: named(undefined),
        description: composeDescription(
          `${extras.deployment === "cloud" ? "Grafana Cloud" : extras.deployment === "datacenter" ? "Self-hosted Grafana" : "Grafana"}${at}`,
        ),
      };
    case "ldap": {
      // The directory's DNS domain reads better than an SRV-lookup hostname
      // (_gc._tcp.corp.example) — derive it from the base DN's DC parts.
      const dcDomain = (extras.baseDn ?? "")
        .split(",")
        .map((p) => p.trim())
        .filter((p) => /^dc=/i.test(p))
        .map((p) => p.slice(3))
        .join(".");
      const domain = dcDomain || host.replace(/^(_[a-z]+\._tcp\.)+/i, "") || undefined;
      return {
        typeLabel,
        displayName: named(domain),
        description: composeDescription(
          domain ? `Active Directory / LDAP directory ${domain}` : `Active Directory / LDAP directory${at}`,
          extras.baseDn?.trim() ? `base DN: ${extras.baseDn.trim()}` : undefined,
        ),
      };
    }
  }
}

/** The single identity step shared by add + edit.
 *
 *  ADD (no `current`): ONE input box — the seed's suggested name, Enter to
 *  accept — while the alias/description defaults apply silently (a suggested
 *  alias that would collide with an existing source is dropped, never blocks).
 *  EDIT: name (required), then the alias and description boxes prefilled with
 *  the stored values. Enter on an empty box skips/clears; Esc cancels. */
export async function promptSourceIdentity(
  existing: ContextSource[],
  seed: SourceIdentitySeed,
  current?: { id?: string; displayName?: string; alias?: string; description?: string },
): Promise<{ displayName: string; alias?: string; description?: string } | undefined> {
  if (!current) {
    const alias =
      seed.aliasSuggestion && !aliasIssue(seed.aliasSuggestion, existing)
        ? normalizeAlias(seed.aliasSuggestion)
        : undefined;
    const name = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      title: `${seed.typeLabel} — name (Enter to accept)`,
      value: seed.displayName,
      prompt:
        "The chat alias and description are set automatically from what you connected — change any of them later via right-click → Edit Name, Alias & Description.",
      validateInput: (v) => (v.trim() ? undefined : "Enter a name"),
    });
    if (!name) return undefined;
    return { displayName: name.trim(), alias, description: seed.description };
  }
  const name = await vscode.window.showInputBox({
    ignoreFocusOut: true,
    title: `${seed.typeLabel} — name`,
    value: current.displayName ?? seed.displayName,
    validateInput: (v) => (v.trim() ? undefined : "Enter a name"),
  });
  if (!name) return undefined;
  const aliasRaw = await vscode.window.showInputBox({
    ignoreFocusOut: true,
    title: "Chat alias (optional)",
    value: current.alias ?? "",
    placeHolder: 'CMDB — short handle for @sharepoint chat ("…in the CMDB database")',
    prompt: current.alias
      ? "Press Enter to keep/change, or clear the box to remove the alias."
      : "Press Enter to skip. You can set it later via right-click → Edit Name, Alias & Description.",
    validateInput: (v) => (v.trim() ? aliasIssue(v, existing, current.id) : undefined),
  });
  if (aliasRaw === undefined) return undefined;
  const descriptionRaw = await vscode.window.showInputBox({
    ignoreFocusOut: true,
    title: "Description (optional)",
    value: current.description ?? "",
    placeHolder: "What's in it — e.g. ServiceNow CMDB replica: application & service inventory",
    prompt: "Shown to Copilot so it picks the right source for a question. Press Enter to skip.",
    validateInput: (v) =>
      v.trim().length > DESCRIPTION_MAX_LENGTH
        ? `Keep it under ${DESCRIPTION_MAX_LENGTH} characters.`
        : undefined,
  });
  if (descriptionRaw === undefined) return undefined;
  return {
    displayName: name.trim(),
    alias: aliasRaw.trim() ? normalizeAlias(aliasRaw) : undefined,
    description: descriptionRaw.trim() ? descriptionRaw.trim().slice(0, DESCRIPTION_MAX_LENGTH) : undefined,
  };
}

/** Resolve a reference source from a command arg, else pick one (offering to
 *  add one when none exist). */
export async function resolveSourceArg(
  arg: unknown,
  store: ContextSourcesStore,
): Promise<ContextSource | undefined> {
  if (arg && typeof arg === "object" && "id" in arg && "baseUrl" in arg) {
    return store.get((arg as ContextSource).id) ?? (arg as ContextSource);
  }
  const all = store.list();
  if (all.length === 0) {
    const add = await vscode.window.showInformationMessage(
      "No reference sources configured yet.",
      "Add Context Source",
    );
    if (add) {
      await vscode.commands.executeCommand("aiSharePoint.addContextSource");
    }
    return undefined;
  }
  if (all.length === 1) return all[0];
  const pick = await vscode.window.showQuickPick(
    all.map((s) => ({
      label: s.displayName,
      description: `${s.alias ? `“${s.alias}” · ` : ""}${s.type} · ${s.deployment}`,
      source: s,
    })),
    { ignoreFocusOut: true, title: "Which source?" },
  );
  return pick?.source;
}

/** The markdown pull-preview shown before a site sync is applied. Pure. */
export function renderPullPreview(
  siteName: string,
  config: SiteSyncConfig,
  report: ChangeReport,
): string {
  const list = (title: string, items: string[]) =>
    items.length
      ? [`**${title} (${items.length}):**`, ...items.slice(0, 50).map((f) => `- \`${f}\``),
         ...(items.length > 50 ? [`- _…and ${items.length - 50} more_`] : []), ""]
      : [];
  return [
    `# Pull preview — ${siteName}`,
    "",
    `Target: \`${config.folder}\` · review gate: **${config.reviewGate}**`,
    "",
    "> Nothing has been written yet. Confirm in the dialog to apply these changes and commit.",
    "",
    ...list("Added", report.added),
    ...list("Updated", report.updated),
    ...list("Removed", report.removed),
    `${report.unchanged} file(s) unchanged.`,
    "",
    ...(report.large.length
      ? [`⚠️ Large files (≥50 MB): ${report.large.join(", ")} — consider excluding before pushing.`, ""]
      : []),
    "_Not yet synced (roadmap): navigation, theme, list items/documents, permissions._",
  ].join("\n");
}

/** Open a bundled `docs/<name>` markdown file (preview, else a text editor). */
export async function openBundledDoc(
  context: vscode.ExtensionContext,
  name: string,
): Promise<void> {
  const uri = vscode.Uri.joinPath(context.extensionUri, "docs", name);
  try {
    await vscode.commands.executeCommand("markdown.showPreview", uri);
  } catch {
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: true });
  }
}

// --- Failed-verify recovery (SQL Server TLS + generic) -----------------------

/** What the add-source flow should do after a failed verification. */
export type VerifyRecovery =
  | { kind: "retry"; url: string }
  | { kind: "credentials" };

/**
 * Offer to FIX a failed connection instead of discarding the wizard.
 *
 * Pilot report: adding a SQL Server whose certificate didn't validate threw the
 * user all the way back to the start, losing the server, instance, port,
 * database, name and credentials they had just typed. The overwhelmingly common
 * cause is a name mismatch — connecting by IP or short name when the certificate
 * is issued for the FQDN — which we can *read out of the error* and offer to
 * correct (mssqlCertRecovery).
 *
 * Returns the recovery to apply, or undefined when the user gives up (the caller
 * then reports the original error, as before).
 */
export async function offerVerifyRecovery(
  sourceType: ContextSourceType,
  currentUrl: string,
  err: unknown,
  opts: {
    /** aiSharePoint.db.allowTrustServerCertificate — a ?trustServerCertificate=true
     *  URL is IGNORED without it, so offering "trust" without offering to turn
     *  this on would silently do nothing. */
    allowTrustSetting: boolean;
    enableTrustSetting: () => Promise<void>;
  },
): Promise<VerifyRecovery | undefined> {
  const message = err instanceof Error ? err.message : String(err);
  const tls = sourceType === "mssql" ? classifyTlsFailure(message) : undefined;

  type Item = vscode.QuickPickItem & { action?: VerifyRecovery | "trust" | "rename" };
  const items: Item[] = [];

  if (tls) {
    const alt = parseCertAltNames(message);
    for (const s of suggestConnectionNames(mssqlHostOf(currentUrl), alt)) {
      items.push({
        label: `$(arrow-right) Connect as "${s.host}"`,
        description: s.reason,
        action: { kind: "retry", url: withMssqlHost(currentUrl, s.host) },
      });
    }
    items.push({
      label: "$(edit) Use a different server name…",
      description: "type the name the certificate was issued for",
      action: "rename",
    });
    items.push({
      label: "$(unlock) Trust the server certificate (skip validation)",
      description: opts.allowTrustSetting
        ? "the SSMS 'Trust server certificate' checkbox"
        : "also enables the machine-scoped setting this requires",
      action: "trust",
    });
  } else {
    // Not a certificate problem — still better than losing the whole wizard.
    items.push({
      label: "$(key) Re-enter credentials",
      description: "wrong password, or the wrong authentication mode",
      action: { kind: "credentials" },
    });
    items.push({
      label: "$(edit) Change the server name…",
      description: "fix a typo in the host without starting over",
      action: "rename",
    });
  }

  const headline = tls
    ? describeTlsFailure(tls, parseCertAltNames(message))
    : `Could not connect: ${message.slice(0, 200)}`;
  const pick = await vscode.window.showQuickPick(items, {
    ignoreFocusOut: true,
    title: "Connection failed — how would you like to fix it?",
    placeHolder: `${headline}  ·  Esc discards this connection.`,
  });
  if (!pick?.action) return undefined;

  if (pick.action === "rename") {
    const next = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      title: "Server name to connect as",
      value: mssqlHostOf(currentUrl),
      prompt: "Everything else you entered (instance, port, database, credentials) is kept.",
      validateInput: (v) => (v.trim() && !v.includes("://") ? undefined : "Enter the server name only — no scheme"),
    });
    if (!next?.trim()) return undefined;
    return { kind: "retry", url: withMssqlHost(currentUrl, next.trim()) };
  }

  if (pick.action === "trust") {
    if (!opts.allowTrustSetting) {
      const ok = await vscode.window.showWarningMessage(
        "Turn off SQL Server certificate validation for this machine?",
        {
          modal: true,
          detail:
            "Connections will no longer verify the server's identity, so this machine can't detect an impostor server or a TLS-intercepting proxy on the database connection. Prefer connecting by the name on the certificate, or installing your internal CA.\n\nThis enables aiSharePoint.db.allowTrustServerCertificate (machine-scoped); per-connection trust still has to be requested by each connection.",
        },
        "Enable and trust",
      );
      if (ok !== "Enable and trust") return undefined;
      await opts.enableTrustSetting();
    }
    return { kind: "retry", url: withTrustServerCertificate(currentUrl, true) };
  }

  return pick.action;
}
