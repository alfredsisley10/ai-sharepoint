import * as vscode from "vscode";
import { ProjectsStore } from "../context/projectsStore";
import { ContextSourcesStore } from "../context/sourcesStore";
import { Project } from "../context/types";

type Row =
  | { kind: "project"; project: Project }
  | { kind: "detail"; project: Project; field: "goals" | "instructions" | "ai" | "sources" };

/**
 * Projects view: the discoverable home for creating, switching, and managing
 * project scopes. Each project expands to its goals, instructions
 * (user-defined), AI-managed context, and member count — making the
 * user/AI context separation visible.
 */
export class ProjectsTreeProvider implements vscode.TreeDataProvider<Row> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private readonly projects: ProjectsStore,
    private readonly sources: ContextSourcesStore,
  ) {
    projects.onDidChange(() => this.emitter.fire());
  }

  getChildren(row?: Row): Row[] {
    if (!row) {
      return this.projects.list().map((project) => ({ kind: "project" as const, project }));
    }
    if (row.kind === "project") {
      return (["goals", "instructions", "ai", "sources"] as const).map((field) => ({
        kind: "detail" as const,
        project: row.project,
        field,
      }));
    }
    return [];
  }

  getTreeItem(row: Row): vscode.TreeItem {
    if (row.kind === "project") {
      const active = this.projects.activeId() === row.project.id;
      const item = new vscode.TreeItem(
        row.project.name,
        vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.id = row.project.id;
      item.description = active ? "● active" : row.project.description;
      item.iconPath = new vscode.ThemeIcon(
        active ? "folder-active" : "folder",
        active ? new vscode.ThemeColor("charts.green") : undefined,
      );
      item.contextValue = active ? "project-active" : "project";
      item.tooltip = new vscode.MarkdownString(
        [
          `**${row.project.name}**${active ? " — _active_" : ""}`,
          ...(row.project.description ? ["", row.project.description] : []),
          "",
          "Click to switch the active scope. Right-click to edit, manage AI context, or remove.",
        ].join("\n"),
      );
      item.command = {
        command: "aiSharePoint.activateProject",
        title: "Switch to Project",
        arguments: [row.project.id],
      };
      return item;
    }
    const p = row.project;
    const oneLine = (s?: string) => (s ? s.split("\n")[0].slice(0, 60) : undefined);
    switch (row.field) {
      case "goals": {
        const item = new vscode.TreeItem(`Goals: ${oneLine(p.goals) ?? "not set"}`);
        item.iconPath = new vscode.ThemeIcon("target");
        item.tooltip = p.goals ?? "User-defined goals — set via Edit Project.";
        item.contextValue = "project-detail";
        return item;
      }
      case "instructions": {
        const item = new vscode.TreeItem(
          `Instructions: ${p.instructions ? oneLine(p.instructions) : "not set"}`,
        );
        item.iconPath = new vscode.ThemeIcon("book");
        item.tooltip = p.instructions ?? "User-defined reference context / baseline instructions.";
        item.contextValue = "project-detail";
        return item;
      }
      case "ai": {
        const notes = p.aiContext ? p.aiContext.split("\n").filter(Boolean).length : 0;
        const item = new vscode.TreeItem(`AI-managed context: ${notes} note${notes === 1 ? "" : "s"}`);
        item.iconPath = new vscode.ThemeIcon("sparkle");
        item.tooltip = new vscode.MarkdownString(
          notes > 0
            ? `_AI-managed — learned as you teach @sharepoint, kept separate from your instructions:_\n\n${p.aiContext}`
            : "The assistant saves learnings here as you teach it (separate from your own instructions). Click to view/reset.",
        );
        item.contextValue = "project-ai";
        item.command = {
          command: "aiSharePoint.manageProjectAiContext",
          title: "Manage AI Context",
          arguments: [p.id],
        };
        return item;
      }
      case "sources":
      default: {
        const names = p.sourceIds
          .map((id) => this.sources.get(id)?.displayName)
          .filter(Boolean) as string[];
        const item = new vscode.TreeItem(`Sources: ${names.length}`);
        item.iconPath = new vscode.ThemeIcon("plug");
        item.tooltip = names.length ? names.join("\n") : "No sources yet — set via Edit Project.";
        item.contextValue = "project-detail";
        return item;
      }
    }
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
