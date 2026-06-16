import * as vscode from "vscode";
import { SitesStore, SiteConnection } from "../auth/sitesStore";
import { ContextSourcesStore } from "../context/sourcesStore";
import { ContextSource } from "../context/types";
import { describeWriteScope } from "../context/adapters/confluenceScope";

/**
 * Render one site connection as a tree item. Shared by the Managed Sites view
 * (managed targets) and the Reference Sources view (read-only sites), so a
 * site looks and behaves identically wherever it appears. The role drives the
 * icon/description and the contextValue (`site-managed` / `site-reference`),
 * which the package.json menus key off.
 */
export function siteTreeItem(conn: SiteConnection): vscode.TreeItem {
  const item = new vscode.TreeItem(conn.displayName, vscode.TreeItemCollapsibleState.None);
  item.id = conn.siteUrl;
  item.description = conn.role === "managed" ? "managed" : "reference";
  item.iconPath = new vscode.ThemeIcon(
    conn.role === "managed" ? "cloud" : "eye",
    conn.lastVerifiedAt
      ? new vscode.ThemeColor("charts.green")
      : new vscode.ThemeColor("charts.yellow"),
  );
  item.contextValue = `site-${conn.role}`;
  item.tooltip = new vscode.MarkdownString(
    [
      `**${conn.displayName}**`,
      "",
      `| | |`,
      `|---|---|`,
      `| URL | ${conn.siteUrl} |`,
      `| Role | ${conn.role} — ${conn.role === "managed" ? "full lifecycle (pull / apply / revert)" : "read-only context"} |`,
      `| Auth | ${conn.authProviderId} |`,
      `| Account | ${conn.account ?? "_not signed in yet_"} |`,
      `| Verified | ${conn.lastVerifiedAt ?? "_never_"} |`,
    ].join("\n"),
  );
  item.command = {
    command: "aiSharePoint.openSiteInBrowser",
    title: "Open in Browser",
    arguments: [conn],
  };
  return item;
}

/** Render a managed context source (e.g. a Confluence space) as a Managed Sites
 *  node — managed targets that aren't SharePoint sites. */
export function managedSourceItem(source: ContextSource): vscode.TreeItem {
  const item = new vscode.TreeItem(source.displayName, vscode.TreeItemCollapsibleState.None);
  item.id = `managed-source:${source.id}`;
  item.description = `managed · ${source.type}`;
  item.iconPath = new vscode.ThemeIcon(
    source.type === "confluence" ? "book" : "cloud",
    source.lastVerifiedAt ? new vscode.ThemeColor("charts.green") : new vscode.ThemeColor("charts.yellow"),
  );
  item.contextValue = `managed-source-${source.type}`;
  if (source.writeScope && source.writeScope.kind !== "instance") {
    item.description += ` · ${source.writeScope.kind === "space" ? source.writeScope.spaceKey : `page ${source.writeScope.pageId}`}`;
  }
  item.tooltip = new vscode.MarkdownString(
    [
      `**${source.displayName}**`,
      "",
      `| | |`,
      `|---|---|`,
      `| Instance | ${source.baseUrl} |`,
      `| Type | ${source.type} (managed — read/write) |`,
      ...(source.type === "confluence"
        ? [
            `| Write scope | ${describeWriteScope(source.writeScope)} |`,
            `| Reads | all of Confluence (ownership & notifications too) |`,
          ]
        : []),
      `| Account | ${source.account ?? "_not verified yet_"} |`,
      `| Verified | ${source.lastVerifiedAt ?? "_never_"} |`,
    ].join("\n"),
  );
  item.command = {
    command: "aiSharePoint.openSourceInBrowser",
    title: "Open in Browser",
    arguments: [source],
  };
  return item;
}

type ManagedNode = SiteConnection | ContextSource;

function isSiteConnection(node: ManagedNode): node is SiteConnection {
  return (node as SiteConnection).siteUrl !== undefined;
}

/**
 * The Managed Sites tree view: managed targets only — SharePoint sites with the
 * full pull/apply/revert lifecycle, AND managed context sources (a Confluence
 * space we actively manage). Read-only/reference connections live under
 * Reference Sources instead.
 */
export class SitesTreeProvider implements vscode.TreeDataProvider<ManagedNode> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private readonly sites: SitesStore,
    private readonly sources: ContextSourcesStore,
  ) {
    sites.onDidChange(() => this.emitter.fire());
    sources.onDidChange(() => this.emitter.fire());
  }

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(node: ManagedNode): vscode.TreeItem {
    return isSiteConnection(node) ? siteTreeItem(node) : managedSourceItem(node);
  }

  getChildren(element?: ManagedNode): ManagedNode[] {
    if (element) return [];
    return [
      ...this.sites.list().filter((c) => c.role === "managed"),
      ...this.sources.list().filter((s) => s.role === "managed"),
    ];
  }
}
