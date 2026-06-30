import * as vscode from "vscode";
import { ErrorReportStore } from "../diagnostics/errorReports";
import { TelemetryStatus } from "../diagnostics/telemetryConfig";

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
    private readonly telemetry: () => TelemetryStatus = () => ({
      enabled: false,
      splunkTokenSet: false,
      otlpHeaderSet: false,
      active: false,
    }),
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
    const tel = this.telemetry();
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
          "Log the full request/response detail of every integration — Graph (SharePoint/Teams/Outlook), Confluence/Jira, LDAP, databases, Power BI, MSAL sign-in, and Copilot prompts. Secrets are redacted in layers (auth headers masked, token bodies withheld, credential-shaped values scrubbed). Local only; never included in diagnostics exports. Click to toggle.",
        command: { command: "aiSharePoint.toggleVerboseLogging", title: "Toggle" },
      },
      {
        id: "telemetry",
        label: "Usage Telemetry (Splunk / OTEL)",
        description: tel.active ? "sending" : tel.enabled ? "enabled — set an endpoint" : "off",
        icon: tel.active
          ? new vscode.ThemeIcon("broadcast", new vscode.ThemeColor("charts.green"))
          : new vscode.ThemeIcon("broadcast"),
        tooltip:
          "Configure anonymized usage telemetry to a Splunk HEC and/or OTEL (OTLP) metrics endpoint. Opt-in and off by default; only categorical metrics + environment leave the machine (no content/PII). Connection details — including tokens — are stored in your OS keychain, never shown again, never in settings, and never in a diagnostics export. Click to manage.",
        command: { command: "aiSharePoint.manageTelemetry", title: "Manage" },
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
        id: "rebrand",
        label: "Rebrand / White-label…",
        icon: new vscode.ThemeIcon("paintcan"),
        tooltip:
          "Apply a new publisher/name/branding to the extension's source and repackage a white-labeled .vsix. Requires the extension source folder; warns before changing the extension ID (which would strand an existing deployment's data).",
        command: { command: "aiSharePoint.rebrandExtension", title: "Rebrand" },
      },
      {
        id: "version",
        label: `AI SharePoint v${this.version}`,
        description: "click to copy support info",
        icon: new vscode.ThemeIcon("verified"),
        tooltip:
          "Copy version + environment + the anonymous install ID for a support ticket (no site/account/PII).",
        command: { command: "aiSharePoint.copySupportInfo", title: "Copy support info" },
      },
    ];
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
