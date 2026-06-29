import * as vscode from "vscode";
import { Logger } from "../core/log";
import { redactError } from "../core/redaction";
import {
  BrandConfig,
  validateBrandConfig,
  summarizeBrand,
  identityChanged,
  extensionId,
} from "./rebrand";
import { rebrandVsix, readVsixPackageJson } from "./rebrandVsix";
import { computeExpiry, ReleaseManifest } from "./releaseExpiry";
import {
  ReleaseProfile,
  ProvisioningContent,
  ProvisionedConnector,
  ProvisionedProject,
  ProvisionedHelp,
  ProvisionedTelemetry,
  parseReleaseProfile,
  serializeReleaseProfile,
  stripProfileSecrets,
  buildProvisioningManifest,
} from "./releaseProfile";
import { obfuscateSecret } from "../diagnostics/secretObfuscation";

/** Optional runtime snapshots the wizard can offer to BAKE into the build:
 *  the user's current reference sources (as non-secret connector descriptors)
 *  and projects (as memory defaults). Supplied by the extension. */
export interface RebrandDeps {
  currentConnectors?: ProvisionedConnector[];
  currentProjects?: ProvisionedProject[];
}
import {
  DeepBrandConfig,
  buildBrandTokens,
  validateDeepBrand,
  camelize,
} from "./brandTokens";

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const HANDLE_RE = /^[a-z0-9][a-z0-9-]*$/;
const msg = (e: unknown) => redactError(e).message;

/**
 * "Rebrand This Extension" (Support & Diagnostics). Applies a new identity AND,
 * optionally, a full product rename (display name, chat handle, and — greenfield
 * only — the internal identifier namespaces) directly to a packaged .vsix: pick
 * the built .vsix, get a rebranded .vsix back. No source tree and no build step —
 * the bundle, manifest, package.json, and assets are transformed in place. The
 * executable counterpart to REBRANDING.md.
 */
export async function runRebrandFlow(log: Logger, deps: RebrandDeps = {}): Promise<void> {
  const start = await vscode.window.showInformationMessage(
    "Rebrand (white-label) this extension",
    {
      modal: true,
      detail:
        "Applies a new identity and (optionally) a full product rename — display name, chat handle, even the internal identifiers — directly to a packaged .vsix. Pick the built .vsix and you get a rebranded .vsix back: no source folder and no build step.",
    },
    "Continue",
  );
  if (start !== "Continue") return;

  const vsixUri = await pickVsix();
  if (!vsixUri) return;

  let vsixBytes: Uint8Array;
  let pkg: {
    publisher?: string;
    name?: string;
    displayName?: string;
    description?: string;
    version?: string;
    release?: { channel?: string; productName?: string };
    contributes?: { chatParticipants?: Array<{ name?: string }> };
  };
  try {
    vsixBytes = await vscode.workspace.fs.readFile(vsixUri);
    pkg = readVsixPackageJson(vsixBytes) as typeof pkg;
  } catch (e) {
    void vscode.window.showErrorMessage(`Could not read that .vsix: ${msg(e)}`);
    return;
  }

  // Always rebrand FROM the original standard build. The transform finds the
  // original brand tokens ("AI SharePoint" / "@sharepoint" / "aiSharePoint") —
  // once a VSIX is already white-labeled those tokens are gone, so re-branding
  // it would only half-apply (the classic "restart with new names didn't update
  // everything" trap). Because this flow never mutates the input and writes a
  // NEW file, starting again from the standard VSIX always yields a complete,
  // consistent rebrand — so steer the user back to it.
  if (pkg.release?.channel === "whitelabel") {
    const proceed = await vscode.window.showWarningMessage(
      `This .vsix is already a white-label build${pkg.release.productName ? ` ("${pkg.release.productName}")` : ""}.`,
      {
        modal: true,
        detail:
          "Re-branding an already-branded VSIX can't fully rename strings that were already changed, so the result may mix identities. For a clean rebrand to NEW identifiers, start again from the ORIGINAL standard .vsix (this flow never modifies the file you pick).",
      },
      "Pick a different .vsix",
      "Rebrand it anyway",
    );
    if (proceed !== "Rebrand it anyway") return;
  }

  const before: BrandConfig = {
    publisher: pkg.publisher ?? "",
    name: pkg.name ?? "",
    displayName: pkg.displayName ?? "",
    description: pkg.description ?? "",
  };
  const currentHandle = pkg.contributes?.chatParticipants?.[0]?.name ?? "sharepoint";

  // A saved release profile (repeatable re-releases) lives next to the VSIX —
  // reusing it pre-fills every prompt so refreshing a release is quick.
  const profileDir = vscode.Uri.joinPath(vsixUri, "..");
  const loaded = await maybeLoadProfile(profileDir);
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

  // --- apply: transform the chosen VSIX in place ----------------------------
  const tokens = buildBrandTokens(deep);

  // Optional icon swap (replaces extension/media/icon.png inside the VSIX).
  let newIcon: Uint8Array | undefined;
  const icon = await vscode.window.showOpenDialog({
    title: "Select a new icon PNG (Cancel to keep the current icon)",
    canSelectMany: false,
    filters: { Images: ["png"] },
  });
  if (icon && icon[0]) {
    try {
      newIcon = await vscode.workspace.fs.readFile(icon[0]);
    } catch (e) {
      log.error("rebrand: icon", e);
      void vscode.window.showWarningMessage(`Could not read that icon: ${msg(e)}. Keeping the current icon.`);
    }
  }

  // Where to write the rebranded VSIX — default next to the input.
  const version = typeof pkg.version === "string" ? pkg.version : "0.0.0";
  const outUri = await vscode.window.showSaveDialog({
    title: "Save the rebranded VSIX",
    defaultUri: vscode.Uri.joinPath(profileDir, `${after.name}-${version}.vsix`),
    filters: { "VS Code Extension": ["vsix"] },
  });
  if (!outUri) return;

  try {
    const outBytes = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Rebranding to "${after.displayName}"…` },
      () =>
        Promise.resolve(
          rebrandVsix(vsixBytes, {
            tokens,
            after,
            handle: deep.handle,
            release,
            ...(hasProvisioning ? { provisioning: provisioningManifest } : {}),
            ...(newIcon ? { newIcon } : {}),
          }),
        ),
    );
    await vscode.workspace.fs.writeFile(outUri, outBytes);
  } catch (e) {
    log.error("rebrand: vsix", e);
    void vscode.window.showErrorMessage(`Could not produce the rebranded VSIX: ${msg(e)}. The original .vsix was not modified.`);
    return;
  }

  log.info(
    `Rebranded VSIX written: ${outUri.fsPath} ("${after.displayName}", ${extensionId(after.publisher, after.name)})${renameIdentifiers ? `, namespace ${deep.idNamespace}` : ""}`,
  );

  // Offer to save a reusable release profile (no secrets) next to the VSIX.
  await saveProfileMaybe(
    profileDir,
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
      ...(hasProvisioning ? { provisioning: stripProfileSecrets(provisioning) } : {}),
    },
    log,
  );

  // --- finish ---------------------------------------------------------------
  const detail = [
    `Wrote ${outUri.fsPath}.`,
    release.expiresAt
      ? `This build expires ${release.expiresAt.slice(0, 10)} (${release.validityDays} days — users must upgrade after that).`
      : "This build never expires.",
    renameIdentifiers
      ? "Internal identifiers were renamed — this is a distinct extension ID, so existing installs of the original keep their own data."
      : "",
    "",
    `Install it with:  code --install-extension "${outUri.fsPath}"`,
  ]
    .filter(Boolean)
    .join("\n");
  await vscode.window.showInformationMessage(`Rebrand complete: "${after.displayName}".`, { modal: true, detail }, "OK");
}

/** Pick the .vsix to rebrand (the built standard package). */
async function pickVsix(): Promise<vscode.Uri | undefined> {
  const picked = await vscode.window.showOpenDialog({
    title: "Select the .vsix to rebrand",
    canSelectMany: false,
    filters: { "VS Code Extension": ["vsix"] },
  });
  return picked?.[0];
}

// --- helpers ---------------------------------------------------------------

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

/** Prompt for a secret (masked input). Returns "" if left blank, undefined if cancelled. */
async function askSecret(prompt: string): Promise<string | undefined> {
  return vscode.window.showInputBox({ prompt, password: true, ignoreFocusOut: true });
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

  // 1) Telemetry (Splunk HEC / OTEL). Endpoints + the enabled flag bake plaintext;
  //    any token entered here is OBFUSCATED into the build and de-obfuscated into
  //    the OS keychain on first run. The committed profile keeps endpoints only.
  const seedTel = seed?.telemetry;
  const wantTelemetry = await yesNo(
    "Pre-configure anonymized telemetry (Splunk HEC / OTEL)?",
    "Endpoints bake in plaintext; any token you enter is obfuscated in the VSIX and moved to the keychain on first run.",
    Boolean(seedTel?.enabled || seedTel?.splunkHecUrl || seedTel?.otlpEndpoint),
  );
  if (wantTelemetry === undefined) return undefined;
  if (wantTelemetry) {
    const tel: ProvisionedTelemetry = { enabled: true };
    const splunkUrl = await ask("Splunk HEC URL (blank to skip Splunk)", seedTel?.splunkHecUrl ?? "", undefined, true);
    if (splunkUrl === undefined) return undefined;
    if (splunkUrl.trim()) {
      tel.splunkHecUrl = splunkUrl.trim();
      const token = await askSecret("Splunk HEC token to bake in (write-only — obfuscated in the build; blank to skip)");
      if (token === undefined) return undefined;
      if (token.trim()) tel.splunkHecTokenObfuscated = obfuscateSecret(token.trim());
    }
    const otlpEndpoint = await ask("OTEL OTLP/HTTP endpoint (blank to skip OTEL)", seedTel?.otlpEndpoint ?? "", undefined, true);
    if (otlpEndpoint === undefined) return undefined;
    if (otlpEndpoint.trim()) {
      tel.otlpEndpoint = otlpEndpoint.trim();
      const hName = await ask("OTLP auth header name (optional, e.g. X-Api-Key)", seedTel?.otlpHeaderName ?? "", undefined, true);
      if (hName === undefined) return undefined;
      if (hName.trim()) {
        tel.otlpHeaderName = hName.trim();
        const hVal = await askSecret(`OTLP auth header value for "${hName.trim()}" (write-only — obfuscated; blank to skip)`);
        if (hVal === undefined) return undefined;
        if (hVal.trim()) tel.otlpHeaderValueObfuscated = obfuscateSecret(hVal.trim());
      }
    }
    if (tel.splunkHecUrl || tel.otlpEndpoint) content.telemetry = tel;
  } else if (seedTel) {
    content.telemetry = seedTel; // keep endpoints from the profile (it carries no tokens)
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
