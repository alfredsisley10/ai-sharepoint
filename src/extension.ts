import * as vscode from "vscode";
import { SecretStore } from "./secrets/secretStore";
import { Logger } from "./core/log";
import { AppError, adviceFor } from "./core/errors";
import { redactError } from "./core/redaction";
import { UsageMeter } from "./copilot/meter";
import { BudgetGuard, BudgetBlockedError } from "./copilot/budget";
import { readBudgetConfigFromSettings } from "./copilot/vscodeBudgetConfig";
import { CopilotService } from "./copilot/copilotService";
import { AuthProviderRegistry, AUTH_PROVIDERS } from "./auth/providerRegistry";
import { tenantCacheHandle } from "./auth/msalCache";
import { isSupportedSiteUrl } from "./auth/sharePointClient";
import { SitesStore, SiteConnection } from "./auth/sitesStore";
import { SiteAccess } from "./auth/siteAccess";
import { InstallIdStore } from "./diagnostics/installId";
import { TelemetryService } from "./diagnostics/telemetry";
import { ErrorReportStore } from "./diagnostics/errorReports";
import { DiagnosticsExportService } from "./diagnostics/exportService";
import { SyncConfigStore, SiteSyncConfig } from "./sync/syncConfigStore";
import { SyncEngine } from "./sync/syncEngine";
import { openOrInitRepository } from "./sync/vscodeGit";
import {
  validateRemote,
  compareUrl,
  prBranchName,
  repoHygieneFiles,
  parseRemoteUrl,
} from "./sync/remotePolicy";
import {
  isBlocked,
  hasChanges,
  commitMessageFor,
  ChangeReport,
} from "./sync/changeReport";
import { UsageStatusBar } from "./ui/statusBar";
import { SitesTreeProvider } from "./ui/sitesView";
import { UsageTreeProvider } from "./ui/usageView";
import { SupportTreeProvider } from "./ui/supportView";
import { UsageDashboard } from "./ui/dashboard";
import { registerChatParticipant } from "./chat/participant";
import { registerLanguageModelTools } from "./chat/tools";

/** Host clock, isolated so it's the single source of "now" (ISO, UTC). */
const nowIso = () => new Date().toISOString();

export function activate(context: vscode.ExtensionContext): void {
  const log = new Logger("AI SharePoint");
  const responses = vscode.window.createOutputChannel("AI SharePoint — Copilot");
  const secrets = new SecretStore(context.secrets);
  const installIds = new InstallIdStore(context.globalState);
  const telemetry = new TelemetryService(context.globalState, nowIso);
  const errors = new ErrorReportStore(context.globalState, nowIso);
  const meter = new UsageMeter(context.globalState);
  const budget = new BudgetGuard(meter, readBudgetConfigFromSettings);
  const copilot = new CopilotService(meter, budget);
  const sites = new SitesStore(context.globalState, context.workspaceState);
  const registry = new AuthProviderRegistry(secrets, (info) => {
    void showDeviceCodePrompt(info.userCode, info.verificationUri);
  });
  const access = new SiteAccess(sites, registry);
  const exporter = new DiagnosticsExportService(
    context,
    installIds,
    telemetry,
    errors,
    meter,
    sites,
    log,
    nowIso,
  );
  const dashboard = new UsageDashboard(meter, budget, nowIso);
  const statusBar = new UsageStatusBar(meter, budget, nowIso);
  const version = String(context.extension.packageJSON.version ?? "0.0.0");

  context.subscriptions.push(
    log,
    responses,
    meter,
    errors,
    sites,
    statusBar,
    dashboard,
  );

  // --- Views -----------------------------------------------------------
  // "Signed in" is inferred from entitled chat models being available — the
  // only signal vscode.lm exposes. Kept current by refreshCopilotState below.
  const copilotState = { chatInstalled: false, signedIn: false };

  const sitesProvider = new SitesTreeProvider(sites);
  const usageProvider = new UsageTreeProvider(
    meter,
    budget,
    nowIso,
    () => copilotState.signedIn,
  );
  const supportProvider = new SupportTreeProvider(errors, version);
  const sitesView = vscode.window.createTreeView("aiSharePoint.sitesView", {
    treeDataProvider: sitesProvider,
  });
  const usageView = vscode.window.createTreeView("aiSharePoint.usageView", {
    treeDataProvider: usageProvider,
  });
  const supportView = vscode.window.createTreeView("aiSharePoint.supportView", {
    treeDataProvider: supportProvider,
  });
  context.subscriptions.push(sitesView, usageView, supportView, supportProvider);

  const syncContext = () => {
    void vscode.commands.executeCommand(
      "setContext",
      "aiSharePoint.hasSites",
      sites.list().length > 0,
    );
    supportView.badge =
      errors.count() > 0
        ? { value: errors.count(), tooltip: `${errors.count()} error report(s)` }
        : undefined;
  };
  syncContext();
  context.subscriptions.push(
    sites.onDidChange(syncContext),
    errors.onDidChange(syncContext),
  );

  // --- Copilot Chat presence/sign-in detection -----------------------------
  // Drives walkthrough auto-completion (onContext) and the Usage view's
  // guided empty state.
  const refreshCopilotState = async (): Promise<void> => {
    copilotState.chatInstalled = Boolean(
      vscode.extensions.getExtension("GitHub.copilot-chat"),
    );
    try {
      copilotState.signedIn =
        (await vscode.lm.selectChatModels({ vendor: "copilot" })).length > 0;
    } catch {
      copilotState.signedIn = false;
    }
    void vscode.commands.executeCommand(
      "setContext",
      "aiSharePoint.copilotChatInstalled",
      copilotState.chatInstalled,
    );
    void vscode.commands.executeCommand(
      "setContext",
      "aiSharePoint.copilotSignedIn",
      copilotState.signedIn,
    );
    usageProvider.refresh();
  };
  void refreshCopilotState();
  context.subscriptions.push(
    vscode.extensions.onDidChange(() => void refreshCopilotState()),
    vscode.lm.onDidChangeChatModels(() => void refreshCopilotState()),
  );

  // --- Chat + tools ------------------------------------------------------
  context.subscriptions.push(
    registerChatParticipant({
      ctx: context,
      sites,
      access,
      copilot,
      meter,
      budget,
      telemetry,
      errors,
      log,
      now: nowIso,
    }),
    ...registerLanguageModelTools(
      sites,
      access,
      meter,
      budget,
      telemetry,
      errors,
      nowIso,
    ),
  );

  // --- Command wrapper: telemetry + central error UX ---------------------
  const register = (
    id: string,
    fn: (...args: unknown[]) => unknown,
  ): void => {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args: unknown[]) => {
        telemetry.record("command", { id: id.replace("aiSharePoint.", "") });
        try {
          await fn(...args);
        } catch (err) {
          const code = errors.capture(id, err);
          log.error(`${id} failed`, err);
          if (code === "auth.cancelled") {
            return; // user backed out — not an error
          }
          const summary =
            err instanceof AppError && err.userSummary
              ? err.userSummary
              : redactError(err).message.slice(0, 200);
          const advice = adviceFor(code);
          const pick = await vscode.window.showErrorMessage(
            `AI SharePoint: ${summary}${advice ? ` — ${advice}` : ""}`,
            "Open Logs",
            "Export Diagnostics",
          );
          if (pick === "Open Logs") {
            log.show();
          } else if (pick === "Export Diagnostics") {
            await vscode.commands.executeCommand("aiSharePoint.exportDiagnostics");
          }
        }
      }),
    );
  };

  // --- Copilot commands ---------------------------------------------------
  register("aiSharePoint.installCopilotChat", async () => {
    // Open the extension's details page (reliable across VS Code versions);
    // fall back to the marketplace search the page is found under.
    try {
      await vscode.commands.executeCommand("extension.open", "GitHub.copilot-chat");
    } catch {
      await vscode.commands.executeCommand(
        "workbench.extensions.search",
        "github copilot chat",
      );
    }
  });

  register("aiSharePoint.checkCopilotStatus", async () => {
    await refreshCopilotState();
    if (!copilotState.chatInstalled) {
      const pick = await vscode.window.showWarningMessage(
        "GitHub Copilot Chat is not installed. AI SharePoint uses it (your own Copilot entitlement) for all AI features.",
        "Install GitHub Copilot Chat",
      );
      if (pick) {
        await vscode.commands.executeCommand("aiSharePoint.installCopilotChat");
      }
      return;
    }
    if (!copilotState.signedIn) {
      void vscode.window.showWarningMessage(
        "GitHub Copilot Chat is installed, but no Copilot models are available yet. Sign in to GitHub in VS Code (Accounts menu, bottom-left) and ensure your account has a Copilot subscription or seat.",
      );
      return;
    }
    const models = await copilot.listModels();
    void vscode.window.showInformationMessage(
      `Copilot is ready: ${models.length} model(s) available (default: ${models[0]?.name ?? "n/a"}).`,
    );
  });

  register("aiSharePoint.listModels", async () => {
    const models = await copilot.listModels();
    if (models.length === 0) {
      void vscode.window.showWarningMessage(
        "No Copilot models available. Is GitHub Copilot installed and signed in?",
      );
      return;
    }
    const preferred = vscode.workspace
      .getConfiguration("aiSharePoint")
      .get<string>("copilot.preferredModelFamily", "");
    const pick = await vscode.window.showQuickPick(
      models.map((m) => ({
        label: `$(circuit-board) ${m.name}`,
        description: `${m.badge} · ${m.tier}${m.family === preferred ? " · current default" : ""}`,
        detail: `family ${m.family} · max input ${m.maxInputTokens.toLocaleString()} tokens`,
        family: m.family,
      })),
      {
        title: "Copilot models — relative premium-request cost (estimate)",
        placeHolder: "Pick a model to set it as this extension's default (Esc to just browse)",
      },
    );
    if (pick) {
      await vscode.workspace
        .getConfiguration("aiSharePoint")
        .update("copilot.preferredModelFamily", pick.family, vscode.ConfigurationTarget.Global);
      void vscode.window.showInformationMessage(
        `Preferred Copilot model set to "${pick.family}". Clear it in Settings → AI SharePoint.`,
      );
    }
  });

  register("aiSharePoint.askCopilot", async () => {
    const prompt = await vscode.window.showInputBox({
      title: "Ask Copilot (metered)",
      prompt: "Usage is metered against your premium-request allowance — watch the status-bar gauge.",
      placeHolder: "e.g. Draft an outline for our team's SharePoint landing page",
    });
    if (!prompt) {
      return;
    }
    const model = await copilot.pickDefaultModel();
    log.info(
      `askCopilot: model=${model.family} (~${meter.multiplierFor(model.family || model.id)} premium unit(s) per request)`,
    );

    responses.show(true);
    responses.appendLine(`\n──────── ${nowIso()} · ${model.name} ────────`);
    responses.appendLine(`> ${prompt}\n`);

    const run = (override: boolean) =>
      vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Copilot (${model.name})…`,
          cancellable: true,
        },
        (_p, token) =>
          copilot.ask(
            {
              prompt,
              label: "askCopilot",
              model,
              overrideBudget: override,
              onChunk: (chunk) => responses.append(chunk),
              token,
            },
            nowIso,
          ),
      );

    try {
      const result = await run(false);
      responses.appendLine(
        `\n\n[${result.modelId} · ~${result.premiumUnits} premium unit(s) · ${result.inputTokens}/${result.outputTokens} tokens]`,
      );
    } catch (err) {
      if (err instanceof BudgetBlockedError) {
        const proceed = await vscode.window.showWarningMessage(
          `Copilot budget cap reached (~${err.verdict.usedPct.toFixed(0)}% of ${err.verdict.allowance} units; hard cap ${err.verdict.hardPct}%). Proceed with this one request anyway?`,
          { modal: true },
          "Proceed Once",
        );
        if (proceed === "Proceed Once") {
          telemetry.record("budget.override");
          const result = await run(true);
          responses.appendLine(
            `\n\n[${result.modelId} · ~${result.premiumUnits} premium unit(s) · budget override]`,
          );
          return;
        }
        return;
      }
      throw err;
    }
  });

  register("aiSharePoint.showUsage", () => dashboard.show());

  register("aiSharePoint.resetUsage", async () => {
    const confirm = await vscode.window.showWarningMessage(
      "Reset the local Copilot usage meter? This clears the extension's usage history (it does not affect GitHub billing).",
      { modal: true },
      "Reset Meter",
    );
    if (confirm === "Reset Meter") {
      await meter.reset();
      void vscode.window.showInformationMessage("Copilot usage meter reset.");
    }
  });

  register("aiSharePoint.setBudget", async () => {
    const cfg = vscode.workspace.getConfiguration("aiSharePoint");
    const allowance = await promptNumber(
      "Monthly premium-request allowance (the gauge's denominator)",
      cfg.get<number>("copilot.monthlyPremiumRequestAllowance", 300),
      1,
    );
    if (allowance === undefined) return;
    const soft = await promptNumber(
      "Soft cap — warn at this % of the allowance",
      cfg.get<number>("budget.softLimitPercent", 80),
      0,
    );
    if (soft === undefined) return;
    const hard = await promptNumber(
      "Hard cap — block at this % (requests can be individually overridden)",
      cfg.get<number>("budget.hardLimitPercent", 100),
      soft,
    );
    if (hard === undefined) return;
    await cfg.update(
      "copilot.monthlyPremiumRequestAllowance",
      allowance,
      vscode.ConfigurationTarget.Global,
    );
    await cfg.update("budget.softLimitPercent", soft, vscode.ConfigurationTarget.Global);
    await cfg.update("budget.hardLimitPercent", hard, vscode.ConfigurationTarget.Global);
    void vscode.window.showInformationMessage(
      `Budget updated: ${allowance} units/month, warn at ${soft}%, block at ${hard}%.`,
    );
  });

  register("aiSharePoint.openBudgetSettings", () =>
    vscode.commands.executeCommand(
      "workbench.action.openSettings",
      "aiSharePoint.budget",
    ),
  );

  // --- Site commands -------------------------------------------------------
  register("aiSharePoint.connectSite", async () => {
    const siteUrl = await vscode.window.showInputBox({
      title: "Connect SharePoint Site (1/3) — site URL",
      prompt: "Commercial, GCC High (.us) and 21Vianet (.cn) clouds are supported.",
      placeHolder: "https://contoso.sharepoint.com/sites/Marketing",
      validateInput: (v) =>
        isSupportedSiteUrl(v)
          ? undefined
          : "Enter a valid https://<tenant>.sharepoint.<com|us|cn> site URL",
    });
    if (!siteUrl) return;
    const trimmed = siteUrl.trim().replace(/\/+$/, "");

    const role = await vscode.window.showQuickPick(
      [
        {
          label: "$(cloud) managed",
          description: "Full lifecycle — sync/Git planned (PLAN §7)",
          value: "managed" as const,
        },
        {
          label: "$(eye) reference",
          description: "Read-only context for chat and tools",
          value: "reference" as const,
        },
      ],
      { title: "Connect SharePoint Site (2/3) — connection role" },
    );
    if (!role) return;

    const method = await vscode.window.showQuickPick(
      AUTH_PROVIDERS.map((p) => ({
        label: p.id === "msal-public-interactive" ? `$(globe) ${p.label}` : `$(device-mobile) ${p.label}`,
        detail: p.detail,
        id: p.id,
      })),
      { title: "Connect SharePoint Site (3/3) — sign-in method" },
    );
    if (!method) return;

    const tenantHost = new URL(trimmed).hostname;
    const cacheHandle = tenantCacheHandle(tenantHost);
    const provider = registry.create(method.id, cacheHandle);
    const client = access.clientFor(
      {
        siteUrl: trimmed,
        displayName: "",
        role: role.value,
        authProviderId: provider.id,
        cacheHandle,
        tenantHost,
      },
      { silent: false },
    );

    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Signing in and resolving the site…",
      },
      () => client.testConnection(trimmed),
    );

    await sites.upsert({
      siteUrl: trimmed,
      displayName: result.site.displayName,
      role: role.value,
      authProviderId: method.id,
      cacheHandle,
      tenantHost,
      account: result.account,
      addedAt: nowIso(),
      lastVerifiedAt: nowIso(),
    });
    telemetry.record("site.connect", { role: role.value, method: method.id });
    log.info(`Connected site (${role.value}) in ${result.latencyMs}ms`);

    const next = await vscode.window.showInformationMessage(
      `Connected to "${result.site.displayName}" as ${result.account}.`,
      "Ask @sharepoint",
    );
    if (next === "Ask @sharepoint") {
      await vscode.commands.executeCommand("workbench.action.chat.open", {
        query: "@sharepoint /site " + result.site.displayName,
      });
    }
  });

  register("aiSharePoint.testConnection", async (arg) => {
    const conn = await resolveConnArg(arg, sites, "Test which connection?");
    if (!conn) return;
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Testing ${conn.displayName}…`,
      },
      () => access.clientFor(conn).testConnection(conn.siteUrl),
    );
    await sites.markVerified(conn.siteUrl, nowIso(), result.account);
    telemetry.record("site.test");
    void vscode.window.showInformationMessage(
      `✓ "${result.site.displayName}" reachable in ${result.latencyMs}ms as ${result.account}.`,
    );
  });

  register("aiSharePoint.openSiteInBrowser", async (arg) => {
    const conn = await resolveConnArg(arg, sites, "Open which site?");
    if (conn) {
      await vscode.env.openExternal(vscode.Uri.parse(conn.siteUrl));
    }
  });

  register("aiSharePoint.copySiteUrl", async (arg) => {
    const conn = await resolveConnArg(arg, sites, "Copy which site URL?");
    if (conn) {
      await vscode.env.clipboard.writeText(conn.siteUrl);
      void vscode.window.showInformationMessage("Site URL copied.");
    }
  });

  register("aiSharePoint.changeSiteRole", async (arg) => {
    const conn = await resolveConnArg(arg, sites, "Change role of which connection?");
    if (!conn) return;
    const next = conn.role === "managed" ? "reference" : "managed";
    const confirm = await vscode.window.showInformationMessage(
      `Change "${conn.displayName}" from ${conn.role} to ${next}?`,
      { modal: true },
      `Change to ${next}`,
    );
    if (confirm) {
      await sites.setRole(conn.siteUrl, next);
      telemetry.record("site.changeRole", { to: next });
    }
  });

  register("aiSharePoint.signOutSite", async (arg) => {
    const conn = await resolveConnArg(arg, sites, "Sign out of which connection?");
    if (!conn) return;
    const confirm = await vscode.window.showWarningMessage(
      `Sign out of "${conn.displayName}"? Cached credentials for its tenant are removed from the OS keychain; other connections sharing the tenant will need sign-in again.`,
      { modal: true },
      "Sign Out",
    );
    if (confirm === "Sign Out") {
      await sites.signOut(conn.siteUrl, secrets);
      telemetry.record("site.signOut");
      void vscode.window.showInformationMessage("Signed out and credentials wiped.");
    }
  });

  register("aiSharePoint.removeSite", async (arg) => {
    const conn = await resolveConnArg(arg, sites, "Remove which connection?");
    if (!conn) return;
    const confirm = await vscode.window.showWarningMessage(
      `Remove "${conn.displayName}"? Cached tenant credentials are wiped from the keychain unless another connection still uses them.`,
      { modal: true },
      "Remove Connection",
    );
    if (confirm === "Remove Connection") {
      await sites.remove(conn.siteUrl, secrets);
      telemetry.record("site.remove");
    }
  });

  register("aiSharePoint.refreshSites", () => sitesProvider.refresh());

  // --- Site sync (Track B slice 1 — ADR-0019) -------------------------------
  const syncConfigs = new SyncConfigStore(context.globalState);
  const syncEngine = new SyncEngine(access, log);

  const requireManaged = (conn: SiteConnection): void => {
    if (conn.role !== "managed") {
      throw new AppError(
        "Reference connections are read-only context (PLAN §5). Change the connection role to 'managed' to enable sync.",
        "config",
        "This connection is read-only (reference role).",
      );
    }
  };
  const allowedRemoteHosts = (): string[] =>
    vscode.workspace
      .getConfiguration("aiSharePoint")
      .get<string[]>("sync.allowedRemoteHosts", ["github.com"]);

  register("aiSharePoint.configureSiteRepo", async (arg) => {
    const conn = await resolveConnArg(arg, sites, "Configure repository for which site?");
    if (!conn) return;
    requireManaged(conn);

    const existing = syncConfigs.get(conn.siteUrl);
    const folderPick = await vscode.window.showOpenDialog({
      title: `Site repository folder for "${conn.displayName}" (1/3)`,
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: "Use this folder",
      defaultUri: existing
        ? vscode.Uri.file(existing.folder)
        : vscode.workspace.workspaceFolders?.[0]?.uri,
    });
    if (!folderPick?.[0]) return;
    const folder = folderPick[0];

    const remoteUrl = await vscode.window.showInputBox({
      title: "Remote repository (2/3) — GitHub.com or your GitHub Enterprise Server",
      prompt: `Allowed hosts: ${allowedRemoteHosts().join(", ")} (admins extend via aiSharePoint.sync.allowedRemoteHosts). Leave empty for local-only.`,
      value: existing?.remoteUrl ?? "",
      placeHolder: "https://github.com/org/site-repo or git@github.corp.example:org/site-repo.git",
      validateInput: (v) => {
        if (!v.trim()) return undefined; // local-only is allowed
        const verdict = validateRemote(v, allowedRemoteHosts());
        return verdict.ok ? undefined : verdict.reason;
      },
    });
    if (remoteUrl === undefined) return;

    const gate = await vscode.window.showQuickPick(
      [
        {
          label: "$(git-pull-request) PR-gated",
          description: "push to a sharepoint-sync/* branch and open a pull request (recommended)",
          value: "pr" as const,
        },
        {
          label: "$(repo-push) Direct push",
          description: "push the base branch directly",
          value: "direct" as const,
        },
      ],
      { title: "Review gate (3/3) — how pushes reach the remote (ADR-0004)" },
    );
    if (!gate) return;

    const repo = await openOrInitRepository(folder);
    // Repo hygiene (ADR-0019 §4): LF normalization is what keeps snapshots
    // byte-stable across platforms; README only written when absent.
    for (const [rel, content] of repoHygieneFiles(conn.displayName, conn.siteUrl)) {
      const target = vscode.Uri.joinPath(folder, rel);
      if (rel === "README.md") {
        try {
          await vscode.workspace.fs.stat(target);
          continue;
        } catch {
          // absent — write it
        }
      }
      await vscode.workspace.fs.writeFile(target, Buffer.from(content, "utf8"));
    }
    const trimmedRemote = remoteUrl.trim();
    if (trimmedRemote && !repo.state.remotes.some((r) => r.name === "origin")) {
      await repo.addRemote("origin", trimmedRemote);
    }

    const config: SiteSyncConfig = {
      siteUrl: conn.siteUrl,
      folder: folder.fsPath,
      remoteUrl: trimmedRemote || undefined,
      baseBranch: existing?.baseBranch ?? repo.state.HEAD?.name ?? "main",
      reviewGate: gate.value,
    };
    await syncConfigs.set(config);
    telemetry.record("sync.configure", {
      gate: gate.value,
      hasRemote: Boolean(trimmedRemote),
    });
    void vscode.window.showInformationMessage(
      `Repository configured for "${conn.displayName}" (${gate.value === "pr" ? "PR-gated" : "direct push"}${trimmedRemote ? "" : ", local-only"}).`,
      "Pull Site Now",
    ).then((pick) => {
      if (pick) void vscode.commands.executeCommand("aiSharePoint.pullSiteToRepo", conn);
    });
  });

  register("aiSharePoint.pullSiteToRepo", async (arg) => {
    const conn = await resolveConnArg(arg, sites, "Pull which site to its repository?");
    if (!conn) return;
    requireManaged(conn);
    const config = syncConfigs.get(conn.siteUrl);
    if (!config) {
      const go = await vscode.window.showInformationMessage(
        `No repository configured for "${conn.displayName}" yet.`,
        "Configure Repository…",
      );
      if (go) await vscode.commands.executeCommand("aiSharePoint.configureSiteRepo", conn);
      return;
    }

    const plan = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Pulling ${conn.displayName}…`,
      },
      (p) => syncEngine.plan(conn, config.folder, (msg) => p.report({ message: msg })),
    );

    if (isBlocked(plan.report)) {
      log.error(
        `Pull blocked: ${plan.report.leakFindings.map((f) => `${f.pattern}(${f.sample})`).join("; ")} ${plan.report.oversize.join(";")}`,
      );
      void vscode.window.showErrorMessage(
        `Pull blocked: ${plan.report.leakFindings.length} credential-shaped finding(s) and ${plan.report.oversize.length} oversize file(s). Nothing was written — see logs.`,
      );
      return;
    }
    if (!hasChanges(plan.report)) {
      await sites.markVerified(conn.siteUrl, nowIso());
      void vscode.window.showInformationMessage(
        `"${conn.displayName}" is already up to date (${plan.report.unchanged} files unchanged).`,
      );
      return;
    }

    const previewDoc = await vscode.workspace.openTextDocument({
      language: "markdown",
      content: renderPullPreview(conn.displayName, config, plan.report),
    });
    await vscode.window.showTextDocument(previewDoc, { preview: true });
    const confirm = await vscode.window.showInformationMessage(
      `Apply ${plan.report.added.length} added, ${plan.report.updated.length} updated, ${plan.report.removed.length} removed file(s) to ${config.folder} and commit?`,
      { modal: true },
      "Apply & Commit",
    );
    if (!confirm) return;

    const staged = await syncEngine.apply(config.folder, plan.files, plan.report);
    const repo = await openOrInitRepository(vscode.Uri.file(config.folder));
    await repo.add(staged);
    const message = commitMessageFor(conn.displayName, plan.report);
    await repo.commit(message);
    await sites.markVerified(conn.siteUrl, nowIso());
    telemetry.record("sync.pull", {
      added: plan.report.added.length,
      updated: plan.report.updated.length,
      removed: plan.report.removed.length,
    });
    log.info(`Committed: ${message}`);

    const next = await vscode.window.showInformationMessage(
      `Committed "${message}".`,
      config.remoteUrl ? "Push to Remote" : "Configure Remote…",
    );
    if (next === "Push to Remote") {
      await vscode.commands.executeCommand("aiSharePoint.pushSiteRepo", conn);
    } else if (next === "Configure Remote…") {
      await vscode.commands.executeCommand("aiSharePoint.configureSiteRepo", conn);
    }
  });

  register("aiSharePoint.pushSiteRepo", async (arg) => {
    const conn = await resolveConnArg(arg, sites, "Push which site repository?");
    if (!conn) return;
    requireManaged(conn);
    const config = syncConfigs.get(conn.siteUrl);
    if (!config?.remoteUrl) {
      void vscode.window.showWarningMessage(
        "No remote configured for this site repository — run “Configure Site Repository…” first.",
      );
      return;
    }
    // Re-validate at push time: the allowlist may have tightened (ADR-0019 §2).
    const verdict = validateRemote(config.remoteUrl, allowedRemoteHosts());
    if (!verdict.ok || !verdict.info) {
      throw new AppError(verdict.reason ?? "Remote rejected.", "config",
        "The configured remote host is not allowlisted.");
    }

    const repo = await openOrInitRepository(vscode.Uri.file(config.folder));
    const base = config.baseBranch || repo.state.HEAD?.name || "main";
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Pushing site repository…" },
      async (p) => {
        if (config.reviewGate === "pr") {
          const branch = prBranchName(nowIso());
          p.report({ message: `branch ${branch}` });
          await repo.createBranch(branch, true);
          await repo.push("origin", branch, true);
          await repo.checkout(base);
          telemetry.record("sync.push", { gate: "pr" });
          const url = compareUrl(verdict.info!, base, branch);
          const open = await vscode.window.showInformationMessage(
            `Pushed ${branch}. Open a pull request to merge into ${base}.`,
            "Open Pull Request Page",
          );
          if (open) await vscode.env.openExternal(vscode.Uri.parse(url));
        } else {
          p.report({ message: `branch ${base}` });
          await repo.push("origin", base, true);
          telemetry.record("sync.push", { gate: "direct" });
          void vscode.window.showInformationMessage(
            `Pushed ${base} to ${parseRemoteUrl(config.remoteUrl!)?.host}.`,
          );
        }
      },
    );
  });

  // --- Diagnostics & support ------------------------------------------------
  register("aiSharePoint.exportDiagnostics", () => exporter.run());

  register("aiSharePoint.showErrorReports", async () => {
    const reports = errors.list();
    if (reports.length === 0) {
      void vscode.window.showInformationMessage("No error reports recorded. 🎉");
      return;
    }
    const pick = await vscode.window.showQuickPick(
      [
        ...reports.map((r) => ({
          label: `$(bug) ${r.code}`,
          description: `${r.context} · ×${r.count} · ${r.lastAt.slice(0, 16)}Z`,
          detail: r.message.slice(0, 120),
          report: r,
          action: undefined as string | undefined,
        })),
        {
          label: "$(export) Export diagnostics bundle…",
          description: "share anonymized reports with the development team",
          detail: undefined,
          report: undefined,
          action: "export",
        },
        {
          label: "$(clear-all) Clear all error reports",
          description: "",
          detail: undefined,
          report: undefined,
          action: "clear",
        },
      ],
      { title: `Error reports (${reports.length})`, matchOnDetail: true },
    );
    if (!pick) return;
    if (pick.action === "export") {
      await vscode.commands.executeCommand("aiSharePoint.exportDiagnostics");
      return;
    }
    if (pick.action === "clear") {
      await errors.clear();
      void vscode.window.showInformationMessage("Error reports cleared.");
      return;
    }
    if (pick.report) {
      const r = pick.report;
      const doc = await vscode.workspace.openTextDocument({
        language: "markdown",
        content: [
          `# Error report — \`${r.code}\``,
          "",
          `| | |`,
          `|---|---|`,
          `| Context | ${r.context} |`,
          `| Occurrences | ${r.count} (first ${r.firstAt}, last ${r.lastAt}) |`,
          "",
          `**${r.name}:** ${r.message}`,
          "",
          ...(r.stack ? ["```", r.stack, "```"] : []),
          "",
          "_Redacted at capture time. Share via Export Diagnostics Bundle._",
        ].join("\n"),
      });
      await vscode.window.showTextDocument(doc, { preview: true });
    }
  });

  register("aiSharePoint.clearErrorReports", async () => {
    await errors.clear();
    void vscode.window.showInformationMessage("Error reports cleared.");
  });

  register("aiSharePoint.rotateAnonymousId", async () => {
    const confirm = await vscode.window.showInformationMessage(
      "Rotate the anonymous install ID and hash salt? Future diagnostics bundles can no longer be correlated with previously exported ones.",
      { modal: true },
      "Rotate",
    );
    if (confirm === "Rotate") {
      const fresh = await installIds.rotate();
      telemetry.record("diagnostics.rotateId");
      void vscode.window.showInformationMessage(
        `New anonymous install ID: ${fresh.id}`,
      );
    }
  });

  register("aiSharePoint.openLogs", () => log.show());

  register("aiSharePoint.openUserGuide", () => openBundledDoc(context, "USER_GUIDE.md"));
  register("aiSharePoint.openPrivacyNotice", () => openBundledDoc(context, "PRIVACY.md"));

  register("aiSharePoint.openWalkthrough", () =>
    vscode.commands.executeCommand(
      "workbench.action.openWalkthrough",
      "alfredsisley10.ai-sharepoint#aiSharePoint.gettingStarted",
    ),
  );

  log.info(`AI SharePoint v${version} activated.`);
  telemetry.record("activate");
}

export function deactivate(): void {
  // Subscriptions are disposed by the host.
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function showDeviceCodePrompt(
  userCode: string,
  verificationUri: string,
): Promise<void> {
  const pick = await vscode.window.showInformationMessage(
    `Device-code sign-in: enter code ${userCode} at ${verificationUri}`,
    "Copy Code & Open Browser",
    "Copy Code",
  );
  if (pick === "Copy Code & Open Browser") {
    await vscode.env.clipboard.writeText(userCode);
    await vscode.env.openExternal(vscode.Uri.parse(verificationUri));
  } else if (pick === "Copy Code") {
    await vscode.env.clipboard.writeText(userCode);
  }
}

async function resolveConnArg(
  arg: unknown,
  sites: SitesStore,
  title: string,
): Promise<SiteConnection | undefined> {
  if (
    arg &&
    typeof arg === "object" &&
    "siteUrl" in arg &&
    typeof (arg as SiteConnection).siteUrl === "string"
  ) {
    return sites.get((arg as SiteConnection).siteUrl) ?? (arg as SiteConnection);
  }
  const all = sites.list();
  if (all.length === 0) {
    const connect = await vscode.window.showInformationMessage(
      "No SharePoint connections yet.",
      "Connect a Site",
    );
    if (connect) {
      await vscode.commands.executeCommand("aiSharePoint.connectSite");
    }
    return undefined;
  }
  if (all.length === 1) {
    return all[0];
  }
  const pick = await vscode.window.showQuickPick(
    all.map((c) => ({
      label: c.displayName,
      description: c.role,
      detail: c.siteUrl,
      conn: c,
    })),
    { title },
  );
  return pick?.conn;
}

async function promptNumber(
  title: string,
  current: number,
  min: number,
): Promise<number | undefined> {
  const raw = await vscode.window.showInputBox({
    title,
    value: String(current),
    validateInput: (v) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= min
        ? undefined
        : `Enter a number ≥ ${min}`;
    },
  });
  return raw === undefined ? undefined : Number(raw);
}

function renderPullPreview(
  siteName: string,
  config: SiteSyncConfig,
  report: ChangeReport,
): string {
  const list = (title: string, items: string[]) =>
    items.length
      ? [`**${title} (${items.length}):**`, ...items.slice(0, 50).map((f) => `- \`${f}\``),
         ...(items.length > 50 ? [`- _…and ${items.length - 50} more_`] : []), ""]
      : [];
  return [
    `# Pull preview — ${siteName}`,
    "",
    `Target: \`${config.folder}\` · review gate: **${config.reviewGate}**`,
    "",
    "> Nothing has been written yet. Confirm in the dialog to apply these changes and commit.",
    "",
    ...list("Added", report.added),
    ...list("Updated", report.updated),
    ...list("Removed", report.removed),
    `${report.unchanged} file(s) unchanged.`,
    "",
    ...(report.large.length
      ? [`⚠️ Large files (≥50 MB): ${report.large.join(", ")} — consider excluding before pushing.`, ""]
      : []),
    "_Not yet synced (roadmap): navigation, theme, list items/documents, permissions._",
  ].join("\n");
}

async function openBundledDoc(
  context: vscode.ExtensionContext,
  name: string,
): Promise<void> {
  const uri = vscode.Uri.joinPath(context.extensionUri, "docs", name);
  try {
    await vscode.commands.executeCommand("markdown.showPreview", uri);
  } catch {
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: true });
  }
}
