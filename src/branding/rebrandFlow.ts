import * as vscode from "vscode";
import { Logger } from "../core/log";
import { redactError } from "../core/redaction";
import {
  BrandConfig,
  validateBrandConfig,
  rebrandPackageJson,
  rebrandLicense,
  replacePhrase,
  summarizeBrand,
  identityChanged,
  extensionId,
  repackageCommand,
  setReleaseManifest,
  setProvisioningManifest,
  SUPPORT_PHRASE,
  SECURITY_PHRASE,
} from "./rebrand";
import { computeExpiry, ReleaseManifest } from "./releaseExpiry";
import {
  ReleaseProfile,
  ProvisioningContent,
  ProvisionedConnector,
  ProvisionedProject,
  ProvisionedHelp,
  parseReleaseProfile,
  serializeReleaseProfile,
  telemetrySettings,
  buildProvisioningManifest,
} from "./releaseProfile";

/** Optional runtime snapshots the wizard can offer to BAKE into the build:
 *  the user's current reference sources (as non-secret connector descriptors)
 *  and projects (as memory defaults). Supplied by the extension. */
export interface RebrandDeps {
  currentConnectors?: ProvisionedConnector[];
  currentProjects?: ProvisionedProject[];
}
import {
  DeepBrandConfig,
  BrandToken,
  buildBrandTokens,
  applyBrandTokens,
  validateDeepBrand,
  camelize,
} from "./brandTokens";

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const HANDLE_RE = /^[a-z0-9][a-z0-9-]*$/;
const msg = (e: unknown) => redactError(e).message;

// Dirs never rewritten. src/branding holds the rebrand engine itself — rewriting
// it would corrupt the find-tokens; test/ isn't shipped and references tokens.
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "out-test",
  "test",
  "scripts",
  ".git",
  ".github",
  ".vscode",
  ".vscode-test",
]);
const REWRITE_EXTS = new Set([".ts", ".md", ".json", ".svg", ".html", ".css"]);
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * "Rebrand This Extension" (Support & Diagnostics). Applies a new identity AND,
 * optionally, a full product rename (display name, chat handle, and — greenfield
 * only — the internal identifier namespaces) across the extension's SOURCE tree,
 * then offers to repackage. The executable counterpart to REBRANDING.md.
 */
export async function runRebrandFlow(log: Logger, deps: RebrandDeps = {}): Promise<void> {
  const start = await vscode.window.showInformationMessage(
    "Rebrand (white-label) this extension",
    {
      modal: true,
      detail:
        "Applies a new identity and (optionally) a full product rename — display name, chat handle, even the internal identifiers — across the extension's SOURCE files, then can build a fresh .vsix. You need the extension's source folder; the installed copy can't rebrand itself.",
    },
    "Continue",
  );
  if (start !== "Continue") return;

  const root = await resolveSourceRoot();
  if (!root) return;

  const pkgUri = vscode.Uri.joinPath(root, "package.json");
  let pkgRaw: string;
  let pkg: {
    publisher?: string;
    name?: string;
    displayName?: string;
    description?: string;
    contributes?: { chatParticipants?: Array<{ name?: string }> };
  };
  try {
    pkgRaw = await readText(pkgUri);
    pkg = JSON.parse(pkgRaw);
  } catch (e) {
    void vscode.window.showErrorMessage(`Could not read a valid package.json there: ${msg(e)}`);
    return;
  }

  const before: BrandConfig = {
    publisher: pkg.publisher ?? "",
    name: pkg.name ?? "",
    displayName: pkg.displayName ?? "",
    description: pkg.description ?? "",
  };
  const currentHandle = pkg.contributes?.chatParticipants?.[0]?.name ?? "sharepoint";

  // Reuse a saved release profile (repeatable re-releases) when one is present —
  // its values pre-fill every prompt below so refreshing a release is quick.
  const loaded = await maybeLoadProfile(root);
  const seedId = loaded?.identity;

  // --- gather the new identity + product naming -----------------------------
  const publisher = await ask("Publisher ID — forms the permanent extension ID (lowercase, hyphens)", seedId?.publisher ?? before.publisher, (v) =>
    ID_RE.test(v) ? undefined : "Lowercase letters, digits, and hyphens only (e.g. contoso).",
  );
  if (publisher === undefined) return;
  const name = await ask("Internal name — also part of the extension ID (lowercase, hyphens)", seedId?.name ?? before.name, (v) =>
    ID_RE.test(v) ? undefined : "Lowercase letters, digits, and hyphens only (e.g. contoso-docs).",
  );
  if (name === undefined) return;
  const displayName = await ask('Product display name (replaces "AI SharePoint" everywhere)', seedId?.displayName ?? before.displayName);
  if (displayName === undefined) return;
  const handle = await ask("Chat handle without @ (replaces @sharepoint)", seedId?.handle ?? currentHandle, (v) =>
    HANDLE_RE.test(v) ? undefined : "Lowercase letters, digits, and hyphens only (e.g. contosodocs).",
  );
  if (handle === undefined) return;
  const description = await ask("Description", seedId?.description ?? before.description);
  if (description === undefined) return;

  // --- depth: cosmetic vs full identifier rename ----------------------------
  const depth = await vscode.window.showQuickPick(
    [
      {
        label: "Product name & handle only",
        description: "recommended — safe on any deployment",
        detail: "Renames everything users see; internal identifiers and stored data/settings are untouched.",
        deep: false,
      },
      {
        label: "Also rename internal identifiers",
        description: "advanced — GREENFIELD ONLY",
        detail: "Renames aiSharePoint.* / aisharepoint_* namespaces too. Changes settings & data keys — existing installs lose their data.",
        deep: true,
      },
    ],
    { title: "How deep should the rename go?", placeHolder: "Choose the rebrand depth", ignoreFocusOut: true },
  );
  if (!depth) return;
  const renameIdentifiers = depth.deep;

  const licenseHolder = await ask("License copyright holder — blank to leave unchanged", seedId?.licenseHolder ?? "", undefined, true);
  if (licenseHolder === undefined) return;
  const supportContact = await ask("Support contact (email/URL/team) — blank to leave unchanged", seedId?.supportContact ?? "", undefined, true);
  if (supportContact === undefined) return;
  const securityContact = await ask("Security contact (email/URL) — blank to leave unchanged", seedId?.securityContact ?? "", undefined, true);
  if (securityContact === undefined) return;

  // Time-limited build (white-label release control): how long this release works
  // before users must upgrade. Blank = no expiry, like the standard build.
  const validityRaw = await ask(
    "Build validity in days — how long this release works before users must upgrade (blank = never expires)",
    loaded?.expiry?.validityDays ? String(loaded.expiry.validityDays) : "",
    (v) => (/^\d{1,4}$/.test(v.trim()) ? undefined : "Whole number of days (e.g. 90), or blank for no expiry."),
    true,
  );
  if (validityRaw === undefined) return;
  let upgradeUrl = "";
  if (validityRaw.trim()) {
    const u = await ask("Upgrade URL shown when the build expires (where users get the new VSIX) — optional", loaded?.expiry?.upgradeUrl ?? "", undefined, true);
    if (u === undefined) return;
    upgradeUrl = u.trim();
  }

  // --- what to BAKE into the build (telemetry, connectors, memory, help) -----
  const provisioning = await gatherProvisioning(deps, loaded?.provisioning);
  if (provisioning === undefined) return; // cancelled

  const after: BrandConfig = {
    publisher: publisher.trim(),
    name: name.trim(),
    displayName: displayName.trim(),
    description: description.trim(),
    licenseHolder: licenseHolder.trim() || undefined,
    supportContact: supportContact.trim() || undefined,
    securityContact: securityContact.trim() || undefined,
  };
  const deep: DeepBrandConfig = {
    displayName: after.displayName,
    handle: handle.trim(),
    renameIdentifiers,
    kebabName: after.name,
    idNamespace: camelize(after.name),
  };

  // Release manifest baked into the rebranded package.json (drives the runtime
  // expiry gate). validityDays is optional — blank means the build never expires.
  const builtAtMs = Date.now();
  const days = validityRaw.trim() ? Number(validityRaw.trim()) : 0;
  const release: ReleaseManifest = {
    channel: "whitelabel",
    builtAt: new Date(builtAtMs).toISOString(),
    productName: after.displayName,
    ...(days > 0
      ? {
          validityDays: days,
          expiresAt: computeExpiry(builtAtMs, days),
          ...(upgradeUrl ? { upgradeUrl } : {}),
        }
      : {}),
  };

  // Provisioning manifest baked into the build for first-run seeding.
  const provisioningManifest = buildProvisioningManifest(provisioning, `${after.publisher}.${after.name}.${builtAtMs}`);
  const hasProvisioning = Boolean(
    provisioningManifest.settings || provisioningManifest.connectors || provisioningManifest.projects || provisioningManifest.help,
  );

  const errors = [...validateBrandConfig(after), ...validateDeepBrand(deep)];
  if (errors.length > 0) {
    void vscode.window.showErrorMessage(`Rebrand cancelled — ${errors.join(" ")}`);
    return;
  }

  // --- greenfield warnings (data-scoping changes) ---------------------------
  if (identityChanged(before, after) || renameIdentifiers) {
    const reasons: string[] = [];
    if (identityChanged(before, after)) {
      reasons.push(`• Extension ID: ${extensionId(before.publisher, before.name)} → ${extensionId(after.publisher, after.name)}`);
    }
    if (renameIdentifiers) {
      reasons.push("• Settings keys and stored-data keys (aiSharePoint.* → " + deep.idNamespace + ".*)");
    }
    const ok = await vscode.window.showWarningMessage(
      "This changes identifiers that scope stored data — GREENFIELD ONLY",
      {
        modal: true,
        detail:
          `${reasons.join("\n")}\n\nVS Code keys all stored connectors, projects, settings, and saved credentials to these identifiers. Any machine that already has this extension will start EMPTY after upgrading — old data is stranded, not deleted. Only continue for a brand-new deployment.`,
      },
      "I understand — continue",
    );
    if (ok !== "I understand — continue") return;
  }

  // --- confirm --------------------------------------------------------------
  const summary = [
    ...summarizeBrand(before, after),
    currentHandle !== deep.handle ? `Chat handle: @${currentHandle} → @${deep.handle}` : "",
    renameIdentifiers ? `Internal namespace: aiSharePoint.* → ${deep.idNamespace}.*` : "Internal identifiers: unchanged",
    release.expiresAt
      ? `Build expiry: ${release.expiresAt.slice(0, 10)} (${release.validityDays} days — users must upgrade after this)`
      : "Build expiry: none (this build never expires)",
    hasProvisioning
      ? `Bake-in: ${[
          provisioningManifest.connectors?.length ? `${provisioningManifest.connectors.length} connector(s)` : "",
          provisioningManifest.projects?.length ? `${provisioningManifest.projects.length} project(s)` : "",
          provisioningManifest.settings ? `${Object.keys(provisioningManifest.settings).length} setting(s)` : "",
          provisioningManifest.help ? "custom help" : "",
        ]
          .filter(Boolean)
          .join(", ")}`
      : "Bake-in: none",
  ].filter(Boolean);
  const apply = await vscode.window.showInformationMessage(
    "Apply this rebrand across the source tree?",
    { modal: true, detail: summary.join("\n") },
    "Apply",
  );
  if (apply !== "Apply") return;

  // --- apply ----------------------------------------------------------------
  const tokens = buildBrandTokens(deep);
  const written: string[] = [];
  const skipped: string[] = [];

  // package.json: brand tokens, then identity fields, then participant name/fullName.
  try {
    let text = applyBrandTokens(pkgRaw, tokens);
    text = rebrandPackageJson(text, after);
    text = text.split('"name": "sharepoint"').join(`"name": ${JSON.stringify(deep.handle)}`);
    text = text.split('"fullName": "SharePoint"').join(`"fullName": ${JSON.stringify(after.displayName)}`);
    text = setReleaseManifest(text, release);
    text = setProvisioningManifest(text, hasProvisioning ? provisioningManifest : undefined);
    await writeText(pkgUri, text);
    written.push("package.json");
  } catch (e) {
    log.error("rebrand: package.json", e);
    void vscode.window.showErrorMessage(`Could not update package.json: ${msg(e)}. No files were changed.`);
    return;
  }

  // Whole-tree brand-token rewrite (src, docs, README, etc.).
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Rebranding source files…" },
    async () => {
      const result = await rewriteTree(root, tokens, log);
      written.push(`${result.changed} source file(s)`);
      if (result.errors > 0) skipped.push(`${result.errors} file(s) unreadable`);
    },
  );

  // LICENSE: brand tokens (renames "AI SharePoint contributors"), then explicit holder.
  await editFile(
    root,
    "LICENSE",
    (t) => {
      let r = applyBrandTokens(t, tokens);
      if (after.licenseHolder) r = rebrandLicense(r, after.licenseHolder);
      return r;
    },
    written,
    skipped,
    log,
  );

  // Distributor contact placeholders.
  if (after.supportContact || after.securityContact) {
    await editFile(
      root,
      "SUPPORT.md",
      (t) => replacePhrase(replacePhrase(t, SUPPORT_PHRASE, after.supportContact).text, SECURITY_PHRASE, after.securityContact).text,
      written,
      skipped,
      log,
    );
  }
  if (after.securityContact) {
    await editFile(root, "docs/SECURITY.md", (t) => replacePhrase(t, SECURITY_PHRASE, after.securityContact).text, written, skipped, log);
  }

  // Optional icon swap.
  const icon = await vscode.window.showOpenDialog({
    title: "Select a new icon PNG (Cancel to keep the current icon)",
    canSelectMany: false,
    filters: { Images: ["png"] },
  });
  if (icon && icon[0]) {
    try {
      const bytes = await vscode.workspace.fs.readFile(icon[0]);
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root, "media", "icon.png"), bytes);
      written.push("media/icon.png");
    } catch (e) {
      log.error("rebrand: icon", e);
      skipped.push("media/icon.png (copy failed)");
    }
  }

  log.info(`Rebranded to "${after.displayName}" (${extensionId(after.publisher, after.name)})${renameIdentifiers ? `, namespace ${deep.idNamespace}` : ""}`);

  // Offer to save a reusable release profile (no secrets) for the next refresh.
  await saveProfileMaybe(
    root,
    {
      version: 1,
      identity: {
        publisher: after.publisher,
        name: after.name,
        displayName: after.displayName,
        handle: deep.handle,
        description: after.description,
        ...(after.licenseHolder ? { licenseHolder: after.licenseHolder } : {}),
        ...(after.supportContact ? { supportContact: after.supportContact } : {}),
        ...(after.securityContact ? { securityContact: after.securityContact } : {}),
        renameIdentifiers,
      },
      ...(days > 0 ? { expiry: { validityDays: days, ...(upgradeUrl ? { upgradeUrl } : {}) } } : {}),
      ...(hasProvisioning ? { provisioning } : {}),
    },
    log,
  );

  // --- finish ---------------------------------------------------------------
  const detail = [
    `Updated: ${written.join(", ")}.`,
    skipped.length ? `Skipped: ${skipped.join(", ")}.` : "",
    "",
    renameIdentifiers
      ? "Internal identifiers were renamed — run the unit tests (they reference the old names) and recompile before shipping."
      : "Recompile to bake the new product name into the bundle.",
    "",
    `"Repackage now" installs dependencies and builds the package in a terminal, printing each step. The result is ${after.name}-<version>.vsix in the source folder (${root.fsPath}) — the exact path is shown when it finishes.`,
  ]
    .filter(Boolean)
    .join("\n");
  const next = await vscode.window.showInformationMessage(
    `Rebrand applied: "${after.displayName}".`,
    { modal: true, detail },
    "Repackage now",
    "Open REBRANDING.md",
  );
  if (next === "Repackage now") {
    const term = vscode.window.createTerminal({ name: "Rebrand & package", cwd: root });
    term.show();
    term.sendText(await resolveRepackageCommand(root));
  } else if (next === "Open REBRANDING.md") {
    try {
      await vscode.window.showTextDocument(vscode.Uri.joinPath(root, "REBRANDING.md"));
    } catch {
      /* doc may be absent in older copies */
    }
  }
}

/**
 * The terminal command for the "Repackage now" step. Prefers the logged,
 * cross-platform build driver (scripts/rebrand-package.js) — it prints each step,
 * streams output so a slow install or a failure is never a silent hang, and
 * reports the exact output `.vsix` path. Invoked as a single token, so no shell
 * chaining operator is involved (Windows PowerShell 5.1 rejects `&&`). Falls back
 * to the shell-aware inline command if the driver isn't present in the source
 * tree (e.g. an older or partial copy).
 */
async function resolveRepackageCommand(root: vscode.Uri): Promise<string> {
  const driver = vscode.Uri.joinPath(root, "scripts", "rebrand-package.js");
  try {
    await vscode.workspace.fs.stat(driver);
    return "node scripts/rebrand-package.js";
  } catch {
    return repackageCommand(vscode.env.shell);
  }
}

// --- tree rewrite ----------------------------------------------------------

async function rewriteTree(
  root: vscode.Uri,
  tokens: BrandToken[],
  log: Logger,
): Promise<{ changed: number; scanned: number; errors: number }> {
  let changed = 0;
  let scanned = 0;
  let errors = 0;

  async function walk(dir: vscode.Uri): Promise<void> {
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(dir);
    } catch (e) {
      errors++;
      log.error("rebrand: readdir", e);
      return;
    }
    for (const [n, type] of entries) {
      if (type === vscode.FileType.Directory) {
        if (SKIP_DIRS.has(n)) continue;
        if (dir.path.endsWith("/src") && n === "branding") continue; // engine self-protection
        await walk(vscode.Uri.joinPath(dir, n));
        continue;
      }
      if (n === "package.json" || n === "package-lock.json") continue; // package.json handled explicitly
      const ext = n.slice(n.lastIndexOf("."));
      if (!REWRITE_EXTS.has(ext)) continue;
      const uri = vscode.Uri.joinPath(dir, n);
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > MAX_FILE_BYTES) continue;
        scanned++;
        const text = await readText(uri);
        const out = applyBrandTokens(text, tokens);
        if (out !== text) {
          await writeText(uri, out);
          changed++;
        }
      } catch (e) {
        errors++;
        log.error(`rebrand: ${n}`, e);
      }
    }
  }

  await walk(root);
  return { changed, scanned, errors };
}

// --- helpers ---------------------------------------------------------------

async function resolveSourceRoot(): Promise<vscode.Uri | undefined> {
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (await looksLikeSource(folder.uri)) {
      const use = await vscode.window.showInformationMessage(
        "Use the extension source in this workspace folder?",
        { modal: true, detail: folder.uri.fsPath },
        "Use this folder",
        "Pick another…",
      );
      if (use === "Use this folder") return folder.uri;
      if (use === undefined) return undefined;
      break;
    }
  }
  const picked = await vscode.window.showOpenDialog({
    title: "Select the extension source folder (containing package.json)",
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
  });
  if (!picked || !picked[0]) return undefined;
  if (await looksLikeSource(picked[0], true)) return picked[0];
  void vscode.window.showErrorMessage("That folder isn't the extension source (no package.json with contributes). Pick the source root.");
  return undefined;
}

/** Identify the extension source structurally (no hardcoded brand name, so it
 *  survives a prior rename): a package.json with `contributes`, alongside the
 *  rebranding guide or a chat-participant contribution. */
async function looksLikeSource(dir: vscode.Uri, lenient = false): Promise<boolean> {
  try {
    const json = JSON.parse(await readText(vscode.Uri.joinPath(dir, "package.json")));
    if (!json?.contributes) return false;
    if (lenient) return true;
    try {
      await vscode.workspace.fs.stat(vscode.Uri.joinPath(dir, "REBRANDING.md"));
      return true;
    } catch {
      return !!json.contributes.chatParticipants;
    }
  } catch {
    return false;
  }
}

async function ask(
  prompt: string,
  value: string,
  validate?: (v: string) => string | undefined,
  allowEmpty = false,
): Promise<string | undefined> {
  return vscode.window.showInputBox({
    prompt,
    value,
    ignoreFocusOut: true,
    validateInput: (v) => {
      const t = v.trim();
      if (!t) return allowEmpty ? undefined : "Required.";
      return validate?.(t);
    },
  });
}

async function readText(uri: vscode.Uri): Promise<string> {
  return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
}

async function writeText(uri: vscode.Uri, text: string): Promise<void> {
  await vscode.workspace.fs.writeFile(uri, Buffer.from(text, "utf8"));
}

/** A two-option Yes/No quick pick; the default is listed first. Returns
 *  undefined if dismissed (so the caller can abort the wizard). */
async function yesNo(title: string, detail: string, def = false): Promise<boolean | undefined> {
  const order = def ? ["Yes", "No"] : ["No", "Yes"];
  const pick = await vscode.window.showQuickPick(
    order.map((label) => ({ label })),
    { ignoreFocusOut: true, title, placeHolder: detail },
  );
  if (!pick) return undefined;
  return pick.label === "Yes";
}

/** Load whitelabel.profile.json (if present) and ask whether to reuse it, so a
 *  refreshed release is a quick, repeatable pass over pre-filled prompts. */
async function maybeLoadProfile(root: vscode.Uri): Promise<ReleaseProfile | undefined> {
  let raw: string;
  try {
    raw = await readText(vscode.Uri.joinPath(root, "whitelabel.profile.json"));
  } catch {
    return undefined; // none saved yet — first run
  }
  let profile: ReleaseProfile;
  try {
    profile = parseReleaseProfile(raw);
  } catch (e) {
    void vscode.window.showWarningMessage(`Ignoring whitelabel.profile.json — ${msg(e)}`);
    return undefined;
  }
  const use = await vscode.window.showInformationMessage(
    `Reuse the saved release profile for "${profile.identity.displayName}"?`,
    {
      modal: true,
      detail:
        "Found whitelabel.profile.json. Reusing it pre-fills every prompt — identity, expiry, and what to bake in — so refreshing this release is quick. Choose Start fresh to ignore it.",
    },
    "Reuse profile",
    "Start fresh",
  );
  return use === "Reuse profile" ? profile : undefined;
}

/** Offer to persist the gathered choices as a reusable, secret-free profile. */
async function saveProfileMaybe(root: vscode.Uri, profile: ReleaseProfile, log: Logger): Promise<void> {
  const save = await vscode.window.showInformationMessage(
    "Save these choices as a reusable release profile?",
    {
      modal: true,
      detail:
        "Writes whitelabel.profile.json to the source folder (no secrets). Next time, the wizard offers to reuse it so refreshing this release is one quick, repeatable step. Commit it alongside the source so your release team shares it.",
    },
    "Save profile",
    "Skip",
  );
  if (save !== "Save profile") return;
  try {
    await writeText(vscode.Uri.joinPath(root, "whitelabel.profile.json"), serializeReleaseProfile(profile));
  } catch (e) {
    log.error("rebrand: save profile", e);
    void vscode.window.showWarningMessage(`Could not save the release profile: ${msg(e)}`);
  }
}

/** Step the user through WHAT to bake into the build: telemetry endpoints,
 *  pre-defined connectors, project/memory defaults, and custom help. Returns the
 *  provisioning content, or undefined if the user cancelled. Seeded from a
 *  loaded profile's provisioning when present. */
async function gatherProvisioning(
  deps: RebrandDeps,
  seed: ProvisioningContent | undefined,
): Promise<ProvisioningContent | undefined> {
  const content: ProvisioningContent = {};

  // 1) Telemetry endpoints (endpoints only — never a token/secret in the VSIX).
  const seedHasTelemetry = Boolean(seed?.settings && Object.keys(seed.settings).some((k) => k.startsWith("telemetry.")));
  const wantTelemetry = await yesNo(
    "Bake in anonymized telemetry (Splunk HEC / OTEL) defaults?",
    "Endpoints only — the Splunk token / OTLP auth header is set per deployment, never embedded in the VSIX.",
    seedHasTelemetry,
  );
  if (wantTelemetry === undefined) return undefined;
  if (wantTelemetry) {
    const splunk = await ask("Splunk HEC URL (blank to skip)", String(seed?.settings?.["telemetry.splunkHec.url"] ?? ""), undefined, true);
    if (splunk === undefined) return undefined;
    const otlp = await ask("OTEL OTLP/HTTP endpoint (blank to skip)", String(seed?.settings?.["telemetry.otlp.endpoint"] ?? ""), undefined, true);
    if (otlp === undefined) return undefined;
    const settings = telemetrySettings({ enabled: Boolean(splunk.trim() || otlp.trim()), splunkHecUrl: splunk, otlpEndpoint: otlp });
    if (Object.keys(settings).length) content.settings = settings;
  } else if (seed?.settings) {
    content.settings = seed.settings;
  }

  // 2) Pre-defined connectors — a snapshot of the current reference sources.
  const conns = deps.currentConnectors ?? [];
  if (conns.length) {
    const bake = await yesNo(
      `Bake in your ${conns.length} current reference source(s) as pre-defined connectors?`,
      "Non-secret settings only (type, URL, alias); each user supplies their own credentials on first use.",
      Boolean(seed?.connectors?.length),
    );
    if (bake === undefined) return undefined;
    if (bake) content.connectors = conns;
  } else if (seed?.connectors?.length) {
    content.connectors = seed.connectors;
  }

  // 3) Pre-defined projects / memory defaults.
  const projs = deps.currentProjects ?? [];
  if (projs.length) {
    const bake = await yesNo(
      `Bake in your ${projs.length} project(s) as memory defaults?`,
      "Goals, instructions, and saved AI context become defaults seeded on first run (users can still edit them).",
      Boolean(seed?.projects?.length),
    );
    if (bake === undefined) return undefined;
    if (bake) content.projects = projs;
  } else if (seed?.projects?.length) {
    content.projects = seed.projects;
  }

  // 4) Custom help content for the target environment.
  const help: ProvisionedHelp = {};
  const guidePick = await vscode.window.showOpenDialog({
    title: "Custom User Guide markdown to bake in (Cancel to skip)",
    canSelectMany: false,
    filters: { Markdown: ["md", "markdown"] },
  });
  if (guidePick && guidePick[0]) {
    try {
      help.userGuide = await readText(guidePick[0]);
    } catch (e) {
      void vscode.window.showWarningMessage(`Could not read the help markdown: ${msg(e)}`);
    }
  } else if (seed?.help?.userGuide) {
    help.userGuide = seed.help.userGuide;
  }
  const welcome = await ask("First-run welcome note shown to users (optional)", seed?.help?.welcome ?? "", undefined, true);
  if (welcome === undefined) return undefined;
  if (welcome.trim()) help.welcome = welcome.trim();
  if (help.userGuide || help.welcome) content.help = help;

  return content;
}

async function editFile(
  root: vscode.Uri,
  rel: string,
  transform: (text: string) => string,
  written: string[],
  skipped: string[],
  log: Logger,
): Promise<void> {
  const uri = vscode.Uri.joinPath(root, ...rel.split("/"));
  try {
    const before = await readText(uri);
    const after = transform(before);
    if (after === before) {
      skipped.push(`${rel} (no change)`);
      return;
    }
    await writeText(uri, after);
    written.push(rel);
  } catch (e) {
    log.error(`rebrand: ${rel}`, e);
    skipped.push(`${rel} (${msg(e)})`);
  }
}
