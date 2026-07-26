/**
 * Integration selection for white-label builds (pure + a tiny runtime holder).
 *
 * A white-label release can choose **which reference-source integrations ship
 * enabled** in the produced build. The chosen set is baked into the package.json
 * `release.integrations` allowlist (see releaseExpiry.ts); at activation the
 * extension reads it and gates the "Add Reference Source" picker so only the
 * selected integrations can be added (and defensively refuses a disabled type).
 *
 * Semantics — deliberately fail-open so the standard build and any older
 * white-label build are unaffected:
 *   - allowlist ABSENT (undefined)  ⇒ every integration is enabled.
 *   - allowlist PRESENT             ⇒ exactly the listed types are enabled
 *                                     (an empty list disables them all).
 * Selecting every integration in the wizard is therefore equivalent to baking no
 * allowlist at all (isFullSelection), which keeps the rebrand diff minimal.
 *
 * The registry below is the source of truth for the WHITE-LABEL SELECTION UI. Its
 * labels mirror `SOURCE_TYPE_LABELS` (extensionHelpers.ts) and the add-source
 * picker; it is kept vscode-free so the selection logic stays unit-tested.
 */

import { ContextSourceType } from "../context/types";

/** One gateable reference-source integration. */
export interface GateableIntegration {
  /** The ContextSourceType this entry enables/disables. */
  type: ContextSourceType;
  /** Product name shown in the selection UI (mirrors SOURCE_TYPE_LABELS). */
  label: string;
  /** Short category hint, shown as the multi-select item description. */
  group: string;
}

/**
 * Every integration a white-label build can include, in a grouped display order.
 * MUST stay in sync with `ContextSourceType` — the compiler enforces that each
 * entry's `type` is a valid member, and `assertRegistryCoversAllTypes` (tests)
 * asserts the set is exhaustive so a newly-added source type can't silently ship
 * ungateable.
 */
export const ALL_INTEGRATIONS: readonly GateableIntegration[] = [
  { type: "confluence", label: "Confluence", group: "Collaboration & knowledge" },
  { type: "jira", label: "Jira", group: "Collaboration & knowledge" },
  { type: "github", label: "GitHub", group: "Collaboration & knowledge" },
  { type: "m365copilot", label: "Microsoft 365 Copilot", group: "Collaboration & knowledge" },
  { type: "servicenow", label: "ServiceNow", group: "IT service management" },
  { type: "splunk", label: "Splunk", group: "Observability" },
  { type: "splunkobs", label: "Splunk Observability Cloud", group: "Observability" },
  { type: "grafana", label: "Grafana", group: "Observability" },
  { type: "powerbi", label: "Power BI", group: "Analytics & BI" },
  { type: "ldap", label: "LDAP / Active Directory", group: "Directory" },
  { type: "mssql", label: "SQL Server", group: "Databases" },
  { type: "postgres", label: "PostgreSQL", group: "Databases" },
  { type: "mysql", label: "MySQL", group: "Databases" },
  { type: "mongodb", label: "MongoDB", group: "Databases" },
];

/** All gateable type ids, in the canonical (registry) order. */
export const ALL_INTEGRATION_TYPES: readonly ContextSourceType[] = ALL_INTEGRATIONS.map((i) => i.type);

const LABEL_BY_TYPE = new Map<string, string>(ALL_INTEGRATIONS.map((i) => [i.type, i.label]));

/** Human label for a type, or the raw type if it isn't a known integration. */
export function labelForIntegration(type: string): string {
  return LABEL_BY_TYPE.get(type) ?? type;
}

/**
 * Normalize a raw allowlist (from the wizard or a baked manifest) to known types
 * in canonical order, de-duplicated. `undefined` passes through as `undefined`
 * (meaning "all enabled"); unknown/removed type ids are dropped so a manifest
 * from a newer/older build never enables a type this build doesn't know.
 */
export function normalizeIntegrationAllowlist(
  list: readonly string[] | undefined,
): ContextSourceType[] | undefined {
  if (!list) return undefined;
  const wanted = new Set(list);
  return ALL_INTEGRATION_TYPES.filter((t) => wanted.has(t));
}

/** Whether an allowlist covers every known integration (⇒ same as no allowlist). */
export function isFullSelection(list: readonly string[] | undefined): boolean {
  if (!list) return true;
  const present = new Set(list);
  return ALL_INTEGRATION_TYPES.every((t) => present.has(t));
}

/**
 * Is `type` enabled under `allowlist`? Fail-open: an absent allowlist enables
 * everything (standard build). A present allowlist enables only its members.
 */
export function isIntegrationEnabled(type: string, allowlist: readonly string[] | undefined): boolean {
  if (!allowlist) return true;
  return allowlist.includes(type);
}

/** The known integrations disabled by an allowlist (for a summary line). */
export function disabledIntegrationLabels(allowlist: readonly string[] | undefined): string[] {
  if (!allowlist) return [];
  return ALL_INTEGRATIONS.filter((i) => !allowlist.includes(i.type)).map((i) => i.label);
}

/** A one-line "N of M — a, b, c" summary of an allowlist, for the confirm step. */
export function summarizeIntegrationSelection(allowlist: readonly string[] | undefined): string {
  if (isFullSelection(allowlist)) return `all ${ALL_INTEGRATIONS.length} integrations`;
  const enabled = ALL_INTEGRATIONS.filter((i) => isIntegrationEnabled(i.type, allowlist));
  if (enabled.length === 0) return "no integrations (all disabled)";
  return `${enabled.length} of ${ALL_INTEGRATIONS.length} — ${enabled.map((i) => i.label).join(", ")}`;
}

// --- runtime holder: set once at activation, read by the add-source gate ------
// Undefined ⇒ no restriction (all enabled). Mirrors releaseExpiry.ts's holder.
let enabled: ContextSourceType[] | undefined;

/** Apply the baked allowlist (from `release.integrations`) for this session.
 *  `undefined`/absent leaves every integration enabled. */
export function setEnabledIntegrations(list: readonly string[] | undefined): void {
  enabled = normalizeIntegrationAllowlist(list);
}

/** Whether a reference-source type may be added/used in this build. */
export function integrationEnabled(type: string): boolean {
  return isIntegrationEnabled(type, enabled);
}

/** The active allowlist, or `undefined` when unrestricted (all enabled). */
export function enabledIntegrationTypes(): readonly ContextSourceType[] | undefined {
  return enabled;
}
