import * as vscode from "vscode";
import { PromptStore } from "../context/promptStore";
import { PromptItem, PromptScope, promptScopes } from "../context/promptLibrary";
import { SitesStore } from "../auth/sitesStore";
import { ContextSourcesStore } from "../context/sourcesStore";
import { ProjectsStore } from "../context/projectsStore";

/** Synthetic folder node: the prompts for one scope (Global, or one entity). */
export interface PromptGroupNode {
  promptScope: PromptScope;
}

type Node = PromptGroupNode | PromptItem;

function isGroup(n: Node): n is PromptGroupNode {
  return (n as PromptGroupNode).promptScope !== undefined;
}

/**
 * The Prompt Library tab: reusable prompt snippets, grouped by where they live —
 * Global first, then per managed site / reference source / project. Clicking a
 * prompt copies it to the clipboard ("use"); management (add/edit/copy/delete) is
 * via the context menu and the "+" title action. Prompts are reuse-on-demand and
 * are NOT injected into the assistant's context (that's what memory is for).
 */
export class PromptsTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private readonly prompts: PromptStore,
    private readonly sites: SitesStore,
    private readonly sources: ContextSourcesStore,
    private readonly projects: ProjectsStore,
  ) {
    prompts.onDidChange(() => this.emitter.fire());
    // Entity renames change the labels shown for scoped groups.
    sites.onDidChange(() => this.emitter.fire());
    sources.onDidChange(() => this.emitter.fire());
    projects.onDidChange(() => this.emitter.fire());
  }

  refresh(): void {
    this.emitter.fire();
  }

  /** Human label for a scope, resolving the entity key to its current name. */
  labelForScope(scope: PromptScope): string {
    switch (scope.kind) {
      case "global":
        return "Global";
      case "site":
        return this.sites.list().find((c) => c.siteUrl === scope.key)?.displayName || scope.key || "site";
      case "source":
        return this.sources.get(scope.key ?? "")?.displayName || scope.key || "source";
      case "project":
        return this.projects.list().find((p) => p.id === scope.key)?.name || scope.key || "project";
    }
  }

  getChildren(node?: Node): Node[] {
    if (!node) return promptScopes(this.prompts.list()).map((promptScope) => ({ promptScope }));
    if (isGroup(node)) return this.prompts.listForScope(node.promptScope);
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (isGroup(node)) {
      const count = this.prompts.listForScope(node.promptScope).length;
      const kindLabel = node.promptScope.kind === "global" ? "" : ` · ${node.promptScope.kind}`;
      const item = new vscode.TreeItem(
        `${this.labelForScope(node.promptScope)} (${count})`,
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.description = kindLabel.replace(/^ · /, "");
      item.iconPath = new vscode.ThemeIcon(
        node.promptScope.kind === "global"
          ? "globe"
          : node.promptScope.kind === "site"
            ? "cloud"
            : node.promptScope.kind === "source"
              ? "book"
              : "folder",
      );
      item.contextValue = "prompt-group";
      return item;
    }
    const item = new vscode.TreeItem(node.title, vscode.TreeItemCollapsibleState.None);
    item.id = `prompt:${node.id}`;
    item.description = node.tags?.length ? node.tags.join(", ") : undefined;
    item.iconPath = new vscode.ThemeIcon("comment-discussion");
    item.contextValue = "prompt-item";
    const tags = node.tags?.length ? `\n\n_${node.tags.join(", ")}_` : "";
    item.tooltip = new vscode.MarkdownString(`**${node.title}**\n\n${node.body.replace(/\n/g, "  \n")}${tags}\n\n_Click to copy to the clipboard._`);
    item.command = {
      command: "aiSharePoint.usePrompt",
      title: "Copy Prompt to Clipboard",
      arguments: [node],
    };
    return item;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
