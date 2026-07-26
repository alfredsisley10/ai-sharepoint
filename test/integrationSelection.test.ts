import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  ALL_INTEGRATIONS,
  ALL_INTEGRATION_TYPES,
  labelForIntegration,
  normalizeIntegrationAllowlist,
  isFullSelection,
  isIntegrationEnabled,
  disabledIntegrationLabels,
  summarizeIntegrationSelection,
  setEnabledIntegrations,
  integrationEnabled,
  enabledIntegrationTypes,
} from "../src/branding/integrationSelection";
import { ContextSourceType } from "../src/context/types";

// Compile-time-exhaustive map of the union: adding a ContextSourceType without a
// registry entry (or vice-versa) fails this test, so a new source type can never
// silently ship un-gateable by the white-label picker.
const EVERY_TYPE: Record<ContextSourceType, true> = {
  confluence: true,
  jira: true,
  github: true,
  ldap: true,
  mssql: true,
  postgres: true,
  mysql: true,
  mongodb: true,
  powerbi: true,
  servicenow: true,
  splunk: true,
  splunkobs: true,
  grafana: true,
  m365copilot: true,
};

test("registry covers every ContextSourceType exactly once", () => {
  assert.deepEqual([...ALL_INTEGRATION_TYPES].sort(), Object.keys(EVERY_TYPE).sort());
  // no duplicate entries
  assert.equal(new Set(ALL_INTEGRATION_TYPES).size, ALL_INTEGRATION_TYPES.length);
  // every entry carries a non-empty label + group
  for (const i of ALL_INTEGRATIONS) {
    assert.ok(i.label.trim(), `${i.type} has a label`);
    assert.ok(i.group.trim(), `${i.type} has a group`);
  }
});

test("labelForIntegration maps known types; passes through unknown", () => {
  assert.equal(labelForIntegration("servicenow"), "ServiceNow");
  assert.equal(labelForIntegration("splunkobs"), "Splunk Observability Cloud");
  assert.equal(labelForIntegration("nope"), "nope");
});

test("normalizeIntegrationAllowlist: undefined passes through; else canonical + deduped + known-only", () => {
  assert.equal(normalizeIntegrationAllowlist(undefined), undefined);
  // canonical registry order regardless of input order, duplicates removed
  assert.deepEqual(normalizeIntegrationAllowlist(["jira", "confluence", "jira"]), ["confluence", "jira"]);
  // unknown/removed type ids are dropped (never enable a type this build lacks)
  assert.deepEqual(normalizeIntegrationAllowlist(["confluence", "vertexai", "bogus"]), ["confluence"]);
  // empty stays empty (a deliberately locked-down build)
  assert.deepEqual(normalizeIntegrationAllowlist([]), []);
});

test("isFullSelection: undefined and a complete set are full; a subset/empty are not", () => {
  assert.equal(isFullSelection(undefined), true);
  assert.equal(isFullSelection([...ALL_INTEGRATION_TYPES]), true);
  // order/dupes don't matter for fullness
  assert.equal(isFullSelection([...ALL_INTEGRATION_TYPES].reverse()), true);
  assert.equal(isFullSelection(["confluence", "jira"]), false);
  assert.equal(isFullSelection([]), false);
});

test("isIntegrationEnabled fails open: absent allowlist enables everything", () => {
  for (const t of ALL_INTEGRATION_TYPES) assert.equal(isIntegrationEnabled(t, undefined), true);
  assert.equal(isIntegrationEnabled("confluence", ["confluence", "jira"]), true);
  assert.equal(isIntegrationEnabled("splunk", ["confluence", "jira"]), false);
  // empty allowlist disables everything
  assert.equal(isIntegrationEnabled("confluence", []), false);
});

test("disabledIntegrationLabels lists exactly the excluded ones", () => {
  assert.deepEqual(disabledIntegrationLabels(undefined), []);
  const disabled = disabledIntegrationLabels(["confluence"]);
  assert.equal(disabled.length, ALL_INTEGRATIONS.length - 1);
  assert.ok(!disabled.includes("Confluence"));
  assert.ok(disabled.includes("Jira"));
});

test("summarizeIntegrationSelection reads well for full / subset / none", () => {
  assert.equal(summarizeIntegrationSelection(undefined), `all ${ALL_INTEGRATIONS.length} integrations`);
  assert.equal(summarizeIntegrationSelection([...ALL_INTEGRATION_TYPES]), `all ${ALL_INTEGRATIONS.length} integrations`);
  assert.equal(
    summarizeIntegrationSelection(["jira", "confluence"]),
    `2 of ${ALL_INTEGRATIONS.length} — Confluence, Jira`,
  );
  assert.equal(summarizeIntegrationSelection([]), "no integrations (all disabled)");
});

test("runtime holder: setEnabledIntegrations normalizes; integrationEnabled honors it; unrestricted by default", () => {
  // default (unset) is unrestricted
  setEnabledIntegrations(undefined);
  assert.equal(enabledIntegrationTypes(), undefined);
  assert.equal(integrationEnabled("mongodb"), true);

  // a subset restricts, and is stored normalized (canonical order, known-only)
  setEnabledIntegrations(["jira", "confluence", "bogus"]);
  assert.deepEqual(enabledIntegrationTypes(), ["confluence", "jira"]);
  assert.equal(integrationEnabled("confluence"), true);
  assert.equal(integrationEnabled("grafana"), false);

  // empty disables all
  setEnabledIntegrations([]);
  assert.equal(integrationEnabled("confluence"), false);

  // reset so this test leaves no global state for others
  setEnabledIntegrations(undefined);
  assert.equal(integrationEnabled("confluence"), true);
});
