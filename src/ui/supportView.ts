import * as vscode from "vscode";
import { ErrorReportStore } from "../diagnostics/errorReports";

interface SupportNode {
  id: string;
  label: string;
  description?: string;
  icon: vscode.ThemeIcon;
  tooltip?: string;
  command?: vscode.Command;
  contextValue?: string;
}

/**
 * Support & Diagnostics view: the enterprise operability surface. Everything
 * a user needs when something goes wrong — or when IT asks "what does this
 * thing collect?" — is one click away.
 */
export class SupportTreeProvider implements vscode.TreeDataProvider<SupportNode> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private readonly errors: ErrorReportStore,
    private readonly version: string,
    private readonly verboseWireOn: () => boolean = () => false,
  ) {
    errors.onDidChange(() => this.emitter.fire());
  }

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(node: SupportNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.label);
    item.id = node.id;
    item.description = node.description;
    item.iconPath = node.icon;
    item.tooltip = node.tooltip;
    item.command = node.command;
    item.contextValue = node.contextValue;
    return item;
  }

  getChildren(node?: SupportNode): SupportNode[] {
    if (node) return [];
    const errorCount = this.errors.count();
    return [
      {
        id: "export",
        label: "Export Diagnostics Bundle…",
        description: "anonymized",
        icon: new vscode.ThemeIcon("export"),
        tooltip:
          "Build an anonymized usage + error report you can review and share with support. Nothing is transmitted automatically.",
        command: { command: "aiSharePoint.exportDiagnostics", title: "Export" },
      },
      {
        id: "errors",
        label: "Error Reports",
        description: errorCount === 0 ? "none" : `${errorCount}`,
        icon:
          errorCount === 0
            ? new vscode.ThemeIcon("pass", new vscode.ThemeColor("charts.green"))
            : new vscode.ThemeIcon("bug", new vscode.ThemeColor("charts.red")),
        tooltip:
          "Locally stored, redacted error reports. Right-click to delete them.",
        command: { command: "aiSharePoint.showErrorReports", title: "Show" },
        contextValue: "errorReports",
      },
      {
        id: "logs",
        label: "Open Extension Logs",
        icon: new vscode.ThemeIcon("output"),
        command: { command: "aiSharePoint.openLogs", title: "Open Logs" },
      },
      {
        id: "verboseWire",
        label: "Verbose Wire Logging",
        description: this.verboseWireOn() ? "on" : "off",
        icon: this.verboseWireOn()
          ? new vscode.ThemeIcon("eye", new vscode.ThemeColor("charts.yellow"))
          : new vscode.ThemeIcon("eye-closed"),
        tooltip:
          "Log the full request/response detail of every integration — Graph (SharePoint/Teams/Outlook), Confluence/Jira, LDAP, databases, Vertex AI Search, Power BI, MSAL sign-in, and Copilot prompts. Secrets are redacted in layers (auth headers masked, token bodies withheld, credential-shaped values scrubbed). Local only; never included in diagnostics exports. Click to toggle.",
        command: { command: "aiSharePoint.toggleVerboseLogging", title: "Toggle" },
      },
      {
        id: "walkthrough",
        label: "Getting Started Walkthrough",
        icon: new vscode.ThemeIcon("rocket"),
        command: { command: "aiSharePoint.openWalkthrough", title: "Open" },
      },
      {
        id: "guide",
        label: "User Guide",
        icon: new vscode.ThemeIcon("book"),
        command: { command: "aiSharePoint.openUserGuide", title: "Open" },
      },
      {
        id: "privacy",
        label: "Privacy & Data Notice",
        icon: new vscode.ThemeIcon("law"),
        tooltip: "Exactly what is stored locally and what an exported bundle contains.",
        command: { command: "aiSharePoint.openPrivacyNotice", title: "Open" },
      },
      {
        id: "rotate",
        label: "Rotate Anonymous Install ID",
        icon: new vscode.ThemeIcon("refresh"),
        tooltip:
          "Generates a new anonymous ID and hash salt, severing correlation with previously exported bundles.",
        command: { command: "aiSharePoint.rotateAnonymousId", title: "Rotate" },
      },
      {
        id: "version",
        label: `AI SharePoint v${this.version}`,
        icon: new vscode.ThemeIcon("verified"),
        tooltip: "Extension version (included in diagnostics bundles).",
      },
    ];
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
