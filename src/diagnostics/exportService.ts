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
        ignoreFocusOut: true,
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
        monthRequests: usage.monthRequests,
        monthFailures: usage.monthFailures,
        todayRequests: usage.todayRequests,
        byModel: usage.byModel.map((m) => ({
          key: m.key,
          requests: m.requests,
          inputTokens: m.inputTokens,
          outputTokens: m.outputTokens,
        })),
        byLabel: usage.byLabel.map((l) => ({
          key: l.key,
          requests: l.requests,
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

  /**
   * Anonymized snapshot of EVERY contributed setting (never raw org values).
   * The key list is read from this build's manifest, so the bundle stays
   * complete as settings are added — no hand-maintained allowlist to drift out
   * of date (which previously left most settings out of support bundles).
   *
   * Classification is safe-by-default: booleans/numbers and fixed `enum`
   * strings are shown raw (categorical, non-identifying); any free-form string
   * or array element that could carry org identity (URLs, hosts, DNs, client
   * ids, model names) is one-way hashed; empty/default values are labeled.
   */
  private settingsSnapshot(
    salt: string,
  ): Record<string, string | number | boolean | string[]> {
    const cfg = vscode.workspace.getConfiguration("aiSharePoint");
    const out: Record<string, string | number | boolean | string[]> = {};

    for (const [fullKey, meta] of this.contributedSettings()) {
      const key = fullKey.replace(/^aiSharePoint\./, "");
      const value = cfg.get(key);
      if (typeof value === "boolean" || typeof value === "number") {
        out[key] = value; // categorical / non-identifying
      } else if (typeof value === "string") {
        const isDefault = meta.default !== undefined && value === meta.default;
        if (value === "") out[key] = "(empty)";
        else if (Array.isArray(meta.enum)) out[key] = value; // fixed vocabulary
        else if (isDefault) out[key] = "(default)";
        else out[key] = anonToken(value, salt); // free-form → hash
      } else if (Array.isArray(value)) {
        out[key] = value.length === 0
          ? []
          : value.map((v) => (typeof v === "string" ? anonToken(v, salt) : String(v)));
      } else if (value !== undefined && value !== null) {
        out[key] = "(configured)"; // object/other — presence only
      }
    }

    // Bespoke, more-readable views for the two auth settings support relies on.
    const authority = cfg.get<string>(
      "auth.tenantAuthority",
      "https://login.microsoftonline.com/common",
    );
    try {
      const u = new URL(authority);
      const tenantSeg = u.pathname.replace(/^\/|\/$/g, "");
      const wellKnown = ["common", "organizations", "consumers", ""];
      out["auth.tenantAuthority"] = `${u.hostname}/${
        wellKnown.includes(tenantSeg) ? tenantSeg || "(root)" : anonToken(tenantSeg, salt)
      }`;
    } catch {
      out["auth.tenantAuthority"] = "invalid-url";
    }
    const clientId = cfg.get<string>("auth.clientId", "").trim();
    out["auth.clientId"] =
      !clientId || clientId === GRAPH_POWERSHELL_CLIENT_ID
        ? "(default first-party app)"
        : anonToken(clientId, salt);

    return out;
  }

  /** All `aiSharePoint.*` settings declared in this build's manifest, with the
   *  bits of schema (default, enum) the snapshot needs to classify each value. */
  private contributedSettings(): Map<string, { default?: unknown; enum?: unknown[] }> {
    const map = new Map<string, { default?: unknown; enum?: unknown[] }>();
    const contributes = (this.ctx.extension.packageJSON as {
      contributes?: { configuration?: unknown };
    }).contributes;
    const blocks = Array.isArray(contributes?.configuration)
      ? contributes!.configuration
      : contributes?.configuration
        ? [contributes.configuration]
        : [];
    for (const block of blocks as Array<{ properties?: Record<string, { default?: unknown; enum?: unknown[] }> }>) {
      for (const [key, schema] of Object.entries(block?.properties ?? {})) {
        if (key.startsWith("aiSharePoint.")) {
          map.set(key, { default: schema?.default, enum: schema?.enum });
        }
      }
    }
    return map;
  }
}
