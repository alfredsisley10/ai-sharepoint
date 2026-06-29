import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  parseReleaseProfile,
  serializeReleaseProfile,
  telemetrySettings,
  buildProvisioningManifest,
  connectorKey,
  planProvisioning,
  ReleaseProfile,
  ProvisioningManifest,
} from "../src/branding/releaseProfile";
import { setProvisioningManifest } from "../src/branding/rebrand";
import { applyProvisioning, ProvisioningEffects } from "../src/branding/provisioning";

const PROFILE: ReleaseProfile = {
  version: 1,
  identity: { publisher: "contoso", name: "contoso-docs", displayName: "Contoso Docs", handle: "contosodocs", description: "Internal docs." },
  expiry: { validityDays: 90, upgradeUrl: "https://dl/x" },
  provisioning: { settings: { "telemetry.enabled": true }, connectors: [{ type: "github", displayName: "GH", baseUrl: "https://github.com", alias: "GH" }] },
};

test("parseReleaseProfile validates identity; serialize round-trips", () => {
  const json = serializeReleaseProfile(PROFILE);
  assert.deepEqual(parseReleaseProfile(json), PROFILE);
  assert.throws(() => parseReleaseProfile("nope"), /not valid JSON/);
  assert.throws(() => parseReleaseProfile(JSON.stringify({})), /identity/);
  assert.throws(() => parseReleaseProfile(JSON.stringify({ identity: { publisher: "p" } })), /name/);
});

test("telemetrySettings maps endpoints (no token) and omits empties", () => {
  assert.deepEqual(telemetrySettings({ enabled: true, splunkHecUrl: "https://h/event", otlpEndpoint: "https://o:4318" }), {
    "telemetry.enabled": true,
    "telemetry.splunkHec.url": "https://h/event",
    "telemetry.otlp.endpoint": "https://o:4318",
  });
  assert.deepEqual(telemetrySettings({ enabled: false }), {});
});

test("buildProvisioningManifest stamps id and omits empty sections", () => {
  const m = buildProvisioningManifest({ connectors: [], settings: { a: 1 } }, "build-1");
  assert.equal(m.id, "build-1");
  assert.deepEqual(m.settings, { a: 1 });
  assert.ok(!("connectors" in m), "empty connectors omitted");
});

test("connectorKey prefers alias, lowercased, else baseUrl", () => {
  assert.equal(connectorKey({ alias: "CMDB", baseUrl: "https://x" }), "cmdb");
  assert.equal(connectorKey({ baseUrl: "https://X.com" }), "https://x.com");
});

test("planProvisioning is idempotent and non-destructive", () => {
  const manifest: ProvisioningManifest = {
    id: "b1",
    settings: { "telemetry.enabled": true, "x.y": 5 },
    connectors: [
      { type: "github", displayName: "GH", baseUrl: "https://github.com", alias: "GH" },
      { type: "jira", displayName: "Jira", baseUrl: "https://j", alias: "JIRA" },
    ],
    projects: [{ name: "Default" }, { name: "Existing" }],
    help: { welcome: "hi" },
  };
  // Already applied → nothing.
  assert.equal(
    planProvisioning(manifest, { appliedId: "b1", existingConnectorKeys: new Set(), existingProjectNames: new Set(), userSetSettingKeys: new Set() }).alreadyApplied,
    true,
  );
  // Fresh install, but one connector / project / setting already present.
  const plan = planProvisioning(manifest, {
    appliedId: undefined,
    existingConnectorKeys: new Set(["gh"]), // GH already there
    existingProjectNames: new Set(["existing"]),
    userSetSettingKeys: new Set(["telemetry.enabled"]), // user already chose
  });
  assert.equal(plan.alreadyApplied, false);
  assert.deepEqual(plan.connectors.map((c) => c.alias), ["JIRA"]);
  assert.deepEqual(plan.projects.map((p) => p.name), ["Default"]);
  assert.deepEqual(plan.settings, { "x.y": 5 }); // telemetry.enabled skipped (user-set)
  assert.deepEqual(plan.help, { welcome: "hi" });
});

test("setProvisioningManifest replaces/inserts the provisioning block", () => {
  const withRelease = ['{', '  "version": "0.68.0",', '  "release": { "channel": "whitelabel" },', '  "publisher": "p"', "}", ""].join("\n");
  const out = setProvisioningManifest(withRelease, { id: "b1", settings: { a: 1 } });
  assert.deepEqual(JSON.parse(out).provisioning, { id: "b1", settings: { a: 1 } });
  assert.equal(JSON.parse(out).publisher, "p");
  // replace an existing block
  const out2 = setProvisioningManifest(out, { id: "b2" });
  assert.deepEqual(JSON.parse(out2).provisioning, { id: "b2" });
  // no release key → insert after version
  const noRelease = ['{', '  "version": "1.0.0",', '  "publisher": "p"', "}", ""].join("\n");
  assert.deepEqual(JSON.parse(setProvisioningManifest(noRelease, { id: "b3" })).provisioning, { id: "b3" });
  // undefined → no-op
  assert.equal(setProvisioningManifest(noRelease, undefined), noRelease);
});

test("applyProvisioning seeds once, skipping what already exists, then marks applied", async () => {
  const seededConnectors: unknown[] = [];
  const seededProjects: unknown[] = [];
  const appliedSettings: Record<string, unknown> = {};
  let help: unknown;
  let markedId: string | undefined;
  const fx: ProvisioningEffects = {
    appliedId: () => undefined,
    existingConnectorKeys: () => new Set(["gh"]),
    existingProjectNames: () => new Set(),
    userHasSetting: () => false,
    seedConnector: async (c) => void seededConnectors.push(c),
    seedProject: async (p) => void seededProjects.push(p),
    applySetting: async (k, v) => void (appliedSettings[k] = v),
    setHelp: async (h) => void (help = h),
    markApplied: async (id) => void (markedId = id),
  };
  const manifest: ProvisioningManifest = {
    id: "b1",
    settings: { "telemetry.enabled": true },
    connectors: [
      { type: "github", displayName: "GH", baseUrl: "https://github.com", alias: "GH" }, // exists → skipped
      { type: "jira", displayName: "Jira", baseUrl: "https://j", alias: "JIRA" },
    ],
    projects: [{ name: "Default" }],
    help: { welcome: "hi" },
  };
  const result = await applyProvisioning(manifest, fx);
  assert.deepEqual(result, { applied: true, connectors: 1, projects: 1, settings: 1, help: true });
  assert.equal(seededConnectors.length, 1);
  assert.deepEqual(appliedSettings, { "telemetry.enabled": true });
  assert.deepEqual(help, { welcome: "hi" });
  assert.equal(markedId, "b1");

  // Second run (already applied id) seeds nothing.
  const fx2: ProvisioningEffects = { ...fx, appliedId: () => "b1" };
  assert.deepEqual(await applyProvisioning(manifest, fx2), { applied: false, connectors: 0, projects: 0, settings: 0, help: false });
});
