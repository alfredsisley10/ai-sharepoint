/**
 * White-label release profile + provisioning manifest (pure).
 *
 * A **release profile** is a non-secret JSON file (whitelabel.profile.json) the
 * release team saves and re-loads so producing a refreshed whitelabeled VSIX is
 * one repeatable step instead of re-answering the whole wizard. It captures the
 * identity, expiry policy, and everything to bake into the build.
 *
 * A **provisioning manifest** is the subset baked into the rebranded
 * package.json (`provisioning`); on first run the extension seeds it —
 * pre-defined connectors (no secrets), default projects/memory, default
 * settings (e.g. telemetry endpoints), and custom help — without ever
 * clobbering anything the user already has.
 *
 * Everything here is pure and unit-tested; the runtime seeding lives in
 * provisioning.ts and the VS Code wizard in rebrandFlow.ts.
 */

import { isObfuscatedSecret } from "../diagnostics/secretObfuscation";

/** A pre-defined reference source — NON-SECRET descriptor only. The user
 *  supplies credentials on first use (the connector seeds as "not verified"). */
export interface ProvisionedConnector {
  type: string;
  displayName: string;
  alias?: string;
  description?: string;
  baseUrl: string;
  deployment?: "cloud" | "datacenter";
  /** Hint for the credential prompt; never a secret. */
  authMethod?: string;
}

/** A pre-defined project / memory default. */
export interface ProvisionedProject {
  name: string;
  description?: string;
  goals?: string;
  instructions?: string;
  aiContext?: string;
}

/** Custom in-product help content for the target environment. */
export interface ProvisionedHelp {
  /** Markdown shown by "Open User Guide" (replaces the bundled guide). */
  userGuide?: string;
  /** Short welcome/notes markdown surfaced on first run. */
  welcome?: string;
}

/**
 * Telemetry connection baked into a whitelabel build. Endpoints are plaintext
 * (not secret); tokens are OBFUSCATED (secretObfuscation.ts) so they never
 * appear readable in package.json. On first run the extension de-obfuscates them
 * into the OS keychain. The committed release profile stores only the
 * non-secret fields (see stripProfileSecrets).
 */
export interface ProvisionedTelemetry {
  enabled?: boolean;
  splunkHecUrl?: string;
  /** Obfuscated Splunk Attribution Identifier blob (the Splunk HEC token). */
  splunkHecTokenObfuscated?: string;
  otlpEndpoint?: string;
  otlpHeaderName?: string;
  /** Obfuscated OTLP auth-header value blob. */
  otlpHeaderValueObfuscated?: string;
}

/** The bake-in payload, minus the per-build id (which is stamped at apply). */
export interface ProvisioningContent {
  /** aiSharePoint.* usability setting defaults (non-secret). */
  settings?: Record<string, unknown>;
  connectors?: ProvisionedConnector[];
  projects?: ProvisionedProject[];
  help?: ProvisionedHelp;
  telemetry?: ProvisionedTelemetry;
}

/** What's baked into package.json; `id` makes first-run seeding idempotent. */
export interface ProvisioningManifest extends ProvisioningContent {
  id: string;
}

export interface ReleaseProfileIdentity {
  publisher: string;
  name: string;
  displayName: string;
  handle: string;
  description: string;
  licenseHolder?: string;
  supportContact?: string;
  securityContact?: string;
  /** Relative path (within the source tree) to a PNG icon. */
  iconPath?: string;
  renameIdentifiers?: boolean;
}

export interface ReleaseProfile {
  version: 1;
  identity: ReleaseProfileIdentity;
  expiry?: { validityDays?: number; upgradeUrl?: string };
  provisioning?: ProvisioningContent;
}

/** Parse + validate a release profile. Throws with a clear message on bad data. */
export function parseReleaseProfile(json: string): ReleaseProfile {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("Release profile is not valid JSON.");
  }
  const p = raw as Partial<ReleaseProfile>;
  if (!p || typeof p !== "object" || !p.identity) {
    throw new Error("Release profile is missing the 'identity' section.");
  }
  const id = p.identity;
  for (const f of ["publisher", "name", "displayName", "handle", "description"] as const) {
    if (!id[f] || typeof id[f] !== "string") {
      throw new Error(`Release profile identity is missing '${f}'.`);
    }
  }
  return { version: 1, identity: id, expiry: p.expiry, provisioning: p.provisioning };
}

export function serializeReleaseProfile(profile: ReleaseProfile): string {
  return `${JSON.stringify({ ...profile, version: 1 }, null, 2)}\n`;
}

/** Strip baked secrets (obfuscated tokens) from provisioning content before it
 *  is written to the COMMITTED release profile — endpoints/flags stay, the
 *  obfuscated token blobs never land in the repo. */
export function stripProfileSecrets(content: ProvisioningContent): ProvisioningContent {
  if (!content.telemetry) return content;
  const t = content.telemetry;
  return {
    ...content,
    telemetry: {
      ...(t.enabled !== undefined ? { enabled: t.enabled } : {}),
      ...(t.splunkHecUrl ? { splunkHecUrl: t.splunkHecUrl } : {}),
      ...(t.otlpEndpoint ? { otlpEndpoint: t.otlpEndpoint } : {}),
      ...(t.otlpHeaderName ? { otlpHeaderName: t.otlpHeaderName } : {}),
    },
  };
}

/**
 * Defense in depth: a telemetry section baked into a white-label package may
 * carry ONLY obfuscated secret blobs — never a plaintext Splunk Attribution
 * Identifier (HEC token) or OTLP auth value. Throws if a `*Obfuscated` field
 * isn't actually obfuscated, or if a plaintext-named secret field slipped in.
 * Called by `buildProvisioningManifest`, so the bake fails loudly rather than
 * shipping a readable credential in package.json.
 */
export function assertTelemetrySecretsObfuscated(t: ProvisionedTelemetry): void {
  const obfuscatedFields: Array<keyof ProvisionedTelemetry> = ["splunkHecTokenObfuscated", "otlpHeaderValueObfuscated"];
  for (const f of obfuscatedFields) {
    const v = t[f];
    if (v !== undefined && !isObfuscatedSecret(v)) {
      throw new Error(`Refusing to bake telemetry: '${f}' is present but not obfuscated. Baked secrets must be obfuscated (secretObfuscation.ts).`);
    }
  }
  // Any field whose name reads like a plaintext secret (token/secret/password/
  // key/auth header value) — but isn't an *Obfuscated blob — must not be baked.
  const stray = Object.keys(t).filter(
    (k) => /(token|secret|password|headervalue)$/i.test(k) && !/obfuscated$/i.test(k),
  );
  if (stray.length) {
    throw new Error(`Refusing to bake telemetry: plaintext secret field(s) present (${stray.join(", ")}). Only obfuscated blobs (and non-secret endpoints/flags) may be baked.`);
  }
}

/** Stamp a provisioning manifest from profile content + a per-build id. Omits
 *  empty sections so the baked block stays minimal. */
export function buildProvisioningManifest(content: ProvisioningContent, id: string): ProvisioningManifest {
  const m: ProvisioningManifest = { id };
  if (content.settings && Object.keys(content.settings).length) m.settings = content.settings;
  if (content.connectors && content.connectors.length) m.connectors = content.connectors;
  if (content.projects && content.projects.length) m.projects = content.projects;
  if (content.help && (content.help.userGuide || content.help.welcome)) m.help = content.help;
  if (content.telemetry && (content.telemetry.enabled || content.telemetry.splunkHecUrl || content.telemetry.otlpEndpoint)) {
    // Guard: never bake a readable secret — only obfuscated blobs + endpoints.
    assertTelemetrySecretsObfuscated(content.telemetry);
    m.telemetry = content.telemetry;
  }
  return m;
}

export interface ProvisioningState {
  /** The id last seeded on this install (from globalState). */
  appliedId?: string;
  /** Connector identity keys already present (lowercased alias or baseUrl). */
  existingConnectorKeys: Set<string>;
  /** Project names already present (lowercased). */
  existingProjectNames: Set<string>;
  /** Setting keys the user has explicitly set (skip those). */
  userSetSettingKeys: Set<string>;
}

export interface ProvisioningPlan {
  alreadyApplied: boolean;
  connectors: ProvisionedConnector[];
  projects: ProvisionedProject[];
  settings: Record<string, unknown>;
  help?: ProvisionedHelp;
  telemetry?: ProvisionedTelemetry;
}

export function connectorKey(c: { alias?: string; baseUrl: string }): string {
  return (c.alias?.trim() || c.baseUrl).toLowerCase();
}

/**
 * Decide what to seed — idempotent and non-destructive. Returns an empty plan if
 * this manifest id was already applied; otherwise only connectors/projects not
 * already present and settings the user hasn't set. Help is included on first
 * apply. Pure.
 */
export function planProvisioning(
  manifest: ProvisioningManifest | undefined,
  state: ProvisioningState,
): ProvisioningPlan {
  const empty: ProvisioningPlan = { alreadyApplied: true, connectors: [], projects: [], settings: {} };
  if (!manifest || (state.appliedId && state.appliedId === manifest.id)) return empty;

  const connectors = (manifest.connectors ?? []).filter(
    (c) => !state.existingConnectorKeys.has(connectorKey(c)),
  );
  const projects = (manifest.projects ?? []).filter(
    (p) => !state.existingProjectNames.has(p.name.trim().toLowerCase()),
  );
  const settings: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(manifest.settings ?? {})) {
    if (!state.userSetSettingKeys.has(k)) settings[k] = v;
  }
  return {
    alreadyApplied: false,
    connectors,
    projects,
    settings,
    ...(manifest.help && (manifest.help.userGuide || manifest.help.welcome) ? { help: manifest.help } : {}),
    ...(manifest.telemetry ? { telemetry: manifest.telemetry } : {}),
  };
}
