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

const DB_TYPES = new Set(["mssql", "postgres", "mysql", "mongodb"]);

type Node = ContextSource | ContextBookmark | SiteConnection;

function isBookmark(node: Node): node is ContextBookmark {
  return (node as ContextBookmark).locator !== undefined;
}

function isSiteConnection(node: Node): node is SiteConnection {
  return (node as SiteConnection).siteUrl !== undefined && (node as SiteConnection).role !== undefined;
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
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly scope: (all: ContextSource[]) => ContextSource[] = (all) => all,
  ) {
    sources.onDidChange(() => this.emitter.fire());
    sites.onDidChange(() => this.emitter.fire());
    bookmarks.onDidChange(() => this.emitter.fire());
    schemas.onDidChange(() => this.emitter.fire());
    catalogs.onDidChange(() => this.emitter.fire());
  }

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (isSiteConnection(node)) return siteTreeItem(node);
    return isBookmark(node) ? this.bookmarkItem(node) : this.sourceItem(node);
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      const referenceSites = this.sites.list().filter((c) => c.role === "reference");
      // Managed context sources (e.g. a managed Confluence space) live under
      // Managed Sites; Reference Sources keeps the read-only ones.
      const referenceSources = this.scope(this.sources.list().filter((s) => s.role !== "managed"));
      return [...referenceSites, ...referenceSources];
    }
    if (isBookmark(node) || isSiteConnection(node)) return [];
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
    item.description = `${source.alias ? `“${source.alias}” · ` : ""}${source.type} · ${source.deployment}${locked ? " · locked" : ""}`;
    const ICON_BY_TYPE: Record<string, string> = {
      jira: "issues",
      github: "github",
      ldap: "organization",
      vertexai: "search",
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
        `| Auth | ${source.authMethod === "pat" ? (source.type === "vertexai" ? "OAuth access token" : source.type === "grafana" ? "Service account token" : "Personal access token") : source.authMethod === "sfx-token" ? "Access token (X-SF-TOKEN)" : source.authMethod === "ldap-simple" ? "LDAP simple bind (UPN/DN + password)" : source.authMethod === "ntlm" ? "Windows Authentication (NTLM)" : source.authMethod === "gcloud-sso" ? "Google SSO (live token from the gcloud CLI — never stored)" : source.authMethod === "aad-sso" ? "Microsoft 365 SSO (shared with your site sign-in)" : "Basic (username + token/password)"} |`,
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
