import * as vscode from "vscode";
import { SitesStore, SiteConnection } from "../auth/sitesStore";

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

/**
 * The Managed Sites tree view: managed targets only (full pull/apply/revert
 * lifecycle). Read-only/reference sites are surfaced under Reference Sources
 * instead. Empty state is handled by a viewsWelcome contribution.
 */
export class SitesTreeProvider implements vscode.TreeDataProvider<SiteConnection> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly sites: SitesStore) {
    sites.onDidChange(() => this.emitter.fire());
  }

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(conn: SiteConnection): vscode.TreeItem {
    return siteTreeItem(conn);
  }

  getChildren(element?: SiteConnection): SiteConnection[] {
    return element ? [] : this.sites.list().filter((c) => c.role === "managed");
  }
}
