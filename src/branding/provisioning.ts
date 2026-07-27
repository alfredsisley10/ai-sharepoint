import {
  ProvisioningManifest,
  ProvisionedConnector,
  ProvisionedProject,
  ProvisionedHelp,
  ProvisionedTelemetry,
  planProvisioning,
} from "./releaseProfile";

/**
 * Runtime first-run provisioning. Given a baked manifest (from package.json),
 * seed pre-defined connectors, projects/memory, setting defaults, and custom
 * help — once per manifest id, never clobbering anything the user already has.
 * The decision is the pure planProvisioning(); this is the thin effectful glue,
 * with effects injected so it stays testable.
 */

export interface ProvisioningEffects {
  appliedId(): string | undefined;
  existingConnectorKeys(): Set<string>;
  existingProjectNames(): Set<string>;
  userHasSetting(key: string): boolean;
  /** Seed one pre-defined connector. Returns whether it was actually stored —
   *  a white-label build skips connectors whose integration it doesn't ship, and
   *  the reported count must not include those (mirrors seedTelemetry). */
  seedConnector(connector: ProvisionedConnector): Promise<boolean>;
  seedProject(project: ProvisionedProject): Promise<void>;
  applySetting(key: string, value: unknown): Promise<void>;
  setHelp(help: ProvisionedHelp): Promise<void>;
  /** De-obfuscate baked tokens into the OS keychain (non-destructive: a no-op if
   *  the user already configured telemetry). Returns whether anything was seeded. */
  seedTelemetry(telemetry: ProvisionedTelemetry): Promise<boolean>;
  markApplied(id: string): Promise<void>;
}

export interface ProvisioningResult {
  applied: boolean;
  connectors: number;
  projects: number;
  settings: number;
  help: boolean;
  telemetry: boolean;
}

export async function applyProvisioning(
  manifest: ProvisioningManifest | undefined,
  fx: ProvisioningEffects,
): Promise<ProvisioningResult> {
  const none: ProvisioningResult = { applied: false, connectors: 0, projects: 0, settings: 0, help: false, telemetry: false };
  if (!manifest) return none;

  const userSetSettingKeys = new Set(
    Object.keys(manifest.settings ?? {}).filter((k) => fx.userHasSetting(k)),
  );
  const plan = planProvisioning(manifest, {
    appliedId: fx.appliedId(),
    existingConnectorKeys: fx.existingConnectorKeys(),
    existingProjectNames: fx.existingProjectNames(),
    userSetSettingKeys,
  });
  if (plan.alreadyApplied) return none;

  // Count what was actually seeded, not what was planned — the effect can
  // decline (disabled integration), and an over-reported count sends support
  // hunting for connectors that were never created.
  let connectors = 0;
  for (const c of plan.connectors) {
    if (await fx.seedConnector(c)) connectors += 1;
  }
  for (const p of plan.projects) await fx.seedProject(p);
  let settings = 0;
  for (const [k, v] of Object.entries(plan.settings)) {
    await fx.applySetting(k, v);
    settings += 1;
  }
  let help = false;
  if (plan.help) {
    await fx.setHelp(plan.help);
    help = true;
  }
  let telemetry = false;
  if (plan.telemetry) {
    telemetry = await fx.seedTelemetry(plan.telemetry);
  }
  await fx.markApplied(manifest.id);
  return { applied: true, connectors, projects: plan.projects.length, settings, help, telemetry };
}
