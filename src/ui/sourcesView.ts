import * as vscode from "vscode";
import { ContextSourcesStore } from "../context/sourcesStore";
import { BookmarksStore } from "../context/bookmarksStore";
import { SchemaStore } from "../context/schemaStore";
import { CatalogStore } from "../context/catalogStore";
import { isExpired, catalogAge } from "../context/catalogCache";
import { ContextSource, ContextBookmark } from "../context/types";
import { isSrvLocator } from "../context/ldap/srvLocator";
import { SitesStore, SiteConnection } from "../auth/sitesStore";
import { siteTreeItem } from "./sitesView";
import { MemoryStore } from "../context/memoryStore";
import { MemoryItem } from "../context/memory";
import { FileSourcesStore } from "../context/files/fileSourcesStore";
import { FileSource } from "../context/files/fileSources";
import { describeKind } from "../context/files/fileContent";
import {
  MemoryGroupNode,
  isMemoryGroup,
  isMemoryItem,
  memoryGroupChildren,
  memoryGroupTreeItem,
  memoryItemTreeItem,
  hasMemory,
} from "./memoryTree";
import {
  SourceGroupNode,
  isSourceGroup,
  ICON_BY_TYPE,
  groupSourcesByType,
  groupFiles,
  groupReferenceSites,
} from "./sourceGrouping";

const DB_TYPES = new Set(["mssql", "postgres", "mysql", "mongodb"]);

type Node =
  | ContextSource
  | ContextBookmark
  | SiteConnection
  | MemoryGroupNode
  | MemoryItem
  | FileSource
  | SourceGroupNode;

function isBookmark(node: Node): node is ContextBookmark {
  return (node as ContextBookmark).locator !== undefined && (node as MemoryItem).origin === undefined;
}

function isSiteConnection(node: Node): node is SiteConnection {
  return (node as SiteConnection).siteUrl !== undefined && (node as SiteConnection).role !== undefined;
}

/** A registered file context source (local or OneDrive/SharePoint). Unique among
 *  node types by its `location` field. */
function isFileSource(node: Node): node is FileSource {
  return (node as FileSource).location !== undefined && (node as FileSource).kind !== undefined;
}

/**
 * Reference Sources view (PLAN §9 unified surface): all read-only references —
 * read-only/reference SharePoint sites first, then context sources (Confluence,
 * Jira, databases, …) with their saved bookmarks (ADR-0010) as children.
 */
export class SourcesTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private readonly sources: ContextSourcesStore,
    private readonly sites: SitesStore,
    private readonly bookmarks: BookmarksStore,
    private readonly schemas: SchemaStore,
    private readonly catalogs: CatalogStore,
    private readonly memory: MemoryStore,
    private readonly files: FileSourcesStore,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly scope: (all: ContextSource[]) => ContextSource[] = (all) => all,
  ) {
    sources.onDidChange(() => this.emitter.fire());
    sites.onDidChange(() => this.emitter.fire());
    bookmarks.onDidChange(() => this.emitter.fire());
    schemas.onDidChange(() => this.emitter.fire());
    catalogs.onDidChange(() => this.emitter.fire());
    memory.onDidChange(() => this.emitter.fire());
    files.onDidChange(() => this.emitter.fire());
  }

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (isSourceGroup(node)) return this.groupItem(node);
    if (isMemoryGroup(node)) return memoryGroupTreeItem(node, this.memory);
    if (isMemoryItem(node)) return memoryItemTreeItem(node);
    if (isFileSource(node)) return this.fileItem(node);
    if (isSiteConnection(node)) {
      const item = siteTreeItem(node);
      // A reference site can carry memory → make it expandable for the group.
      if (hasMemory(this.memory, { kind: "site", key: node.siteUrl })) {
        item.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
      }
      return item;
    }
    return isBookmark(node) ? this.bookmarkItem(node) : this.sourceItem(node);
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      const referenceSites = this.sites.list().filter((c) => c.role === "reference");
      // Managed context sources (e.g. a managed Confluence space) live under
      // Managed Sites; Reference Sources keeps the read-only ones.
      const referenceSources = this.scope(this.sources.list().filter((s) => s.role !== "managed"));
      // Registered files (local + OneDrive/SharePoint) are read-only context too,
      // so they belong in this list — otherwise the user can't see what's added.
      // Same-type sources, multiple files, and multiple sites each fold into a
      // group; singletons stay at the top level (see sourceGrouping).
      return [
        ...groupReferenceSites(referenceSites),
        ...groupSourcesByType(referenceSources),
        ...groupFiles(this.files.list()),
      ];
    }
    if (isSourceGroup(node)) return node.children;
    if (isMemoryGroup(node)) return this.memory.listForScope(node.memoryScope);
    if (isMemoryItem(node) || isBookmark(node) || isFileSource(node)) return [];
    if (isSiteConnection(node)) return memoryGroupChildren(this.memory, { kind: "site", key: node.siteUrl });
    return [
      ...this.bookmarks.listForSource(node.id),
      ...memoryGroupChildren(this.memory, { kind: "source", key: node.id }),
    ];
  }

  /** A group header (same-type sources, the Files folder, or the sites folder):
   *  collapsible and expanded by default so the folding organizes without hiding
   *  anything on first view. Expanding it reveals nested children, which is what
   *  makes VS Code draw the vertical indent guide down to them. */
  private groupItem(node: SourceGroupNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
    item.id = node.id;
    item.iconPath = new vscode.ThemeIcon(node.icon);
    item.contextValue = "context-source-group";
    return item;
  }

  private fileItem(source: FileSource): vscode.TreeItem {
    const item = new vscode.TreeItem(source.label, vscode.TreeItemCollapsibleState.None);
    item.id = `file:${source.id}`;
    const where = source.location.kind === "local" ? "local file" : "OneDrive/SharePoint";
    item.description = `${describeKind(source.kind)} · ${where}`;
    const tabular = source.kind === "csv" || source.kind === "tsv" || source.kind === "xlsx" || source.kind === "xls";
    item.iconPath = new vscode.ThemeIcon(tabular ? "table" : "file");
    item.contextValue = "context-file";
    const loc = source.location.kind === "local" ? source.location.path : (source.location.webUrl ?? "OneDrive/SharePoint item");
    const cell = (s: string) => s.replace(/\|/g, "\\|");
    item.tooltip = new vscode.MarkdownString(
      [
        `**${cell(source.label)}** _(read-only file context)_`,
        "",
        `| | |`,
        `|---|---|`,
        `| Kind | ${describeKind(source.kind)} |`,
        `| Location | ${cell(loc)} |`,
        `| Added | ${source.addedAt} |`,
        "",
        `_Click to read · @sharepoint reads it with \`#spReadFile\`._`,
      ].join("\n"),
    );
    item.command = { command: "aiSharePoint.readFileSource", title: "Read", arguments: [source] };
    return item;
  }

  private sourceItem(source: ContextSource): vscode.TreeItem {
    const bookmarkCount = this.bookmarks.listForSource(source.id).length;
    const expandable = bookmarkCount > 0 || hasMemory(this.memory, { kind: "source", key: source.id });
    const item = new vscode.TreeItem(
      source.displayName,
      expandable
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    item.id = source.id;
    const locked = this.sources.isLockedOut(source.id);
    item.description = `${source.alias ? `“${source.alias}” · ` : ""}${source.type} · ${source.deployment}${locked ? " · locked" : ""}`;
    const icon = ICON_BY_TYPE[source.type] ?? "book"; // confluence (and any future type) → book
    item.iconPath = new vscode.ThemeIcon(
      icon,
      locked
        ? new vscode.ThemeColor("charts.red")
        : source.lastVerifiedAt
          ? new vscode.ThemeColor("charts.green")
          : new vscode.ThemeColor("charts.yellow"),
    );
    item.contextValue = locked
      ? "context-source-locked"
      : DB_TYPES.has(source.type)
        ? "context-source-db"
        : source.type === "confluence" || source.type === "jira"
          ? "context-source-atlassian"
          : "context-source";
    const cell = (s: string) => s.replace(/\|/g, "\\|");
    item.tooltip = new vscode.MarkdownString(
      [
        `**${source.displayName}** _(read-only context — PLAN §9)_`,
        ...(source.description ? ["", `_${cell(source.description)}_`] : []),
        "",
        `| | |`,
        `|---|---|`,
        ...(source.alias
          ? [`| Chat alias | “${cell(source.alias)}” — e.g. \`@sharepoint find … in ${cell(source.alias)}\` |`]
          : []),
        `| Type | ${source.type} (${source.deployment}) |`,
        `| URL | ${source.baseUrl} |`,
        ...(isSrvLocator(source.baseUrl)
          ? [`| Resolution | DNS SRV on every connection (durable — survives DC changes) |`]
          : []),
        ...(source.baseDn ? [`| Base DN | ${source.baseDn} |`] : []),
        `| Auth | ${source.authMethod === "pat" ? (source.type === "grafana" ? "Service account token" : "Personal access token") : source.authMethod === "github-oauth" ? "GitHub sign-in (OAuth)" : source.authMethod === "github-app" ? "GitHub App installation token" : source.authMethod === "sfx-token" ? "Access token (X-SF-TOKEN)" : source.authMethod === "ldap-simple" ? "LDAP simple bind (UPN/DN + password)" : source.authMethod === "ntlm" ? "Windows Authentication (NTLM)" : source.authMethod === "aad-sso" ? "Microsoft 365 SSO (shared with your site sign-in)" : "Basic (username + token/password)"} |`,
        `| Account | ${source.account ?? "_not verified_"} |`,
        `| Verified | ${source.lastVerifiedAt ?? "_never_"} |`,
        ...(bookmarkCount > 0 ? [`| Bookmarks | ${bookmarkCount} |`] : []),
        ...(DB_TYPES.has(source.type)
          ? [
              `| Schema | ${(() => {
                const s = this.schemas.getSync(source.id);
                if (!s) return "_not loaded — right-click → Load Schema_";
                return `${s.catalog.tables.length} tables · semantic index ${s.semanticState}${s.semantic?.partial ? " (partial)" : ""}`;
              })()} |`,
            ]
          : []),
        ...(source.type === "confluence" || source.type === "jira"
          ? [
              `| Catalog | ${(() => {
                const c = this.catalogs.getSync(source.id);
                if (!c) return "_not pre-cached — offered on first browse_";
                return `${c.entries.length} entries · cached ${catalogAge(c, this.now())}${isExpired(c, this.now()) ? " · **expired**" : ""}${c.complete ? "" : " · partial"}`;
              })()} |`,
            ]
          : []),
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
