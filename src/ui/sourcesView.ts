import * as vscode from "vscode";
import { ContextSourcesStore } from "../context/sourcesStore";
import { BookmarksStore } from "../context/bookmarksStore";
import { ContextSource, ContextBookmark } from "../context/types";
import { isSrvLocator } from "../context/ldap/srvLocator";

type Node = ContextSource | ContextBookmark;

function isBookmark(node: Node): node is ContextBookmark {
  return (node as ContextBookmark).locator !== undefined;
}

/**
 * Reference Sources view (PLAN §9 unified surface): sources at the top level,
 * their saved bookmarks (ADR-0010) as children.
 */
export class SourcesTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private readonly sources: ContextSourcesStore,
    private readonly bookmarks: BookmarksStore,
  ) {
    sources.onDidChange(() => this.emitter.fire());
    bookmarks.onDidChange(() => this.emitter.fire());
  }

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(node: Node): vscode.TreeItem {
    return isBookmark(node) ? this.bookmarkItem(node) : this.sourceItem(node);
  }

  getChildren(node?: Node): Node[] {
    if (!node) return this.sources.list();
    if (isBookmark(node)) return [];
    return this.bookmarks.listForSource(node.id);
  }

  private sourceItem(source: ContextSource): vscode.TreeItem {
    const bookmarkCount = this.bookmarks.listForSource(source.id).length;
    const item = new vscode.TreeItem(
      source.displayName,
      bookmarkCount > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    item.id = source.id;
    const locked = this.sources.isLockedOut(source.id);
    item.description = `${source.type} · ${source.deployment}${locked ? " · locked" : ""}`;
    const icon =
      source.type === "jira"
        ? "issues"
        : source.type === "ldap"
          ? "organization"
          : ["mssql", "postgres", "mysql", "mongodb"].includes(source.type)
            ? "database"
            : "book";
    item.iconPath = new vscode.ThemeIcon(
      icon,
      locked
        ? new vscode.ThemeColor("charts.red")
        : source.lastVerifiedAt
          ? new vscode.ThemeColor("charts.green")
          : new vscode.ThemeColor("charts.yellow"),
    );
    item.contextValue = locked ? "context-source-locked" : "context-source";
    item.tooltip = new vscode.MarkdownString(
      [
        `**${source.displayName}** _(read-only context — PLAN §9)_`,
        "",
        `| | |`,
        `|---|---|`,
        `| Type | ${source.type} (${source.deployment}) |`,
        `| URL | ${source.baseUrl} |`,
        ...(isSrvLocator(source.baseUrl)
          ? [`| Resolution | DNS SRV on every connection (durable — survives DC changes) |`]
          : []),
        ...(source.baseDn ? [`| Base DN | ${source.baseDn} |`] : []),
        `| Auth | ${source.authMethod === "pat" ? "Personal access token" : source.authMethod === "ldap-simple" ? "LDAP simple bind (UPN/DN + password)" : "Basic (username + token/password)"} |`,
        `| Account | ${source.account ?? "_not verified_"} |`,
        `| Verified | ${source.lastVerifiedAt ?? "_never_"} |`,
        ...(bookmarkCount > 0 ? [`| Bookmarks | ${bookmarkCount} |`] : []),
        ...(locked
          ? ["", "🔒 **Auth lockout protection engaged** (3 failures). Reset via the context menu after checking the credential with your admin."]
          : []),
      ].join("\n"),
    );
    return item;
  }

  private bookmarkItem(bookmark: ContextBookmark): vscode.TreeItem {
    const item = new vscode.TreeItem(bookmark.name);
    item.id = bookmark.id;
    item.description = bookmark.kind;
    item.iconPath = new vscode.ThemeIcon(
      bookmark.kind === "item" ? "bookmark" : bookmark.kind === "container" ? "folder" : "search",
    );
    item.contextValue = "context-bookmark";
    item.tooltip = new vscode.MarkdownString(
      [`**${bookmark.name}** _(${bookmark.kind})_`, "", "```", bookmark.locator, "```"].join("\n"),
    );
    item.command = {
      command: "aiSharePoint.runBookmark",
      title: "Run Bookmark",
      arguments: [bookmark],
    };
    return item;
  }
}
