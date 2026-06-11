import * as vscode from "vscode";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildBundle,
  bundleToMarkdown,
  scanForLeaks,
  BundleScope,
  BundleInputs,
} from "./bundle";
import { InstallIdStore } from "./installId";
import { TelemetryService } from "./telemetry";
import { ErrorReportStore } from "./errorReports";
import { UsageMeter } from "../copilot/meter";
import { SitesStore } from "../auth/sitesStore";
import { anonHost, anonToken } from "../core/anonymize";
import { GRAPH_POWERSHELL_CLIENT_ID } from "../auth/authConfig";
import { Logger } from "../core/log";

/**
 * The user-facing export pipeline (ADR-0018):
 *   choose scope → assemble anonymized bundle → leak-scan → preview →
 *   explicit confirm → save JSON (+ Markdown companion) → reveal.
 *
 * Everything before "save" is in-memory; nothing is written unless the user
 * confirms, and a "block"-severity leak finding aborts the export entirely.
 */
export class DiagnosticsExportService {
  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly installIds: InstallIdStore,
    private readonly telemetry: TelemetryService,
    private readonly errors: ErrorReportStore,
    private readonly meter: UsageMeter,
    private readonly sites: SitesStore,
    private readonly log: Logger,
    private readonly now: () => string,
  ) {}

  async run(): Promise<void> {
    const scopePick = await vscode.window.showQuickPick(
      [
        {
          label: "$(package) Full bundle",
          description: "usage + feature counters + error reports",
          detail: "Best for bug reports — gives the development team the complete picture.",
          scope: "full" as BundleScope,
        },
        {
          label: "$(graph) Usage only",
          description: "Copilot usage and feature counters",
          scope: "usage" as BundleScope,
        },
        {
          label: "$(bug) Error reports only",
          description: "redacted error reports",
          scope: "errors" as BundleScope,
        },
      ],
      {
        title: "Export diagnostics — choose what to include",
        placeHolder: "All data is anonymized and previewed before anything is saved",
      },
    );
    if (!scopePick) return;

    const bundle = buildBundle(this.assembleInputs(scopePick.scope));
    const json = JSON.stringify(bundle, null, 2);
    const markdown = bundleToMarkdown(bundle);

    // Defense-in-depth gate: refuse to export anything secret-shaped.
    const findings = scanForLeaks(json, [bundle.anonymousInstallId]);
    const blockers = findings.filter((f) => f.severity === "block");
    if (blockers.length > 0) {
      this.log.error(
        `Diagnostics export blocked by leak scan: ${blockers
          .map((f) => `${f.pattern}×${f.count}`)
          .join(", ")}`,
      );
      void vscode.window.showErrorMessage(
        `Diagnostics export blocked: the safety scan found ${blockers.length} pattern(s) that look like sensitive data (${blockers
          .map((f) => f.pattern)
          .join(", ")}). Nothing was written. Please report this via the extension repository.`,
      );
      return;
    }

    // Preview: the human-readable companion, exactly as it would be saved.
    const previewDoc = await vscode.workspace.openTextDocument({
      content: markdown,
      language: "markdown",
    });
    await vscode.window.showTextDocument(previewDoc, { preview: true });

    const warnNote =
      findings.length > 0
        ? ` Review note: ${findings
            .map((f) => `${f.count}× ${f.pattern}`)
            .join(", ")} present (non-secret patterns, listed for transparency).`
        : "";
    const choice = await vscode.window.showInformationMessage(
      `Export this diagnostics bundle? This is the exact content that will be saved — nothing is sent anywhere by the extension.${warnNote}`,
      { modal: true },
      "Save Bundle…",
      "Copy JSON to Clipboard",
    );
    if (!choice) return;

    if (choice === "Copy JSON to Clipboard") {
      await vscode.env.clipboard.writeText(json);
      this.telemetry.record("diagnostics.export", { scope: scopePick.scope, via: "clipboard" });
      void vscode.window.showInformationMessage(
        "Diagnostics bundle JSON copied to clipboard.",
      );
      return;
    }

    const stamp = this.now().replace(/[-:]/g, "").slice(0, 13); // YYYYMMDDTHHMM
    const defaultUri = vscode.Uri.file(
      path.join(os.homedir(), `ai-sharepoint-diagnostics-${stamp}.json`),
    );
    const target = await vscode.window.showSaveDialog({
      defaultUri,
      filters: { "Diagnostics bundle (JSON)": ["json"] },
      title: "Save diagnostics bundle",
    });
    if (!target) return;

    await vscode.workspace.fs.writeFile(target, Buffer.from(json, "utf8"));
    const mdUri = target.with({ path: target.path.replace(/\.json$/i, "") + ".md" });
    await vscode.workspace.fs.writeFile(mdUri, Buffer.from(markdown, "utf8"));

    this.telemetry.record("diagnostics.export", { scope: scopePick.scope, via: "file" });
    this.log.info(`Diagnostics bundle exported (scope: ${scopePick.scope}).`);

    const action = await vscode.window.showInformationMessage(
      `Diagnostics bundle saved (JSON + Markdown). Share it with your support contact or attach it to an issue.`,
      "Reveal in File Manager",
      "Copy Path",
    );
    if (action === "Reveal in File Manager") {
      await vscode.commands.executeCommand("revealFileInOS", target);
    } else if (action === "Copy Path") {
      await vscode.env.clipboard.writeText(target.fsPath);
    }
  }

  private assembleInputs(scope: BundleScope): BundleInputs {
    const identity = this.installIds.get();
    const nowIso = this.now();
    const cfg = vscode.workspace.getConfiguration("aiSharePoint");
    const allowance = Math.max(
      1,
      cfg.get<number>("copilot.monthlyPremiumRequestAllowance", 300),
    );
    const usage = this.meter.snapshot(nowIso);

    return {
      generatedAt: nowIso,
      scope,
      anonymousInstallId: identity.id,
      environment: {
        extensionVersion: String(this.ctx.extension.packageJSON.version ?? "0.0.0"),
        vscodeVersion: vscode.version,
        platform: `${process.platform}-${process.arch}`,
        uiKind: vscode.env.uiKind === vscode.UIKind.Web ? "web" : "desktop",
        remoteName: vscode.env.remoteName,
        appHost: vscode.env.appHost,
      },
      settings: this.settingsSnapshot(identity.salt),
      sites: this.sites.list().map((s) => ({
        tenant: anonHost(s.tenantHost, identity.salt),
        role: s.role,
        authProviderId: s.authProviderId,
        verified: Boolean(s.lastVerifiedAt),
      })),
      usage: {
        monthPremiumUnits: usage.monthPremiumUnits,
        monthRequests: usage.monthRequests,
        monthFailures: usage.monthFailures,
        todayRequests: usage.todayRequests,
        allowance,
        usedPercent: (usage.monthPremiumUnits / allowance) * 100,
        byModel: usage.byModel.map((m) => ({
          key: m.key,
          requests: m.requests,
          premiumUnits: m.premiumUnits,
          inputTokens: m.inputTokens,
          outputTokens: m.outputTokens,
        })),
        byLabel: usage.byLabel.map((l) => ({
          key: l.key,
          requests: l.requests,
          premiumUnits: l.premiumUnits,
        })),
        daily: usage.daily,
      },
      telemetry: (() => {
        const snap = this.telemetry.snapshot();
        return {
          totalsByEvent: snap.totalsByEvent,
          daysCovered: snap.days,
          recentEvents: snap.recent.slice(-100),
        };
      })(),
      errors: this.errors.list(),
    };
  }

  /** Anonymized snapshot of this extension's settings (never raw org values). */
  private settingsSnapshot(
    salt: string,
  ): Record<string, string | number | boolean | string[]> {
    const cfg = vscode.workspace.getConfiguration("aiSharePoint");
    const authority = cfg.get<string>(
      "auth.tenantAuthority",
      "https://login.microsoftonline.com/common",
    );
    let authorityView = "default(common)";
    try {
      const u = new URL(authority);
      const tenantSeg = u.pathname.replace(/^\/|\/$/g, "");
      const wellKnown = ["common", "organizations", "consumers", ""];
      authorityView = `${u.hostname}/${
        wellKnown.includes(tenantSeg) ? tenantSeg || "(root)" : anonToken(tenantSeg, salt)
      }`;
    } catch {
      authorityView = "invalid-url";
    }
    const clientId = cfg.get<string>("auth.clientId", "").trim();
    return {
      "copilot.monthlyPremiumRequestAllowance": cfg.get<number>(
        "copilot.monthlyPremiumRequestAllowance",
        300,
      ),
      "copilot.preferredModelFamily":
        cfg.get<string>("copilot.preferredModelFamily", "") || "(economy-first default)",
      "budget.mode": cfg.get<string>("budget.mode", "block"),
      "budget.softLimitPercent": cfg.get<number>("budget.softLimitPercent", 80),
      "budget.hardLimitPercent": cfg.get<number>("budget.hardLimitPercent", 100),
      "auth.tenantAuthority": authorityView,
      "auth.clientId":
        !clientId || clientId === GRAPH_POWERSHELL_CLIENT_ID
          ? "(default first-party app)"
          : anonToken(clientId, salt),
      "auth.additionalAuthorityHosts": cfg
        .get<string[]>("auth.additionalAuthorityHosts", [])
        .map((h) => anonToken(h, salt)),
      "diagnostics.usageCapture": cfg.get<string>("diagnostics.usageCapture", "followVSCode"),
      "diagnostics.errorCapture": cfg.get<boolean>("diagnostics.errorCapture", true),
    };
  }
}
