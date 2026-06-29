import {
  ProvisioningManifest,
  ProvisionedConnector,
  ProvisionedProject,
  ProvisionedHelp,
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
  seedConnector(connector: ProvisionedConnector): Promise<void>;
  seedProject(project: ProvisionedProject): Promise<void>;
  applySetting(key: string, value: unknown): Promise<void>;
  setHelp(help: ProvisionedHelp): Promise<void>;
  markApplied(id: string): Promise<void>;
}

export interface ProvisioningResult {
  applied: boolean;
  connectors: number;
  projects: number;
  settings: number;
  help: boolean;
}

export async function applyProvisioning(
  manifest: ProvisioningManifest | undefined,
  fx: ProvisioningEffects,
): Promise<ProvisioningResult> {
  const none: ProvisioningResult = { applied: false, connectors: 0, projects: 0, settings: 0, help: false };
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

  for (const c of plan.connectors) await fx.seedConnector(c);
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
  await fx.markApplied(manifest.id);
  return { applied: true, connectors: plan.connectors.length, projects: plan.projects.length, settings, help };
}
