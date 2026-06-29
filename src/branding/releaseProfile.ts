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

/** The bake-in payload, minus the per-build id (which is stamped at apply). */
export interface ProvisioningContent {
  /** aiSharePoint.* setting defaults (e.g. telemetry endpoints, usability). */
  settings?: Record<string, unknown>;
  connectors?: ProvisionedConnector[];
  projects?: ProvisionedProject[];
  help?: ProvisionedHelp;
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

/** Map the wizard's telemetry choices to aiSharePoint.telemetry.* setting defaults
 *  (endpoints only — never a token/secret, which must not ship in a VSIX). */
export function telemetrySettings(t: {
  enabled?: boolean;
  splunkHecUrl?: string;
  otlpEndpoint?: string;
  otlpHeaders?: Record<string, string>;
}): Record<string, unknown> {
  const s: Record<string, unknown> = {};
  if (t.enabled) s["telemetry.enabled"] = true;
  if (t.splunkHecUrl?.trim()) s["telemetry.splunkHec.url"] = t.splunkHecUrl.trim();
  if (t.otlpEndpoint?.trim()) s["telemetry.otlp.endpoint"] = t.otlpEndpoint.trim();
  if (t.otlpHeaders && Object.keys(t.otlpHeaders).length) s["telemetry.otlp.headers"] = t.otlpHeaders;
  return s;
}

/** Stamp a provisioning manifest from profile content + a per-build id. Omits
 *  empty sections so the baked block stays minimal. */
export function buildProvisioningManifest(content: ProvisioningContent, id: string): ProvisioningManifest {
  const m: ProvisioningManifest = { id };
  if (content.settings && Object.keys(content.settings).length) m.settings = content.settings;
  if (content.connectors && content.connectors.length) m.connectors = content.connectors;
  if (content.projects && content.projects.length) m.projects = content.projects;
  if (content.help && (content.help.userGuide || content.help.welcome)) m.help = content.help;
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
  };
}
