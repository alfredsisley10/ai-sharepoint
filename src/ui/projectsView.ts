import * as vscode from "vscode";
import { ProjectsStore } from "../context/projectsStore";
import { ContextSourcesStore } from "../context/sourcesStore";
import { ChatWorkspaceStore } from "../context/chatWorkspaceStore";
import { Project } from "../context/types";

type Row =
  | { kind: "project"; project: Project }
  | { kind: "detail"; project: Project; field: "goals" | "instructions" | "ai" | "sources" | "workspace" }
  | { kind: "dir"; uri: vscode.Uri; name: string }
  | { kind: "file"; uri: vscode.Uri; name: string };

/** Order directory entries: folders first, then files, each alphabetical. */
function sortEntries(entries: [string, vscode.FileType][]): [string, vscode.FileType][] {
  return [...entries].sort((a, b) => {
    const aDir = a[1] === vscode.FileType.Directory ? 0 : 1;
    const bDir = b[1] === vscode.FileType.Directory ? 0 : 1;
    return aDir - bDir || a[0].localeCompare(b[0]);
  });
}

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
    private readonly chatWorkspace?: ChatWorkspaceStore,
  ) {
    projects.onDidChange(() => this.emitter.fire());
    chatWorkspace?.onDidChange(() => this.emitter.fire());
  }

  async getChildren(row?: Row): Promise<Row[]> {
    if (!row) {
      return this.projects.list().map((project) => ({ kind: "project" as const, project }));
    }
    if (row.kind === "project") {
      return (["goals", "instructions", "ai", "sources", "workspace"] as const).map((field) => ({
        kind: "detail" as const,
        project: row.project,
        field,
      }));
    }
    // The workspace row (when on) and any folder under it browse the on-disk
    // project workspace — where the space dossier (inventory, owners,
    // dossier.xlsx, recommended-revision scaffolds, per-owner outreach) and chat
    // transcripts are written, so the user can open all project content here.
    if (row.kind === "detail" && row.field === "workspace" && this.chatWorkspace?.enabled(row.project.id)) {
      return this.readDir(this.chatWorkspace.baseUri(row.project));
    }
    if (row.kind === "dir") {
      return this.readDir(row.uri);
    }
    return [];
  }

  private async readDir(uri: vscode.Uri): Promise<Row[]> {
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(uri);
    } catch {
      return []; // folder not created yet (no dossier / transcript written)
    }
    return sortEntries(entries).map(([name, type]) =>
      type === vscode.FileType.Directory
        ? { kind: "dir" as const, uri: vscode.Uri.joinPath(uri, name), name }
        : { kind: "file" as const, uri: vscode.Uri.joinPath(uri, name), name },
    );
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
    if (row.kind === "dir") {
      // Plain tree item (not resourceUri-backed) so it renders with uniform
      // indentation/indent-guides like the rest of the Projects tree.
      const item = new vscode.TreeItem(row.name, vscode.TreeItemCollapsibleState.Collapsed);
      item.iconPath = vscode.ThemeIcon.Folder;
      item.contextValue = "project-file-dir";
      return item;
    }
    if (row.kind === "file") {
      const item = new vscode.TreeItem(row.name, vscode.TreeItemCollapsibleState.None);
      item.iconPath = vscode.ThemeIcon.File;
      item.contextValue = "project-file";
      item.tooltip = row.uri.fsPath;
      // Open on click — text files in an editor tab; xlsx and other binaries in
      // their default app.
      item.command = { command: "vscode.open", title: "Open", arguments: [row.uri] };
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
      case "workspace": {
        const on = this.chatWorkspace?.enabled(p.id) ?? false;
        // When on, expand to browse the workspace files (dossier, owners,
        // dossier.xlsx, recommended scaffolds, outreach, transcripts).
        const item = new vscode.TreeItem(
          `Workspace files${on ? "" : ": off"}`,
          on ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
        );
        item.iconPath = new vscode.ThemeIcon(on ? "folder-active" : "new-folder");
        item.tooltip = new vscode.MarkdownString(
          on
            ? "Browse this project's workspace: the space **dossier** (inventory, owners, `dossier.xlsx`, recommended-revision scaffolds, per-owner outreach) and chat transcripts. Expand to open any file; click the label to open the SUMMARY."
            : "Off. Start a chat workspace to save this project's conversations and dossiers into a browsable folder. Click to start.",
        );
        item.contextValue = on ? "project-workspace-on" : "project-workspace-off";
        item.command = {
          command: on ? "aiSharePoint.openProjectWorkspace" : "aiSharePoint.startProjectWorkspace",
          title: on ? "Open Workspace" : "Start Workspace",
          arguments: [p],
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
