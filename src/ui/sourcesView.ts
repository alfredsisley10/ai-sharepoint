import * as vscode from "vscode";
import { ContextSourcesStore } from "../context/sourcesStore";
import { ContextSource } from "../context/types";

/** Reference Sources view (PLAN §9 unified surface) — one row per source. */
export class SourcesTreeProvider implements vscode.TreeDataProvider<ContextSource> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly sources: ContextSourcesStore) {
    sources.onDidChange(() => this.emitter.fire());
  }

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(source: ContextSource): vscode.TreeItem {
    const item = new vscode.TreeItem(source.displayName);
    item.id = source.id;
    const locked = this.sources.isLockedOut(source.id);
    item.description = `${source.type} · ${source.deployment}${locked ? " · locked" : ""}`;
    item.iconPath = new vscode.ThemeIcon(
      source.type === "jira" ? "issues" : "book",
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
        `| Auth | ${source.authMethod === "pat" ? "Personal access token" : "Basic (username + token/password)"} |`,
        `| Account | ${source.account ?? "_not verified_"} |`,
        `| Verified | ${source.lastVerifiedAt ?? "_never_"} |`,
        ...(locked
          ? ["", "🔒 **Auth lockout protection engaged** (3 failures). Reset via the context menu after checking the credential with your admin."]
          : []),
      ].join("\n"),
    );
    return item;
  }

  getChildren(element?: ContextSource): ContextSource[] {
    return element ? [] : this.sources.list();
  }
}
