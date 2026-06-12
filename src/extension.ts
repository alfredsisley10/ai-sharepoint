import * as vscode from "vscode";
import * as os from "node:os";
import * as path from "node:path";
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
import { parseDesiredState } from "./sync/desiredState";
import { buildPushPlan, renderPushPlan, hasWork } from "./sync/pushPlan";
import { applyPushPlan, assertFresh } from "./sync/pushEngine";
import { serializeSite } from "./sync/serializer";
import { SharePointWriteClient } from "./auth/sharePointWriteClient";
import { ContextSourcesStore } from "./context/sourcesStore";
import { ContextService } from "./context/contextService";
import { TtlCache } from "./context/cache";
import {
  ContextSource,
  ContextCredential,
  ContextDeployment,
  ContextSourceType,
} from "./context/types";
import { registerContextTools } from "./chat/contextTools";
import { buildReferenceExport, parseReferenceImport } from "./context/referenceExport";
import { aliasIssue, normalizeAlias, DESCRIPTION_MAX_LENGTH } from "./context/sourceRef";
import { SchemaStore } from "./context/schemaStore";
import { SchemaIndexer } from "./context/db/schemaIndexer";
import { SourceSchema, qualifiedName } from "./context/db/schemaIndex";
import { assertReadOnlySql, parseMongoSpec } from "./context/db/readSafe";
import { CatalogStore } from "./context/catalogStore";
import {
  buildVertexServingConfig,
  vertexUrlIssue,
  parseVertexHint,
  endpointForLocation,
  listVertexEngines,
  listGcloudProjects,
  getVertexToken,
} from "./context/adapters/vertexSearch";
import {
  buildCatalog,
  isExpired,
  catalogAge,
  DEFAULT_CATALOG_TTL_HOURS,
  SourceCatalog,
  CatalogEntry,
  LoadCheckpoint,
} from "./context/catalogCache";
import { setWireSink } from "./core/wireLog";
import { setLdapDnsServers } from "./context/ldap/ldapClient";
import { enumeratePowerBiDatasets, POWERBI_SCOPES } from "./context/adapters/powerbi";
import { listSnowTables } from "./context/adapters/servicenow";
import {
  buildSnowAuthUrl,
  exchangeSnowCode,
  SNOW_LOOPBACK_PORT,
} from "./context/adapters/servicenowAuth";
import { deriveSplunkApiCandidates, verifySplunk } from "./context/adapters/splunk";
import * as http from "node:http";
import * as nodeCrypto from "node:crypto";
import { OutboxStore } from "./comms/outboxStore";
import { CommsClient } from "./comms/commsClient";
import {
  CommDraft,
  CommChannel,
  parseRecipients,
  recipientIssue,
  draftIssue,
  draftLabel,
  explainCommsError,
  MAX_BODY_CHARS,
  MAX_SUBJECT_CHARS,
} from "./comms/outbox";
import { CommsTreeProvider } from "./ui/commsView";
import { registerCommsTools } from "./chat/commsTools";
import { parseSsmsServerName, buildMssqlUrl } from "./context/db/mssqlAuth";
import { scanForLeaks } from "./diagnostics/bundle";
import { BookmarksStore } from "./context/bookmarksStore";
import { ContextBookmark } from "./context/types";
import { discoverActiveDirectory } from "./context/ldap/discoveryHost";
import { guessBindUpn, domainToBaseDn } from "./context/ldap/discovery";
import { srvLocatorUrl } from "./context/ldap/srvLocator";
import { realHostSignals } from "./context/ldap/discoveryHost";
import { SourcesTreeProvider } from "./ui/sourcesView";
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

  const contextSources = new ContextSourcesStore(context.globalState, secrets, nowIso);
  const contextCache = new TtlCache();
  // AAD broker for "aad-sso" sources (Power BI): reuses a connected site's
  // MSAL provider; the stored "secret" is only the provider/cache handles.
  const aadBroker = async (
    credential: ContextCredential,
    interactive: boolean,
    scopes: string[],
  ): Promise<string> => {
    let handles: { providerId?: string; cacheHandle?: string } = {};
    try {
      handles = JSON.parse(credential.secret) as typeof handles;
    } catch {
      // fall through to the guard below
    }
    if (!handles.providerId || !handles.cacheHandle) {
      throw new AppError(
        "This source's Microsoft 365 link is incomplete — remove and re-add it.",
        "auth.failed",
      );
    }
    const provider = registry.create(handles.providerId, handles.cacheHandle);
    if (!interactive) {
      const silent = provider.acquireTokenSilent
        ? await provider.acquireTokenSilent(scopes)
        : null;
      if (!silent) {
        throw new AppError(
          "Sign-in required for Power BI — run “Test Context Source” on it to sign in.",
          "auth.failed",
        );
      }
      return silent.token;
    }
    return (await provider.acquireToken(scopes)).token;
  };
  const contextService = new ContextService(contextSources, contextCache, aadBroker);
  const bookmarks = new BookmarksStore(context.globalState);
  const schemas = new SchemaStore(context.globalStorageUri);
  const schemaIndexer = new SchemaIndexer(copilot, schemas, telemetry, log, nowIso);
  void schemas.preload();
  const catalogs = new CatalogStore(context.globalStorageUri);
  void catalogs.preload();

  const sitesProvider = new SitesTreeProvider(sites);
  const sourcesProvider = new SourcesTreeProvider(contextSources, bookmarks, schemas, catalogs, nowIso);
  const usageProvider = new UsageTreeProvider(
    meter,
    budget,
    nowIso,
    () => copilotState.signedIn,
  );
  const verboseWireOn = () =>
    vscode.workspace.getConfiguration("aiSharePoint").get<boolean>("logging.verboseWire", false);
  const supportProvider = new SupportTreeProvider(errors, version, verboseWireOn);

  // --- Verbose wire logging (pilot): full request/response detail from
  // every integration. Redaction is layered: structural at each tap (auth
  // headers masked, token bodies withheld, passwords never emitted),
  // key-masking in wireLog.safeJson, and the Logger's redactText pass on
  // every line. Local only — never part of diagnostics exports.
  const applyWireLogging = () => {
    setWireSink(
      verboseWireOn()
        ? (e) =>
            log.info(
              `[wire:${e.integration}] ${e.direction} ${e.summary}${e.detail ? `\n${e.detail}` : ""}`,
            )
        : undefined,
    );
  };
  applyWireLogging();
  const applyLdapDnsServers = () =>
    setLdapDnsServers(
      vscode.workspace.getConfiguration("aiSharePoint").get<string[]>("ldap.dnsServers", []),
    );
  applyLdapDnsServers();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("aiSharePoint.ldap.dnsServers")) {
        applyLdapDnsServers();
      }
      if (e.affectsConfiguration("aiSharePoint.logging.verboseWire")) {
        applyWireLogging();
        log.info(`Verbose wire logging ${verboseWireOn() ? "ENABLED" : "disabled"}.`);
        supportProvider.refresh();
      }
    }),
    { dispose: () => setWireSink(undefined) },
  );
  // In-place VSIX upgrades can run the new extension.js against a stale
  // cached manifest until the window reloads — createTreeView then throws
  // "No view is registered with id". One missing view must not abort the
  // whole activation: degrade to a warning and self-heal on reload.
  const tryCreateTreeView = <T>(
    id: string,
    provider: vscode.TreeDataProvider<T>,
  ): vscode.TreeView<T> | undefined => {
    try {
      return vscode.window.createTreeView(id, { treeDataProvider: provider });
    } catch (err) {
      log.warn(
        `View ${id} could not be registered (${err instanceof Error ? err.message : String(err)}) — usually a pending window reload after a VSIX upgrade. Run "Developer: Reload Window".`,
      );
      void vscode.window.showWarningMessage(
        "AI SharePoint updated — reload the window to finish (Developer: Reload Window).",
      );
      return undefined;
    }
  };

  const sitesView = tryCreateTreeView("aiSharePoint.sitesView", sitesProvider);
  const sourcesView = tryCreateTreeView("aiSharePoint.sourcesView", sourcesProvider);
  context.subscriptions.push(contextSources, bookmarks);
  if (sourcesView) context.subscriptions.push(sourcesView);
  const usageView = tryCreateTreeView("aiSharePoint.usageView", usageProvider);
  const supportView = tryCreateTreeView("aiSharePoint.supportView", supportProvider);
  const outbox = new OutboxStore(context.globalState);
  const commsProvider = new CommsTreeProvider(outbox);
  const commsView = tryCreateTreeView("aiSharePoint.commsView", commsProvider);
  const syncCommsBadge = () => {
    if (!commsView) return;
    commsView.badge =
      outbox.count() > 0
        ? { value: outbox.count(), tooltip: `${outbox.count()} draft(s) awaiting your approval` }
        : undefined;
  };
  syncCommsBadge();
  context.subscriptions.push(
    supportProvider,
    outbox,
    commsProvider,
    outbox.onDidChange(syncCommsBadge),
    ...registerCommsTools(outbox, telemetry, errors, nowIso),
  );
  for (const v of [sitesView, usageView, supportView, commsView]) {
    if (v) context.subscriptions.push(v);
  }

  const syncContext = () => {
    void vscode.commands.executeCommand(
      "setContext",
      "aiSharePoint.hasSites",
      sites.list().length > 0,
    );
    if (supportView) supportView.badge =
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
      sources: contextSources,
      bookmarks,
      schemas,
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
    ...registerContextTools(
      contextSources,
      contextService,
      bookmarks,
      schemas,
      schemaIndexer,
      telemetry,
      errors,
      nowIso,
    ),
    schemas,
    catalogs,
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
        ignoreFocusOut: true,
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
      ignoreFocusOut: true,
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
      ignoreFocusOut: true,
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
      { ignoreFocusOut: true, title: "Connect SharePoint Site (2/3) — connection role" },
    );
    if (!role) return;

    const method = await vscode.window.showQuickPick(
      AUTH_PROVIDERS.map((p) => ({
        label: p.id === "msal-public-interactive" ? `$(globe) ${p.label}` : `$(device-mobile) ${p.label}`,
        detail: p.detail,
        id: p.id,
      })),
      { ignoreFocusOut: true, title: "Connect SharePoint Site (3/3) — sign-in method" },
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

    // The Git extension reliably detects repositories inside the workspace;
    // out-of-workspace folders are a known init/open failure class (0.6.1
    // pilot fix). Offer to add the folder so detection is deterministic.
    const inWorkspace = vscode.workspace.workspaceFolders?.some(
      (wf) =>
        folder.fsPath === wf.uri.fsPath ||
        folder.fsPath.startsWith(wf.uri.fsPath + path.sep),
    );
    if (!inWorkspace) {
      const pick = await vscode.window.showInformationMessage(
        `"${path.basename(folder.fsPath)}" is outside your current VS Code workspace. Adding it as a workspace folder makes Git detection and Source Control integration reliable.`,
        { modal: true },
        "Add to Workspace and Continue",
        "Continue Without Adding",
      );
      if (!pick) return;
      if (pick === "Add to Workspace and Continue") {
        vscode.workspace.updateWorkspaceFolders(
          vscode.workspace.workspaceFolders?.length ?? 0,
          0,
          { uri: folder },
        );
        // Give the Git extension a moment to pick up the new root.
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    const remoteUrl = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      title: "Remote repository (2/3) — GitHub.com or your GitHub Enterprise Server",
      prompt: `Allowed hosts: ${allowedRemoteHosts().join(", ")}. Leave empty for local-only. An unlisted GHES host can be allowlisted in the next step.`,
      value: existing?.remoteUrl ?? "",
      placeHolder: "https://github.com/org/site-repo or git@github.corp.example:org/site-repo.git",
      validateInput: (v) =>
        !v.trim() || parseRemoteUrl(v)
          ? undefined
          : "Not a recognized git remote URL (https://host/org/repo or git@host:org/repo).",
    });
    if (remoteUrl === undefined) return;

    // Egress allowlist (ADR-0019 §2) with a self-service path: a user editing
    // their own machine-scoped settings could add the host manually anyway,
    // so a confirmed one-click add does not weaken the control — it removes
    // friction for pilots while managed fleets pre-distribute the setting.
    if (remoteUrl.trim()) {
      let verdict = validateRemote(remoteUrl, allowedRemoteHosts());
      if (!verdict.ok && verdict.info) {
        const host = verdict.info.host;
        const pick = await vscode.window.showWarningMessage(
          `"${host}" is not in your allowed Git hosts (${allowedRemoteHosts().join(", ")}). Adding it permits pushing serialized SharePoint site content to that server — only proceed for your organization's own GitHub Enterprise Server.`,
          { modal: true },
          `Allow "${host}" and Continue`,
          "Open Setting",
        );
        if (pick === `Allow "${host}" and Continue`) {
          await vscode.workspace
            .getConfiguration("aiSharePoint")
            .update(
              "sync.allowedRemoteHosts",
              [...allowedRemoteHosts(), host],
              vscode.ConfigurationTarget.Global,
            );
          telemetry.record("sync.allowHost");
          verdict = validateRemote(remoteUrl, allowedRemoteHosts());
        } else {
          if (pick === "Open Setting") {
            await vscode.commands.executeCommand(
              "workbench.action.openSettings",
              "aiSharePoint.sync.allowedRemoteHosts",
            );
          }
          return;
        }
      }
      if (!verdict.ok) {
        throw new AppError(verdict.reason ?? "Remote rejected.", "config",
          "The remote host could not be allowlisted.");
      }
    }

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
      { ignoreFocusOut: true, title: "Review gate (3/3) — how pushes reach the remote (ADR-0004)" },
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

  /** Shared write-back pipeline (ADR-0021 §5): plan from `desiredFiles` →
   *  deletions opt-in → preview → confirm → freshness gate → safety snapshot
   *  (side path) → sequential apply → reconcile pull + commit. Used by both
   *  Apply Repository (working tree) and Revert to Commit (files at a ref). */
  const runWriteBackFlow = async (
    conn: SiteConnection,
    config: SiteSyncConfig,
    repo: Awaited<ReturnType<typeof openOrInitRepository>>,
    desiredFiles: Map<string, string>,
    headline: string,
  ): Promise<void> => {
    const { snapshot, planBase, plan } = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Planning ${headline} for ${conn.displayName}…` },
      async (p) => {
        const snap = await syncEngine.gatherSnapshot(conn, (m) => p.report({ message: m }));
        return {
          snapshot: snap,
          planBase: serializeSite(snap),
          plan: buildPushPlan(parseDesiredState(desiredFiles), snap),
        };
      },
    );

    if (!hasWork(plan, true)) {
      void vscode.window.showInformationMessage(
        `SharePoint already matches the target state for "${conn.displayName}"${plan.warnings.length ? ` (${plan.warnings.length} warning(s))` : ""}.`,
      );
      return;
    }

    let includeDeletions = false;
    if (plan.deletions.length > 0) {
      const delPick = await vscode.window.showQuickPick(
        [
          {
            label: "$(shield) Skip deletions",
            description: `${plan.deletions.length} artifact(s) not in the target state are left untouched (recommended)`,
            value: false,
          },
          {
            label: "$(trash) Include deletions",
            description: "DELETE artifacts from SharePoint that are absent from the target state",
            value: true,
          },
        ],
        { ignoreFocusOut: true, title: `${headline} — ${plan.deletions.length} deletion(s) detected` },
      );
      if (!delPick) return;
      includeDeletions = delPick.value;
    }

    const previewDoc = await vscode.workspace.openTextDocument({
      language: "markdown",
      content: renderPushPlan(`${conn.displayName} — ${headline}`, plan, includeDeletions),
    });
    await vscode.window.showTextDocument(previewDoc, { preview: true });
    const opCount = plan.ops.length + (includeDeletions ? plan.deletions.length : 0);
    const confirm = await vscode.window.showWarningMessage(
      `${headline}: write ${opCount} operation(s) to "${conn.displayName}" in SharePoint?${includeDeletions ? ` This INCLUDES ${plan.deletions.length} deletion(s).` : ""} A safety snapshot is committed first; the site is re-checked for drift.`,
      { modal: true },
      includeDeletions ? "Apply Including Deletions" : "Apply to SharePoint",
    );
    if (!confirm) return;

    const writer = new SharePointWriteClient(
      registry.create(conn.authProviderId, conn.cacheHandle),
    );
    const outcome = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Applying to SharePoint…", cancellable: false },
      async (p) => {
        p.report({ message: "freshness check…" });
        await assertFresh(() => syncEngine.gatherSnapshot(conn), planBase);

        // Safety snapshot: pre-push live state committed to a side path —
        // never over the working tree's desired files (ADR-0021 §5).
        p.report({ message: "safety snapshot…" });
        const stamp = nowIso().replace(/[-:]/g, "").slice(0, 15);
        const snapDir = `.aisharepoint/snapshots/${stamp}`;
        const snapPaths: string[] = [];
        for (const [rel, content] of planBase) {
          const target = vscode.Uri.joinPath(
            vscode.Uri.file(config.folder),
            ...`${snapDir}/${rel}`.split("/"),
          );
          await vscode.workspace.fs.writeFile(target, Buffer.from(content, "utf8"));
          snapPaths.push(target.fsPath);
        }
        await repo.add(snapPaths);
        await repo.commit(`Safety snapshot before ${headline.toLowerCase()} (${stamp})`);

        return applyPushPlan(writer, snapshot.site.id, plan, includeDeletions, {
          progress: (m) => p.report({ message: m }),
          log: (m) => log.info(m),
        });
      },
    );
    telemetry.record("sync.writeback", {
      ops: outcome.applied.length,
      failed: Boolean(outcome.failedAt),
      deletions: includeDeletions,
    });

    // Reconcile: pull the now-current live state so repo == live again.
    const reconcile = await syncEngine.plan(conn, config.folder);
    if (!isBlocked(reconcile.report) && hasChanges(reconcile.report)) {
      const staged = await syncEngine.apply(config.folder, reconcile.files, reconcile.report);
      await repo.add(staged);
      await repo.commit(
        `${headline} applied: ${outcome.applied.length} op(s)${outcome.failedAt ? " (stopped early)" : ""}`,
      );
    }
    await sites.markVerified(conn.siteUrl, nowIso());

    if (outcome.failedAt) {
      void vscode.window.showErrorMessage(
        `${headline} stopped after ${outcome.applied.length} op(s) at "${outcome.failedAt.op}": ${outcome.failedAt.error.slice(0, 160)} — the repository now reflects the actual live state; the intended state is preserved in commit history. Fix and re-run.`,
      );
    } else {
      void vscode.window.showInformationMessage(
        `✓ ${headline} complete: ${outcome.applied.length} operation(s) applied to "${conn.displayName}". Repository reconciled with live state.`,
      );
    }
  };

  /** Guards shared by the write-back entry points. Returns null when blocked. */
  const writeBackPreflight = async (
    arg: unknown,
    title: string,
  ): Promise<{ conn: SiteConnection; config: SiteSyncConfig; repo: Awaited<ReturnType<typeof openOrInitRepository>> } | null> => {
    const conn = await resolveConnArg(arg, sites, title);
    if (!conn) return null;
    requireManaged(conn);
    const config = syncConfigs.get(conn.siteUrl);
    if (!config) {
      void vscode.window.showWarningMessage(
        "No repository configured for this site — run “Configure Site Repository…”, pull, then retry.",
      );
      return null;
    }
    // Clean-tree guard: every desired edit must be committed before write-back,
    // so the closing reconcile pull can never destroy unsaved work (ADR-0021).
    const repo = await openOrInitRepository(vscode.Uri.file(config.folder));
    const dirty =
      (repo.state.workingTreeChanges?.length ?? 0) + (repo.state.indexChanges?.length ?? 0);
    if (dirty > 0) {
      void vscode.window.showWarningMessage(
        `The site repository has ${dirty} uncommitted change(s). Commit them first — write-back reconciles the working tree with live SharePoint afterwards.`,
      );
      return null;
    }
    return { conn, config, repo };
  };

  register("aiSharePoint.applyRepoToSharePoint", async (arg) => {
    const pre = await writeBackPreflight(arg, "Apply which site repository to SharePoint?");
    if (!pre) return;
    const repoFiles = await syncEngine.readRepoFiles(pre.config.folder);
    if (repoFiles.size === 0) {
      void vscode.window.showWarningMessage(
        "The repository has no site files yet — run “Pull Site to Repository” first.",
      );
      return;
    }
    await runWriteBackFlow(pre.conn, pre.config, pre.repo, repoFiles, "Write-back");
  });

  register("aiSharePoint.revertSiteToCommit", async (arg) => {
    const pre = await writeBackPreflight(arg, "Revert which site to an earlier commit?");
    if (!pre) return;

    const commits = await pre.repo.log({ maxEntries: 30 });
    if (commits.length === 0) {
      void vscode.window.showWarningMessage("The site repository has no commits yet.");
      return;
    }
    const pick = await vscode.window.showQuickPick(
      commits.map((c) => ({
        label: `$(git-commit) ${c.hash.slice(0, 7)}`,
        description: (c.authorDate ?? c.commitDate)?.toISOString().slice(0, 16) ?? "",
        detail: c.message.split("\n")[0].slice(0, 100),
        hash: c.hash,
      })),
      {
        ignoreFocusOut: true,
        title: "Revert site to which commit? (ADR-0005 — a safety snapshot is taken first)",
        matchOnDetail: true,
      },
    );
    if (!pick) return;
    const short = pick.hash.slice(0, 7);

    // The committed manifest is the file inventory at that ref.
    let manifestRaw: string;
    try {
      manifestRaw = await pre.repo.show(pick.hash, ".aisharepoint/site.json");
    } catch {
      void vscode.window.showErrorMessage(
        `Commit ${short} contains no site snapshot (.aisharepoint/site.json) — pick a commit created by a pull or write-back.`,
      );
      return;
    }
    const filesAtRef = new Map<string, string>([[".aisharepoint/site.json", manifestRaw]]);
    try {
      const manifest = JSON.parse(manifestRaw) as {
        contents?: { lists?: Array<{ file: string }>; pages?: Array<{ file: string }> };
      };
      const inventory = [
        ...(manifest.contents?.lists ?? []),
        ...(manifest.contents?.pages ?? []),
      ].map((e) => e.file);
      for (const rel of inventory) {
        try {
          filesAtRef.set(rel, await pre.repo.show(pick.hash, rel));
        } catch {
          log.warn(`revert: ${rel} missing at ${short} — skipped.`);
        }
      }
    } catch {
      void vscode.window.showErrorMessage(`The snapshot manifest at ${short} is unreadable.`);
      return;
    }
    telemetry.record("sync.revertPlanned");
    await runWriteBackFlow(pre.conn, pre.config, pre.repo, filesAtRef, `Revert to ${short}`);
  });

  // --- Reference context sources (Track A — PLAN §9) -------------------------
  /** Power BI credential = pointer to a connected site's Microsoft 365
   *  sign-in (no secret of its own — ADR-0027). */
  const pickAadCredential = async (): Promise<ContextCredential | undefined> => {
    const all = sites.list();
    if (all.length === 0) {
      const add = await vscode.window.showInformationMessage(
        "Power BI uses your Microsoft 365 sign-in — connect a SharePoint site first to establish it.",
        "Connect Site",
      );
      if (add) await vscode.commands.executeCommand("aiSharePoint.connectSite");
      return undefined;
    }
    let conn = all.length === 1 ? all[0] : undefined;
    if (!conn) {
      const pick = await vscode.window.showQuickPick(
        all.map((c) => ({
          label: c.displayName,
          description: `${c.tenantHost}${c.account ? ` · ${c.account}` : ""}`,
          conn: c,
        })),
        { ignoreFocusOut: true, title: "Use which Microsoft 365 sign-in for Power BI?" },
      );
      if (!pick) return undefined;
      conn = pick.conn;
    }
    return {
      method: "aad-sso",
      secret: JSON.stringify({ providerId: conn.authProviderId, cacheHandle: conn.cacheHandle }),
    };
  };

  register("aiSharePoint.addContextSource", async () => {
    const typePick = await vscode.window.showQuickPick(
      [
        { label: "$(book) Confluence", value: "confluence" as ContextSourceType },
        { label: "$(issues) Jira", value: "jira" as ContextSourceType },
        {
          label: "$(organization) LDAP / Active Directory",
          description: "auto-discovers domain controllers via DNS",
          value: "ldap" as ContextSourceType,
        },
        { label: "$(database) SQL Server", description: "read-only SELECT (READ UNCOMMITTED, capped)", value: "mssql" as ContextSourceType },
        { label: "$(database) PostgreSQL", description: "read-only session, capped", value: "postgres" as ContextSourceType },
        { label: "$(database) MySQL", description: "read-only session, capped", value: "mysql" as ContextSourceType },
        { label: "$(database) MongoDB", description: "find/aggregate reads, capped", value: "mongodb" as ContextSourceType },
        { label: "$(search) Vertex AI Search", description: "Google enterprise search — Gemini-grounded answers, SSO via gcloud", value: "vertexai" as ContextSourceType },
        { label: "$(graph) Power BI (cloud)", description: "workspaces & datasets — read-only DAX analysis, Microsoft 365 SSO", value: "powerbi" as ContextSourceType },
        { label: "$(tools) ServiceNow", description: "incidents/changes/CMDB/knowledge — read-only Table API", value: "servicenow" as ContextSourceType },
        { label: "$(pulse) Splunk", description: "read-only SPL searches (oneshot, time-bounded)", value: "splunk" as ContextSourceType },
      ],
      { ignoreFocusOut: true, title: "Add Context Source — type (read-only reference data)" },
    );
    if (!typePick) return;

    let baseUrl: string;
    let baseDn: string | undefined;
    let presetCredential: ContextCredential | undefined;
    let deployment: ContextDeployment = "datacenter";
    let defaultUpn: string | undefined;

    const DB_TYPES = new Set(["mssql", "postgres", "mysql", "mongodb"]);
    if (typePick.value === "ldap") {
      const endpoint = await resolveLdapEndpoint();
      if (!endpoint) return;
      baseUrl = endpoint.baseUrl;
      baseDn = endpoint.baseDn;
      defaultUpn = endpoint.defaultUpn;
    } else if (typePick.value === "mssql") {
      // Field-by-field wizard (pilot direction): no string parsing — each
      // element is prompted, the connection URL is built from the parts, and
      // the add flow verifies it live before anything is saved.
      const hostRaw = await vscode.window.showInputBox({
        ignoreFocusOut: true,
        title: "SQL Server (1/4) — server FQDN or hostname",
        placeHolder: "sqlserver.corp.example   (pasting an SSMS name like server\\INSTANCE,port also works)",
        validateInput: (v) =>
          v.trim() && !v.includes("://") ? undefined : "Enter the server name only — no scheme",
      });
      if (!hostRaw) return;
      // Convenience: a pasted SSMS server name pre-fills the next steps.
      const pasted = parseSsmsServerName(hostRaw);
      const host = (pasted?.host ?? hostRaw).trim();

      const instanceRaw = await vscode.window.showInputBox({
        ignoreFocusOut: true,
        title: "SQL Server (2/4) — instance name",
        value: pasted?.instance ?? "",
        placeHolder: "PROD — leave empty for the default instance",
        prompt: "Only needed when connecting via SQL Browser; ignored for routing when a port is given (SSMS behavior).",
      });
      if (instanceRaw === undefined) return;
      const instance = instanceRaw.trim() || undefined;

      const portRaw = await vscode.window.showInputBox({
        ignoreFocusOut: true,
        title: "SQL Server (3/4) — TCP port",
        value: pasted?.port !== undefined ? String(pasted.port) : "",
        placeHolder: instance
          ? "leave empty to resolve via SQL Browser — or the instance's static port (recommended when Browser is disabled)"
          : "1433 — or your non-standard port",
        prompt: "An explicit port connects directly (most reliable in hardened environments).",
        validateInput: (v) => {
          if (!v.trim()) return undefined;
          const n = Number(v.trim());
          return Number.isInteger(n) && n >= 1 && n <= 65535 ? undefined : "Port must be 1–65535 (or empty)";
        },
      });
      if (portRaw === undefined) return;
      const portNum = portRaw.trim() ? Number(portRaw.trim()) : undefined;
      if (portNum === undefined && !instance) {
        void vscode.window.showInformationMessage("No port or instance given — using the default port 1433.");
      }

      const database = await vscode.window.showInputBox({
        ignoreFocusOut: true,
        title: "SQL Server (4/4) — database name",
        placeHolder: "Sales",
        validateInput: (v) => (v.trim() ? undefined : "Enter the database name"),
      });
      if (!database) return;

      const certPick = await vscode.window.showQuickPick(
        [
          {
            label: "$(verified) Validate server certificate (recommended)",
            description: "requires a trusted cert whose name matches the host",
            value: false,
          },
          {
            label: "$(unlock) Trust server certificate",
            description: "skip validation — self-signed certs or FQDN/name mismatches (the SSMS checkbox)",
            value: true,
          },
        ],
        { ignoreFocusOut: true, title: "SQL Server TLS certificate handling" },
      );
      if (!certPick) return;

      baseUrl = buildMssqlUrl({
        host,
        instance,
        port: portNum,
        database: database.trim(),
        trustServerCertificate: certPick.value,
      });
    } else if (typePick.value === "servicenow") {
      deployment = "cloud";
      const url = await vscode.window.showInputBox({
        ignoreFocusOut: true,
        title: "ServiceNow — instance URL",
        placeHolder: "https://yourorg.service-now.com",
        validateInput: (v) => {
          try {
            return new URL(v.trim()).protocol === "https:" ? undefined : "HTTPS URLs only";
          } catch {
            return "Enter a valid https:// URL";
          }
        },
      });
      if (!url) return;
      baseUrl = url.trim().replace(/\/+$/, "");
      // Connect first, then enumerate what THIS account can read — no table
      // names to know (pilot). Falls back to typing one if listing fails.
      presetCredential = await promptContextCredential("servicenow", "cloud", undefined, baseUrl);
      if (!presetCredential) return;
      const snowCred = presetCredential;
      let tables: Array<{ name: string; label: string }> = [];
      try {
        tables = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: "Listing the ServiceNow tables you can access…" },
          () => listSnowTables({ baseUrl }, snowCred, contextService.caps()),
        );
      } catch (err) {
        log.warn(`ServiceNow table enumeration failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (tables.length > 0) {
        const pick = await vscode.window.showQuickPick(
          [
            {
              label: "$(list-unordered) No default — pick a table per question",
              description: "free-text chat questions will need a table named",
              name: undefined as string | undefined,
            },
            ...tables.map((t) => ({ label: t.label, description: t.name, name: t.name as string | undefined })),
          ],
          {
            ignoreFocusOut: true,
            title: `Default table (${tables.length} readable) — free-text questions search here`,
            matchOnDescription: true,
          },
        );
        if (!pick) return;
        if (pick.name) baseUrl += `?table=${encodeURIComponent(pick.name)}`;
      } else {
        const table = await vscode.window.showInputBox({
          ignoreFocusOut: true,
          title: "ServiceNow — default table (listing unavailable; optional)",
          value: "incident",
          prompt: "Couldn't enumerate tables with this account — type one (the instance still enforces its ACLs).",
          validateInput: (v) => (!v.trim() || /^[a-z0-9_]+$/.test(v.trim()) ? undefined : "Table names are lowercase_with_underscores"),
        });
        if (table === undefined) return;
        if (table.trim()) baseUrl += `?table=${encodeURIComponent(table.trim())}`;
      }
    } else if (typePick.value === "splunk") {
      deployment = "datacenter";
      const url = await vscode.window.showInputBox({
        ignoreFocusOut: true,
        title: "Splunk — the URL you open in your browser (1/3)",
        placeHolder: "https://acme.splunkcloud.com — the management API address is derived and verified for you",
        validateInput: (v) => {
          try {
            return new URL(v.trim()).protocol === "https:" ? undefined : "HTTPS URLs only";
          } catch {
            return "Enter a valid https:// URL";
          }
        },
      });
      if (!url) return;
      const webEntry = url.trim().replace(/\/+$/, "");
      const candidates = deriveSplunkApiCandidates(webEntry);
      presetCredential = await promptContextCredential("splunk", "datacenter");
      if (!presetCredential) return;
      const splunkCred = presetCredential;
      baseUrl = "";
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Finding your Splunk management API…" },
        async (progress) => {
          for (const cand of candidates) {
            progress.report({ message: cand });
            try {
              await verifySplunk(
                { id: "probe", type: "splunk", displayName: "probe", baseUrl: cand, deployment: "datacenter", authMethod: splunkCred.method, addedAt: nowIso() },
                splunkCred,
                contextService.caps(),
              );
              baseUrl = cand;
              return;
            } catch (err) {
              log.warn(`Splunk probe ${cand} failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        },
      );
      if (!baseUrl) {
        const manual = await vscode.window.showInputBox({
          ignoreFocusOut: true,
          title: "Couldn't reach the derived API address — enter the management API URL",
          value: candidates[0] ?? "https://splunk.corp.example:8089",
          prompt: "Usually the same host on port 8089. Splunk Cloud may need API access enabled / IP allowlisting — see the message in the log.",
          validateInput: (v) => {
            try {
              return new URL(v.trim()).protocol === "https:" ? undefined : "HTTPS URLs only";
            } catch {
              return "Enter a valid https:// URL";
            }
          },
        });
        if (!manual) return;
        baseUrl = manual.trim().replace(/\/+$/, "");
      }
      // The browser URL doubles as the deep-link target.
      const autoWeb = !webEntry.includes(":8089") ? webEntry : "";
      const index = await vscode.window.showInputBox({
        ignoreFocusOut: true,
        title: "Splunk — default index (2/3, optional)",
        placeHolder: "main — free-text chat questions search this index (Enter to skip)",
        validateInput: (v) =>
          !v.trim() || /^[A-Za-z0-9_-]+$/.test(v.trim()) ? undefined : "Index names: letters/digits/_/-",
      });
      if (index === undefined) return;
      const web = await vscode.window.showInputBox({
        ignoreFocusOut: true,
        title: "Splunk — Splunk Web URL for deep links (3/3)",
        value: autoWeb,
        placeHolder: "https://acme.splunkcloud.com — pre-filled from what you entered (Enter to accept)",
        validateInput: (v) => {
          if (!v.trim()) return undefined;
          try {
            return new URL(v.trim()).protocol === "https:" ? undefined : "HTTPS URLs only";
          } catch {
            return "Enter a valid https:// URL (or leave empty)";
          }
        },
      });
      if (web === undefined) return;
      const params = new URLSearchParams();
      if (index.trim()) params.set("index", index.trim());
      if (web.trim()) params.set("web", web.trim().replace(/\/+$/, ""));
      const qs = params.toString();
      if (qs) baseUrl += `?${qs}`;
    } else if (typePick.value === "powerbi") {
      deployment = "cloud";
      // Pilot: users only know app.powerbi.com — confirm the portal, sign in
      // with the existing Microsoft 365 session, then ENUMERATE what they can
      // access instead of asking for dataset names/GUIDs.
      const portal = await vscode.window.showInputBox({
        ignoreFocusOut: true,
        title: "Power BI — portal URL (just confirm)",
        value: "https://app.powerbi.com",
        prompt: "The connector talks to the Power BI API with your Microsoft 365 sign-in; this is only a confirmation of which Power BI you use.",
        validateInput: (v) => {
          try {
            return new URL(v.trim()).protocol === "https:" ? undefined : "HTTPS URLs only";
          } catch {
            return "Enter a valid https:// URL";
          }
        },
      });
      if (!portal) return;
      baseUrl = "https://api.powerbi.com/v1.0/myorg";
      presetCredential = await pickAadCredential();
      if (!presetCredential) return;
      const cred = presetCredential;
      try {
        const datasets = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: "Listing the Power BI datasets you can access…" },
          () => enumeratePowerBiDatasets((i) => aadBroker(cred, i, POWERBI_SCOPES), contextService.caps()),
        );
        if (datasets.length > 0) {
          const pick = await vscode.window.showQuickPick(
            [
              {
                label: "$(list-unordered) No default — pick a dataset per question",
                description: "chat can still target any dataset by name",
                id: undefined as string | undefined,
              },
              ...datasets.map((d) => ({
                label: d.name,
                description: `${d.workspace}`,
                id: d.id as string | undefined,
              })),
            ],
            {
              ignoreFocusOut: true,
              title: `Default dataset (${datasets.length} visible) — bare questions go here`,
              matchOnDescription: true,
            },
          );
          if (!pick) return;
          if (pick.id) baseUrl += `?dataset=${encodeURIComponent(pick.id)}`;
        } else {
          void vscode.window.showInformationMessage(
            "No datasets are visible to this account yet — the source still connects; datasets appear in Browse & Bookmark once you're granted access.",
          );
        }
      } catch (err) {
        // Enumeration is a convenience — never block adding the source on it.
        log.warn(`Power BI dataset enumeration failed: ${err instanceof Error ? err.message : String(err)}`);
        void vscode.window.showWarningMessage(
          "Could not list datasets right now — the source will still be added; use Browse & Bookmark later.",
        );
      }
    } else if (typePick.value === "vertexai") {
      deployment = "cloud";
      // Pilot: users often only have the corporate search URL — offer SSO
      // discovery (projects → apps across global/us/eu) and hint-parsing of
      // any pasted URL before falling back to manual IDs.
      const setupMode = await vscode.window.showQuickPick(
        [
          {
            label: "$(account) Find my search app via Google SSO (recommended)",
            description: "uses your gcloud sign-in to list projects and apps — no IDs needed",
            value: "discover" as const,
          },
          {
            label: "$(edit) Enter details — or paste any URL you have",
            description: "corporate search page, Cloud Console, or serving-config URL",
            value: "manual" as const,
          },
        ],
        { ignoreFocusOut: true, title: "Vertex AI Search — set up from what you have" },
      );
      if (!setupMode) return;
      if (setupMode.value === "discover") {
        const projects = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: "Listing your Google Cloud projects (gcloud SSO)…" },
          () => listGcloudProjects(),
        );
        if (projects.length === 0) {
          void vscode.window.showWarningMessage(
            "Your Google SSO session sees no projects. Ask the search app's owner for the project ID and app ID, then re-add with manual entry.",
          );
          return;
        }
        const projPick = await vscode.window.showQuickPick(
          projects.map((pr) => ({ label: pr.projectId, description: pr.name, pr })),
          { ignoreFocusOut: true, title: "Which project hosts the search app? (ask the app owner if unsure)", matchOnDescription: true },
        );
        if (!projPick) return;
        const token = await getVertexToken({ method: "gcloud-sso", secret: "gcloud-cli-session" });
        const engines = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Looking for search apps in ${projPick.pr.projectId} (global/us/eu)…` },
          () => listVertexEngines(token, projPick.pr.projectId, 20_000),
        );
        if (engines.length === 0) {
          void vscode.window.showWarningMessage(
            `No search apps are visible to you in ${projPick.pr.projectId}. Your account may lack list permission even though searching works — ask the app owner for the location (global/us/eu) and app ID, then re-add with manual entry (pasting the corporate search page's URL pre-fills what it can).`,
          );
          return;
        }
        const engPick = await vscode.window.showQuickPick(
          engines.map((e) => ({ label: e.displayName, description: `${e.engineId} · ${e.location}`, e })),
          { ignoreFocusOut: true, title: "Pick your search app" },
        );
        if (!engPick) return;
        baseUrl = buildVertexServingConfig({
          projectId: projPick.pr.projectId,
          location: engPick.e.location,
          engineId: engPick.e.engineId,
          endpoint: endpointForLocation(engPick.e.location),
        });
      } else {
        const first = await vscode.window.showInputBox({
          ignoreFocusOut: true,
          title: "Vertex AI Search — project ID, or paste ANY URL you have",
          placeHolder: "my-corp-search-prod — or paste the corporate search / Cloud Console / serving-config URL",
          validateInput: (v) => (v.trim() ? undefined : "Enter a project ID or paste a URL"),
        });
        if (!first) return;
        if (vertexUrlIssue(first.trim()) === undefined) {
          baseUrl = first.trim();
        } else {
          const isUrlish = /[/:]/.test(first.trim());
          const hint = isUrlish ? parseVertexHint(first) : {};
          let projectId = hint.projectId ?? (isUrlish ? undefined : first.trim());
          if (!projectId) {
            projectId = (
              await vscode.window.showInputBox({
                ignoreFocusOut: true,
                title: "Google Cloud project ID",
                prompt: "That URL didn't carry a project ID — it's in the Cloud Console URL (?project=…) or available from the app owner.",
                validateInput: (v) => (v.trim() ? undefined : "Enter the project ID"),
              })
            )?.trim();
            if (!projectId) return;
          }
          const location = await vscode.window.showInputBox({
            ignoreFocusOut: true,
            title: "Location",
            value: hint.location ?? "global",
            prompt: "global, us, or eu — pre-filled when your pasted URL contained it; otherwise the app owner knows. The connector probes the matching regional endpoint automatically.",
            validateInput: (v) => (v.trim() ? undefined : "Enter the location (e.g. global)"),
          });
          if (!location) return;
          const engineId = await vscode.window.showInputBox({
            ignoreFocusOut: true,
            title: "App (engine) ID",
            value: hint.engineId ?? "",
            placeHolder: "enterprise-search_1700000000000",
            prompt: "Pre-filled when your pasted URL contained it; otherwise shown in the Cloud Console app list (ask the owner).",
            validateInput: (v) => (v.trim() ? undefined : "Enter the app/engine ID"),
          });
          if (!engineId) return;
          baseUrl = buildVertexServingConfig({
            projectId,
            location: location.trim(),
            engineId: engineId.trim(),
            endpoint: endpointForLocation(location.trim()),
          });
        }
      }
    } else if (DB_TYPES.has(typePick.value)) {
      const placeholders: Record<string, string> = {
        postgres: "postgresql://pghost.corp.example:5432/mydb  (?ssl=false to disable TLS)",
        mysql: "mysql://mysqlhost.corp.example:3306/mydb  (?ssl=true to enable TLS)",
        mongodb: "mongodb://mongo.corp.example:27017/mydb  (mongodb+srv:// supported)",
      };
      const url = await vscode.window.showInputBox({
        ignoreFocusOut: true,
        title: "Database connection URL (read-only reference access)",
        placeHolder: placeholders[typePick.value],
        validateInput: (v) => {
          try {
            const u = new URL(v.trim());
            if (!u.pathname.replace(/^\/+/, "")) return "Include the database name: …/dbname";
            return undefined;
          } catch {
            return "Enter a valid connection URL";
          }
        },
      });
      if (!url) return;
      baseUrl = url.trim();
    } else {
      const depPick = await vscode.window.showQuickPick(
        [
          { label: "$(cloud) Cloud", description: "*.atlassian.net", value: "cloud" as ContextDeployment },
          { label: "$(server) Data Center / Server", description: "self-hosted", value: "datacenter" as ContextDeployment },
        ],
        { ignoreFocusOut: true, title: "Add Context Source — deployment" },
      );
      if (!depPick) return;
      deployment = depPick.value;
      const url = await vscode.window.showInputBox({
      ignoreFocusOut: true,
        title: "Add Context Source — base URL",
        placeHolder:
          depPick.value === "cloud"
            ? typePick.value === "confluence"
              ? "https://yourorg.atlassian.net/wiki"
              : "https://yourorg.atlassian.net"
            : `https://${typePick.value}.corp.example`,
        validateInput: (v) => {
          try {
            return new URL(v.trim()).protocol === "https:" ? undefined : "HTTPS URLs only";
          } catch {
            return "Enter a valid https:// URL";
          }
        },
      });
      if (!url) return;
      baseUrl = url.trim().replace(/\/+$/, "");
    }

    const credential =
      presetCredential ??
      (typePick.value === "powerbi"
        ? await pickAadCredential()
        : await promptContextCredential(typePick.value, deployment, defaultUpn));
    if (!credential) return;
    const hostLabel = (() => {
      try {
        return new URL(baseUrl).hostname;
      } catch {
        return baseUrl;
      }
    })();
    const displayName =
      (await vscode.window.showInputBox({
      ignoreFocusOut: true,
        title: "Add Context Source — display name",
        value: `${hostLabel} (${typePick.value})`,
      })) ?? "";
    if (!displayName) return;

    const details = await promptSourceAliasAndDescription(contextSources.list());
    if (!details) return;

    const source: ContextSource = {
      id: crypto.randomUUID(),
      type: typePick.value,
      displayName: displayName.trim(),
      alias: details.alias,
      description: details.description,
      baseUrl,
      baseDn,
      deployment,
      authMethod: credential.method,
      addedAt: nowIso(),
    };
    try {
      const { account } = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Verifying source…" },
        () => contextService.verify(source, credential, true),
      );
      await contextSources.upsert({ ...source, account, lastVerifiedAt: nowIso() });
      await contextSources.setCredential(source.id, credential);
      telemetry.record("context.add", { type: source.type, deployment: source.deployment, method: credential.method });
      void vscode.window.showInformationMessage(
        `Connected "${source.displayName}" as ${account} (read-only).`,
      );
      if (DB_TYPES.has(source.type)) {
        // First use of a database source: preload the schema catalog, then
        // offer the Copilot semantic indexing (consent-gated, ADR-0024).
        // Failures here never undo the just-added source.
        void vscode.commands.executeCommand("aiSharePoint.loadSourceSchema", source);
      }
    } catch (err) {
      // Nothing was saved — discard the unsaved source's failure record too.
      await contextSources.resetLockout(source.id);
      throw err;
    }
  });

  register("aiSharePoint.testContextSource", async (arg) => {
    const source = await resolveSourceArg(arg, contextSources);
    if (!source) return;
    const gateNow = contextSources.attemptAllowed(source.id, false);
    if (!gateNow.allowed && gateNow.reason === "circuit-open") {
      void vscode.window.showErrorMessage(
        `"${source.displayName}" is locked out after repeated auth failures (lockout protection). Verify the credential with your administrator, then run "Reset Source Auth Lockout".`,
      );
      return;
    }
    let credential = await contextSources.getCredential(source.id);
    let fresh = false;
    if (!credential || (!gateNow.allowed && gateNow.reason === "credential-bad")) {
      credential =
        source.type === "powerbi"
          ? await pickAadCredential()
          : await promptContextCredential(source.type, source.deployment, undefined, source.baseUrl);
      if (!credential) return;
      fresh = true;
    }
    const { account } = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Testing ${source.displayName}…` },
      () => contextService.verify(source, credential!, fresh),
    );
    if (fresh) {
      await contextSources.setCredential(source.id, credential);
      await contextSources.upsert({ ...contextSources.get(source.id)!, authMethod: credential.method, account });
    }
    telemetry.record("context.test");
    void vscode.window.showInformationMessage(
      `✓ "${source.displayName}" reachable as ${account}.`,
    );
  });

  register("aiSharePoint.removeContextSource", async (arg) => {
    const source = await resolveSourceArg(arg, contextSources);
    if (!source) return;
    const confirm = await vscode.window.showWarningMessage(
      `Remove "${source.displayName}"? Its stored credential is wiped from the OS keychain and cached results are discarded.`,
      { modal: true },
      "Remove Source",
    );
    if (confirm === "Remove Source") {
      await contextSources.remove(source.id);
      await bookmarks.removeForSource(source.id);
      await schemas.remove(source.id);
      await catalogs.remove(source.id);
      contextCache.invalidateSource(source.id);
      telemetry.record("context.remove");
    }
  });

  register("aiSharePoint.editSourceAlias", async (arg) => {
    const source = await resolveSourceArg(arg, contextSources);
    if (!source) return;
    const details = await promptSourceAliasAndDescription(contextSources.list(), source);
    if (!details) return;
    const stored = contextSources.get(source.id) ?? source;
    await contextSources.upsert({ ...stored, alias: details.alias, description: details.description });
    telemetry.record("context.alias", {
      alias: details.alias ? "set" : "cleared",
      description: details.description ? "set" : "cleared",
    });
    void vscode.window.showInformationMessage(
      details.alias
        ? `"${source.displayName}" answers to "${details.alias}" now — e.g. @sharepoint find … in the ${details.alias} database.`
        : `Alias cleared for "${source.displayName}".`,
    );
  });

  // --- Database schema catalog + semantic index (ADR-0024) -----------------
  const DB_SOURCE_TYPES = new Set(["mssql", "postgres", "mysql", "mongodb"]);

  const requireDbSource = (source: ContextSource): boolean => {
    if (DB_SOURCE_TYPES.has(source.type)) return true;
    void vscode.window.showInformationMessage(
      `"${source.displayName}" is a ${source.type} source — schema catalogs apply to database sources.`,
    );
    return false;
  };

  const loadSchemaWithProgress = async (source: ContextSource): Promise<SourceSchema> => {
    const catalog = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Reading "${source.displayName}" schema (metadata only)…`,
      },
      () => contextService.loadSchemaCatalog(source, nowIso()),
    );
    const previous = schemas.getSync(source.id);
    const schema: SourceSchema = {
      catalog,
      // A re-pulled catalog keeps the existing semantic layer; re-index to
      // cover newly appeared tables.
      semantic: previous?.semantic,
      semanticState: previous?.semanticState ?? "none",
    };
    await schemas.set(source.id, schema);
    telemetry.record("schema.load", { type: source.type, tables: String(catalog.tables.length) });
    return schema;
  };

  register("aiSharePoint.loadSourceSchema", async (arg) => {
    const source = await resolveSourceArg(arg, contextSources);
    if (!source || !requireDbSource(source)) return;
    const schema = await loadSchemaWithProgress(source);
    void vscode.window.showInformationMessage(
      `Schema loaded: ${schema.catalog.tables.length} tables/collections from "${source.displayName}"${schema.catalog.truncated ? " (truncated by caps)" : ""}.`,
    );
    if (schema.semanticState === "none") {
      await schemaIndexer.indexInteractively(source, schema);
    }
  });

  register("aiSharePoint.indexSourceSchema", async (arg) => {
    // "Index Database Schema": one action — read every table/view the
    // account can access, then Copilot writes descriptive summaries.
    const source = await resolveSourceArg(arg, contextSources);
    if (!source || !requireDbSource(source)) return;
    const schema = await loadSchemaWithProgress(source);
    await schemaIndexer.indexInteractively(source, schema);
  });

  register("aiSharePoint.indexSourceContent", async (arg) => {
    // "Index Database Content Types": sampled distinct values per column,
    // described by Copilot — requires the schema pass first.
    const source = await resolveSourceArg(arg, contextSources);
    if (!source || !requireDbSource(source)) return;
    const schema = schemas.getSync(source.id) ?? (await loadSchemaWithProgress(source));
    await schemaIndexer.indexContentInteractively(source, schema, (table) =>
      contextService.sampleTable(source, table),
    );
  });

  // --- Catalog pre-cache (Confluence spaces / Jira projects+queues) --------
  /** Continue?-checkpoint asked every N seconds. While the prompt (or the
   *  user) waits, the page loop is parked — no requests reach the source,
   *  so the ask itself is the overload protection. */
  const makeCatalogCheckpoint = (sourceName: string): LoadCheckpoint => {
    const everySeconds = Math.max(
      5,
      vscode.workspace.getConfiguration("aiSharePoint").get<number>("context.catalogCheckpointSeconds", 15),
    );
    const startedAt = Date.now();
    let windowStart = Date.now();
    return async () => {
      if (Date.now() - windowStart < everySeconds * 1000) return true;
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      const pick = await vscode.window.showWarningMessage(
        `Pre-caching the "${sourceName}" catalog has been running for ${elapsed}s. Keep loading? (No requests are sent while this prompt waits.)`,
        "Keep Loading",
        "Stop & Keep Partial",
      );
      windowStart = Date.now();
      return pick === "Keep Loading";
    };
  };

  const runCatalogPrecache = async (source: ContextSource): Promise<SourceCatalog | undefined> => {
    const ttlHours = Math.max(
      1,
      vscode.workspace.getConfiguration("aiSharePoint").get<number>("context.catalogTtlHours", DEFAULT_CATALOG_TTL_HOURS),
    );
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Pre-caching "${source.displayName}" catalog…`,
        cancellable: true,
      },
      (_progress, token) => {
        const checkpoint = makeCatalogCheckpoint(source.displayName);
        return contextService.precacheCatalog(source, async () =>
          token.isCancellationRequested ? false : checkpoint(),
        );
      },
    );
    const catalog = buildCatalog(result.entries, result.complete, nowIso(), ttlHours);
    await catalogs.set(source.id, catalog);
    telemetry.record("catalog.precache", {
      type: source.type,
      entries: String(result.entries.length),
      complete: String(result.complete),
    });
    void vscode.window.showInformationMessage(
      `Catalog cached: ${result.entries.length} entr${result.entries.length === 1 ? "y" : "ies"} from "${source.displayName}"${result.complete ? "" : " (partial — stopped at a checkpoint)"}. Expires in ${ttlHours} h; refresh any time via "Pre-cache Source Catalog".`,
    );
    return catalog;
  };

  register("aiSharePoint.precacheSourceCatalog", async (arg) => {
    const source = await resolveSourceArg(arg, contextSources);
    if (!source) return;
    if (source.type !== "confluence" && source.type !== "jira") {
      void vscode.window.showInformationMessage(
        "Catalog pre-caching applies to Confluence and Jira sources (databases use Load/Refresh Database Schema).",
      );
      return;
    }
    await runCatalogPrecache(source);
  });

  /** Cached-catalog gate for browsing: fresh cache → instant local list;
   *  expired → refresh/stale/live choice; first use → pre-cache offer. */
  const catalogEntriesFor = async (
    source: ContextSource,
  ): Promise<CatalogEntry[] | "live" | undefined> => {
    const cached = catalogs.getSync(source.id);
    if (cached && !isExpired(cached, nowIso())) return cached.entries;
    if (cached) {
      const pick = await vscode.window.showQuickPick(
        [
          {
            label: "$(sync) Refresh the full catalog now",
            description: `cached ${catalogAge(cached, nowIso())} — expired`,
            value: "refresh" as const,
          },
          {
            label: "$(history) Use the expired copy",
            description: `${cached.entries.length} entries, instant`,
            value: "stale" as const,
          },
          { label: "$(cloud) Quick browse (capped, live)", value: "live" as const },
        ],
        { ignoreFocusOut: true, title: `"${source.displayName}" catalog cache has expired` },
      );
      if (!pick) return undefined;
      if (pick.value === "stale") return cached.entries;
      if (pick.value === "live") return "live";
      return (await runCatalogPrecache(source))?.entries;
    }
    const pick = await vscode.window.showQuickPick(
      [
        {
          label: "$(cloud-download) Pre-cache the full catalog (recommended)",
          description: "one-time load with continue-checkpoints; searched locally afterwards",
          value: "precache" as const,
        },
        {
          label: "$(cloud) Quick browse (capped, live)",
          description: "top entries only, nothing cached",
          value: "live" as const,
        },
      ],
      {
        ignoreFocusOut: true,
        title: `First browse of "${source.displayName}" — pre-cache its full catalog for fast local search?`,
      },
    );
    if (!pick) return undefined;
    if (pick.value === "live") return "live";
    return (await runCatalogPrecache(source))?.entries;
  };

  register("aiSharePoint.viewSourceSchema", async (arg) => {
    const source = await resolveSourceArg(arg, contextSources);
    if (!source || !requireDbSource(source)) return;
    const schema = schemas.getSync(source.id) ?? (await loadSchemaWithProgress(source));
    const sem = new Map(
      (schema.semantic?.tables ?? []).map((t) => [t.table.toLowerCase(), t]),
    );
    const lines = [
      `# ${source.displayName} — schema catalog`,
      "",
      `- Engine: **${schema.catalog.engine}** · database **${schema.catalog.database}**`,
      `- Fetched: ${schema.catalog.fetchedAt} · ${schema.catalog.tables.length} tables/collections${schema.catalog.truncated ? " · **truncated by caps**" : ""}`,
      `- Semantic index: **${schema.semanticState}**${schema.semantic ? ` (${schema.semantic.tables.length} tables, model ${schema.semantic.modelId}${schema.semantic.partial ? ", partial" : ""})` : ""}`,
      "",
      "_Catalog = names and types read from the database. Semantic tags/synonyms (when indexed) are Copilot's generalization so free-form questions find the right columns._",
    ];
    for (const t of schema.catalog.tables) {
      const s = sem.get(qualifiedName(t).toLowerCase());
      lines.push("", `## ${qualifiedName(t)} _(${t.kind})_${s?.purpose ? ` — ${s.purpose}` : ""}`, "");
      lines.push("| Column | Type | Meaning (tags) | Also known as |", "|---|---|---|---|");
      for (const c of t.columns) {
        const sc = s?.columns.find((x) => x.name.toLowerCase() === c.name.toLowerCase());
        lines.push(
          `| ${c.name} | ${c.dataType} | ${sc ? sc.tags.join(", ") + (sc.note ? ` — ${sc.note}` : "") : ""} | ${sc?.synonyms.join(", ") ?? ""} |`,
        );
      }
    }
    const doc = await vscode.workspace.openTextDocument({
      language: "markdown",
      content: lines.join("\n"),
    });
    await vscode.window.showTextDocument(doc, { preview: true });
  });

  register("aiSharePoint.browseSource", async (arg) => {
    const source = await resolveSourceArg(arg, contextSources);
    if (!source) return;

    type Cand = { name: string; locator: string; kind: ContextBookmark["kind"]; detail: string };
    let candidate: Cand | undefined;

    const catalogLabel =
      source.type === "confluence"
        ? "$(library) Browse spaces"
        : source.type === "jira"
          ? "$(library) Browse queues, favourite filters & projects"
          : ["mssql", "postgres", "mysql", "mongodb"].includes(source.type)
            ? "$(database) Browse tables / collections"
            : undefined;
    const mode = await vscode.window.showQuickPick(
      [
        ...(catalogLabel
          ? [{ label: catalogLabel, description: "pick from the source's catalog", value: "catalog" as const }]
          : []),
        {
          label: "$(search) Search, then bookmark",
          description: "run a query; save the query itself or a specific result",
          value: "search" as const,
        },
      ],
      { ignoreFocusOut: true, title: `Browse & Bookmark — ${source.displayName}` },
    );
    if (!mode) return;

    if (mode.value === "catalog") {
      let candidates: ReadonlyArray<Cand>;
      if (source.type === "confluence" || source.type === "jira") {
        const cached = await catalogEntriesFor(source);
        if (cached === undefined) return;
        candidates =
          cached === "live"
            ? await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `Browsing ${source.displayName}…` },
                () => contextService.browseCandidates(source),
              )
            : cached;
      } else {
        candidates = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Browsing ${source.displayName}…` },
          () => contextService.browseCandidates(source),
        );
      }
      if (candidates.length === 0) {
        void vscode.window.showInformationMessage(
          source.type === "jira"
            ? "Jira returned nothing browsable (no JSM queues, starred filters, or visible projects for this account). Star a filter in Jira or use the search path — both still work."
            : "Nothing browsable was returned — try the search path instead.",
        );
        return;
      }
      const pick = await vscode.window.showQuickPick(
        candidates.map((c) => ({
          label: `$(${c.detail.includes("queue") ? "inbox" : c.detail.includes("filter") ? "filter" : "library"}) ${c.name}`,
          description: c.detail,
          detail: c.locator,
          cand: c as Cand,
        })),
        { ignoreFocusOut: true, title: `Bookmark what from ${source.displayName}?`, matchOnDetail: true },
      );
      if (!pick) return;
      candidate = pick.cand;
    } else {
      const query = await vscode.window.showInputBox({
      ignoreFocusOut: true,
        title: `Search ${source.displayName}`,
        placeHolder:
          source.type === "ldap" ? "name / login / raw LDAP filter" : "free text, or raw CQL/JQL",
      });
      if (!query) return;
      const hits = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Searching…" },
        () => contextService.search(source, query),
      );
      const pick = await vscode.window.showQuickPick(
        [
          {
            label: "$(save) Bookmark this query itself",
            description: `${hits.length} result(s) just now`,
            detail: query,
            cand: { name: query.slice(0, 40), locator: query, kind: "query", detail: "" } as Cand,
          },
          ...hits.map((h) => ({
            label: `$(bookmark) ${h.title}`,
            description: Object.entries(h.meta ?? {})
              .filter(([k]) => k !== "dn" && k !== "key" && k !== "id")
              .slice(0, 3)
              .map(([, v]) => v)
              .join(" · "),
            detail: h.url,
            cand: {
              name: h.title.slice(0, 60),
              locator: h.meta?.key ?? h.meta?.id ?? h.meta?.dn ?? "",
              kind: "item",
              detail: "",
            } as Cand,
          })),
        ].filter((i) => i.cand.locator),
        { ignoreFocusOut: true, title: "Bookmark the query, or one specific result?", matchOnDetail: true },
      );
      if (!pick) return;
      candidate = pick.cand;
    }

    // Database candidates are canned sample queries ("SELECT TOP 25 * …") —
    // let the user tailor the SQL/spec before it's saved (pilot request).
    if (DB_SOURCE_TYPES.has(source.type) && candidate.kind === "query") {
      const edited = await vscode.window.showInputBox({
        ignoreFocusOut: true,
        title:
          source.type === "mongodb"
            ? "Bookmark query — adjust the MongoDB spec (JSON)"
            : "Bookmark query — adjust the SQL (read-only SELECT)",
        value: candidate.locator,
        prompt: "Edit columns, WHERE clauses, limits… It stays guarded read-only at run time.",
        validateInput: (v) => bookmarkLocatorIssue(source.type, "query", v),
      });
      if (!edited) return;
      candidate = { ...candidate, locator: edited.trim() };
    }

    const name = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      title: "Bookmark name",
      value: candidate.name,
      prompt: "Shown in the Reference Sources tree and usable by name in chat (#spRunBookmark).",
    });
    if (!name) return;
    await bookmarks.add({
      id: crypto.randomUUID(),
      sourceId: source.id,
      name: name.trim(),
      locator: candidate.locator,
      kind: candidate.kind,
    });
    telemetry.record("bookmark.add", { type: source.type, kind: candidate.kind, via: "browse" });
    void vscode.window.showInformationMessage(
      `Bookmark "${name.trim()}" saved under ${source.displayName}.`,
    );
  });

  register("aiSharePoint.addBookmark", async (arg) => {
    const source = await resolveSourceArg(arg, contextSources);
    if (!source) return;
    const isDb = DB_SOURCE_TYPES.has(source.type);
    const kindHint =
      source.type === "ldap"
        ? "LDAP filter / DN"
        : source.type === "jira"
          ? "JQL / issue key"
          : source.type === "mongodb"
            ? '{"collection": "...", "filter": {...}, "limit": 25}'
            : isDb
              ? "SELECT … (read-only)"
              : "CQL / page id";
    const locator = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      title: `Bookmark for "${source.displayName}" — locator`,
      placeHolder: kindHint,
      prompt: "A reusable query or a specific item locator (no credentials).",
      validateInput: isDb ? (v) => bookmarkLocatorIssue(source.type, "query", v) : undefined,
    });
    if (!locator) return;
    // Database bookmarks are always queries (there is no item fetch).
    const kindPick = isDb
      ? { value: "query" as const }
      : await vscode.window.showQuickPick(
          [
            { label: "$(search) Query", description: "a saved search to run", value: "query" as const },
            { label: "$(bookmark) Item", description: "a specific page/issue/entry by id/key/DN", value: "item" as const },
          ],
          { ignoreFocusOut: true, title: "Bookmark kind" },
        );
    if (!kindPick) return;
    const name = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      title: "Bookmark name",
      placeHolder: "e.g. Open R&D incidents",
      value: locator.slice(0, 40),
    });
    if (!name) return;
    await bookmarks.add({
      id: crypto.randomUUID(),
      sourceId: source.id,
      name: name.trim(),
      locator: locator.trim(),
      kind: kindPick.value,
    });
    telemetry.record("bookmark.add", { type: source.type, kind: kindPick.value });
    void vscode.window.showInformationMessage(`Bookmark "${name.trim()}" saved.`);
  });

  register("aiSharePoint.runBookmark", async (arg) => {
    const bookmark = arg as ContextBookmark | undefined;
    if (!bookmark?.sourceId) return;
    const source = contextSources.get(bookmark.sourceId);
    if (!source) {
      void vscode.window.showWarningMessage("This bookmark's source no longer exists.");
      return;
    }
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Running "${bookmark.name}"…` },
      async () =>
        bookmark.kind === "item"
          ? await contextService.getItem(source, bookmark.locator)
          : await contextService.search(source, bookmark.locator),
    );
    telemetry.record("bookmark.run", { kind: bookmark.kind });
    const doc = await vscode.workspace.openTextDocument({
      language: "json",
      content: JSON.stringify(
        { bookmark: bookmark.name, source: source.displayName, result },
        null,
        2,
      ),
    });
    await vscode.window.showTextDocument(doc, { preview: true });
  });

  register("aiSharePoint.removeBookmark", async (arg) => {
    const bookmark = arg as ContextBookmark | undefined;
    if (!bookmark?.id) return;
    await bookmarks.remove(bookmark.id);
    telemetry.record("bookmark.remove");
  });

  register("aiSharePoint.editBookmark", async (arg) => {
    let bookmark = arg as ContextBookmark | undefined;
    if (!bookmark?.id) {
      // Palette path: pick one.
      const all = bookmarks.list();
      if (all.length === 0) {
        void vscode.window.showInformationMessage("No bookmarks saved yet.");
        return;
      }
      const pick = await vscode.window.showQuickPick(
        all.map((b) => ({
          label: b.name,
          description: contextSources.get(b.sourceId)?.displayName ?? "",
          detail: b.locator,
          bookmark: b,
        })),
        { ignoreFocusOut: true, title: "Edit which bookmark?", matchOnDetail: true },
      );
      if (!pick) return;
      bookmark = pick.bookmark;
    }
    const source = contextSources.get(bookmark.sourceId);
    const name = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      title: "Edit bookmark — name",
      value: bookmark.name,
      validateInput: (v) => (v.trim() ? undefined : "Enter a name"),
    });
    if (!name) return;
    const locator = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      title:
        source && DB_SOURCE_TYPES.has(source.type) && bookmark.kind === "query"
          ? source.type === "mongodb"
            ? "Edit bookmark — MongoDB query spec (JSON)"
            : "Edit bookmark — SQL query (read-only SELECT)"
          : "Edit bookmark — locator (query or item id)",
      value: bookmark.locator,
      prompt:
        source && DB_SOURCE_TYPES.has(source.type) && bookmark.kind === "query"
          ? "Adjust the saved query freely — it stays guarded read-only at run time."
          : "A reusable query or a specific item locator (no credentials).",
      validateInput: (v) => bookmarkLocatorIssue(source?.type, bookmark!.kind, v),
    });
    if (!locator) return;
    await bookmarks.update({
      ...bookmark,
      name: name.trim(),
      locator: locator.trim(),
    });
    telemetry.record("bookmark.edit", { type: source?.type ?? "unknown" });
    void vscode.window.showInformationMessage(`Bookmark "${name.trim()}" updated.`);
  });

  register("aiSharePoint.resetSourceLockout", async (arg) => {
    const source = await resolveSourceArg(arg, contextSources);
    if (!source) return;
    const confirm = await vscode.window.showWarningMessage(
      `Reset the auth-failure lockout for "${source.displayName}"? Only do this after confirming with your administrator that the account is not about to lock — the breaker exists to protect it (ADR-0009).`,
      { modal: true },
      "Reset Lockout",
    );
    if (confirm === "Reset Lockout") {
      await contextSources.resetLockout(source.id);
      void vscode.window.showInformationMessage(
        "Lockout reset. Run “Test Context Source” to enter a fresh credential.",
      );
    }
  });

  register("aiSharePoint.clearContextCache", () => {
    contextCache.clear();
    void vscode.window.showInformationMessage("Cached reference-source results cleared.");
  });

  register("aiSharePoint.exportReferenceConfig", async () => {
    const all = contextSources.list();
    if (all.length === 0 && bookmarks.list().length === 0) {
      void vscode.window.showInformationMessage("No reference sources or bookmarks to export.");
      return;
    }
    const schemasById = new Map(
      all.flatMap((s) => {
        const schema = schemas.getSync(s.id);
        return schema ? [[s.id, schema] as const] : [];
      }),
    );
    const exportDoc = buildReferenceExport(all, bookmarks.list(), nowIso(), schemasById);
    const json = JSON.stringify(exportDoc, null, 2);
    // Defense in depth (ADR-0013): the builder is secret-free by construction;
    // the scan refuses to write if anything credential-shaped slipped through.
    const blockers = scanForLeaks(json).filter((f) => f.severity === "block");
    if (blockers.length > 0) {
      void vscode.window.showErrorMessage(
        `Export blocked by the safety scan (${blockers.map((f) => f.pattern).join(", ")}). Nothing was written.`,
      );
      return;
    }
    const preview = await vscode.workspace.openTextDocument({ language: "json", content: json });
    await vscode.window.showTextDocument(preview, { preview: true });
    const confirm = await vscode.window.showInformationMessage(
      `Export ${exportDoc.sources.length} source(s) and ${exportDoc.bookmarks.length} bookmark(s)? The file contains descriptors and bookmarks only — no credentials or accounts; recipients sign in with their own.`,
      { modal: true },
      "Save Reference Config…",
    );
    if (!confirm) return;
    const stamp = nowIso().replace(/[-:]/g, "").slice(0, 13);
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(
        path.join(os.homedir(), `ai-sharepoint-reference-config-${stamp}.json`),
      ),
      filters: { "Reference config (JSON)": ["json"] },
    });
    if (!target) return;
    await vscode.workspace.fs.writeFile(target, Buffer.from(json, "utf8"));
    telemetry.record("context.exportConfig", { sources: exportDoc.sources.length });
    void vscode.window.showInformationMessage("Reference config exported (secret-free).");
  });

  register("aiSharePoint.importReferenceConfig", async () => {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { "Reference config (JSON)": ["json"] },
      title: "Import reference config (sources + bookmarks, no credentials)",
    });
    if (!picked?.[0]) return;
    const json = Buffer.from(await vscode.workspace.fs.readFile(picked[0])).toString("utf8");
    const parsed = parseReferenceImport(json, nowIso(), () => crypto.randomUUID());

    const existingNames = new Set(contextSources.list().map((s) => s.displayName.toLowerCase()));
    const fresh = parsed.sources.filter((s) => !existingNames.has(s.displayName.toLowerCase()));
    const skipped = parsed.sources.length - fresh.length;
    // Aliases must stay unique against what's already configured here — drop
    // (don't fail on) imported aliases that collide.
    const existingAliases = new Set(
      contextSources.list().flatMap((s) => (s.alias ? [s.alias.toLowerCase()] : [])),
    );
    for (const s of fresh) {
      if (s.alias && existingAliases.has(s.alias.toLowerCase())) {
        parsed.warnings.push(`Alias "${s.alias}" of "${s.displayName}" is already in use here — dropped.`);
        delete s.alias;
      } else if (s.alias) {
        existingAliases.add(s.alias.toLowerCase());
      }
    }
    if (fresh.length === 0 && parsed.bookmarks.length === 0) {
      void vscode.window.showWarningMessage(
        `Nothing to import${skipped ? ` (${skipped} source(s) already exist by name)` : ""}.`,
      );
      return;
    }
    const freshIds = new Set(fresh.map((s) => s.id));
    const freshBookmarks = parsed.bookmarks.filter((b) => freshIds.has(b.sourceId));
    const confirm = await vscode.window.showInformationMessage(
      `Import ${fresh.length} source(s) and ${freshBookmarks.length} bookmark(s)?${skipped ? ` ${skipped} source(s) skipped (same name already configured).` : ""} Credentials are NOT included — verify each source with your own sign-in afterwards.${parsed.warnings.length ? ` ${parsed.warnings.length} entr(ies) were skipped as malformed.` : ""}`,
      { modal: true },
      "Import",
    );
    if (!confirm) return;
    for (const s of fresh) {
      await contextSources.upsert(s);
    }
    for (const b of freshBookmarks) {
      await bookmarks.add(b);
    }
    for (const entry of parsed.schemas) {
      if (freshIds.has(entry.sourceId)) {
        await schemas.set(entry.sourceId, entry.schema);
      }
    }
    telemetry.record("context.importConfig", { sources: fresh.length, bookmarks: freshBookmarks.length });
    void vscode.window.showInformationMessage(
      `Imported ${fresh.length} source(s) and ${freshBookmarks.length} bookmark(s). Run “Test Context Source” on each to sign in (lockout-safe single verify).`,
    );
  });

  register("aiSharePoint.discoverActiveDirectory", async () => {
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Discovering Active Directory via DNS…" },
      () => discoverActiveDirectory(),
    );
    const lines = [
      `# Active Directory discovery`,
      "",
      `**Domain:** ${result.domain}  _(via ${result.via})_`,
      `**Base DN:** \`${result.baseDn}\``,
      "",
      `**Durable connection locators** _(re-resolved on every connection — survive DC changes)_:`,
      "",
      `- Global Catalog: \`${srvLocatorUrl(result.domain, "gc")}\``,
      `- Domain Controllers: \`${srvLocatorUrl(result.domain, "dc")}\``,
      "",
      `**Servers these currently resolve to (${result.candidates.length}, informational):**`,
      "",
      "| Host | Port | Kind |",
      "|---|---|---|",
      ...result.candidates.map(
        (c) => `| ${c.host} | ${c.port} | ${c.kind === "gc" ? "Global Catalog" : "Domain Controller"} |`,
      ),
      "",
      "_Add a source with **Add Context Source → LDAP / Active Directory** — it stores the durable locator, never a specific server._",
    ];
    const doc = await vscode.workspace.openTextDocument({
      language: "markdown",
      content: lines.join("\n"),
    });
    await vscode.window.showTextDocument(doc, { preview: true });
    telemetry.record("context.adDiscover", { endpoints: result.candidates.length });
  });

  // --- Communication Channels (ADR-0025) -----------------------------------
  // Drafts are prepared into the outbox; sending happens ONLY in
  // reviewCommDraft after a modal approval that names every recipient.

  const COMMS_CONN_KEY = "aiSharePoint.commsConnection";
  const commsClientFor = async (): Promise<CommsClient | undefined> => {
    const all = sites.list();
    if (all.length === 0) {
      const add = await vscode.window.showInformationMessage(
        "Communications use your Microsoft 365 sign-in — connect a SharePoint site first to establish it.",
        "Connect Site",
      );
      if (add) await vscode.commands.executeCommand("aiSharePoint.connectSite");
      return undefined;
    }
    let conn = all.length === 1 ? all[0] : undefined;
    if (!conn) {
      const remembered = context.globalState.get<string>(COMMS_CONN_KEY);
      conn = all.find((c) => c.cacheHandle === remembered);
    }
    if (!conn) {
      const pick = await vscode.window.showQuickPick(
        all.map((c) => ({
          label: c.displayName,
          description: `${c.tenantHost}${c.account ? ` · ${c.account}` : ""}`,
          conn: c,
        })),
        { ignoreFocusOut: true, title: "Send using which Microsoft 365 sign-in?" },
      );
      if (!pick) return undefined;
      conn = pick.conn;
      await context.globalState.update(COMMS_CONN_KEY, conn.cacheHandle);
    }
    const provider = registry.create(conn.authProviderId, conn.cacheHandle);
    return new CommsClient(provider, false);
  };

  const promptCommDraft = async (
    channel: CommChannel,
    current?: CommDraft,
  ): Promise<CommDraft | undefined> => {
    const toRaw = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      title: `${channel === "teams" ? "Teams message" : "Email"} — recipients`,
      value: current?.to.join(", ") ?? "",
      placeHolder: "jdoe@corp.example, asmith@corp.example  (individuals, max 10)",
      validateInput: (v) => recipientIssue(parseRecipients(v)),
    });
    if (!toRaw) return undefined;
    let subject = current?.subject;
    if (channel === "outlook") {
      subject = await vscode.window.showInputBox({
        ignoreFocusOut: true,
        title: "Email — subject",
        value: current?.subject ?? "",
        validateInput: (v) =>
          !v.trim()
            ? "Email drafts need a subject."
            : v.length > MAX_SUBJECT_CHARS
              ? `Max ${MAX_SUBJECT_CHARS} characters.`
              : undefined,
      });
      if (!subject) return undefined;
    }
    const body = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      title: `${channel === "teams" ? "Teams message" : "Email"} — body`,
      value: current?.body ?? "",
      placeHolder: "Plain text. Tip: ask @sharepoint to draft longer messages — they land here for approval too.",
      validateInput: (v) =>
        !v.trim() ? "The message body is empty." : v.length > MAX_BODY_CHARS ? "Too long." : undefined,
    });
    if (!body) return undefined;
    const draft: CommDraft = {
      id: current?.id ?? crypto.randomUUID(),
      channel,
      to: parseRecipients(toRaw),
      ...(subject?.trim() ? { subject: subject.trim() } : {}),
      body,
      createdAt: current?.createdAt ?? nowIso(),
      origin: current?.origin ?? "user",
      ...(current?.reason ? { reason: current.reason } : {}),
    };
    const issue = draftIssue(draft);
    if (issue) {
      void vscode.window.showErrorMessage(`Draft not saved: ${issue}`);
      return undefined;
    }
    return draft;
  };

  register("aiSharePoint.draftTeamsMessage", async () => {
    const draft = await promptCommDraft("teams");
    if (!draft) return;
    await outbox.add(draft);
    telemetry.record("comms.draft", { channel: "teams", via: "user" });
    const review = await vscode.window.showInformationMessage(
      "Draft added to Communications — nothing sends until you approve it there.",
      "Review & Send Now",
    );
    if (review) await vscode.commands.executeCommand("aiSharePoint.reviewCommDraft", draft);
  });

  register("aiSharePoint.draftOutlookEmail", async () => {
    const draft = await promptCommDraft("outlook");
    if (!draft) return;
    await outbox.add(draft);
    telemetry.record("comms.draft", { channel: "outlook", via: "user" });
    const review = await vscode.window.showInformationMessage(
      "Draft added to Communications — nothing sends until you approve it there.",
      "Review & Send Now",
    );
    if (review) await vscode.commands.executeCommand("aiSharePoint.reviewCommDraft", draft);
  });

  register("aiSharePoint.editCommDraft", async (arg) => {
    const existing = (arg as CommDraft)?.id ? outbox.get((arg as CommDraft).id) : undefined;
    if (!existing) return;
    const edited = await promptCommDraft(existing.channel, existing);
    if (!edited) return;
    await outbox.update(edited);
    void vscode.window.showInformationMessage("Draft updated (still pending your approval).");
  });

  register("aiSharePoint.discardCommDraft", async (arg) => {
    const draft = (arg as CommDraft)?.id ? outbox.get((arg as CommDraft).id) : undefined;
    if (!draft) return;
    const confirm = await vscode.window.showWarningMessage(
      `Discard the ${draft.channel} draft to ${draft.to.join(", ")}? Nothing was ever sent.`,
      { modal: true },
      "Discard Draft",
    );
    if (confirm !== "Discard Draft") return;
    await outbox.remove(draft.id);
    telemetry.record("comms.discard", { channel: draft.channel, origin: draft.origin });
  });

  register("aiSharePoint.reviewCommDraft", async (arg) => {
    let draft = (arg as CommDraft)?.id ? outbox.get((arg as CommDraft).id) : undefined;
    if (!draft) {
      const all = outbox.list();
      if (all.length === 0) {
        void vscode.window.showInformationMessage(
          "No communication drafts pending. Create one with “Draft Teams Message” / “Draft Outlook Email”, or ask @sharepoint to prepare one.",
        );
        return;
      }
      const pick = await vscode.window.showQuickPick(
        all.map((d) => ({
          label: draftLabel(d),
          description: `${d.channel} → ${d.to.join(", ")}`,
          d,
        })),
        { ignoreFocusOut: true, title: "Review which draft?" },
      );
      if (!pick) return;
      draft = pick.d;
    }

    // Full-fidelity preview first — approval must never rely on a truncated
    // toast (ADR-0025: the user sees exactly what would be sent).
    const previewDoc = await vscode.workspace.openTextDocument({
      language: "markdown",
      content: [
        `# ${draft.channel === "teams" ? "Teams message" : "Outlook email"} — pending approval`,
        "",
        `**To:** ${draft.to.join(", ")}`,
        ...(draft.subject ? [`**Subject:** ${draft.subject}`] : []),
        `**Prepared by:** ${draft.origin === "agent" ? "@sharepoint (assistant)" : "you"} at ${draft.createdAt}`,
        ...(draft.reason ? [`**Why:** ${draft.reason}`] : []),
        "",
        "---",
        "",
        draft.body,
        "",
        "---",
        "_Nothing has been sent. Approve or discard in the dialog._",
      ].join("\n"),
    });
    await vscode.window.showTextDocument(previewDoc, { preview: true });

    const sendLabel = draft.channel === "teams" ? "Send via Teams" : "Send Email";
    const buttons =
      draft.channel === "outlook"
        ? [sendLabel, "Save to Outlook Drafts", "Discard Draft"]
        : [sendLabel, "Discard Draft"];
    const choice = await vscode.window.showWarningMessage(
      `Approve this ${draft.channel === "teams" ? "Teams message" : "email"}?`,
      {
        modal: true,
        detail: `To: ${draft.to.join(", ")}${draft.subject ? `\nSubject: ${draft.subject}` : ""}\n\nIt is sent from YOUR account${draft.origin === "agent" ? " (content was prepared by the assistant — review it)" : ""}. The full text is open in the editor behind this dialog.`,
      },
      ...buttons,
    );
    if (!choice) return; // stays pending
    if (choice === "Discard Draft") {
      await outbox.remove(draft.id);
      telemetry.record("comms.discard", { channel: draft.channel, origin: draft.origin });
      return;
    }
    const commsClient = await commsClientFor();
    if (!commsClient) return;

    try {
      await runCommsSend();
    } catch (err) {
      const hint = explainCommsError(err instanceof Error ? err.message : String(err));
      if (hint) {
        throw new AppError(
          `Could not reach your Outlook/Teams via Microsoft Graph: ${err instanceof Error ? err.message : String(err)}`,
          "graph.forbidden",
          hint,
        );
      }
      throw err;
    }
    async function runCommsSend(): Promise<void> {
      await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Resolving recipients…" },
      async (progress) => {
        const resolved = [];
        const failures: string[] = [];
        for (const r of draft!.to) {
          try {
            resolved.push(await commsClient.resolveRecipient(r));
          } catch {
            failures.push(r);
          }
        }
        if (failures.length > 0) {
          throw new AppError(
            `Not sent — ${failures.length} recipient(s) could not be found in the directory: ${failures.join(", ")}. Edit the draft and retry.`,
            "config",
          );
        }
        if (choice === "Save to Outlook Drafts") {
          progress.report({ message: "Creating the draft in your mailbox…" });
          const created = await commsClient.createMailDraft(resolved, draft!.subject ?? "", draft!.body);
          await outbox.remove(draft!.id);
          telemetry.record("comms.saveDraft", { channel: "outlook", origin: draft!.origin });
          const open = await vscode.window.showInformationMessage(
            "Saved to your Outlook Drafts — finish and send it from Outlook.",
            ...(created.webLink ? ["Open in Outlook"] : []),
          );
          if (open && created.webLink) {
            await vscode.env.openExternal(vscode.Uri.parse(created.webLink));
          }
          return;
        }
        progress.report({ message: `Sending to ${resolved.map((r) => r.displayName).join(", ")}…` });
        if (draft!.channel === "teams") {
          await commsClient.sendTeamsMessage(resolved, draft!.body);
        } else {
          const created = await commsClient.createMailDraft(resolved, draft!.subject ?? "", draft!.body);
          await commsClient.sendMailDraft(created.id);
        }
        await outbox.remove(draft!.id);
        telemetry.record("comms.send", { channel: draft!.channel, origin: draft!.origin });
        void vscode.window.showInformationMessage(
          `Sent to ${resolved.map((r) => r.displayName).join(", ")} via ${draft!.channel === "teams" ? "Teams" : "Outlook"}.`,
        );
      },
      );
    }
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
        {
          label: "$(close) Close",
          description: "dismiss this list (clicking elsewhere or Esc works too)",
          detail: undefined as string | undefined,
          report: undefined as undefined,
          action: undefined as string | undefined,
        },
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
      {  title: `Error reports (${reports.length})`, matchOnDetail: true },
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
    const count = errors.count();
    if (count === 0) {
      void vscode.window.showInformationMessage("No error reports to delete.");
      return;
    }
    const confirm = await vscode.window.showWarningMessage(
      `Delete ${count} locally stored error report${count === 1 ? "" : "s"}? This cannot be undone.`,
      { modal: true },
      "Delete Reports",
    );
    if (confirm !== "Delete Reports") return;
    await errors.clear();
    void vscode.window.showInformationMessage("Error reports deleted.");
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

  register("aiSharePoint.toggleVerboseLogging", async () => {
    const next = !verboseWireOn();
    await vscode.workspace
      .getConfiguration("aiSharePoint")
      .update("logging.verboseWire", next, vscode.ConfigurationTarget.Global);
    if (next) {
      log.show();
      void vscode.window.showInformationMessage(
        "Verbose wire logging is ON — every integration request/response is written to the AI SharePoint log. Secrets are redacted (auth headers masked, token bodies withheld, credentials never logged), but the output is detailed: turn it off after debugging.",
      );
    } else {
      void vscode.window.showInformationMessage("Verbose wire logging is off.");
    }
  });

  register("aiSharePoint.openLogs", async () => {
    log.info("Extension logs opened from Support & Diagnostics.");
    // OutputChannel.show() alone can fail to reopen a closed Output panel
    // (microsoft/vscode#40690 family), so force the panel open first, then
    // select our channel in it — the reliable order.
    await vscode.commands
      .executeCommand("workbench.panel.output.focus")
      .then(undefined, () => undefined);
    log.show();
  });

  register("aiSharePoint.openUserGuide", () => openBundledDoc(context, "USER_GUIDE.md"));
  register("aiSharePoint.openPrivacyNotice", () => openBundledDoc(context, "PRIVACY.md"));

  register("aiSharePoint.openWalkthrough", async () => {
    // Build the category ID from the runtime extension ID so it can never
    // drift from package.json (publisher.name#walkthroughId).
    const walkthroughId = `${context.extension.id}#aiSharePoint.gettingStarted`;
    await vscode.commands.executeCommand("workbench.action.openWalkthrough", walkthroughId, false);
    // The first invocation can race walkthrough registration and fall back to
    // the generic Welcome page (microsoft/vscode#187958). Re-issuing against
    // the now-open page takes the makeCategoryVisibleWhenAvailable path,
    // which awaits registration — idempotent when the first call succeeded.
    await new Promise((resolve) => setTimeout(resolve, 400));
    await vscode.commands.executeCommand("workbench.action.openWalkthrough", walkthroughId, false);
  });

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
      ignoreFocusOut: true,
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

/** ServiceNow browser sign-in: PKCE auth-code over a loopback redirect —
 *  the browser (and its existing SSO session) does the authenticating;
 *  we only ever see the one-time code and the resulting tokens. */
async function snowBrowserSignIn(
  instanceUrl: string,
  clientId: string,
  clientSecret: string | undefined,
): Promise<ContextCredential | undefined> {
  const verifier = nodeCrypto.randomBytes(32).toString("base64url");
  const challenge = nodeCrypto.createHash("sha256").update(verifier).digest("base64url");
  const state = nodeCrypto.randomUUID();

  const code = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Complete the ServiceNow sign-in in your browser…",
      cancellable: true,
    },
    (_p, token) =>
      new Promise<string | undefined>((resolve, reject) => {
        const server = http.createServer((req, res) => {
          const u = new URL(req.url ?? "/", `http://localhost:${SNOW_LOOPBACK_PORT}`);
          if (u.pathname !== "/callback") {
            res.writeHead(404).end();
            return;
          }
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end("<html><body><h3>AI SharePoint: sign-in received.</h3>You can close this tab and return to VS Code.</body></html>");
          const returnedState = u.searchParams.get("state");
          const returnedCode = u.searchParams.get("code");
          server.close();
          if (!returnedCode || returnedState !== state) {
            reject(new AppError("ServiceNow sign-in returned no valid code (state mismatch).", "auth.failed"));
          } else {
            resolve(returnedCode);
          }
        });
        server.on("error", (err: NodeJS.ErrnoException) => {
          reject(
            new AppError(
              err.code === "EADDRINUSE"
                ? `Port ${SNOW_LOOPBACK_PORT} is busy — close the application using it and retry.`
                : `Sign-in listener failed: ${err.message}`,
              "auth.failed",
            ),
          );
        });
        server.listen(SNOW_LOOPBACK_PORT, "127.0.0.1", () => {
          void vscode.env.openExternal(
            vscode.Uri.parse(buildSnowAuthUrl(instanceUrl, clientId, state, challenge)),
          );
        });
        const timer = setTimeout(() => {
          server.close();
          reject(new AppError("ServiceNow sign-in timed out after 3 minutes.", "auth.failed"));
        }, 180_000);
        token.onCancellationRequested(() => {
          clearTimeout(timer);
          server.close();
          resolve(undefined);
        });
      }),
  );
  if (!code) return undefined;
  const tokens = await exchangeSnowCode(
    instanceUrl,
    { code, clientId, clientSecret, codeVerifier: verifier },
    Date.now(),
  );
  return { method: "snow-oauth", secret: JSON.stringify(tokens) };
}

/** Validate a bookmark locator at edit/save time. SQL bookmarks must stay
 *  read-only SELECTs (the runtime guard re-checks — this is early feedback);
 *  MongoDB bookmarks must be a valid query spec. */
function bookmarkLocatorIssue(
  type: ContextSourceType | undefined,
  kind: ContextBookmark["kind"],
  value: string,
): string | undefined {
  if (!value.trim()) return "Enter a locator";
  if (kind !== "query") return undefined;
  if (type === "mssql" || type === "postgres" || type === "mysql") {
    const verdict = assertReadOnlySql(value);
    return verdict.ok ? undefined : verdict.reason;
  }
  if (type === "mongodb") {
    try {
      parseMongoSpec(value);
      return undefined;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }
  return undefined;
}

/** Shared by add + edit: optional chat alias (unique, validated) and
 *  description. Enter on an empty box skips/clears; Esc cancels the flow. */
async function promptSourceAliasAndDescription(
  existing: ContextSource[],
  current?: { id?: string; alias?: string; description?: string },
): Promise<{ alias?: string; description?: string } | undefined> {
  const aliasRaw = await vscode.window.showInputBox({
    ignoreFocusOut: true,
    title: "Chat alias (optional)",
    value: current?.alias ?? "",
    placeHolder: 'CMDB — short handle for @sharepoint chat ("…in the CMDB database")',
    prompt: current?.alias
      ? "Press Enter to keep/change, or clear the box to remove the alias."
      : "Press Enter to skip. You can set it later via right-click → Edit Alias & Description.",
    validateInput: (v) => (v.trim() ? aliasIssue(v, existing, current?.id) : undefined),
  });
  if (aliasRaw === undefined) return undefined;
  const descriptionRaw = await vscode.window.showInputBox({
    ignoreFocusOut: true,
    title: "Description (optional)",
    value: current?.description ?? "",
    placeHolder: "What's in it — e.g. ServiceNow CMDB replica: application & service inventory",
    prompt: "Shown to Copilot so it picks the right source for a question. Press Enter to skip.",
    validateInput: (v) =>
      v.trim().length > DESCRIPTION_MAX_LENGTH
        ? `Keep it under ${DESCRIPTION_MAX_LENGTH} characters.`
        : undefined,
  });
  if (descriptionRaw === undefined) return undefined;
  return {
    alias: aliasRaw.trim() ? normalizeAlias(aliasRaw) : undefined,
    description: descriptionRaw.trim() ? descriptionRaw.trim().slice(0, DESCRIPTION_MAX_LENGTH) : undefined,
  };
}

async function resolveSourceArg(
  arg: unknown,
  store: ContextSourcesStore,
): Promise<ContextSource | undefined> {
  if (arg && typeof arg === "object" && "id" in arg && "baseUrl" in arg) {
    return store.get((arg as ContextSource).id) ?? (arg as ContextSource);
  }
  const all = store.list();
  if (all.length === 0) {
    const add = await vscode.window.showInformationMessage(
      "No reference sources configured yet.",
      "Add Context Source",
    );
    if (add) {
      await vscode.commands.executeCommand("aiSharePoint.addContextSource");
    }
    return undefined;
  }
  if (all.length === 1) return all[0];
  const pick = await vscode.window.showQuickPick(
    all.map((s) => ({
      label: s.displayName,
      description: `${s.alias ? `“${s.alias}” · ` : ""}${s.type} · ${s.deployment}`,
      source: s,
    })),
    { ignoreFocusOut: true, title: "Which source?" },
  );
  return pick?.source;
}

interface LdapEndpoint {
  baseUrl: string;
  baseDn: string;
  defaultUpn?: string;
}

/** Run AD auto-discovery and offer DURABLE endpoints: when servers come from
 *  DNS SRV, the source stores the lookup itself (ldaps+srv://…) and re-resolves
 *  on every connection — individual server names are shown only as
 *  informational "currently resolves to" detail (ADR-0020 amendment). */
async function resolveLdapEndpoint(): Promise<LdapEndpoint | undefined> {
  type Item = vscode.QuickPickItem & { endpoint?: LdapEndpoint; manual?: boolean };
  const items: Item[] = [];
  let discoveredUpn: string | undefined;

  try {
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Discovering Active Directory via DNS…" },
      () => discoverActiveDirectory(),
    );
    discoveredUpn = guessBindUpn(realHostSignals(), result.domain);
    const gcHosts = result.candidates.filter((c) => c.kind === "gc").map((c) => c.host);
    const dcHosts = result.candidates.filter((c) => c.kind === "dc").map((c) => c.host);
    const currently = (hosts: string[]) =>
      hosts.length ? `currently resolves to: ${hosts.slice(0, 3).join(", ")}${hosts.length > 3 ? ", …" : ""}` : "no servers currently resolving";
    items.push({
      label: `$(search) Discovered domain: ${result.domain}`,
      kind: vscode.QuickPickItemKind.Separator,
    } as Item);
    if (gcHosts.length > 0) {
      items.push({
        label: "$(globe) Global Catalog via DNS (recommended)",
        description: "forest-wide reads · durable — re-resolved on every connection",
        detail: `${srvLocatorUrl(result.domain, "gc")} · ${currently(gcHosts)}`,
        endpoint: {
          baseUrl: srvLocatorUrl(result.domain, "gc"),
          baseDn: result.baseDn,
          defaultUpn: discoveredUpn,
        },
      });
    }
    if (dcHosts.length > 0) {
      items.push({
        label: "$(server) Domain Controllers via DNS",
        description: "domain-scoped reads · durable — re-resolved on every connection",
        detail: `${srvLocatorUrl(result.domain, "dc")} · ${currently(dcHosts)}`,
        endpoint: {
          baseUrl: srvLocatorUrl(result.domain, "dc"),
          baseDn: result.baseDn,
          defaultUpn: discoveredUpn,
        },
      });
    }
  } catch (err) {
    void vscode.window.showWarningMessage(
      `AD auto-discovery: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  items.push({
    label: "$(edit) Enter a specific server manually…",
    description: "pins one host — use only when DNS discovery is unavailable",
    manual: true,
  });

  const pick = await vscode.window.showQuickPick(items, {
    ignoreFocusOut: true,
    title: "Active Directory endpoint",
    placeHolder: "DNS-based endpoints stay valid as domain controllers change over time",
  });
  if (!pick) return undefined;
  if (pick.endpoint) return pick.endpoint;
  if (!pick.manual) return undefined;

  const url = await vscode.window.showInputBox({
      ignoreFocusOut: true,
    title: "LDAP server URL (static — prefer the DNS option when available)",
    placeHolder: "ldaps://dc01.corp.example:636  (or ldap://…:389)",
    validateInput: (v) =>
      /^ldaps?:\/\/[^\s/]+/i.test(v.trim()) ? undefined : "Enter an ldap:// or ldaps:// URL",
  });
  if (!url) return undefined;
  let guessedBase = "";
  const hostMatch = url.match(/\/\/([^:/]+)/);
  if (hostMatch && hostMatch[1].includes(".")) {
    guessedBase = domainToBaseDn(hostMatch[1].split(".").slice(1).join("."));
  }
  const baseDn = await vscode.window.showInputBox({
      ignoreFocusOut: true,
    title: "Base DN (search root)",
    value: guessedBase,
    placeHolder: "DC=corp,DC=example,DC=com",
    validateInput: (v) => (/dc=/i.test(v) ? undefined : "Expected a DN containing DC= components"),
  });
  if (!baseDn) return undefined;
  return { baseUrl: url.trim(), baseDn: baseDn.trim(), defaultUpn: discoveredUpn };
}

async function promptContextCredential(
  type: ContextSourceType,
  deployment: ContextDeployment,
  defaultUpn?: string,
  baseUrl?: string,
): Promise<ContextCredential | undefined> {
  let method: ContextCredential["method"];
  if (type === "splunk") {
    const mode = await vscode.window.showQuickPick(
      [
        {
          label: "$(shield) Authentication token (recommended)",
          description: "Splunk Web → Settings → Tokens — scoped, revocable",
          value: "pat" as const,
        },
        {
          label: "$(key) Username + password",
          description: "a least-privilege search-only account is recommended",
          value: "basic" as const,
        },
      ],
      { ignoreFocusOut: true, title: "Splunk sign-in" },
    );
    if (!mode) return undefined;
    if (mode.value === "pat") {
      const secret = await vscode.window.showInputBox({
        ignoreFocusOut: true,
        title: "Splunk authentication token",
        password: true,
        prompt: "Stored only in your OS keychain; verified with a single read (lockout-safe).",
      });
      if (!secret) return undefined;
      return { method: "pat", secret: secret.trim() };
    }
    const username = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      title: "Splunk user",
      placeHolder: "search.readonly",
    });
    if (!username) return undefined;
    const secret = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      title: "Splunk password",
      password: true,
      prompt: "Stored only in your OS keychain; verified with a single read (lockout-safe).",
    });
    if (!secret) return undefined;
    return { method: "basic", username: username.trim(), secret };
  }
  if (type === "servicenow") {
    const snowClientId = vscode.workspace
      .getConfiguration("aiSharePoint")
      .get<string>("servicenow.oauthClientId", "")
      .trim();
    const mode = await vscode.window.showQuickPick(
      [
        ...(baseUrl
          ? [
              {
                label: "$(globe) Browser sign-in (SSO — recommended)",
                description: snowClientId
                  ? "opens your browser; your existing ServiceNow session does the authenticating"
                  : "requires aiSharePoint.servicenow.oauthClientId (one-time admin setup)",
                value: "browser" as const,
              },
            ]
          : []),
        {
          label: "$(key) Basic — integration user + password",
          description: "a least-privilege read-only service account is recommended",
          value: "basic" as const,
        },
        {
          label: "$(shield) OAuth bearer token",
          description: "paste an access token from your instance's OAuth provider",
          value: "pat" as const,
        },
      ],
      { ignoreFocusOut: true, title: "ServiceNow sign-in" },
    );
    if (!mode) return undefined;
    if (mode.value === "browser") {
      if (!snowClientId) {
        void vscode.window.showWarningMessage(
          "Browser sign-in needs aiSharePoint.servicenow.oauthClientId — ask your ServiceNow admin to create an OAuth client (Application Registry) with redirect URL http://localhost:51725/callback, then set the ID in settings.",
        );
        return undefined;
      }
      const secretRaw = await vscode.window.showInputBox({
        ignoreFocusOut: true,
        title: "OAuth client secret — Enter to skip for PKCE/public clients",
        password: true,
        prompt: "Only needed when the Application Registry entry is confidential; PKCE-enabled clients need none.",
      });
      if (secretRaw === undefined) return undefined;
      return snowBrowserSignIn(baseUrl!, snowClientId, secretRaw.trim() || undefined);
    }
    if (mode.value === "pat") {
      const secret = await vscode.window.showInputBox({
        ignoreFocusOut: true,
        title: "ServiceNow OAuth access token",
        password: true,
        prompt: "Stored only in your OS keychain; verified with a single read (lockout-safe).",
      });
      if (!secret) return undefined;
      return { method: "pat", secret: secret.trim() };
    }
    const username = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      title: "ServiceNow user",
      placeHolder: "integration.readonly",
      prompt: "Use a least-privilege read account where available.",
    });
    if (!username) return undefined;
    const secret = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      title: "ServiceNow password",
      password: true,
      prompt: "Stored only in your OS keychain; verified with a single read (lockout-safe).",
    });
    if (!secret) return undefined;
    return { method: "basic", username: username.trim(), secret };
  }
  if (type === "vertexai") {
    const mode = await vscode.window.showQuickPick(
      [
        {
          label: "$(account) Google SSO via the gcloud CLI (recommended)",
          description: "uses your existing `gcloud auth login` session — tokens are never stored",
          value: "gcloud-sso" as const,
        },
        {
          label: "$(key) Paste an OAuth access token",
          description: "expires after ~1 h — for machines without the gcloud CLI",
          value: "pat" as const,
        },
      ],
      { ignoreFocusOut: true, title: "Vertex AI Search sign-in (Google SSO)" },
    );
    if (!mode) return undefined;
    if (mode.value === "gcloud-sso") {
      // Marker only — each call asks the CLI for a live SSO token.
      return { method: "gcloud-sso", secret: "gcloud-cli-session" };
    }
    const secret = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      title: "Google OAuth access token",
      password: true,
      prompt: "From `gcloud auth print-access-token` or your SSO portal. Stored only in your OS keychain.",
    });
    if (!secret) return undefined;
    return { method: "pat", secret: secret.trim() };
  }
  if (type === "mssql" || type === "postgres" || type === "mysql" || type === "mongodb") {
    let dbMethod: ContextCredential["method"] = "basic";
    let userTitle = "Database user (read-only account recommended)";
    let userPlaceholder = "report_reader";
    if (type === "mssql") {
      const mode = await vscode.window.showQuickPick(
        [
          {
            label: "$(key) SQL Server Authentication",
            description: "database login + password",
            value: "basic" as const,
          },
          {
            label: "$(account) Windows Authentication (NTLM)",
            description: "DOMAIN\\user or user@domain + password — no passwordless SSO (pure-JS NTLM)",
            value: "ntlm" as const,
          },
        ],
        { ignoreFocusOut: true, title: "SQL Server sign-in method" },
      );
      if (!mode) return undefined;
      dbMethod = mode.value;
      if (dbMethod === "ntlm") {
        userTitle = "Windows account";
        userPlaceholder = "CORP\\jdoe  or  jdoe@corp.example";
      }
    }
    const username = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      title: userTitle,
      placeHolder: userPlaceholder,
      prompt: "Use a least-privilege read account where available (ADR-0022).",
    });
    if (!username) return undefined;
    const secret = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      title: dbMethod === "ntlm" ? "Windows account password" : "Database password",
      password: true,
      prompt: "Stored only in your OS keychain; verified with a single read (lockout-safe).",
    });
    if (!secret) return undefined;
    return { method: dbMethod, username: username.trim(), secret };
  }
  if (type === "ldap") {
    // LDAP simple bind: UPN / DOMAIN\user / DN + password (ADR-0020).
    const username = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      title: "Active Directory sign-in — bind identity",
      value: defaultUpn ?? "",
      placeHolder: "you@corp.example  ·  CORP\\you  ·  CN=You,OU=Users,DC=corp,DC=example",
      prompt: "Your own AD account (read-only). Lockout-safe: a wrong password is never retried automatically.",
    });
    if (!username) return undefined;
    const secret = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      title: "Active Directory password",
      password: true,
      prompt: "Stored only in your OS keychain; verified with a single bind.",
    });
    if (!secret) return undefined;
    return { method: "ldap-simple", username: username.trim(), secret };
  }
  if (deployment === "cloud") {
    method = "basic"; // Atlassian Cloud: email + API token over Basic
  } else {
    const pick = await vscode.window.showQuickPick(
      [
        {
          label: "$(key) Personal access token",
          description: "Recommended for Data Center",
          value: "pat" as const,
        },
        {
          label: "$(account) Username + password/token (Basic)",
          description: "Standard-user path (ADR-0014)",
          value: "basic" as const,
        },
      ],
      { ignoreFocusOut: true, title: "Sign-in method" },
    );
    if (!pick) return undefined;
    method = pick.value;
  }

  let username: string | undefined;
  if (method === "basic") {
    username = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      title: deployment === "cloud" ? "Atlassian account email" : "Username",
      placeHolder: deployment === "cloud" ? "you@yourorg.com" : "jdoe",
    });
    if (!username) return undefined;
  }
  const secret = await vscode.window.showInputBox({
      ignoreFocusOut: true,
    title:
      method === "pat"
        ? "Personal access token"
        : deployment === "cloud"
          ? `${type === "jira" ? "Jira" : "Confluence"} API token (id.atlassian.com → Security → API tokens)`
          : "Password or token",
    password: true,
    prompt: "Stored only in your OS keychain; verified with a single read (lockout-safe).",
  });
  if (!secret) return undefined;
  return { method, username, secret };
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
