import * as vscode from "vscode";
import { SitesStore, SiteConnection } from "../auth/sitesStore";

/**
 * The Sites tree view (PLAN §5): one node per connection, role-distinguished
 * icons, rich tooltips, inline + context-menu actions wired via package.json
 * menus. Empty state is handled by a viewsWelcome contribution.
 */
export class SitesTreeProvider
  implements vscode.TreeDataProvider<SiteConnection>
{
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly sites: SitesStore) {
    sites.onDidChange(() => this.emitter.fire());
  }

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(conn: SiteConnection): vscode.TreeItem {
    const item = new vscode.TreeItem(
      conn.displayName,
      vscode.TreeItemCollapsibleState.None,
    );
    item.id = conn.siteUrl;
    item.description = conn.role === "managed" ? "managed" : "reference";
    item.iconPath = new vscode.ThemeIcon(
      conn.role === "managed" ? "cloud" : "eye",
      conn.lastVerifiedAt
        ? new vscode.ThemeColor("charts.green")
        : new vscode.ThemeColor("charts.yellow"),
    );
    item.contextValue = `site-${conn.role}`;

    const tooltip = new vscode.MarkdownString(
      [
        `**${conn.displayName}**`,
        "",
        `| | |`,
        `|---|---|`,
        `| URL | ${conn.siteUrl} |`,
        `| Role | ${conn.role} — ${conn.role === "managed" ? "full lifecycle (sync planned)" : "read-only context"} |`,
        `| Auth | ${conn.authProviderId} |`,
        `| Account | ${conn.account ?? "_not signed in yet_"} |`,
        `| Verified | ${conn.lastVerifiedAt ?? "_never_"} |`,
      ].join("\n"),
    );
    item.tooltip = tooltip;
    item.command = {
      command: "aiSharePoint.openSiteInBrowser",
      title: "Open in Browser",
      arguments: [conn],
    };
    return item;
  }

  getChildren(element?: SiteConnection): SiteConnection[] {
    return element ? [] : this.sites.list();
  }
}
