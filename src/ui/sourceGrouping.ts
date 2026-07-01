import type { ContextSource, ContextSourceType } from "../context/types";
import type { SiteConnection } from "../auth/sitesStore";
import type { FileSource } from "../context/files/fileSources";

/**
 * Pure tree-shaping for the Reference Sources view (no `vscode` import, so it is
 * unit-testable). Folds the flat reference list into collapsible groups, but
 * ONLY when a group would hold more than one member:
 *   - reference sources of the SAME type → one "<Type> (N)" group;
 *   - attached files → one "Files (N)" group when there is more than one file;
 *   - reference SharePoint sites → one "SharePoint sites (N)" group.
 * A lone member of a category stays at the top level, so the tree nests only
 * where nesting actually organizes.
 */

/** Codicon per source type; confluence (and any future type) → book. */
export const ICON_BY_TYPE: Record<string, string> = {
  jira: "issues",
  github: "github",
  ldap: "organization",
  powerbi: "graph",
  servicenow: "tools",
  splunk: "pulse",
  splunkobs: "dashboard",
  grafana: "graph-line",
  m365copilot: "sparkle",
  mssql: "database",
  postgres: "database",
  mysql: "database",
  mongodb: "database",
};

/** Human, group-header label per type. */
export const TYPE_LABEL: Record<string, string> = {
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
  splunkobs: "Splunk Observability",
  grafana: "Grafana",
  m365copilot: "Microsoft 365 Copilot",
};

/** Members a group can hold: real reference nodes (never another group — the
 *  tree is one level of grouping deep, so indent guides stay legible). */
export type Groupable = ContextSource | FileSource | SiteConnection;

/** A synthetic node that folds several members under one collapsible header.
 *  Distinguished from every real node by `kind: "source-group"` (FileSource's
 *  `kind` is a FileKind like "pdf", never this literal, and it also carries
 *  `location`). */
export interface SourceGroupNode {
  kind: "source-group";
  /** Stable, unique tree id (drives VS Code's expand/collapse memory). */
  id: string;
  label: string;
  icon: string;
  children: Groupable[];
}

export function isSourceGroup(node: unknown): node is SourceGroupNode {
  return !!node && typeof node === "object" && (node as SourceGroupNode).kind === "source-group";
}

/**
 * Fold reference sources of the SAME type under one group, but only when a type
 * has MORE THAN ONE source. Group order follows each type's first appearance,
 * and members keep their store order, so the view is stable across refreshes.
 */
export function groupSourcesByType(sources: ContextSource[]): Array<ContextSource | SourceGroupNode> {
  const byType = new Map<ContextSourceType, ContextSource[]>();
  for (const s of sources) {
    const members = byType.get(s.type);
    if (members) members.push(s);
    else byType.set(s.type, [s]);
  }
  const out: Array<ContextSource | SourceGroupNode> = [];
  for (const [type, members] of byType) {
    if (members.length > 1) {
      out.push({
        kind: "source-group",
        id: `group:type:${type}`,
        label: `${TYPE_LABEL[type] ?? type} (${members.length})`,
        icon: ICON_BY_TYPE[type] ?? "book",
        children: members,
      });
    } else {
      out.push(members[0]);
    }
  }
  return out;
}

/** Fold attached files under one "Files (N)" group when there is MORE THAN ONE;
 *  a single file stays at the top level. */
export function groupFiles(files: FileSource[]): Array<FileSource | SourceGroupNode> {
  if (files.length <= 1) return files;
  return [
    {
      kind: "source-group",
      id: "group:files",
      label: `Files (${files.length})`,
      icon: "files",
      children: files,
    },
  ];
}

/** Reference SharePoint sites are all one "type", so apply the same rule: fold
 *  them under a single group only when there is MORE THAN ONE. */
export function groupReferenceSites(sites: SiteConnection[]): Array<SiteConnection | SourceGroupNode> {
  if (sites.length <= 1) return sites;
  return [
    {
      kind: "source-group",
      id: "group:sharepoint-sites",
      label: `SharePoint sites (${sites.length})`,
      icon: "eye", // reference sites use the "eye" (read-only) codicon
      children: sites,
    },
  ];
}
