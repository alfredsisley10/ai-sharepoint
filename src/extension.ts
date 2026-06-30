import * as vscode from "vscode";
import * as os from "node:os";
import * as path from "node:path";
import { SecretStore } from "./secrets/secretStore";
import { Logger } from "./core/log";
import { AppError, adviceForError, classifyError } from "./core/errors";
import { EXTENSION_VERSION } from "./core/version";
import { redactError } from "./core/redaction";
import { UsageMeter } from "./copilot/meter";
import { CopilotService } from "./copilot/copilotService";
import { AuthProviderRegistry, AUTH_PROVIDERS } from "./auth/providerRegistry";
import { tenantCacheHandle } from "./auth/msalCache";
import { isSupportedSiteUrl } from "./auth/sharePointClient";
import { SitesStore, SiteConnection } from "./auth/sitesStore";
import { SiteAccess } from "./auth/siteAccess";
import { SharePointSessionStore } from "./auth/sharePointSessionStore";
import { registerSharePointSessionTools } from "./chat/sharePointSessionTools";
import { verifySharePointSession, sharePointCookieIssue } from "./auth/sharePointRestSession";
import { InstallIdStore } from "./diagnostics/installId";
import { TelemetryService } from "./diagnostics/telemetry";
import { ErrorReportStore } from "./diagnostics/errorReports";
import { DiagnosticsExportService } from "./diagnostics/exportService";
import { LessonsStore } from "./diagnostics/lessonsStore";
import { registerLessonsTools } from "./chat/lessonsTools";
import { registerMemoryTools } from "./chat/memoryTools";
import { BlockedTermsStore } from "./diagnostics/blockedTermsStore";
import { registerProxyTools } from "./chat/proxyTools";
import { ModelLimitsStore } from "./diagnostics/modelLimitsStore";
import { buildLessonsExport, lessonsToMarkdown } from "./diagnostics/lessons";
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
import { SharePointWriteClient, WritePermissionMode } from "./auth/sharePointWriteClient";
import { ContextSourcesStore } from "./context/sourcesStore";
import { ContextService } from "./context/contextService";
import { TtlCache } from "./context/cache";
import {
  ContextSource,
  ContextCredential,
  ContextDeployment,
  ContextSourceType,
  ConfluenceWriteScope,
} from "./context/types";
import {
  parseConfluenceUrl,
  writeScopeFromParsed,
  describeWriteScope,
} from "./context/adapters/confluenceScope";
import { summarizeProbe, summarizeFunctionalityProbe } from "./context/adapters/confluenceProbe";
import { registerContextTools } from "./chat/contextTools";
import { buildReferenceExport, parseReferenceImport, planMemoryImport, exportLeakBlockers } from "./context/referenceExport";
import { aliasIssue, normalizeAlias, resolveSourceRef, DESCRIPTION_MAX_LENGTH } from "./context/sourceRef";
import {
  rowsToCsv,
  exportFileName,
  sanitizeExportFileName,
  EXPORT_MAX_ROWS,
  EXPORT_TIMEOUT_MS,
  EXPORT_DIR,
} from "./context/exportData";
import { deriveSplunkObsEndpoints } from "./context/adapters/splunkObservability";
import { SchemaStore } from "./context/schemaStore";
import { SchemaIndexer } from "./context/db/schemaIndexer";
import { SourceSchema, ErModel, ProbedRelationship, TestedPair, qualifiedName } from "./context/db/schemaIndex";
import {
  proposeJoinCandidates,
  proposeExhaustivePairs,
  classifyJoin,
  renderErMermaid,
  renderProbeStatus,
  renderProbeReport,
  buildJoinCandidatePrompt,
  parseJoinCandidateResponse,
  parseJoinSpecs,
  buildSqlJoinExtractionPrompt,
  diagnoseSqlAgainstCatalog,
  mergeRelationships,
  buildCastRetryCandidates,
  initialSampleSize,
  nextSampleSize,
  pairKey,
  JoinCandidate,
  ER_SAMPLE_SIZE,
  ER_FULL_JOIN_MAX_ROWS,
  ER_AUTO_SWEEP_TABLES,
  ER_SLOW_PROBE_MS,
  ER_EXHAUSTIVE_PAIR_CAP,
  ER_STATUS_REFRESH_MS,
} from "./context/db/erDiagram";
import { assertReadOnlySql, parseMongoSpec } from "./context/db/readSafe";
import { CatalogStore } from "./context/catalogStore";
import {
  buildVertexServingConfig,
  vertexUrlIssue,
  parseVertexHint,
  endpointForLocation,
  listVertexEngines,
  listGcloudProjects,
  findVertexProjectForEngine,
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
import { setWireSink, safeUrl } from "./core/wireLog";
import { setLdapDnsServers } from "./context/ldap/ldapClient";
import {
  ProjectsStore,
  Project,
  INSTRUCTIONS_MAX_CHARS,
  GOALS_MAX_CHARS,
  AI_CONTEXT_MAX_CHARS,
} from "./context/projectsStore";
import { ProjectsTreeProvider } from "./ui/projectsView";
import { registerProjectTools } from "./chat/projectTools";
import {
  enumeratePowerBiDatasets,
  getAzPowerBiToken,
  POWERBI_SCOPES,
  AZURE_CLI_CLIENT_ID,
  POWERBI_AZCLI_CACHE_PREFIX,
} from "./context/adapters/powerbi";
import { listSnowTables } from "./context/adapters/servicenow";
import {
  buildSnowAuthUrl,
  exchangeSnowCode,
  cleanCookieString,
  cookieStringIssue,
  cookieNames,
  buildSnowSessionSecret,
  userTokenIssue,
  SNOW_LOOPBACK_PORT,
} from "./context/adapters/servicenowAuth";
import {
  deriveSplunkApiCandidates,
  verifySplunk,
  searchSplunk,
  listSplunkApps,
} from "./context/adapters/splunk";
import * as http from "node:http";
import * as nodeCrypto from "node:crypto";
import { OutboxStore } from "./comms/outboxStore";
import { CommsClient } from "./comms/commsClient";
import {
  TeamsWebhook,
  teamsWebhookUrlIssue,
  isKnownWebhookHost,
  buildTeamsWebhookPayload,
  postTeamsWebhook,
} from "./comms/teamsWebhook";
import {
  CommsMethodKind,
  verificationKey,
  generateVerificationCode,
  codeMatches,
  buildTestMessage,
  verifiedLabel,
} from "./comms/commsTest";
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
import { registerSiteDevTools } from "./chat/siteDevTools";
import { parseSsmsServerName, buildMssqlUrl } from "./context/db/mssqlAuth";
import { scanForLeaks } from "./diagnostics/bundle";
import { BookmarksStore } from "./context/bookmarksStore";
import { MemoryStore } from "./context/memoryStore";
import { MemoryItem, MemoryScope, MemoryScopeKind, normalizeMemoryInput } from "./context/memory";
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
import { runRebrandFlow } from "./branding/rebrandFlow";
import { evaluateExpiry, setReleaseStatus, ReleaseManifest } from "./branding/releaseExpiry";
import { ExternalTelemetry, ExternalTelemetryConfig } from "./diagnostics/externalTelemetry";
import { TelemetryEnv } from "./diagnostics/telemetrySink";
import { TelemetryConfigStore, effectiveTelemetryConfig, StoredTelemetryConfig, telemetryStatus, TelemetryStatus } from "./diagnostics/telemetryConfig";
import { applyProvisioning, ProvisioningEffects } from "./branding/provisioning";
import { ProvisioningManifest, connectorKey } from "./branding/releaseProfile";
import { deobfuscateSecret } from "./diagnostics/secretObfuscation";
import { UsageDashboard } from "./ui/dashboard";
import { registerChatParticipant } from "./chat/participant";
import { registerLanguageModelTools } from "./chat/tools";

/** Host clock, isolated so it's the single source of "now" (ISO, UTC). */
const nowIso = () => new Date().toISOString();

export function activate(context: vscode.ExtensionContext): void {
  const log = new Logger("AI SharePoint");

  // Release expiry (white-label time-limited builds): read the manifest baked
  // into package.json and, if past its date, gate the AI surfaces with an
  // upgrade prompt. Fails open on a missing/standard build or malformed data.
  const releaseManifest = (context.extension.packageJSON as { release?: ReleaseManifest }).release;
  const expiry = evaluateExpiry(releaseManifest, Date.now());
  setReleaseStatus(expiry);
  if (expiry.message) {
    const items = expiry.upgradeUrl ? ["Get the latest version"] : [];
    const open = (choice?: string) => {
      if (choice && expiry.upgradeUrl) void vscode.env.openExternal(vscode.Uri.parse(expiry.upgradeUrl));
    };
    if (expiry.state === "expired") void vscode.window.showErrorMessage(expiry.message, ...items).then(open);
    else if (expiry.state === "warn") void vscode.window.showWarningMessage(expiry.message, ...items).then(open);
  }
  const responses = vscode.window.createOutputChannel("AI SharePoint — Copilot");
  const secrets = new SecretStore(context.secrets);
  const installIds = new InstallIdStore(context.globalState);
  // Optional, opt-in external telemetry (Splunk HEC / OTLP metrics). Anonymized
  // and opportunistic — see externalTelemetry.ts. Env dimensions ride on every
  // exported event. Configured via aiSharePoint.telemetry.* (off by default).
  const telemetryEnv: TelemetryEnv = {
    extVersion: EXTENSION_VERSION,
    extChannel: releaseManifest?.channel,
    vscodeVersion: vscode.version,
    osType: os.type(),
    osVersion: os.release(),
    osPlatform: process.platform,
    installId: installIds.get().id,
  };
  // Connection config lives in the OS keychain (never settings/exportable);
  // a cached holder feeds the sink synchronously and is refreshed on change.
  const telemetryConfigStore = new TelemetryConfigStore(secrets);
  let telemetryConfig: ExternalTelemetryConfig | undefined;
  let telemetryStatusCache: TelemetryStatus = telemetryStatus(undefined);
  const externalTelemetry = new ExternalTelemetry(telemetryEnv, () => telemetryConfig);
  context.subscriptions.push({ dispose: () => externalTelemetry.dispose() });
  const refreshTelemetry = async (): Promise<void> => {
    const stored = await telemetryConfigStore.load();
    telemetryConfig = effectiveTelemetryConfig(stored);
    telemetryStatusCache = telemetryStatus(stored);
    externalTelemetry.start(); // no-op unless an OTLP endpoint is configured
  };
  void refreshTelemetry();
  const telemetry = new TelemetryService(context.globalState, nowIso, externalTelemetry);
  telemetry.record("activate", { ...(releaseManifest?.channel ? { channel: releaseManifest.channel } : {}) });
  const errors = new ErrorReportStore(context.globalState, nowIso);
  const lessons = new LessonsStore(context.globalState, EXTENSION_VERSION, nowIso);
  const blockedTerms = new BlockedTermsStore(context.globalState);
  const modelLimits = new ModelLimitsStore(context.globalState, nowIso);
  const meter = new UsageMeter(context.globalState);
  const copilot = new CopilotService(meter);
  const sites = new SitesStore(context.globalState, context.workspaceState);
  const spSessions = new SharePointSessionStore(context.secrets, context.globalState);
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
  const dashboard = new UsageDashboard(meter, nowIso);
  const statusBar = new UsageStatusBar(meter, nowIso);
  const version = String(context.extension.packageJSON.version ?? "0.0.0");

  // Torn-install detector: `version` is whatever MANIFEST VS Code loaded;
  // EXTENSION_VERSION is compiled into this file. When they disagree, new
  // code is running against stale contributions — views/commands from
  // newer releases (Projects, Communications, renamed views) silently
  // don't exist in the UI and can't even be re-enabled from the container
  // menu (pilot). A window reload does not always heal this; a full
  // restart or reinstall does. Say so, by name, once.
  if (version !== EXTENSION_VERSION) {
    log.warn(
      `Torn installation detected: code ${EXTENSION_VERSION} is running against manifest ${version}. Views/commands contributed after ${version} are missing from the UI.`,
    );
    void vscode.window
      .showWarningMessage(
        `AI SharePoint's installed files are out of sync: the interface manifest is v${version} but the running code is v${EXTENSION_VERSION}, so views and commands from newer releases are missing (e.g. the Projects view). Reload the window; if this message comes back, fully quit and restart VS Code — and if it persists, uninstall the extension and reinstall the latest VSIX.`,
        "Reload Window",
      )
      .then((pick) => {
        if (pick === "Reload Window") {
          void vscode.commands.executeCommand("workbench.action.reloadWindow");
        }
      });
  }

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
    // clientId (optional) = sign in as a specific public client: the Power BI
    // no-install path stores the Azure CLI first-party app id here.
    let handles: { providerId?: string; cacheHandle?: string; clientId?: string } = {};
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
    const provider = registry.create(handles.providerId, handles.cacheHandle, handles.clientId);
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
  const projects = new ProjectsStore(context.globalState);
  const memory = new MemoryStore(context.globalState);
  const syncConfigs = new SyncConfigStore(context.globalState);

  // First-run provisioning: seed any pre-defined connectors / projects /
  // setting defaults / custom help baked into this (whitelabeled) build. Runs
  // once per manifest id, never clobbers what the user already has, and the
  // store change events refresh the views. Connectors seed WITHOUT credentials —
  // the user supplies those on first use (ADR-0009 verify-on-connect).
  const provisioningManifest = (context.extension.packageJSON as { provisioning?: ProvisioningManifest }).provisioning;
  if (provisioningManifest) {
    const cfg = () => vscode.workspace.getConfiguration("aiSharePoint");
    const provisioningFx: ProvisioningEffects = {
      appliedId: () => context.globalState.get<string>("aiSharePoint.provisionedId"),
      existingConnectorKeys: () =>
        new Set(contextSources.list().map((s) => connectorKey({ alias: s.alias, baseUrl: s.baseUrl }))),
      existingProjectNames: () => new Set(projects.list().map((p) => p.name.trim().toLowerCase())),
      userHasSetting: (key) => {
        const i = cfg().inspect(key);
        return (
          i?.globalValue !== undefined ||
          i?.workspaceValue !== undefined ||
          i?.workspaceFolderValue !== undefined
        );
      },
      seedConnector: (c) => {
        const source: ContextSource = {
          id: crypto.randomUUID(),
          type: c.type as ContextSourceType,
          displayName: c.displayName,
          ...(c.alias ? { alias: c.alias } : {}),
          ...(c.description ? { description: c.description } : {}),
          baseUrl: c.baseUrl,
          deployment: (c.deployment ?? "datacenter") as ContextDeployment,
          authMethod: (c.authMethod ?? "pat") as ContextSource["authMethod"],
          addedAt: nowIso(),
          role: "reference",
        };
        return Promise.resolve(contextSources.upsert(source));
      },
      seedProject: (p) =>
        Promise.resolve(
          projects.upsert({
            id: crypto.randomUUID(),
            name: p.name,
            ...(p.description ? { description: p.description } : {}),
            ...(p.goals ? { goals: p.goals } : {}),
            ...(p.instructions ? { instructions: p.instructions } : {}),
            ...(p.aiContext ? { aiContext: p.aiContext } : {}),
            sourceIds: [],
          }),
        ),
      applySetting: (key, value) => Promise.resolve(cfg().update(key, value, vscode.ConfigurationTarget.Global)),
      setHelp: (help) => Promise.resolve(context.globalState.update("aiSharePoint.provisionedHelp", help)),
      seedTelemetry: async (t) => {
        // Non-destructive: never overwrite a user-configured telemetry connection.
        if (await telemetryConfigStore.load()) return false;
        const stored: StoredTelemetryConfig = { enabled: Boolean(t.enabled) };
        if (t.splunkHecUrl) stored.splunkHecUrl = t.splunkHecUrl;
        if (t.otlpEndpoint) stored.otlpEndpoint = t.otlpEndpoint;
        if (t.otlpHeaderName) stored.otlpHeaderName = t.otlpHeaderName;
        // De-obfuscate baked tokens straight into the keychain (never settings).
        try {
          if (t.splunkHecTokenObfuscated) stored.splunkHecToken = deobfuscateSecret(t.splunkHecTokenObfuscated);
          if (t.otlpHeaderValueObfuscated) stored.otlpHeaderValue = deobfuscateSecret(t.otlpHeaderValueObfuscated);
        } catch (e) {
          log.warn(`Provisioned telemetry token could not be de-obfuscated: ${e instanceof Error ? e.message : String(e)}`);
        }
        await telemetryConfigStore.save(stored);
        await refreshTelemetry();
        return true;
      },
      markApplied: (id) => Promise.resolve(context.globalState.update("aiSharePoint.provisionedId", id)),
    };
    void applyProvisioning(provisioningManifest, provisioningFx)
      .then((r) => {
        if (!r.applied) return;
        log.info(
          `Provisioned ${r.connectors} connector(s), ${r.projects} project(s), ${r.settings} setting default(s)${r.help ? ", custom help" : ""}${r.telemetry ? ", telemetry endpoint" : ""}.`,
        );
        const welcome = context.globalState.get<{ welcome?: string }>("aiSharePoint.provisionedHelp")?.welcome;
        if (welcome) void vscode.window.showInformationMessage(welcome);
      })
      .catch((e) => {
        // First-run seeding is best-effort: a failed seed must never block
        // activation or surface as an unhandled rejection. The manifest stays
        // un-marked, so a later reload retries cleanly.
        log.warn(
          `First-run provisioning did not complete: ${e instanceof Error ? e.message : String(e)}`,
        );
      });
  }

  const sitesProvider = new SitesTreeProvider(sites, contextSources, memory);
  const sourcesProvider = new SourcesTreeProvider(
    contextSources,
    sites,
    bookmarks,
    schemas,
    catalogs,
    memory,
    nowIso,
    (all) => projects.scope(all),
  );
  const usageProvider = new UsageTreeProvider(
    meter,
    nowIso,
    () => copilotState.signedIn,
  );
  const verboseWireOn = () =>
    vscode.workspace.getConfiguration("aiSharePoint").get<boolean>("logging.verboseWire", false);
  const supportProvider = new SupportTreeProvider(errors, version, verboseWireOn, () => telemetryStatusCache);

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
  // cached manifest until the window reloads. Anything the cached manifest
  // doesn't declare THROWS on registration — createTreeView for a new view
  // ("No view is registered with id"), lm.registerTool for a tool added by
  // the update (which aborts activation mid-flight, breaking commands too).
  // Strategy: read the manifest VS Code ACTUALLY loaded and skip what it
  // can't host; wrap every registration block; surface ONE information
  // prompt with the fix as a button. Details go to the log only.
  const loadedManifest = context.extension.packageJSON as {
    contributes?: {
      views?: Record<string, Array<{ id?: string }>>;
      languageModelTools?: Array<{ name?: string }>;
    };
  };
  const declaredViews = new Set(
    Object.values(loadedManifest.contributes?.views ?? {})
      .flat()
      .map((v) => v.id)
      .filter((id): id is string => Boolean(id)),
  );
  const pendingRegistrations: string[] = [];
  let reloadPromptQueued = false;
  const promptReloadOnce = () => {
    if (reloadPromptQueued) return;
    reloadPromptQueued = true;
    // Activation registers everything synchronously; a short delay
    // coalesces every failure into the one prompt.
    setTimeout(() => {
      log.warn(
        `Pending window reload after the update — not yet registered: ${pendingRegistrations.join(", ")}.`,
      );
      void vscode.window
        .showInformationMessage(
          "AI SharePoint finished updating — reload the window to activate everything.",
          "Reload Window",
        )
        .then((pick) => {
          if (pick === "Reload Window") {
            void vscode.commands.executeCommand("workbench.action.reloadWindow");
          }
        });
    }, 1_000);
  };
  const tryCreateTreeView = <T>(
    id: string,
    provider: vscode.TreeDataProvider<T>,
  ): vscode.TreeView<T> | undefined => {
    // Manifest pre-check: a view the loaded manifest doesn't declare would
    // throw on creation AND keep throwing asynchronously from later
    // refresh/badge traffic — never create it at all.
    if (declaredViews.size > 0 && !declaredViews.has(id)) {
      pendingRegistrations.push(id);
      promptReloadOnce();
      return undefined;
    }
    try {
      return vscode.window.createTreeView(id, { treeDataProvider: provider });
    } catch (err) {
      log.warn(
        `View ${id} could not be registered (${err instanceof Error ? err.message : String(err)}) — usually a pending window reload after a VSIX upgrade.`,
      );
      pendingRegistrations.push(id);
      promptReloadOnce();
      return undefined;
    }
  };
  /** Registration blocks (chat participant, language-model tools) throw as
   *  a GROUP against a stale manifest — degrade to the reload prompt
   *  instead of aborting activation (which used to strand commands and
   *  surface raw errors). Registrations made before the throw stay live
   *  until the reload; that is harmless and short-lived. */
  const tryRegister = (label: string, make: () => vscode.Disposable[]): vscode.Disposable[] => {
    try {
      return make();
    } catch (err) {
      log.warn(
        `${label} could not be registered (${err instanceof Error ? err.message : String(err)}) — pending window reload after the update.`,
      );
      pendingRegistrations.push(label);
      promptReloadOnce();
      return [];
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
  // Setting .badge/.description on a view whose manifest entry is still
  // mid-refresh after an in-place VSIX upgrade throws "No view is registered
  // with id" even when createTreeView returned an object — swallow it; the
  // view self-heals on reload (the tryCreateTreeView toast already advised it).
  const safeViewOp = (fn: () => void): void => {
    try {
      fn();
    } catch (err) {
      log.warn(`Deferred view update skipped (pending reload?): ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const syncCommsBadge = () => {
    if (!commsView) return;
    safeViewOp(() => {
      commsView.badge =
        outbox.count() > 0
          ? { value: outbox.count(), tooltip: `${outbox.count()} draft(s) awaiting your approval` }
          : undefined;
    });
  };
  syncCommsBadge();
  context.subscriptions.push(
    supportProvider,
    outbox,
    commsProvider,
    outbox.onDidChange(syncCommsBadge),
    ...tryRegister("site-dev tools", () => registerSiteDevTools(sites, access, syncConfigs, telemetry, errors)),
    ...tryRegister("project tools", () => registerProjectTools(projects, telemetry, errors)),
    ...tryRegister("lessons tools", () => registerLessonsTools(lessons, telemetry, errors)),
    ...tryRegister("memory tools", () =>
      registerMemoryTools(memory, contextSources, sites, telemetry, errors, () => crypto.randomUUID(), nowIso),
    ),
    ...tryRegister("proxy tools", () => registerProxyTools(blockedTerms, telemetry, errors)),
    blockedTerms,
    lessons,
  );
  const projectsProvider = new ProjectsTreeProvider(projects, contextSources);
  const projectsView = tryCreateTreeView("aiSharePoint.projectsView", projectsProvider);
  if (projectsView) context.subscriptions.push(projectsView, projectsProvider);
  for (const v of [sitesView, usageView, supportView, commsView]) {
    if (v) context.subscriptions.push(v);
  }

  const syncContext = () => {
    void vscode.commands.executeCommand(
      "setContext",
      "aiSharePoint.hasSites",
      // Drives the Managed Sites empty state: managed targets only — managed
      // SharePoint sites OR managed context sources (e.g. a Confluence space).
      // Read-only connections live under Reference Sources.
      sites.list().some((c) => c.role === "managed") ||
        contextSources.list().some((s) => s.role === "managed"),
    );
    // Gate item-scoped commands in the Command Palette so they only appear when
    // there's something to act on (the commands keep their picker fallbacks, so
    // this only hides them when the relevant collection is empty).
    const setKey = (key: string, value: boolean) =>
      void vscode.commands.executeCommand("setContext", key, value);
    setKey("aiSharePoint.hasSources", contextSources.list().length > 0);
    setKey("aiSharePoint.hasProjects", projects.list().length > 0);
    setKey("aiSharePoint.hasBookmarks", bookmarks.list().length > 0);
    if (supportView)
      safeViewOp(() => {
        supportView.badge =
          errors.count() > 0
            ? { value: errors.count(), tooltip: `${errors.count()} error report(s)` }
            : undefined;
      });
  };
  syncContext();
  context.subscriptions.push(
    sites.onDidChange(syncContext),
    errors.onDidChange(syncContext),
    contextSources.onDidChange(syncContext),
    projects.onDidChange(syncContext),
    bookmarks.onDidChange(syncContext),
  );

  // Reflect the active project in the Reference Sources view header.
  // Switching project (or back to All Sources) must immediately re-scope the
  // Reference Sources tree AND update its header. SourcesTreeProvider does
  // not subscribe to project changes itself, so without the explicit
  // refresh the tree kept showing the previous scope — sources "vanished"
  // entering a project and didn't return on "All sources" until some other
  // refresh fired (pilot).
  const onProjectChange = () => {
    if (sourcesView) {
      safeViewOp(() => {
        const active = projects.active();
        sourcesView.description = active ? `Project: ${active.name}` : undefined;
      });
    }
    sourcesProvider.refresh();
  };
  onProjectChange();
  context.subscriptions.push(projects.onDidChange(onProjectChange));

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
    ...tryRegister("chat participant", () => [
      registerChatParticipant({
        ctx: context,
        sites,
        access,
        sources: contextSources,
        bookmarks,
        schemas,
        projects,
        copilot,
        meter,
        telemetry,
        errors,
        lessons,
        memory,
        proxyTerms: blockedTerms,
        modelLimits,
        log,
        now: nowIso,
      }),
    ]),
    ...tryRegister("site tools", () =>
      registerLanguageModelTools(
        sites,
        access,
        meter,
        telemetry,
        errors,
        nowIso,
      ),
    ),
    ...tryRegister("sharepoint session tools", () =>
      registerSharePointSessionTools(spSessions, telemetry, errors, () => contextService.caps().timeoutMs),
    ),
    spSessions,
    ...tryRegister("context tools", () =>
      registerContextTools(
        contextSources,
        contextService,
        bookmarks,
        schemas,
        schemaIndexer,
        telemetry,
        errors,
        nowIso,
        () => projects.scope(contextSources.list()),
      ),
    ),
    schemas,
    catalogs,
    projects,
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
          // Pass results through — tools read outcomes via executeCommand.
          return await fn(...args);
        } catch (err) {
          const code = errors.capture(id, err);
          telemetry.record("error", { code }); // error TYPE only — never the message/body
          log.error(`${id} failed`, err);
          if (code === "auth.cancelled") {
            return; // user backed out — not an error
          }
          const summary =
            err instanceof AppError && err.userSummary
              ? err.userSummary
              : redactError(err).message.slice(0, 200);
          const advice = adviceForError(err, code);
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
          return undefined;
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
    // Explicit user retry: close the entitlement pause before re-probing.
    copilot.resetEntitlementGate();
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
        title: "Copilot models — published premium-request multiplier",
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
      title: "Ask Copilot",
      prompt: "Uses your Copilot subscription (your GitHub billing page is the authoritative usage source).",
      placeHolder: "e.g. Draft an outline for our team's SharePoint landing page",
    });
    if (!prompt) {
      return;
    }
    const model = await copilot.pickDefaultModel();
    log.info(`askCopilot: model=${model.family}`);

    responses.show(true);
    responses.appendLine(`\n──────── ${nowIso()} · ${model.name} ────────`);
    responses.appendLine(`> ${prompt}\n`);

    const result = await vscode.window.withProgress(
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
            onChunk: (chunk) => responses.append(chunk),
            token,
          },
          nowIso,
        ),
    );
    responses.appendLine(
      `\n\n[${result.modelId} · ${result.inputTokens}/${result.outputTokens} tokens]`,
    );
  });

  register("aiSharePoint.showUsage", () => dashboard.show());

  register("aiSharePoint.resetUsage", async () => {
    const confirm = await vscode.window.showWarningMessage(
      "Reset the local Copilot activity counters? This clears the extension's request history (it does not affect GitHub billing).",
      { modal: true },
      "Reset Counters",
    );
    if (confirm === "Reset Counters") {
      await meter.reset();
      void vscode.window.showInformationMessage("Copilot activity counters reset.");
    }
  });

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
    // This is a read/connectivity check. SharePoint write-back isn't a simple
    // REST write — it runs through the pull → apply → revert sync pipeline and
    // needs Sites.Selected/ReadWrite admin consent — so there's no quick write
    // probe here; say so rather than imply this proved write.
    void vscode.window.showInformationMessage(
      `✓ "${result.site.displayName}" reachable in ${result.latencyMs}ms as ${result.account} (read/connectivity check${conn.role === "managed" ? "; managed write-back goes through Pull → Apply" : ""}).`,
    );
  });

  // No-admin WRITE path (ADR-0046): connect a SharePoint site via the user's own
  // signed-in BROWSER SESSION (FedAuth/rtFa cookies + form digest). Unlike Graph
  // write (which needs tenant-admin consent), this replays the access the user
  // already has in the Web UI.
  register("aiSharePoint.connectSiteSession", async () => {
    const url = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      title: "SharePoint browser session — site URL",
      placeHolder: "https://contoso.sharepoint.com/sites/Engineering",
      validateInput: (v) => {
        try {
          return /\.sharepoint\.(com|us|cn|de)$/i.test(new URL(v.trim()).hostname) || new URL(v.trim()).protocol === "https:"
            ? undefined
            : "Enter the https:// site URL";
        } catch {
          return "Enter a valid https:// site URL";
        }
      },
    });
    if (!url) return;
    const siteUrl = url.trim().replace(/\/+$/, "");
    const cookies = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      password: true,
      title: "SharePoint browser session — paste the Cookie header",
      placeHolder: "FedAuth=…; rtFa=…; …",
      prompt:
        "In a signed-in SharePoint tab: DevTools → Network → click any request to the site → Request Headers → copy the WHOLE Cookie value. Some cookies are HttpOnly, so the Network request header is the reliable source. Stored only in your OS keychain; sessions expire in hours.",
      validateInput: (v) => sharePointCookieIssue(v),
    });
    if (!cookies) return;
    try {
      const identity = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Verifying the SharePoint session…" },
        () => verifySharePointSession(siteUrl, cookies, contextService.caps().timeoutMs),
      );
      await spSessions.connect(
        { siteUrl, webTitle: identity.webTitle, account: identity.account, addedAt: nowIso(), lastVerifiedAt: nowIso() },
        cookies,
      );
      telemetry.record("sp.session.connect");
      void vscode.window.showInformationMessage(
        `Connected "${identity.webTitle}" via browser session as ${identity.account}. @sharepoint can now read & write its lists (no admin consent). Re-run this when the session expires.`,
      );
    } catch (err) {
      const safe = err instanceof AppError ? (err.userSummary ?? err.message) : err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Session verification failed: ${safe}`);
    }
  });

  register("aiSharePoint.disconnectSiteSession", async () => {
    const all = spSessions.list();
    if (all.length === 0) {
      void vscode.window.showInformationMessage("No SharePoint browser-session connections.");
      return;
    }
    const pick = await vscode.window.showQuickPick(
      all.map((s) => ({ label: s.webTitle, description: s.siteUrl, s })),
      { ignoreFocusOut: true, title: "Disconnect which SharePoint browser session?" },
    );
    if (!pick) return;
    await spSessions.remove(pick.s.siteUrl);
    void vscode.window.showInformationMessage(`Disconnected "${pick.s.webTitle}" (session cookies wiped from the keychain).`);
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

  register("aiSharePoint.pullSiteToRepo", async (arg): Promise<string> => {
    const conn = await resolveConnArg(arg, sites, "Pull which site to its repository?");
    if (!conn) return "cancelled";
    requireManaged(conn);
    const config = syncConfigs.get(conn.siteUrl);
    if (!config) {
      const go = await vscode.window.showInformationMessage(
        `No repository configured for "${conn.displayName}" yet.`,
        "Configure Repository…",
      );
      if (go) await vscode.commands.executeCommand("aiSharePoint.configureSiteRepo", conn);
      return "no-repo";
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
      return "blocked";
    }
    if (!hasChanges(plan.report)) {
      await sites.markVerified(conn.siteUrl, nowIso());
      void vscode.window.showInformationMessage(
        `"${conn.displayName}" is already up to date (${plan.report.unchanged} files unchanged).`,
      );
      return "up-to-date";
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
    if (!confirm) return "cancelled";

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
    return `committed:${plan.report.added.length}+${plan.report.updated.length}~${plan.report.removed.length}-`;
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
  ): Promise<string> => {
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
      return "no-changes";
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
      if (!delPick) return "cancelled";
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
    if (!confirm) return "cancelled";

    const writeMode = vscode.workspace
      .getConfiguration("aiSharePoint")
      .get<WritePermissionMode>("sync.writePermissionMode", "selected");
    const writer = new SharePointWriteClient(
      registry.create(conn.authProviderId, conn.cacheHandle),
      writeMode,
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
      return `failed:${outcome.applied.length}:${outcome.failedAt.op}`;
    }
    void vscode.window.showInformationMessage(
      `✓ ${headline} complete: ${outcome.applied.length} operation(s) applied to "${conn.displayName}". Repository reconciled with live state.`,
    );
    return `applied:${outcome.applied.length}`;
  };

  /** Guards shared by the write-back entry points. Blocked outcomes carry a
   *  machine-readable reason so agent tools can relay what ACTUALLY happened
   *  (pilot: "look for the preview dialog" after a flow that never opened one). */
  const writeBackPreflight = async (
    arg: unknown,
    title: string,
  ): Promise<
    | { ok: true; conn: SiteConnection; config: SiteSyncConfig; repo: Awaited<ReturnType<typeof openOrInitRepository>> }
    | { ok: false; outcome: string }
  > => {
    const conn = await resolveConnArg(arg, sites, title);
    if (!conn) return { ok: false, outcome: "cancelled" };
    requireManaged(conn);
    const config = syncConfigs.get(conn.siteUrl);
    if (!config) {
      void vscode.window.showWarningMessage(
        "No repository configured for this site — run “Configure Site Repository…”, pull, then retry.",
      );
      return { ok: false, outcome: "no-repo" };
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
      return { ok: false, outcome: `dirty:${dirty}` };
    }
    return { ok: true, conn, config, repo };
  };

  register("aiSharePoint.applyRepoToSharePoint", async (arg): Promise<string> => {
    const pre = await writeBackPreflight(arg, "Apply which site repository to SharePoint?");
    if (!pre.ok) return pre.outcome;
    const repoFiles = await syncEngine.readRepoFiles(pre.config.folder);
    if (repoFiles.size === 0) {
      void vscode.window.showWarningMessage(
        "The repository has no site files yet — run “Pull Site to Repository” first.",
      );
      return "empty-repo";
    }
    return runWriteBackFlow(pre.conn, pre.config, pre.repo, repoFiles, "Write-back");
  });

  register("aiSharePoint.revertSiteToCommit", async (arg) => {
    const pre = await writeBackPreflight(arg, "Revert which site to an earlier commit?");
    if (!pre.ok) return;

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
  /** Power BI sign-in (ADR-0027 amendment). Azure CLI SSO leads: the shared
   *  Microsoft 365 sign-in app ("Microsoft Graph Command Line Tools") needs
   *  tenant admin approval for Power BI scopes, which pilots can't get — the
   *  Azure CLI is a Microsoft first-party app already authorized for the
   *  Power BI service, so `az login` works with no per-app approval. */
  const pickAadCredential = async (): Promise<ContextCredential | undefined> => {
    const mode = await vscode.window.showQuickPick(
      [
        {
          label: "$(account) Microsoft sign-in — nothing to install (recommended)",
          description: "signs in as the Azure CLI app (no admin approval, no CLI needed); browser or device code",
          value: "noinstall" as const,
        },
        {
          label: "$(terminal) Azure CLI (az) session",
          description: "uses your existing `az login`; tokens never stored — same consent posture as above",
          value: "az" as const,
        },
        {
          label: "$(organization) Microsoft 365 sign-in (shared with SharePoint)",
          description: "may require tenant admin approval of the sign-in app for Power BI scopes",
          value: "aad" as const,
        },
        {
          label: "$(key) Paste an access token",
          description: "from shell.azure.com or another machine — ~1 h lifetime",
          value: "pat" as const,
        },
      ],
      { ignoreFocusOut: true, title: "Power BI sign-in" },
    );
    if (!mode) return undefined;
    if (mode.value === "noinstall") {
      // Sign in AS the Azure CLI first-party app via MSAL — no local CLI,
      // no app registration, no per-app admin approval (it's pre-authorized
      // for the Power BI service). The refresh token lives in its own
      // keychain MSAL cache, deleted with the source.
      const provider = await vscode.window.showQuickPick(
        AUTH_PROVIDERS.map((p) => ({ label: p.label, detail: p.detail, id: p.id })),
        { ignoreFocusOut: true, title: "Power BI Microsoft sign-in — browser or device code?" },
      );
      if (!provider) return undefined;
      return {
        method: "aad-sso",
        secret: JSON.stringify({
          providerId: provider.id,
          cacheHandle: `${POWERBI_AZCLI_CACHE_PREFIX}${crypto.randomUUID()}`,
          clientId: AZURE_CLI_CLIENT_ID,
        }),
      };
    }
    if (mode.value === "az") {
      // Marker only — nothing secret is stored; every call asks the CLI.
      return { method: "az-sso", secret: "az-cli-session" };
    }
    if (mode.value === "pat") {
      const token = await vscode.window.showInputBox({
        ignoreFocusOut: true,
        password: true,
        title: "Power BI access token",
        prompt:
          "No CLI installed? Open shell.azure.com (works in any browser, nothing to install) and run `az account get-access-token --resource https://analysis.windows.net/powerbi/api --query accessToken -o tsv`, then paste the output. Stored only in your OS keychain; expires after ~1 h (re-paste via Test Context Source).",
      });
      if (!token?.trim()) return undefined;
      return { method: "pat", secret: token.trim() };
    }
    const all = sites.list();
    if (all.length === 0) {
      const add = await vscode.window.showInformationMessage(
        "This option reuses your Microsoft 365 sign-in — connect a SharePoint site first to establish it (or pick “Microsoft sign-in — nothing to install” instead).",
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

  /** Power BI token getter for a credential of any of the three methods —
   *  the wizard-side mirror of ContextService's routing. */
  const pbiTokenGetter =
    (cred: ContextCredential) =>
    (interactive: boolean): Promise<string> =>
      cred.method === "az-sso"
        ? getAzPowerBiToken()
        : cred.method === "pat"
          ? Promise.resolve(cred.secret)
          : aadBroker(cred, interactive, POWERBI_SCOPES);

  register("aiSharePoint.addContextSource", async (presetArg?: unknown) => {
    const preset = presetArg as { type?: ContextSourceType; role?: "managed" | "reference" } | undefined;
    const typePick = preset?.type
      ? { label: "", value: preset.type }
      : await vscode.window.showQuickPick(
      [
        { label: "$(book) Confluence", value: "confluence" as ContextSourceType },
        { label: "$(issues) Jira", value: "jira" as ContextSourceType },
        { label: "$(github) GitHub", description: "code, issues/PRs, repos & commits — Cloud or Enterprise Server (read-only)", value: "github" as ContextSourceType },
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
        { label: "$(graph) Power BI (cloud)", description: "workspaces & datasets — read-only DAX analysis, Azure CLI or Microsoft 365 SSO", value: "powerbi" as ContextSourceType },
        { label: "$(sparkle) Microsoft 365 Copilot", description: "grounded enterprise context via the Copilot Retrieval API — reuses your Microsoft 365 sign-in", value: "m365copilot" as ContextSourceType },
        { label: "$(tools) ServiceNow", description: "incidents/changes/CMDB/knowledge — read-only Table API", value: "servicenow" as ContextSourceType },
        { label: "$(pulse) Splunk", description: "read-only SPL searches (oneshot, time-bounded)", value: "splunk" as ContextSourceType },
        { label: "$(dashboard) Splunk Observability Cloud", description: "metrics/detectors/dashboards/active incidents (the former SignalFx)", value: "splunkobs" as ContextSourceType },
        { label: "$(graph-line) Grafana", description: "dashboards, alert state, annotations, and LIVE panel data — Cloud or self-hosted", value: "grafana" as ContextSourceType },
      ],
      { ignoreFocusOut: true, title: "Add Context Source — type (read-only reference data)" },
    );
    if (!typePick) return;

    let baseUrl: string;
    let baseDn: string | undefined;
    let presetCredential: ContextCredential | undefined;
    let deployment: ContextDeployment = "datacenter";
    let defaultUpn: string | undefined;
    // Managed Confluence: the write boundary derived from the onboarding URL.
    let writeScope: ConfluenceWriteScope | undefined;

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
      presetCredential = await promptContextCredential("splunk", "datacenter", undefined, webEntry);
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
      // Splunk Cloud often disables the default "search" app and meters by a
      // line-of-business app — dispatch must run in that app's namespace. List
      // the apps the account can see, let the user pick, and verify a real
      // search dispatches there before saving.
      let selectedApp: string | undefined;
      let apps: Array<{ name: string; label: string }> = [];
      try {
        apps = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: "Listing the Splunk apps you can access…" },
          () => listSplunkApps({ baseUrl }, splunkCred, contextService.caps().timeoutMs),
        );
      } catch (err) {
        log.warn(`Splunk app listing failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (apps.length > 0) {
        for (;;) {
          const pick = await vscode.window.showQuickPick(
            [
              ...apps.map((a) => ({ label: a.label, description: a.name, app: a.name as string | undefined })),
              {
                label: "$(circle-slash) No specific app (default search context)",
                description: "only if the default search app is enabled for your account",
                app: undefined as string | undefined,
              },
            ],
            {
              ignoreFocusOut: true,
              title: "Which Splunk search app should searches run in? (line-of-business app for workload/billing)",
              matchOnDescription: true,
            },
          );
          if (!pick) return;
          selectedApp = pick.app;
          const probeBase = selectedApp ? `${baseUrl}?app=${encodeURIComponent(selectedApp)}` : baseUrl;
          try {
            await vscode.window.withProgress(
              {
                location: vscode.ProgressLocation.Notification,
                title: selectedApp ? `Verifying search works in "${selectedApp}"…` : "Verifying search dispatch…",
              },
              () =>
                searchSplunk(
                  {
                    id: "probe",
                    type: "splunk",
                    displayName: "probe",
                    baseUrl: probeBase,
                    deployment: "datacenter",
                    authMethod: splunkCred.method,
                    addedAt: nowIso(),
                  },
                  splunkCred,
                  '{"spl": "| makeresults count=1", "earliest": "-1m"}',
                  contextService.caps(),
                ),
            );
            break; // a search dispatched successfully in this namespace
          } catch (err) {
            const choice = await vscode.window.showWarningMessage(
              `A test search ${selectedApp ? `in "${selectedApp}" ` : "in the default context "}failed: ${err instanceof Error ? err.message : String(err)}. On metered Splunk Cloud the default app is often disabled — pick your line-of-business search app.`,
              "Pick a different app",
              "Use this app anyway",
            );
            if (choice === "Use this app anyway") break;
            if (!choice) return;
            // else loop back to the app picker
          }
        }
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
      if (selectedApp) params.set("app", selectedApp);
      if (index.trim()) params.set("index", index.trim());
      if (web.trim()) params.set("web", web.trim().replace(/\/+$/, ""));
      const qs = params.toString();
      if (qs) baseUrl += `?${qs}`;
    } else if (typePick.value === "splunkobs") {
      deployment = "cloud";
      // Users know the app URL (or just the realm) — both API and app
      // addresses derive from it.
      const entry = await vscode.window.showInputBox({
        ignoreFocusOut: true,
        title: "Splunk Observability Cloud — the URL you open in your browser (or just the realm)",
        placeHolder: "https://app.us1.signalfx.com — or simply: us1",
        validateInput: (v) =>
          deriveSplunkObsEndpoints(v)
            ? undefined
            : "Paste the app/API URL (app.<realm>.signalfx.com) or the realm (us0, us1, eu0, …)",
      });
      if (!entry) return;
      const ep = deriveSplunkObsEndpoints(entry)!;
      const typeDefault = await vscode.window.showQuickPick(
        [
          { label: "$(graph) Metrics", description: "free-text questions search metric names (default)", value: "metric" as const },
          { label: "$(flame) Active incidents", description: "what is alerting right now", value: "incident" as const },
          { label: "$(bell) Detectors", description: "alerting rules by name", value: "detector" as const },
          { label: "$(dashboard) Dashboards", description: "dashboards by name", value: "dashboard" as const },
        ],
        { ignoreFocusOut: true, title: "What should bare chat questions search by default?" },
      );
      if (!typeDefault) return;
      const obsParams = new URLSearchParams();
      obsParams.set("web", ep.appBase);
      obsParams.set("type", typeDefault.value);
      baseUrl = `${ep.apiBase}?${obsParams.toString()}`;
    } else if (typePick.value === "grafana") {
      const entry = await vscode.window.showInputBox({
        ignoreFocusOut: true,
        title: "Grafana — the URL you open in your browser",
        placeHolder: "https://acme.grafana.net  or  https://grafana.corp.example",
        validateInput: (v) => {
          try {
            return new URL(v.trim()).protocol === "https:" ? undefined : "HTTPS URLs only";
          } catch {
            return "Enter a valid https:// URL";
          }
        },
      });
      if (!entry) return;
      const u = new URL(entry.trim());
      baseUrl = `${u.protocol}//${u.host}`;
      deployment = /\.grafana\.net$/i.test(u.hostname) ? "cloud" : "datacenter";
    } else if (typePick.value === "github") {
      const entry = await vscode.window.showInputBox({
        ignoreFocusOut: true,
        title: "GitHub — the URL you open in your browser",
        placeHolder: "https://github.com   or   https://github.corp.example   (GitHub Enterprise Server)",
        prompt: "Search & read span the orgs/repos your token can see — code, issues/PRs, repositories, and commits. Read-only.",
        validateInput: (v) => {
          try {
            return new URL(v.trim()).protocol === "https:" ? undefined : "HTTPS URLs only";
          } catch {
            return "Enter a valid https:// URL";
          }
        },
      });
      if (!entry) return;
      const u = new URL(entry.trim());
      baseUrl = `${u.protocol}//${u.host}`;
      // github.com (and its api/uploads subdomains) is SaaS; anything else is GHES.
      deployment = /(^|\.)github\.com$/i.test(u.hostname) ? "cloud" : "datacenter";
      presetCredential = await promptContextCredential("github", deployment, undefined, baseUrl);
      if (!presetCredential) return;
    } else if (typePick.value === "powerbi") {
      deployment = "cloud";
      // Pilot: users only know app.powerbi.com — confirm the portal, sign in
      // with the existing Microsoft 365 session, then ENUMERATE what they can
      // access instead of asking for dataset names/GUIDs.
      const portal = await vscode.window.showInputBox({
        ignoreFocusOut: true,
        title: "Power BI — portal URL (just confirm)",
        value: "https://app.powerbi.com",
        prompt: "The connector talks to the Power BI API with the sign-in you pick next; this is only a confirmation of which Power BI you use.",
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
          () => enumeratePowerBiDatasets(pbiTokenGetter(cred), contextService.caps()),
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
    } else if (typePick.value === "m365copilot") {
      deployment = "cloud";
      // Both engines are Graph calls that reuse the SAME Microsoft 365 sign-in
      // as SharePoint (an aad-sso token for graph.microsoft.com). The enabled
      // surfaces ride on the baseUrl query so they travel with the
      // reference-config export — and each surface added expands the delegated
      // consent the account must hold, so it is an explicit, opt-in choice.
      const surfacePicks = await vscode.window.showQuickPick(
        [
          { label: "$(folder) SharePoint & OneDrive documents", description: "Copilot Retrieval — semantic doc grounding (recommended)", value: "sharePoint" as const, picked: true },
          { label: "$(plug) Graph connectors", description: "Copilot Retrieval — Copilot connector content · needs ExternalItem.Read.All", value: "externalItem" as const },
          { label: "$(mail) Outlook email", description: "Microsoft Search — your mailbox · needs Mail.Read", value: "message" as const },
          { label: "$(calendar) Calendar events", description: "Microsoft Search — your calendar · needs Calendars.Read", value: "event" as const },
          { label: "$(comment-discussion) Teams messages", description: "Microsoft Search — your chats · needs Chat.Read (tenant support varies)", value: "chatMessage" as const },
          { label: "$(person) People", description: "Microsoft Search — people & expertise · needs People.Read", value: "person" as const },
        ],
        {
          ignoreFocusOut: true,
          canPickMany: true,
          title: "Microsoft 365 Copilot — surfaces to ground on (each one expands consent)",
        },
      );
      if (!surfacePicks || surfacePicks.length === 0) return;
      const surfaces = surfacePicks.map((p) => p.value);
      baseUrl = `https://graph.microsoft.com/v1.0/copilot/retrieval?surfaces=${surfaces.join(",")}`;

      const signIn = await vscode.window.showQuickPick(
        [
          {
            label: "$(organization) Microsoft 365 sign-in (shared with SharePoint)",
            description: "reuses a connected site's sign-in — recommended",
            value: "aad" as const,
          },
          {
            label: "$(key) Paste a Graph access token",
            description: "from shell.azure.com or another machine — ~1 h lifetime",
            value: "pat" as const,
          },
        ],
        { ignoreFocusOut: true, title: "Microsoft 365 Copilot sign-in" },
      );
      if (!signIn) return;
      if (signIn.value === "pat") {
        const token = await vscode.window.showInputBox({
          ignoreFocusOut: true,
          password: true,
          title: "Microsoft Graph access token",
          prompt:
            "No CLI installed? Open shell.azure.com and run `az account get-access-token --resource https://graph.microsoft.com --query accessToken -o tsv`, then paste it. Stored only in your OS keychain; expires after ~1 h (re-paste via Test Context Source).",
        });
        if (!token?.trim()) return;
        presetCredential = { method: "pat", secret: token.trim() };
      } else {
        const all = sites.list();
        if (all.length === 0) {
          const add = await vscode.window.showInformationMessage(
            "This reuses your Microsoft 365 sign-in — connect a SharePoint site first to establish it.",
            "Connect Site",
          );
          if (add) await vscode.commands.executeCommand("aiSharePoint.connectSite");
          return;
        }
        let conn = all.length === 1 ? all[0] : undefined;
        if (!conn) {
          const pick = await vscode.window.showQuickPick(
            all.map((c) => ({
              label: c.displayName,
              description: `${c.tenantHost}${c.account ? ` · ${c.account}` : ""}`,
              conn: c,
            })),
            { ignoreFocusOut: true, title: "Use which Microsoft 365 sign-in for Copilot retrieval?" },
          );
          if (!pick) return;
          conn = pick.conn;
        }
        presetCredential = {
          method: "aad-sso",
          secret: JSON.stringify({ providerId: conn.authProviderId, cacheHandle: conn.cacheHandle }),
        };
      }
      if (!presetCredential) return;
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
          placeHolder: "my-corp-search-prod — or e.g. https://vertexaisearch.cloud.google/us/home/cid/… (your search page)",
          prompt:
            "Accepted URLs: the corporate search page you open via SSO (vertexaisearch.cloud.google/<region>/home/cid/<app>?csesidx=… — region and app are read from it; the csesidx session id is ignored), a Cloud Console app URL, or a full serving-config URL.",
          validateInput: (v) => (v.trim() ? undefined : "Enter a project ID or paste a URL"),
        });
        if (!first) return;
        if (vertexUrlIssue(first.trim()) === undefined) {
          baseUrl = first.trim();
        } else {
          const isUrlish = /[/:]/.test(first.trim());
          const hint = isUrlish ? parseVertexHint(first) : {};
          let projectId = hint.projectId ?? (isUrlish ? undefined : first.trim());
          // The corporate search page names the app (cid) and region but not
          // the hosting project — and a standard user can rarely "ask the
          // admin". With the app id + location known, the wizard can FIND the
          // project itself: scan the projects the user's Google sign-in can
          // already see and probe which one hosts this app.
          if (!projectId && hint.engineId && hint.location) {
            const how = await vscode.window.showQuickPick(
              [
                {
                  label: "$(search) Find the project for me (recommended)",
                  description: "scans the projects your gcloud sign-in can see for this app — no IDs to know",
                  value: "auto" as const,
                },
                {
                  label: "$(edit) Enter the project ID myself",
                  description: "if you already know it",
                  value: "manual" as const,
                },
              ],
              {
                ignoreFocusOut: true,
                title: `Your search page names the app (${hint.engineId}) and region (${hint.location}) — only the hosting project is missing`,
              },
            );
            if (!how) return;
            if (how.value === "auto") {
              try {
                const token = await getVertexToken({ method: "gcloud-sso", secret: "gcloud-cli-session" });
                const projects = await vscode.window.withProgress(
                  { location: vscode.ProgressLocation.Notification, title: "Listing the projects your Google sign-in can see…" },
                  () => listGcloudProjects(),
                );
                const matches = await vscode.window.withProgress(
                  { location: vscode.ProgressLocation.Notification, title: `Searching ${projects.length} project(s) for app "${hint.engineId}"…` },
                  (progress) =>
                    findVertexProjectForEngine(token, projects, hint.engineId!, hint.location!, 15_000, (checked, total) =>
                      progress.report({ message: `${checked}/${total} checked` }),
                    ),
                );
                if (matches.length === 1) {
                  projectId = matches[0];
                  void vscode.window.showInformationMessage(
                    `Found it: app "${hint.engineId}" lives in project "${projectId}".`,
                  );
                } else if (matches.length > 1) {
                  const pick = await vscode.window.showQuickPick(
                    matches.map((m) => ({ label: m })),
                    { ignoreFocusOut: true, title: "This app id exists in several projects you can see — pick one" },
                  );
                  if (!pick) return;
                  projectId = pick.label;
                } else {
                  void vscode.window.showWarningMessage(
                    `None of the ${projects.length} project(s) visible to your Google sign-in host app "${hint.engineId}" in ${hint.location} — your account likely uses the app without any project role (common with Entra/Azure AD SSO). Continue to manual entry and paste a request URL from the search page's Network tab — it embeds the project number.`,
                  );
                }
              } catch (err) {
                log.warn(`Vertex project auto-detection failed: ${err instanceof Error ? err.message : String(err)}`);
                void vscode.window.showWarningMessage(
                  `Could not auto-detect the project: ${err instanceof Error ? err.message : String(err)}`,
                );
              }
            }
          }
          if (!projectId) {
            const entered = (
              await vscode.window.showInputBox({
                ignoreFocusOut: true,
                title: "Google Cloud project — ID, number, or a pasted request from your search page",
                prompt: hint.engineId
                  ? `No GCP access at all (e.g. you reach the search page via Entra/Azure AD SSO)? The page's OWN traffic carries it: on the search page press F12 → Network → run a search → click the request named search/answer/servingConfigs → copy its full URL and paste it here — it embeds projects/<number>/… and the project NUMBER works like an ID. Otherwise: "Find the project for me" (previous step), \`gcloud projects list\` (terminal or shell.cloud.google.com), or ask whoever shared the page.`
                  : "That URL didn't carry a project ID — paste a request URL from the search page's Network tab (it embeds projects/<number>/…), or get the ID from the Cloud Console URL (?project=…) / the app owner.",
                validateInput: (v) => (v.trim() ? undefined : "Enter a project ID/number, or paste a request URL containing projects/…"),
              })
            )?.trim();
            if (!entered) return;
            // A pasted request URL / resource string carries the project —
            // and often a more precise location/engine; the fuller capture
            // wins over the page-URL hint.
            const pastedHint = /projects\//i.test(entered) ? parseVertexHint(entered) : {};
            projectId = pastedHint.projectId ?? entered;
            if (pastedHint.location) hint.location = pastedHint.location;
            if (pastedHint.engineId) hint.engineId = pastedHint.engineId;
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
      const managedConfluence = typePick.value === "confluence" && preset?.role === "managed";
      const url = await vscode.window.showInputBox({
      ignoreFocusOut: true,
        title: managedConfluence
          ? "Managed Confluence — URL of the space or page to manage"
          : "Add Context Source — base URL",
        prompt: managedConfluence
          ? "Paste the space or page you want to manage (read/write) — its URL defines the write boundary. Reads, ownership and notifications still span ALL of Confluence regardless. A bare instance URL lets you pick the scope next."
          : typePick.value === "confluence"
            ? "The instance root — search and read span all of Confluence."
            : undefined,
        placeHolder:
          depPick.value === "cloud"
            ? typePick.value === "confluence"
              ? managedConfluence
                ? "https://yourorg.atlassian.net/wiki/spaces/ENG  (or …/spaces/~you for your personal space)"
                : "https://yourorg.atlassian.net/wiki"
              : "https://yourorg.atlassian.net"
            : managedConfluence
              ? "https://confluence.corp.example/spaces/ENG  (or /spaces/~you, /display/ENG, a page URL…)"
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

      if (typePick.value === "confluence") {
        // A Confluence connector ALWAYS reads globally, so normalize baseUrl to
        // the instance root (origin + any /wiki or /confluence context path)
        // regardless of how deep a URL was pasted (ADR-0040).
        const parsed = parseConfluenceUrl(url.trim());
        if (parsed) {
          baseUrl = parsed.baseUrl;
          if (managedConfluence) {
            writeScope = writeScopeFromParsed(parsed, url.trim());
            // A bare instance URL gives no write boundary — let the user narrow
            // it to a space (managed targets are normally scoped). They can
            // still choose to manage the whole instance.
            if (writeScope.kind === "instance") {
              const narrow = await vscode.window.showQuickPick(
                [
                  { label: "$(book) Scope to a space", description: "enter a space key (incl. ~personal) — recommended", value: "space" as const },
                  { label: "$(globe) Manage the entire instance", description: "no write boundary — any page anywhere", value: "instance" as const },
                ],
                { ignoreFocusOut: true, title: "Managed Confluence — write boundary" },
              );
              if (!narrow) return;
              if (narrow.value === "space") {
                const key = await vscode.window.showInputBox({
                  ignoreFocusOut: true,
                  title: "Managed Confluence — space key",
                  placeHolder: "ENG   ·   ~jdoe for a personal space",
                  validateInput: (v) => (v.trim() ? undefined : "Enter a space key"),
                });
                if (!key) return;
                writeScope = { kind: "space", spaceKey: key.trim(), url: baseUrl };
              }
            }
          }
        }
      }
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
      role: preset?.role ?? "reference",
      ...(writeScope ? { writeScope } : {}),
    };
    try {
      const { account } = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Verifying source…" },
        () => contextService.verify(source, credential, true),
      );
      await contextSources.upsert({ ...source, account, lastVerifiedAt: nowIso() });
      await contextSources.setCredential(source.id, credential);
      telemetry.record("context.add", { type: source.type, deployment: source.deployment, method: credential.method, ...(source.role === "managed" ? { role: "managed" } : {}) });
      void vscode.window.showInformationMessage(
        source.role === "managed"
          ? `Connected "${source.displayName}" as ${account} — managed: writes are bounded to ${describeWriteScope(writeScope)}; reads span all of Confluence.`
          : `Connected "${source.displayName}" as ${account} (read-only).`,
      );
      if (DB_TYPES.has(source.type)) {
        // First use of a database source: preload the schema catalog, then
        // offer the Copilot semantic indexing (consent-gated, ADR-0024).
        // Failures here never undo the just-added source.
        void vscode.commands.executeCommand("aiSharePoint.loadSourceSchema", source);
      }
      // A managed Confluence target exists to be WRITTEN to — offer to verify
      // that up front (read succeeded; write can still 403 on permissions / a
      // read-only or not-yet-created personal space / a proxy). Non-destructive.
      if (source.type === "confluence" && source.role === "managed") {
        const run = await vscode.window.showInformationMessage(
          `Run a safe write test on "${source.displayName}" now? It creates a temporary page in ${describeWriteScope(writeScope)} and immediately deletes it — so any write-permission problem shows up now, not at publish time.`,
          "Run Write Test",
          "Skip",
        );
        if (run === "Run Write Test") {
          await vscode.commands.executeCommand("aiSharePoint.testWriteAccess", { ...source, account, lastVerifiedAt: nowIso() });
        }
      }
    } catch (err) {
      // Nothing was saved — discard the unsaved source's failure record too.
      await contextSources.resetLockout(source.id);
      throw err;
    }
  });

  // Managed Sites "+": a managed target can be a SharePoint site OR a Confluence
  // space we actively manage (read/write via the source's own API token).
  register("aiSharePoint.addManagedTarget", async () => {
    const pick = await vscode.window.showQuickPick(
      [
        { label: "$(cloud) SharePoint site", description: "Microsoft 365 sign-in; managed or reference", value: "sharepoint" as const },
        { label: "$(book) Confluence space", description: "read/write with your own API token — no admin consent", value: "confluence" as const },
      ],
      { ignoreFocusOut: true, title: "Add a managed target" },
    );
    if (!pick) return;
    if (pick.value === "sharepoint") {
      await vscode.commands.executeCommand("aiSharePoint.connectSite");
    } else {
      await vscode.commands.executeCommand("aiSharePoint.addContextSource", { type: "confluence", role: "managed" });
    }
  });

  // Open a context source in the browser (Managed Sites node click + menu).
  register("aiSharePoint.openSourceInBrowser", async (arg) => {
    const source = await resolveSourceArg(arg, contextSources);
    if (source) await vscode.env.openExternal(vscode.Uri.parse(source.baseUrl));
  });

  // Flip a context source between managed (Managed Sites) and reference
  // (Reference Sources) — the same move-across as a SharePoint site's role.
  register("aiSharePoint.changeSourceRole", async (arg) => {
    const source = await resolveSourceArg(arg, contextSources);
    if (!source) return;
    const next = source.role === "managed" ? "reference" : "managed";
    await contextSources.upsert({ ...source, role: next });
    void vscode.window.showInformationMessage(
      `"${source.displayName}" is now ${next === "managed" ? "managed (read/write — Managed Sites)" : "a read-only reference (Reference Sources)"}.`,
    );
  });

  // Safe, non-destructive write-access test for a managed Confluence target:
  // create → update → delete a throwaway page in scope, then report the verdict.
  register("aiSharePoint.testWriteAccess", async (arg) => {
    const source = await resolveSourceArg(arg, contextSources);
    if (!source) return;
    if (source.type !== "confluence") {
      void vscode.window.showInformationMessage("Write tests apply to managed Confluence targets.");
      return;
    }
    if (source.role !== "managed") {
      const go = await vscode.window.showInformationMessage(
        `"${source.displayName}" is a read-only reference, so there's nothing to write to. Make it a managed target first?`,
        "Make Managed",
      );
      if (go === "Make Managed") await vscode.commands.executeCommand("aiSharePoint.changeSourceRole", source);
      return;
    }
    try {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Testing write access to "${source.displayName}" (creates + deletes a temporary page)…` },
        () => contextService.probeConfluenceWrite(source),
      );
      const verdict = summarizeProbe(result);
      if (result.ok) {
        void vscode.window.showInformationMessage(`✅ ${verdict}`);
      } else {
        const actions = !result.cleanedUp && result.pageUrl ? ["Open Stray Page", "Verbose Log"] : ["Verbose Log"];
        const choice = await vscode.window.showWarningMessage(`⚠️ ${verdict}`, ...actions);
        if (choice === "Open Stray Page" && result.pageUrl) {
          await vscode.env.openExternal(vscode.Uri.parse(result.pageUrl));
        } else if (choice === "Verbose Log") {
          await vscode.workspace
            .getConfiguration("aiSharePoint")
            .update("logging.verboseWire", true, vscode.ConfigurationTarget.Global);
          void vscode.window.showInformationMessage(
            "Verbose wire logging enabled (Output → AI SharePoint). Re-run the write test to capture the server's exact response, then disable it again.",
          );
        }
      }
    } catch (err) {
      const safe = err instanceof AppError ? (err.userSummary ?? err.message) : err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Write test could not run: ${safe}`);
    }
  });

  // Safe, non-destructive CONTENT FUNCTIONALITY test for a managed Confluence
  // target: author a sample page of built-in rich elements (toc, panels, status,
  // task list, code, expand, layout…), pull the rendered content to confirm they
  // published as real Confluence elements (not literal "[TOC]" text), then delete.
  register("aiSharePoint.testConfluenceFunctionality", async (arg) => {
    const source = await resolveSourceArg(arg, contextSources);
    if (!source) return;
    if (source.type !== "confluence") {
      void vscode.window.showInformationMessage("Content functionality tests apply to managed Confluence targets.");
      return;
    }
    if (source.role !== "managed") {
      const go = await vscode.window.showInformationMessage(
        `"${source.displayName}" is a read-only reference, so there's nothing to author to. Make it a managed target first?`,
        "Make Managed",
      );
      if (go === "Make Managed") await vscode.commands.executeCommand("aiSharePoint.changeSourceRole", source);
      return;
    }
    try {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Testing Confluence content functionality on "${source.displayName}" (renders & removes a sample page)…` },
        () => contextService.probeConfluenceFunctionality(source),
      );
      const verdict = summarizeFunctionalityProbe(result);
      if (result.ok) {
        void vscode.window.showInformationMessage(`✅ ${verdict}`);
      } else {
        const actions = !result.cleanedUp && result.pageUrl ? ["Open Sample Page", "Verbose Log"] : ["Verbose Log"];
        const choice = await vscode.window.showWarningMessage(`⚠️ ${verdict}`, ...actions);
        if (choice === "Open Sample Page" && result.pageUrl) {
          await vscode.env.openExternal(vscode.Uri.parse(result.pageUrl));
        } else if (choice === "Verbose Log") {
          await vscode.workspace
            .getConfiguration("aiSharePoint")
            .update("logging.verboseWire", true, vscode.ConfigurationTarget.Global);
          void vscode.window.showInformationMessage(
            "Verbose wire logging enabled (Output → AI SharePoint). Re-run the content test to capture the exchange, then disable it again.",
          );
        }
      }
    } catch (err) {
      const safe = err instanceof AppError ? (err.userSummary ?? err.message) : err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Content functionality test could not run: ${safe}`);
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
    const promptCredential = () =>
      source.type === "powerbi"
        ? pickAadCredential()
        : promptContextCredential(source.type, source.deployment, undefined, source.baseUrl);
    let credential = await contextSources.getCredential(source.id);
    let fresh = false;
    if (!credential || (!gateNow.allowed && gateNow.reason === "credential-bad")) {
      credential = await promptCredential();
      if (!credential) return;
      fresh = true;
    }
    for (;;) {
      let account: string;
      try {
        ({ account } = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Testing ${source.displayName}…` },
          () => contextService.verify(source, credential!, fresh),
        ));
      } catch (err) {
        // A STORED credential rejected on an explicit test is the routine
        // "session/token expired" case (pilot: a working Splunk source going
        // 401 once the splunkd cookie aged out) — offer the refresh right
        // here instead of a dead-end error. Freshly-entered credentials
        // still fail through the normal error path.
        if (fresh || classifyError(err) !== "auth.failed") throw err;
        errors.capture("aiSharePoint.testContextSource", err);
        const hint =
          credential!.method === "splunk-session"
            ? "Your Splunk browser session has likely expired — sign in to Splunk Web again and capture a fresh splunkd cookie."
            : credential!.method === "snow-session"
              ? "Your ServiceNow browser-session cookies were rejected (sessions expire with the browser; captures can also be incomplete) — re-capture the full Cookie header from a signed-in tab."
              : "The stored token/credentials may have expired or been revoked.";
        const pick = await vscode.window.showWarningMessage(
          `"${source.displayName}" rejected its stored sign-in. ${hint}`,
          "Refresh Sign-in",
        );
        if (pick !== "Refresh Sign-in") return;
        const next = await promptCredential();
        if (!next) return;
        credential = next;
        fresh = true;
        continue;
      }
      if (fresh) {
        await contextSources.setCredential(source.id, credential!);
        await contextSources.upsert({ ...contextSources.get(source.id)!, authMethod: credential!.method, account });
      }
      telemetry.record("context.test");
      // "Test Context Source" verifies a READ only (a single authenticated
      // fetch). Be explicit about that — and for a managed Confluence target,
      // where write is the whole point, offer the separate non-destructive
      // write probe right here so the two aren't confused.
      if (source.type === "confluence" && source.role === "managed") {
        const pick = await vscode.window.showInformationMessage(
          `✓ "${source.displayName}" READ verified as ${account}. This did NOT test write access.`,
          "Test Write Access",
        );
        if (pick === "Test Write Access") {
          await vscode.commands.executeCommand(
            "aiSharePoint.testWriteAccess",
            contextSources.get(source.id) ?? source,
          );
        }
      } else {
        void vscode.window.showInformationMessage(
          `✓ "${source.displayName}" reachable as ${account} (read-only check).`,
        );
      }
      return;
    }
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
      // The Power BI no-install sign-in keeps its MSAL refresh-token cache in
      // a source-private keychain entry — wipe it with the source.
      const cred = await contextSources.getCredential(source.id).catch(() => undefined);
      if (cred?.method === "aad-sso") {
        try {
          const handles = JSON.parse(cred.secret) as { cacheHandle?: string };
          if (handles.cacheHandle?.startsWith(POWERBI_AZCLI_CACHE_PREFIX)) {
            await secrets.delete(handles.cacheHandle);
          }
        } catch {
          // unreadable secret — nothing more to clean
        }
      }
      await contextSources.remove(source.id);
      await bookmarks.removeForSource(source.id);
      await schemas.remove(source.id);
      await catalogs.remove(source.id);
      await projects.forgetSource(source.id);
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

  // --- Projects: named scopes for sources/bookmarks/instructions -----------
  const promptProjectDetails = async (current?: Project): Promise<Project | undefined> => {
    const name = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      title: current ? "Project — name" : "New project — name",
      value: current?.name ?? "",
      placeHolder: "AI Automation Initiative",
      validateInput: (v) => (v.trim() ? undefined : "Enter a project name"),
    });
    if (!name) return undefined;
    const description = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      title: "Project — description (optional, Enter to skip)",
      value: current?.description ?? "",
    });
    if (description === undefined) return undefined;
    const goals = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      title: "Project — goals / objectives (optional, Enter to skip)",
      value: current?.goals ?? "",
      placeHolder: "e.g. Build an AI-automation knowledge base; identify owners of legacy apps.",
      prompt: `What this project is for. Shown to @sharepoint as your goals (max ${GOALS_MAX_CHARS} chars).`,
      validateInput: (v) => (v.length > GOALS_MAX_CHARS ? `Max ${GOALS_MAX_CHARS} characters.` : undefined),
    });
    if (goals === undefined) return undefined;
    const instructions = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      title: "Project — instructions & reference context (optional, Enter to skip)",
      value: current?.instructions ?? "",
      placeHolder: "e.g. Prefer the CMDB for application questions; cite Confluence pages; answer in German.",
      prompt: `Your baseline instructions + common reference context, prepended to every @sharepoint turn while active (max ${INSTRUCTIONS_MAX_CHARS} chars). Separate from the AI-managed context.`,
      validateInput: (v) =>
        v.length > INSTRUCTIONS_MAX_CHARS ? `Max ${INSTRUCTIONS_MAX_CHARS} characters.` : undefined,
    });
    if (instructions === undefined) return undefined;
    const all = contextSources.list();
    if (all.length === 0) {
      void vscode.window.showWarningMessage("Add at least one reference source before scoping a project.");
      return undefined;
    }
    const member = new Set(current?.sourceIds ?? []);
    const picks = await vscode.window.showQuickPick(
      all.map((s) => ({
        label: s.displayName,
        description: `${s.alias ? `“${s.alias}” · ` : ""}${s.type}`,
        picked: member.has(s.id),
        s,
      })),
      {
        ignoreFocusOut: true,
        canPickMany: true,
        title: "Project — which sources belong to it? (bookmarks follow their sources)",
      },
    );
    if (!picks) return undefined;
    return {
      id: current?.id ?? crypto.randomUUID(),
      name: name.trim(),
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(goals.trim() ? { goals: goals.trim() } : {}),
      ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
      // Preserve AI-managed context across user edits — it is never set here.
      ...(current?.aiContext ? { aiContext: current.aiContext } : {}),
      sourceIds: picks.map((x) => x.s.id),
    };
  };

  register("aiSharePoint.createProject", async () => {
    const project = await promptProjectDetails();
    if (!project) return;
    await projects.upsert(project);
    await projects.setActive(project.id);
    telemetry.record("project.create", { sources: String(project.sourceIds.length) });
    void vscode.window.showInformationMessage(
      `Project "${project.name}" created and activated — chat and the Reference Sources view are now scoped to its ${project.sourceIds.length} source(s).`,
    );
  });

  register("aiSharePoint.switchProject", async () => {
    const all = projects.list();
    const pick = await vscode.window.showQuickPick(
      [
        {
          label: "$(globe) All sources (no project)",
          description: "disable scoping",
          id: undefined as string | undefined,
        },
        ...all.map((pr) => ({
          label: `$(folder) ${pr.name}`,
          description: `${pr.sourceIds.length} source(s)${pr.instructions ? " · instructions" : ""}${pr.id === projects.activeId() ? " · active" : ""}`,
          detail: pr.description,
          id: pr.id as string | undefined,
        })),
      ],
      { ignoreFocusOut: true, title: "Scope chat + views to which project?" },
    );
    if (!pick) return;
    await projects.setActive(pick.id);
    telemetry.record("project.switch");
  });

  register("aiSharePoint.editProject", async () => {
    const all = projects.list();
    if (all.length === 0) {
      void vscode.window.showInformationMessage("No projects yet — run “Projects: Create Project”.");
      return;
    }
    const pick = await vscode.window.showQuickPick(
      all.map((pr) => ({ label: pr.name, description: `${pr.sourceIds.length} source(s)`, pr })),
      { ignoreFocusOut: true, title: "Edit which project?" },
    );
    if (!pick) return;
    const edited = await promptProjectDetails(pick.pr);
    if (!edited) return;
    await projects.upsert(edited);
    void vscode.window.showInformationMessage(`Project "${edited.name}" updated.`);
  });

  register("aiSharePoint.removeProject", async () => {
    const all = projects.list();
    if (all.length === 0) return;
    const pick = await vscode.window.showQuickPick(
      all.map((pr) => ({ label: pr.name, pr })),
      { ignoreFocusOut: true, title: "Remove which project? (sources/bookmarks are NOT deleted)" },
    );
    if (!pick) return;
    const confirm = await vscode.window.showWarningMessage(
      `Remove project "${pick.pr.name}"? Its sources, bookmarks, and indexes remain — only the scope/instructions bundle is deleted.`,
      { modal: true },
      "Remove Project",
    );
    if (confirm !== "Remove Project") return;
    await projects.remove(pick.pr.id);
  });

  // Click-to-activate from the Projects view (arg = project id).
  register("aiSharePoint.activateProject", async (arg) => {
    const id = typeof arg === "string" ? arg : undefined;
    if (!id) return;
    const project = projects.get(id);
    if (!project) return;
    if (projects.activeId() === id) {
      const off = await vscode.window.showInformationMessage(
        `"${project.name}" is already active. Deactivate (show all sources)?`,
        "Show All Sources",
      );
      if (off) await projects.setActive(undefined);
      return;
    }
    await projects.setActive(id);
    telemetry.record("project.switch", { via: "view" });
    void vscode.window.showInformationMessage(`Project "${project.name}" is now active.`);
  });

  // View / reset the AI-managed context (kept separate from user instructions).
  register("aiSharePoint.manageProjectAiContext", async (arg) => {
    const id =
      typeof arg === "string"
        ? arg
        : (arg as Project | undefined)?.id ?? projects.active()?.id;
    let project = id ? projects.get(id) : undefined;
    if (!project) {
      const all = projects.list();
      if (all.length === 0) {
        void vscode.window.showInformationMessage("No projects yet — create one in the Projects view.");
        return;
      }
      const pick = await vscode.window.showQuickPick(
        all.map((pr) => ({ label: pr.name, pr })),
        { ignoreFocusOut: true, title: "Manage AI context for which project?" },
      );
      if (!pick) return;
      project = pick.pr;
    }
    const notes = project.aiContext?.split("\n").filter(Boolean).length ?? 0;
    const action = await vscode.window.showQuickPick(
      [
        { label: "$(eye) View saved AI context", value: "view" as const },
        { label: "$(edit) Edit AI context", value: "edit" as const },
        ...(notes > 0 ? [{ label: "$(clear-all) Clear AI context", value: "clear" as const }] : []),
      ],
      {
        ignoreFocusOut: true,
        title: `"${project.name}" — AI-managed context (${notes} note${notes === 1 ? "" : "s"})`,
      },
    );
    if (!action) return;
    if (action.value === "view") {
      const doc = await vscode.workspace.openTextDocument({
        language: "markdown",
        content: [
          `# ${project.name} — AI-managed context`,
          "",
          "_Learnings @sharepoint saved as you taught it. This is **separate** from your own",
          "goals/instructions; edit those via **Edit Project**._",
          "",
          project.aiContext || "_(empty — nothing learned yet)_",
        ].join("\n"),
      });
      await vscode.window.showTextDocument(doc, { preview: true });
      return;
    }
    if (action.value === "edit") {
      const edited = await vscode.window.showInputBox({
        ignoreFocusOut: true,
        title: `${project.name} — AI-managed context`,
        value: project.aiContext ?? "",
        prompt: `Edit the AI-managed learnings (max ${AI_CONTEXT_MAX_CHARS} chars). Clear the box to remove all.`,
        validateInput: (v) =>
          v.length > AI_CONTEXT_MAX_CHARS ? `Max ${AI_CONTEXT_MAX_CHARS} characters.` : undefined,
      });
      if (edited === undefined) return;
      await projects.setAiContext(project.id, edited);
      void vscode.window.showInformationMessage(`AI context for "${project.name}" updated.`);
      return;
    }
    const confirm = await vscode.window.showWarningMessage(
      `Clear the AI-managed context for "${project.name}"? Your goals/instructions are not affected.`,
      { modal: true },
      "Clear AI Context",
    );
    if (confirm === "Clear AI Context") {
      await projects.setAiContext(project.id, undefined);
    }
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

  register("aiSharePoint.buildErDiagram", async (arg) => {
    const source = await resolveSourceArg(arg, contextSources);
    if (!source || !requireDbSource(source)) return;
    const schema = schemas.getSync(source.id) ?? (await loadSchemaWithProgress(source));
    // Sizing pass (ADR-0030 amendment): approximate row counts from catalog
    // statistics plan the whole run — complete joins where tables are small,
    // right-sized samples where they aren't.
    const rowEstimates = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Estimating table sizes in "${source.displayName}"…` },
      () => contextService.estimateRows(source).catch(() => ({}) as Record<string, number>),
    );
    // Scope: a 100-table database is rarely ONE diagram. An optional
    // prefix/keyword filter PRE-SELECTS tables (shared prefixes usually mean
    // a shared objective), then a searchable multi-select lets the user
    // refine by hand. Relationships outside the scope survive from earlier
    // runs (merge on persist).
    const prefixFilter = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      title: `Scope the ER run (1/2, optional) — ${schema.catalog.tables.length} table(s) available`,
      prompt:
        "Comma-separated prefixes or keywords to PRE-SELECT tables (e.g. `fin_, gl_` — shared prefixes usually mean a shared objective). Leave empty to pre-select everything; you refine in the next step either way.",
      placeHolder: "fin_, gl_   (Enter to pre-select all tables)",
    });
    if (prefixFilter === undefined) return;
    const needles = prefixFilter
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const matchesFilter = (t: (typeof schema.catalog.tables)[number]) =>
      needles.length === 0 ||
      needles.some((n) => t.name.toLowerCase().includes(n) || qualifiedName(t).toLowerCase().includes(n));
    const tablePicks = await vscode.window.showQuickPick(
      schema.catalog.tables.map((t) => ({
        label: qualifiedName(t),
        description: `${t.kind} · ${t.columns.length} column(s)${rowEstimates[qualifiedName(t).toLowerCase()] !== undefined ? ` · ~${rowEstimates[qualifiedName(t).toLowerCase()].toLocaleString()} rows` : ""}`,
        picked: matchesFilter(t),
        table: t,
      })),
      {
        ignoreFocusOut: true,
        canPickMany: true,
        matchOnDescription: true,
        title: "Scope the ER run (2/2) — type to search, check the tables/views to include",
        placeHolder: needles.length > 0 ? `Pre-selected by: ${needles.join(", ")} — adjust as needed` : "All tables pre-selected — uncheck to narrow",
      },
    );
    if (!tablePicks) return;
    const selectedTables = tablePicks.map((p) => p.table);
    if (selectedTables.length < 2) {
      void vscode.window.showInformationMessage("An ER run needs at least two tables in scope.");
      return;
    }
    const scoped: SourceSchema =
      selectedTables.length === schema.catalog.tables.length
        ? schema
        : { ...schema, catalog: { ...schema.catalog, tables: selectedTables } };
    const heuristic = proposeJoinCandidates(scoped);
    const smallTables = scoped.catalog.tables.filter((t) => {
      const rows = rowEstimates[qualifiedName(t).toLowerCase()];
      return rows === undefined || rows === 0 || rows <= ER_FULL_JOIN_MAX_ROWS;
    }).length;
    // Small scopes are ALWAYS swept exhaustively, whatever the mode: name
    // heuristics cannot connect member_dn → distinguishedName, and "probe
    // every plausible column pair, measure, verify" IS the method when
    // nothing else is known about a database (pilot: 3-table AD export).
    const autoSweep = selectedTables.length <= ER_AUTO_SWEEP_TABLES;
    const aiAvailable = SchemaIndexer.enabledByPolicy();
    const mode = await vscode.window.showQuickPick(
      [
        ...(aiAvailable
          ? [
              {
                label: "$(sparkle) AI-assisted — heuristics + Copilot-proposed joins (recommended)",
                description:
                  "Copilot reads the indexed names, types, tags, and content summaries to propose likely joins — and refines once from the measured rates if little confirms",
                value: "ai" as const,
              },
            ]
          : []),
        {
          label: "$(beaker) Standard — heuristic candidates only",
          description: `${heuristic.length} pair(s): FK-shaped names, matching names, agreeing tags`,
          value: "standard" as const,
        },
        {
          label: "$(microscope) Thorough — AI + every column pair across small/unknown-size tables",
          description: `adds all type-compatible pairs between the ${smallTables} eligible table(s) (≤ ${ER_FULL_JOIN_MAX_ROWS.toLocaleString()} rows or no statistics; capped at ${ER_EXHAUSTIVE_PAIR_CAP})`,
          value: "thorough" as const,
        },
        {
          label: "$(rocket) Maximum — every escalation, automatically",
          description:
            "thorough + cast comparison across MISMATCHED types, retries of failed probes, and large tables with bounded samples — no prompts between passes",
          value: "max" as const,
        },
      ],
      { ignoreFocusOut: true, title: "Build ER Diagram — how exhaustively? (escalations are also offered as the run progresses)" },
    );
    if (!mode) return;
    const aiEnabled = aiAvailable && mode.value !== "standard";
    const tried = new Set(heuristic.map((c) => pairKey(c)));
    // Known joins: paste a WORKING SQL query/snippet (or bare equalities) —
    // every join condition is extracted, alias-aware; Copilot summarizes
    // when deterministic parsing falls short. Probed FIRST and kept even
    // below the automatic thresholds (the working query is the evidence).
    const knownInput = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      title: "Known joins (optional) — paste ANY portion of working SQL",
      prompt:
        "Anything goes: a whole SELECT, just the ON/WHERE join logic (aliases may be undeclared — they're inferred), or bare equalities with no qualifiers at all (\"member_dn = sAMAccountName\"). ALL join conditions are extracted; if parsing still falls short, Copilot can summarize the SQL into target joins. Extracted joins are probed first and persist even at low measured rates (marked \"defined\").",
      placeHolder: "full query · ON u.dn = ga.member_dn AND … · member_dn = distinguishedName   (Enter to skip)",
    });
    if (knownInput === undefined) return;
    const userJoins: JoinCandidate[] = [];
    const addUserJoin = (j: { fromTable: string; fromColumn: string; toTable: string; toColumn: string; warning?: string; cast?: boolean }, reason: string) => {
      const candidate: JoinCandidate = {
        fromTable: j.fromTable,
        fromColumn: j.fromColumn,
        toTable: j.toTable,
        toColumn: j.toColumn,
        reason,
        priority: 6,
        userDefined: true,
        // Cross-typed joins from working SQL probe the way they run: cast.
        ...(j.warning || j.cast ? { cast: true } : {}),
      };
      const k = pairKey(candidate);
      if (tried.has(k)) return;
      tried.add(k);
      userJoins.push(candidate);
    };
    let joinIssues: string[] = [];
    if (knownInput.trim()) {
      // FULL schema: known joins may cross the scope.
      const extracted = parseJoinSpecs(knownInput, schema);
      joinIssues = extracted.issues;
      for (const j of extracted.joins) addUserJoin(j, "from pasted SQL");
      if (userJoins.length > 0) {
        void vscode.window.showInformationMessage(
          `Extracted ${userJoins.length} join(s) from the SQL: ${userJoins
            .slice(0, 4)
            .map((j) => `${j.fromColumn}↔${j.toColumn}`)
            .join(", ")}${userJoins.length > 4 ? ", …" : ""}.`,
        );
      } else {
        // Nothing parsed: the usual real cause is the SQL's tables not being
        // in the LOADED catalog (wrong database/schema, or schema not
        // refreshed). Say so by name instead of a blank "couldn't determine".
        const diag = diagnoseSqlAgainstCatalog(knownInput, schema);
        if (diag.missing.length > 0) {
          void vscode.window.showWarningMessage(
            `These table(s) in your SQL aren't in the loaded catalog: ${diag.missing.join(", ")}. The catalog has ${diag.catalogTables.length} table(s)${diag.catalogTables.length <= 12 ? `: ${diag.catalogTables.join(", ")}` : ` (e.g. ${diag.catalogTables.slice(0, 8).join(", ")}, …)`}. Run “Load/Refresh Database Schema” or confirm you selected the right database, then retry.`,
          );
        }
      }
      // AI summarization fallback: messy SQL (deep subqueries, dialect
      // quirks) that deterministic parsing couldn't fully resolve.
      if (aiAvailable && (userJoins.length === 0 || joinIssues.length > 0)) {
        const useAi = await vscode.window.showInformationMessage(
          `${userJoins.length === 0 ? "No joins could be parsed from the SQL." : `${joinIssues.length} part(s) of the SQL didn't resolve.`} Let Copilot read the SQL and summarize the target joins? (Sends the pasted SQL plus table/column names to Copilot.)`,
          "Summarize with Copilot",
          "Skip",
        );
        if (useAi === "Summarize with Copilot") {
          try {
            const res = await vscode.window.withProgress(
              { location: vscode.ProgressLocation.Notification, title: "Copilot is summarizing the SQL into target joins…" },
              () =>
                copilot.ask(
                  { prompt: buildSqlJoinExtractionPrompt(knownInput, schema), label: "erSqlJoins" },
                  nowIso,
                ),
            );
            const aiExtracted = parseJoinCandidateResponse(res.text, schema, undefined, { allowCrossFamily: true });
            for (const p of aiExtracted) {
              addUserJoin(p, `from pasted SQL (Copilot): ${p.reason.replace(/^AI: /, "")}`);
            }
            void vscode.window.showInformationMessage(
              aiExtracted.length > 0
                ? `Copilot extracted ${aiExtracted.length} additional join(s) from the SQL.`
                : "Copilot found no further joins it could map to the catalog.",
            );
          } catch (err) {
            log.warn(`SQL join summarization unavailable: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      } else if (joinIssues.length > 0) {
        void vscode.window.showWarningMessage(
          `${joinIssues.length} part(s) of the SQL didn't resolve and will be skipped: ${joinIssues.join(" · ").slice(0, 400)}`,
        );
      }
    }
    // The user's description of the data — domain knowledge the catalog
    // can't carry — seeds the AI hypothesis pass (and persists for re-runs).
    let aiHint = schema.er?.aiHint ?? "";
    if (aiEnabled) {
      const hintInput = await vscode.window.showInputBox({
        ignoreFocusOut: true,
        title: "Describe this data for the AI (optional)",
        value: aiHint,
        prompt:
          "Domain knowledge that helps the join hypotheses, e.g. “SAP FI tables — MANDT is the client key on every table; *_BUKRS columns are company codes; tables prefixed gl_ share the ledger key”.",
        placeHolder: "What is this data? Which columns are shared keys? (Enter to skip)",
      });
      if (hintInput === undefined) return;
      aiHint = hintInput.trim();
    }
    // AI proposals run early in the queue (priority 5): Copilot sees what
    // the heuristics cannot — content-type summaries and the user's hint
    // saying two differently named columns hold the same identifiers.
    const aiPropose = async (rejected?: TestedPair[]): Promise<JoinCandidate[]> => {
      const res = await copilot.ask(
        {
          prompt: buildJoinCandidatePrompt(scoped, { rejected, ...(aiHint ? { hint: aiHint } : {}) }),
          label: "erCandidates",
        },
        nowIso,
      );
      return parseJoinCandidateResponse(res.text, scoped).filter((p) => {
        const k = pairKey(p);
        if (tried.has(k)) return false;
        tried.add(k);
        return true;
      });
    };
    let aiPairs: JoinCandidate[] = [];
    if (aiEnabled) {
      try {
        aiPairs = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: "Asking Copilot for join hypotheses…" },
          () => aiPropose(),
        );
      } catch (err) {
        log.warn(`AI join proposals unavailable: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const candidates = [
      ...userJoins,
      ...aiPairs,
      ...heuristic,
      ...(mode.value === "thorough" || mode.value === "max" || autoSweep
        ? proposeExhaustivePairs(scoped, rowEstimates, tried)
        : []),
    ];
    if (candidates.length === 0) {
      void vscode.window.showInformationMessage(
        "No join candidates in this scope. Widen the table selection, supply known joins, or run “Index Database Schema”/“Index Database Content Types” first so tags can propose pairs.",
      );
      return;
    }
    const fullPairs = candidates.filter((c) => {
      const f = rowEstimates[c.fromTable.toLowerCase()] ?? 0;
      const t = rowEstimates[c.toTable.toLowerCase()] ?? 0;
      return initialSampleSize(f, t) === "full";
    }).length;
    const consent = await vscode.window.showInformationMessage(
      `Build the ER model for "${source.displayName}"? ${candidates.length} candidate pair(s)${aiPairs.length > 0 ? ` (${aiPairs.length} proposed by Copilot)` : ""}${autoSweep && mode.value !== "thorough" ? ` — small scope, so every type-compatible column pair is swept` : ""} will be probed with bounded read-only count queries (≈${candidates.length * 2}+): ${fullPairs} pair(s) get COMPLETE join tests (both tables small), the rest start with row-count-sized samples and ESCALATE toward completeness while the database answers fast — backing off the moment it doesn't. Only match COUNTS are read; no row data leaves the database.`,
      { modal: true },
      "Probe & Build",
    );
    if (consent !== "Probe & Build") return;
    const endFor = (qualified: string, column: string) => {
      const t = schema.catalog.tables.find(
        (x) => qualifiedName(x).toLowerCase() === qualified.toLowerCase(),
      );
      return t ? { ...(t.schema ? { schema: t.schema } : {}), table: t.name, column } : undefined;
    };
    const relationships: ProbedRelationship[] = [];
    const testedLog: TestedPair[] = [];
    let zeroSampleCount = 0;
    let tested = 0;
    let partial = false;
    let slowStreak = 0;
    let aiRefined: number | undefined;
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        // The toast shows title + message on ONE truncating line — a long
        // title starved the message of space and users saw neither counts
        // nor the ETA (pilot). Keep the title minimal; the vitals live in
        // the message, compact-form, leftmost.
        title: "ER model",
        cancellable: true,
      },
      async (progress, token) => {
        // Big-picture status, throttled: "37/220 · ~3 min left · 12 found ·
        // …" — per-pair/per-tier detail must not drown the run's shape
        // (pilot). The queue can GROW mid-run (the AI refinement round
        // appends new hypotheses).
        const queue = [...candidates];
        const runStarted = Date.now();
        let passLabel = "native pass";
        let lastMessage = "";
        let lastStatusAt = 0;
        const paint = (done: number, current?: string, force = false, increment = 0) => {
          const now = Date.now();
          // Recompute the line at the throttle cadence — but EVERY report
          // carries a message: an increment-only report CLEARS the toast
          // text, which is why users saw a bare "ER model" with detail
          // flashing in and instantly vanishing (pilot).
          if (force || !lastMessage || now - lastStatusAt >= ER_STATUS_REFRESH_MS) {
            lastStatusAt = now;
            lastMessage = renderProbeStatus({
              done,
              total: queue.length,
              found: relationships.length,
              elapsedMs: now - runStarted,
              current,
              phase: passLabel,
            });
          }
          progress.report({ increment, message: lastMessage });
        };
        paint(0, undefined, true);
        const probeOne = async (c: JoinCandidate, i: number): Promise<void> => {
          const from = endFor(c.fromTable, c.fromColumn);
          const to = endFor(c.toTable, c.toColumn);
          if (!from || !to) return;
          const rowsFrom = rowEstimates[c.fromTable.toLowerCase()] ?? 0;
          const rowsTo = rowEstimates[c.toTable.toLowerCase()] ?? 0;
          // After three consecutive slow probes the whole run de-escalates
          // to minimal samples — sensitivity beats completeness.
          let sample: number | "full" =
            slowStreak >= 3 ? ER_SAMPLE_SIZE : initialSampleSize(rowsFrom, rowsTo);
          try {
            let forward = { sampled: 0, matched: 0 };
            let backward = { sampled: 0, matched: 0 };
            let complete = sample === "full";
            for (;;) {
              paint(
                i,
                `${c.fromTable}.${c.fromColumn} ↔ ${c.toTable}.${c.toColumn} (${sample === "full" ? "complete join" : `${sample}-value sample`})`,
              );
              const started = Date.now();
              // Cost hint (#1): scale each probe's timeout to the larger table
              // so big unindexed joins finish instead of timing out at 30s.
              const cost = { scanRows: Math.max(rowsFrom, rowsTo) };
              forward = await contextService.probeJoin(source, from, to, sample, c.cast === true, cost);
              backward = await contextService.probeJoin(source, to, from, sample, c.cast === true, cost);
              const duration = Date.now() - started;
              if (duration >= ER_SLOW_PROBE_MS) {
                slowStreak += 1;
                // Give the database air after a slow round (sensitivity).
                await new Promise((r) => setTimeout(r, Math.min(2_000, duration)));
              } else {
                slowStreak = 0;
              }
              if (sample === "full") {
                complete = true;
                break;
              }
              const next = slowStreak > 0 ? undefined : nextSampleSize(sample, duration, rowsFrom);
              if (next === undefined) break;
              sample = next;
              complete = next === "full";
            }
            tested += 1;
            if (forward.sampled === 0 && backward.sampled === 0) zeroSampleCount += 1;
            const graded = classifyJoin(forward, backward);
            // User-provided joins persist even below the thresholds — the
            // user asserted them; the measured rates stay visible.
            const verdict = graded.verdict ?? (c.userDefined ? ("defined" as const) : undefined);
            testedLog.push({
              fromTable: c.fromTable,
              fromColumn: c.fromColumn,
              toTable: c.toTable,
              toColumn: c.toColumn,
              forwardRate: graded.forwardRate,
              backwardRate: graded.backwardRate,
              sampledForward: forward.sampled,
              sampledBackward: backward.sampled,
              outcome: verdict ?? "rejected",
              reason: c.reason,
              ...(c.cast ? { cast: true } : {}),
            });
            if (verdict) {
              relationships.push({
                fromTable: c.fromTable,
                fromColumn: c.fromColumn,
                toTable: c.toTable,
                toColumn: c.toColumn,
                forwardRate: graded.forwardRate,
                backwardRate: graded.backwardRate,
                sampledForward: forward.sampled,
                sampledBackward: backward.sampled,
                ...(complete ? { complete: true } : {}),
                ...(c.cast ? { cast: true } : {}),
                verdict,
                ...(graded.note ? { note: graded.note } : {}),
                reason: c.reason,
              });
            }
          } catch (err) {
            // One failed pair (permissions, timeout) never voids the rest.
            partial = true;
            slowStreak += 1;
            testedLog.push({
              fromTable: c.fromTable,
              fromColumn: c.fromColumn,
              toTable: c.toTable,
              toColumn: c.toColumn,
              forwardRate: 0,
              backwardRate: 0,
              sampledForward: 0,
              sampledBackward: 0,
              outcome: "failed",
              reason: c.reason,
            });
            log.warn(
              `ER probe failed for ${c.fromTable}.${c.fromColumn} ↔ ${c.toTable}.${c.toColumn}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          paint(i, undefined, false, 100 / queue.length);
        };
        // Escalation ladder: each stage runs when the queue drains and may
        // append new candidates. Maximum mode escalates automatically; the
        // other modes ASK between passes, so the user progresses to more
        // thorough methods deliberately (pilot: a clean "zero joins" must
        // never be the end of the road).
        const maxMode = mode.value === "max";
        const askEscalate = async (passName: string, question: string): Promise<boolean> => {
          if (maxMode) return true;
          // The progress toast says what we're waiting for, and the
          // approval itself is MODAL — an escalation gate must not be a
          // missable toast behind the spinner (pilot).
          paint(queue.length, `awaiting your approval for the ${passName}…`, true);
          const pick = await vscode.window.showInformationMessage(
            `Build ER Diagram — escalate to the ${passName}?`,
            { modal: true, detail: question },
            "Escalate",
          );
          return pick === "Escalate";
        };
        const stages: Array<() => Promise<JoinCandidate[]>> = [];
        if (aiEnabled) {
          stages.push(async () => {
            // Incremental refinement: little confirmed → show Copilot what
            // was MEASURED (the near-misses) and probe its new hypotheses.
            if (relationships.length >= 3) return [];
            const rejected = testedLog
              .filter((t) => t.outcome === "rejected" || t.outcome === "failed")
              .sort((a, b) => Math.max(b.forwardRate, b.backwardRate) - Math.max(a.forwardRate, a.backwardRate));
            if (rejected.length === 0) return [];
            passLabel = "AI refinement";
            paint(queue.length, "asking Copilot to refine the hypotheses from the measured rates…", true);
            const more = await aiPropose(rejected).catch((err) => {
              log.warn(`AI refinement unavailable: ${err instanceof Error ? err.message : String(err)}`);
              return [] as JoinCandidate[];
            });
            aiRefined = more.length;
            return more;
          });
        }
        stages.push(async () => {
          // Cast pass: retry failed/zero-sample pairs with CAST comparison
          // (types `=` rejects look exactly like "no relationship") and
          // sweep cross-type pairs. The decisive pass for legacy exports.
          const failures = testedLog.filter(
            (t) => t.outcome === "failed" || (t.sampledForward === 0 && t.sampledBackward === 0),
          ).length;
          if (relationships.length >= 3 && failures === 0) return [];
          const retries = buildCastRetryCandidates(testedLog, tried);
          const crossType = proposeExhaustivePairs(scoped, rowEstimates, tried, ER_FULL_JOIN_MAX_ROWS, ER_EXHAUSTIVE_PAIR_CAP, { crossFamily: true });
          const next = [...retries, ...crossType];
          if (next.length === 0) return [];
          if (
            !(await askEscalate(
              "cast pass",
              `${relationships.length} relationship(s) so far${failures > 0 ? `; ${failures} probe(s) failed or sampled nothing — often LOB/mismatched types that plain '=' cannot compare` : ""}.\n\n${next.length} pair(s) would be probed: failed pairs re-tested and cross-type pairs compared by casting both sides to text.`,
            ))
          ) {
            return [];
          }
          passLabel = "cast pass";
          paint(queue.length, "comparing as text across mismatched/LOB types…", true);
          return next;
        });
        stages.push(async () => {
          // Large-table pass: bounded samples against tables the sweep
          // normally leaves alone.
          if (relationships.length >= 3) return [];
          const large = proposeExhaustivePairs(scoped, rowEstimates, tried, ER_FULL_JOIN_MAX_ROWS, ER_EXHAUSTIVE_PAIR_CAP, { includeLarge: true, crossFamily: true });
          if (large.length === 0) return [];
          if (
            !(await askEscalate(
              "large-table pass",
              `Still ${relationships.length} relationship(s).\n\n${large.length} pair(s) involving big tables would be probed with strictly bounded samples (${ER_SAMPLE_SIZE}+ values, never full scans).`,
            ))
          ) {
            return [];
          }
          passLabel = "large tables";
          paint(queue.length, "bounded samples against the big tables…", true);
          return large;
        });
        let i = 0;
        for (;;) {
          if (token.isCancellationRequested) {
            partial = true;
            break;
          }
          if (i >= queue.length) {
            const stage = stages.shift();
            if (!stage) break;
            const more = await stage();
            if (more.length > 0) queue.push(...more);
            continue;
          }
          await probeOne(queue[i], i);
          i += 1;
        }
      },
    );
    relationships.sort(
      (a, b) => Math.max(b.forwardRate, b.backwardRate) - Math.max(a.forwardRate, a.backwardRate),
    );
    const bestRate = (t: TestedPair) => Math.max(t.forwardRate, t.backwardRate);
    // A scoped run must not erase what earlier runs established outside its
    // scope: re-probed pairs take the new measurement, the rest survive.
    const previous = schemas.getSync(source.id)?.er;
    const er: ErModel = {
      builtAt: nowIso(),
      builtBy: EXTENSION_VERSION,
      sampleSize: ER_SAMPLE_SIZE,
      candidatesTested: tested,
      relationships: mergeRelationships(previous?.relationships ?? [], relationships),
      ...(partial ? { partial: true } : {}),
      mode: mode.value,
      rowEstimates: { ...(previous?.rowEstimates ?? {}), ...rowEstimates },
      ...(selectedTables.length < schema.catalog.tables.length
        ? { scopeTables: selectedTables.length }
        : {}),
      ...(aiHint ? { aiHint } : {}),
      report: {
        tested: [...testedLog].sort((a, b) => bestRate(b) - bestRate(a)).slice(0, 80),
        zeroSampleCount,
        ...(aiEnabled ? { aiProposed: aiPairs.length, ...(aiRefined ? { aiRefined } : {}) } : {}),
      },
    };
    await schemas.set(source.id, { ...(schemas.getSync(source.id) ?? schema), er });
    telemetry.record("schema.er", {
      type: source.type,
      mode: mode.value,
      candidates: String(candidates.length),
      tested: String(tested),
      found: String(relationships.length),
      partial: String(partial),
    });
    const completeCount = relationships.filter((r) => r.complete).length;
    // Zero results must be DIAGNOSABLE, not a dead end: lead with the best
    // measured rate and route to the probe report (pilot: 800 pairs, zero
    // results, no way to see why).
    const bestMiss = testedLog.filter((t) => t.outcome !== "strong" && t.outcome !== "likely").sort((a, b) => bestRate(b) - bestRate(a))[0];
    const summary =
      relationships.length === 0 && tested > 0
        ? `ER model for "${source.displayName}": no pair passed the thresholds across ${tested} probe(s). Best measured rate: ${bestMiss ? `${Math.round(bestRate(bestMiss) * 100)}% (${bestMiss.fromTable}.${bestMiss.fromColumn} ↔ ${bestMiss.toTable}.${bestMiss.toColumn})` : "n/a"}${zeroSampleCount >= Math.max(3, tested / 2) ? " — most probes sampled ZERO values, which points at a sampling/permissions problem, not absent relationships" : ""}. The probe report shows every near-miss.`
        : `ER model for "${source.displayName}": ${relationships.length} relationship(s) from ${tested} probed pair(s) (${completeCount} verified by complete joins)${partial ? " — partial, re-run to finish" : ""}. Persisted with the schema; chat now uses these JOIN paths.`;
    const view = await vscode.window.showInformationMessage(summary, "View Schema & ER Diagram");
    if (view) {
      await vscode.commands.executeCommand("aiSharePoint.viewSourceSchema", contextSources.get(source.id));
    }
  });

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
      `- ER model: **${schema.er ? `${schema.er.relationships.length} relationship(s)` : "not built"}**${schema.er ? ` (probed ${schema.er.builtAt}${schema.er.partial ? ", partial" : ""})` : " — run “Build Database ER Diagram”"}`,
      "",
      "_Catalog = names and types read from the database. Semantic tags/synonyms (when indexed) are Copilot's generalization so free-form questions find the right columns._",
    ];
    if (schema.er) {
      lines.push(
        "",
        "## Entity relationships (probed join rates)",
        "",
        `_No foreign keys needed: each pair below was tested empirically — complete joins where both tables are small (≤ ${ER_FULL_JOIN_MAX_ROWS.toLocaleString()} rows), adaptive samples escalated toward completeness while the database answered fast elsewhere; match rate measured in both directions (forward/backward). ≈100% = designed-in join; full one way + partial the other = an intentional subset (use a LEFT JOIN from the wider side).${schema.er.mode === "thorough" ? " Thorough mode: every type-compatible pair across small tables was also tested." : ""} Open the markdown preview for the diagram._`,
        "",
        "```mermaid",
        renderErMermaid(schema.er),
        "```",
        "",
        "| Join | Match fwd | Match back | Verdict | Reading |",
        "|---|---|---|---|---|",
      );
      for (const r of schema.er.relationships) {
        lines.push(
          `| \`${r.fromTable}.${r.fromColumn} = ${r.toTable}.${r.toColumn}\` | ${Math.round(r.forwardRate * 100)}%${r.complete ? " (complete)" : ""}${r.cast ? " (cast)" : ""} | ${Math.round(r.backwardRate * 100)}% | ${r.verdict} | ${r.note ?? r.reason} |`,
        );
      }
      lines.push(...renderProbeReport(schema.er));
    }
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

  // ADR-0031: large datasets leave through FILES, not chat — run the query
  // with export bounds and write every row into the workspace, so Copilot
  // only ever sees the path and a count.
  register(
    "aiSharePoint.exportSearchResults",
    async (arg): Promise<{ file: string; rows: number } | undefined> => {
      const plain =
        arg && typeof arg === "object" && !("baseUrl" in arg)
          ? (arg as { source?: string; query?: string; fileName?: string })
          : undefined;
      const source = plain?.source
        ? resolveSourceRef(contextSources.list(), plain.source)
        : await resolveSourceArg(arg, contextSources);
      if (!source) {
        if (plain?.source) {
          throw new AppError(`No reference source matches "${plain.source}".`, "config");
        }
        return undefined;
      }
      const isDb = ["mssql", "postgres", "mysql", "mongodb"].includes(source.type);
      const query =
        plain?.query?.trim() ||
        (await vscode.window.showInputBox({
          ignoreFocusOut: true,
          title: `Export from ${source.displayName} — query`,
          prompt: `Runs read-only with export bounds (up to ${EXPORT_MAX_ROWS.toLocaleString("en-US")} rows, ${Math.round(EXPORT_TIMEOUT_MS / 1000)}s) and writes every result to a file — nothing is sent to Copilot.`,
          placeHolder: isDb
            ? source.type === "mongodb"
              ? '{"collection": "...", "filter": {...}}'
              : "SELECT … (single read-only statement)"
            : "Raw query (CQL/JQL/filter/SPL…) or free text",
        }));
      if (!query?.trim()) return undefined;
      const ext = source.type === "mongodb" ? "json" : "csv";
      const fileName =
        (plain?.fileName ? sanitizeExportFileName(plain.fileName, ext) : undefined) ??
        exportFileName(source.alias ?? source.displayName, ext, nowIso());
      const rows = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Exporting from ${source.displayName} (up to ${EXPORT_MAX_ROWS.toLocaleString("en-US")} rows)…`,
        },
        () =>
          contextService.searchForExport(source, query, {
            maxResults: EXPORT_MAX_ROWS,
            timeoutMs: EXPORT_TIMEOUT_MS,
          }),
      );
      const content = ext === "json" ? JSON.stringify(rows, null, 2) : rowsToCsv(rows);
      const ws = vscode.workspace.workspaceFolders?.[0];
      let target: vscode.Uri;
      let shownPath: string;
      if (ws) {
        const dir = vscode.Uri.joinPath(ws.uri, EXPORT_DIR);
        await vscode.workspace.fs.createDirectory(dir);
        target = vscode.Uri.joinPath(dir, fileName);
        shownPath = `${EXPORT_DIR}/${fileName}`;
      } else {
        const picked = await vscode.window.showSaveDialog({
          saveLabel: "Export",
          filters: ext === "json" ? { JSON: ["json"] } : { CSV: ["csv"] },
          defaultUri: vscode.Uri.file(fileName),
        });
        if (!picked) return undefined;
        target = picked;
        shownPath = picked.fsPath;
      }
      await vscode.workspace.fs.writeFile(target, Buffer.from(content, "utf8"));
      telemetry.record("context.export", { type: source.type, rows: String(rows.length) });
      const capNote =
        rows.length >= EXPORT_MAX_ROWS
          ? ` — capped at ${EXPORT_MAX_ROWS.toLocaleString("en-US")}; narrow the query for the rest`
          : "";
      void vscode.window
        .showInformationMessage(
          `Exported ${rows.length.toLocaleString("en-US")} row(s) to ${shownPath}${capNote}.`,
          "Open File",
        )
        .then(async (open) => {
          if (open) await vscode.window.showTextDocument(target);
        });
      return { file: shownPath, rows: rows.length };
    },
  );

  register("aiSharePoint.exportReferenceConfig", async () => {
    const allSites = sites.list();
    const allSources = contextSources.list();
    const allProjects = projects.list();
    if (allSites.length === 0 && allSources.length === 0 && allProjects.length === 0) {
      void vscode.window.showInformationMessage("Nothing to export yet — connect a site, add a reference source, or create a project first.");
      return;
    }
    // One combined, grouped multi-select: pick any subset of sites, sources,
    // projects, and per-entity memory.
    type PickItem = vscode.QuickPickItem & { kind2?: "site" | "source" | "project" | "memory"; key?: string };
    const items: PickItem[] = [];
    if (allSites.length) {
      items.push({ label: "Managed sites", kind: vscode.QuickPickItemKind.Separator });
      for (const s of allSites) {
        items.push({ label: s.displayName || s.siteUrl, description: `${s.role} · ${s.siteUrl}`, picked: true, kind2: "site", key: s.siteUrl });
      }
    }
    if (allSources.length) {
      items.push({ label: "Reference sources", kind: vscode.QuickPickItemKind.Separator });
      for (const s of allSources) {
        items.push({ label: s.displayName, description: `${s.type}${s.alias ? ` · @${s.alias}` : ""}`, picked: true, kind2: "source", key: s.id });
      }
    }
    if (allProjects.length) {
      items.push({ label: "Projects", kind: vscode.QuickPickItemKind.Separator });
      for (const p of allProjects) {
        items.push({ label: p.name, description: `${p.sourceIds.length} source(s)`, picked: true, kind2: "project", key: p.id });
      }
    }
    // Memory notes: one row per entity that has any. Key encodes the scope
    // (`site:<url>` / `source:<id>`) so it never collides with the entity rows.
    const memSites = allSites.filter((s) => memory.listForScope({ kind: "site", key: s.siteUrl }).length > 0);
    const memSources = allSources.filter((s) => memory.listForScope({ kind: "source", key: s.id }).length > 0);
    if (memSites.length || memSources.length) {
      items.push({ label: "Memory notes", kind: vscode.QuickPickItemKind.Separator });
      for (const s of memSites) {
        const n = memory.listForScope({ kind: "site", key: s.siteUrl }).length;
        items.push({ label: `${s.displayName || s.siteUrl} — memory`, description: `${n} note(s)`, picked: true, kind2: "memory", key: `site:${s.siteUrl}` });
      }
      for (const s of memSources) {
        const n = memory.listForScope({ kind: "source", key: s.id }).length;
        items.push({ label: `${s.displayName} — memory`, description: `${n} note(s)`, picked: true, kind2: "memory", key: `source:${s.id}` });
      }
    }
    const chosen = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      ignoreFocusOut: true,
      title: "Export — select sites, sources, projects, and memory",
      placeHolder: "Everything is pre-selected; toggle off anything you don't want. Esc cancels — nothing is written.",
    });
    if (!chosen || chosen.length === 0) return;
    const pickedSites = new Set(chosen.filter((c) => c.kind2 === "site").map((c) => c.key));
    const pickedSources = new Set(chosen.filter((c) => c.kind2 === "source").map((c) => c.key));
    const pickedProjects = new Set(chosen.filter((c) => c.kind2 === "project").map((c) => c.key));
    const pickedMemory = chosen.filter((c) => c.kind2 === "memory").map((c) => c.key!);
    const selSites = allSites.filter((s) => pickedSites.has(s.siteUrl));
    const selSources = allSources.filter((s) => pickedSources.has(s.id));
    const selProjects = allProjects.filter((p) => pickedProjects.has(p.id));
    const selSourceIds = new Set(selSources.map((s) => s.id));
    const selBookmarks = bookmarks.list().filter((b) => selSourceIds.has(b.sourceId));
    // Collect the memory for every picked entity. Source-scoped notes re-key to
    // the source displayName via a map over ALL sources (so a note exports even
    // if its source descriptor isn't selected — recipients match it by name).
    const selMemory: MemoryItem[] = [];
    for (const k of pickedMemory) {
      const sep = k.indexOf(":");
      const kind = k.slice(0, sep) as MemoryScopeKind;
      const key = k.slice(sep + 1);
      selMemory.push(...memory.listForScope({ kind, key }));
    }
    const allSourceNames = new Map(allSources.map((s) => [s.id, s.displayName] as const));
    const schemasById = new Map(
      selSources.flatMap((s) => {
        const schema = schemas.getSync(s.id);
        return schema ? [[s.id, schema] as const] : [];
      }),
    );
    const exportDoc = buildReferenceExport(selSources, selBookmarks, nowIso(), schemasById, selProjects, selSites, selMemory, allSourceNames);
    const json = JSON.stringify(exportDoc, null, 2);
    // Defense in depth (ADR-0013): the builder is secret-free by construction;
    // exportLeakBlockers refuses to write if anything credential-shaped slipped
    // through (it deliberately allows the site/source URLs that ARE the payload).
    const blockers = exportLeakBlockers(json);
    if (blockers.length > 0) {
      void vscode.window.showErrorMessage(
        `Export blocked by the safety scan (${blockers.join(", ")}). Nothing was written.`,
      );
      return;
    }
    const preview = await vscode.workspace.openTextDocument({ language: "json", content: json });
    await vscode.window.showTextDocument(preview, { preview: true });
    const summary = [
      exportDoc.sites?.length ? `${exportDoc.sites.length} site(s)` : "",
      exportDoc.sources.length ? `${exportDoc.sources.length} source(s)` : "",
      exportDoc.projects?.length ? `${exportDoc.projects.length} project(s)` : "",
      exportDoc.bookmarks.length ? `${exportDoc.bookmarks.length} bookmark(s)` : "",
      exportDoc.memory?.length ? `${exportDoc.memory.length} memory note(s)` : "",
    ].filter(Boolean).join(", ");
    const confirm = await vscode.window.showInformationMessage(
      `Export ${summary}? The file contains descriptors and bookmarks only — no credentials, tokens, or accounts; recipients sign in with their own.`,
      { modal: true },
      "Save…",
    );
    if (!confirm) return;
    const stamp = nowIso().replace(/[-:]/g, "").slice(0, 13);
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(os.homedir(), `ai-sharepoint-config-${stamp}.json`)),
      filters: { "Workspace config (JSON)": ["json"] },
    });
    if (!target) return;
    await vscode.workspace.fs.writeFile(target, Buffer.from(json, "utf8"));
    telemetry.record("context.exportConfig", {
      sites: exportDoc.sites?.length ?? 0,
      sources: exportDoc.sources.length,
      projects: exportDoc.projects?.length ?? 0,
      memory: exportDoc.memory?.length ?? 0,
    });
    void vscode.window.showInformationMessage("Configuration exported (secret-free).");
  });

  register("aiSharePoint.importReferenceConfig", async () => {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { "Workspace config (JSON)": ["json"] },
      title: "Import sites, sources, projects & memory (no credentials)",
    });
    if (!picked?.[0]) return;
    const json = Buffer.from(await vscode.workspace.fs.readFile(picked[0])).toString("utf8");
    let parsed: ReturnType<typeof parseReferenceImport>;
    try {
      parsed = parseReferenceImport(json, nowIso(), () => crypto.randomUUID());
    } catch (e) {
      void vscode.window.showErrorMessage(`Could not import: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (parsed.sites.length === 0 && parsed.sources.length === 0 && parsed.projects.length === 0 && parsed.memory.length === 0) {
      void vscode.window.showWarningMessage(
        `Nothing to import.${parsed.warnings.length ? ` ${parsed.warnings.length} entr(ies) were malformed.` : ""}`,
      );
      return;
    }
    // Let the user choose which items in the file to bring in.
    type PickItem = vscode.QuickPickItem & { kind2?: "site" | "source" | "project" | "memory"; key?: string };
    const items: PickItem[] = [];
    if (parsed.sites.length) {
      items.push({ label: "Managed sites", kind: vscode.QuickPickItemKind.Separator });
      for (const s of parsed.sites) items.push({ label: s.displayName, description: `${s.role} · ${s.siteUrl}`, picked: true, kind2: "site", key: s.siteUrl });
    }
    if (parsed.sources.length) {
      items.push({ label: "Reference sources", kind: vscode.QuickPickItemKind.Separator });
      for (const s of parsed.sources) items.push({ label: s.displayName, description: s.type, picked: true, kind2: "source", key: s.id });
    }
    if (parsed.projects.length) {
      items.push({ label: "Projects", kind: vscode.QuickPickItemKind.Separator });
      for (const p of parsed.projects) items.push({ label: p.name, description: `${p.sourceIds.length} source(s)`, picked: true, kind2: "project", key: p.id });
    }
    if (parsed.memory.length) {
      items.push({ label: "Memory notes (review / decline)", kind: vscode.QuickPickItemKind.Separator });
      // Per-note rows so the user can decline individually (key = stable index).
      parsed.memory.forEach((m, i) =>
        items.push({
          label: m.title,
          description: `${m.scopeKind === "site" ? "site" : "source"}: ${m.scopeRef}${m.origin === "ai" ? " · AI-proposed" : ""}`,
          detail: m.text.length > 100 ? `${m.text.slice(0, 100)}…` : m.text,
          picked: true,
          kind2: "memory",
          key: `mem:${i}`,
        }),
      );
    }
    const chosen = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      ignoreFocusOut: true,
      title: "Import — select what to bring in",
      placeHolder: "Everything is pre-selected; toggle off anything you don't want. Esc cancels.",
    });
    if (!chosen || chosen.length === 0) return;
    const pickSites = new Set(chosen.filter((c) => c.kind2 === "site").map((c) => c.key));
    const pickSources = new Set(chosen.filter((c) => c.kind2 === "source").map((c) => c.key));
    const pickProjects = new Set(chosen.filter((c) => c.kind2 === "project").map((c) => c.key));
    const pickMemory = new Set(chosen.filter((c) => c.kind2 === "memory").map((c) => c.key));

    // Sites: create descriptors not already present (by URL); the user signs in after.
    const existingSiteUrls = new Set(sites.list().map((c) => c.siteUrl.toLowerCase()));
    const freshSites = parsed.sites.filter((s) => pickSites.has(s.siteUrl) && !existingSiteUrls.has(s.siteUrl.toLowerCase()));
    const skippedSites = parsed.sites.filter((s) => pickSites.has(s.siteUrl)).length - freshSites.length;

    // Sources: dedupe by display name; resolve alias collisions.
    const selectedSources = parsed.sources.filter((s) => pickSources.has(s.id));
    const existingNames = new Set(contextSources.list().map((s) => s.displayName.toLowerCase()));
    const fresh = selectedSources.filter((s) => !existingNames.has(s.displayName.toLowerCase()));
    const skipped = selectedSources.length - fresh.length;
    const existingAliases = new Set(contextSources.list().flatMap((s) => (s.alias ? [s.alias.toLowerCase()] : [])));
    for (const s of fresh) {
      if (s.alias && existingAliases.has(s.alias.toLowerCase())) {
        parsed.warnings.push(`Alias "${s.alias}" of "${s.displayName}" is already in use here — dropped.`);
        delete s.alias;
      } else if (s.alias) {
        existingAliases.add(s.alias.toLowerCase());
      }
    }
    const freshIds = new Set(fresh.map((s) => s.id));
    const freshBookmarks = parsed.bookmarks.filter((b) => freshIds.has(b.sourceId));
    const wantProjects = parsed.projects.filter((p) => pickProjects.has(p.id));

    // Memory: resolve each selected note's portable ref to a LOCAL scope, then
    // dedup against what's already stored (Phase 2 = skip exact matches; Phase 4
    // adds intelligent merge). Site refs match a known site URL (existing or just-
    // imported); source refs match a source displayName (just-imported or existing).
    const knownSiteUrls = [...sites.list().map((c) => c.siteUrl), ...freshSites.map((s) => s.siteUrl)];
    const sourceIdByName = new Map<string, string>();
    for (const s of contextSources.list()) sourceIdByName.set(s.displayName.toLowerCase(), s.id);
    for (const s of fresh) sourceIdByName.set(s.displayName.toLowerCase(), s.id);
    const resolveScope = (kind: MemoryScopeKind, ref: string): MemoryScope | undefined => {
      if (kind === "site") {
        const url = knownSiteUrls.find((u) => u.toLowerCase().replace(/\/+$/, "") === ref.toLowerCase().replace(/\/+$/, ""));
        return url ? { kind: "site", key: url } : undefined;
      }
      const id = sourceIdByName.get(ref.toLowerCase());
      return id ? { kind: "source", key: id } : undefined;
    };
    const selectedMemory = parsed.memory.filter((_, i) => pickMemory.has(`mem:${i}`));
    const memPlan = planMemoryImport(selectedMemory, resolveScope, memory.list(), () => crypto.randomUUID(), nowIso());
    if (memPlan.unresolved.length) {
      parsed.warnings.push(`${memPlan.unresolved.length} memory note(s) skipped — their site/source isn't here (import or add it first).`);
    }

    if (freshSites.length === 0 && fresh.length === 0 && freshBookmarks.length === 0 && wantProjects.length === 0 && memPlan.toAdd.length === 0) {
      void vscode.window.showWarningMessage(
        `Nothing new to import${skipped + skippedSites + memPlan.duplicates ? ` (${skipped + skippedSites + memPlan.duplicates} item(s) already present)` : ""}.`,
      );
      return;
    }
    const parts = [
      freshSites.length ? `${freshSites.length} site(s)` : "",
      fresh.length ? `${fresh.length} source(s)` : "",
      freshBookmarks.length ? `${freshBookmarks.length} bookmark(s)` : "",
      memPlan.toAdd.length ? `${memPlan.toAdd.length} memory note(s)` : "",
    ].filter(Boolean).join(", ");
    const alreadyPresent = skipped + skippedSites + memPlan.duplicates;
    const confirm = await vscode.window.showInformationMessage(
      `Import ${parts || "the selected project(s)"}?${alreadyPresent ? ` ${alreadyPresent} already-present item(s) skipped.` : ""} Credentials are NOT included — sign in to each site/source afterwards.${parsed.warnings.length ? ` ${parsed.warnings.length} entr(ies) skipped/malformed.` : ""}`,
      { modal: true },
      "Import",
    );
    if (!confirm) return;
    for (const s of freshSites) {
      const tenantHost = new URL(s.siteUrl).hostname;
      await sites.upsert({
        siteUrl: s.siteUrl,
        displayName: s.displayName,
        role: s.role,
        authProviderId: AUTH_PROVIDERS[0].id,
        cacheHandle: tenantCacheHandle(tenantHost),
        tenantHost,
        addedAt: nowIso(),
      });
    }
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
    const existingProjects = new Set(projects.list().map((pr) => pr.name.toLowerCase()));
    let importedProjects = 0;
    for (const pr of wantProjects) {
      if (existingProjects.has(pr.name.toLowerCase())) continue;
      const memberIds = pr.sourceIds.filter((id) => freshIds.has(id));
      await projects.upsert({ ...pr, sourceIds: memberIds });
      importedProjects++;
    }
    for (const m of memPlan.toAdd) {
      await memory.add(m);
    }
    telemetry.record("context.importConfig", {
      sites: freshSites.length,
      sources: fresh.length,
      bookmarks: freshBookmarks.length,
      projects: importedProjects,
      memory: memPlan.toAdd.length,
    });
    const done = [
      freshSites.length ? `${freshSites.length} site(s)` : "",
      fresh.length ? `${fresh.length} source(s)` : "",
      importedProjects ? `${importedProjects} project(s)` : "",
      memPlan.toAdd.length ? `${memPlan.toAdd.length} memory note(s)` : "",
    ].filter(Boolean).join(", ");
    void vscode.window.showInformationMessage(
      `Imported ${done || "the selected items"}. Sign in to each site/source to activate (lockout-safe single verify).`,
    );
  });

  // Memory: per-entity notes (user + AI) that give @sharepoint extra context about
  // a site/source. Managed here via a picker; injected into chat when in scope.
  // Resolve a human label for a memory scope (for the manage loop title) by
  // looking up the owning site/source; falls back to the raw key.
  const labelForScope = (s: MemoryScope): string =>
    s.kind === "site"
      ? sites.list().find((c) => c.siteUrl === s.key)?.displayName || s.key
      : contextSources.list().find((src) => src.id === s.key)?.displayName || s.key;
  register("aiSharePoint.manageMemory", async (preselect?: unknown) => {
    let scope: MemoryScope | undefined;
    let label = "";
    const node = preselect && typeof preselect === "object" ? (preselect as Partial<SiteConnection & ContextSource> & { memoryScope?: MemoryScope; scope?: MemoryScope }) : undefined;
    // Right-clicked the "Memory (N)" folder or a note → that exact scope.
    const fromTree = node?.memoryScope ?? (node?.scope && typeof node.scope === "object" && "kind" in node.scope ? node.scope : undefined);
    if (fromTree && (fromTree.kind === "site" || fromTree.kind === "source") && typeof fromTree.key === "string") {
      scope = fromTree;
      label = labelForScope(fromTree);
    } else if (node && typeof node.siteUrl === "string" && typeof node.role === "string") {
      scope = { kind: "site", key: node.siteUrl };
      label = node.displayName || node.siteUrl;
    } else if (node && typeof node.id === "string" && typeof node.type === "string") {
      scope = { kind: "source", key: node.id };
      label = node.displayName ?? node.id;
    } else {
      const choices = [
        ...sites.list().map((c) => ({
          label: c.displayName || c.siteUrl,
          description: `site · ${c.siteUrl}`,
          scope: { kind: "site" as const, key: c.siteUrl },
        })),
        ...contextSources.list().map((s) => ({
          label: s.displayName,
          description: `source · ${s.type}`,
          scope: { kind: "source" as const, key: s.id },
        })),
      ];
      if (choices.length === 0) {
        void vscode.window.showInformationMessage("Add a managed site or reference source first — memory attaches to one.");
        return;
      }
      const pick = await vscode.window.showQuickPick(choices, {
        title: "Manage memory — pick a site or source",
        placeHolder: "Memory gives @sharepoint extra context about that site/source (used when it's in scope).",
        ignoreFocusOut: true,
      });
      if (!pick) return;
      scope = pick.scope;
      label = pick.label;
    }
    // Manage loop: list items + add/edit/copy/delete.
    for (;;) {
      const items = memory.listForScope(scope);
      const ADD = "$(add) Add a memory note…";
      const chosen = await vscode.window.showQuickPick(
        [
          { label: ADD, alwaysShow: true } as vscode.QuickPickItem & { item?: MemoryItem },
          ...items.map((m) => ({
            label: `$(note) ${m.title}`,
            description: m.origin === "ai" ? "AI-proposed" : "",
            detail: m.text.length > 120 ? `${m.text.slice(0, 120)}…` : m.text,
            item: m,
          })),
        ],
        { title: `Memory for ${label} — ${items.length} note(s)`, placeHolder: "Pick a note to edit/copy/delete, or add one. Esc closes.", ignoreFocusOut: true },
      );
      if (!chosen) return;
      if (chosen.label === ADD) {
        const title = await vscode.window.showInputBox({ title: "New memory — short title", prompt: "e.g. Soft deletes", ignoreFocusOut: true, validateInput: (v) => (v.trim() ? undefined : "Required.") });
        if (!title) continue;
        const text = await vscode.window.showInputBox({ title: "New memory — the note", prompt: "Context @sharepoint should know about this site/source", ignoreFocusOut: true, validateInput: (v) => (v.trim() ? undefined : "Required.") });
        if (!text) continue;
        const norm = normalizeMemoryInput(title, text);
        const at = nowIso();
        await memory.add({ id: crypto.randomUUID(), scope, title: norm.title, text: norm.text, ...(norm.tags ? { tags: norm.tags } : {}), origin: "user", createdAt: at, updatedAt: at });
        continue;
      }
      const m = chosen.item;
      if (!m) continue;
      const act = await vscode.window.showQuickPick(["Edit", "Copy", "Delete"], { title: `"${m.title}"${m.origin === "ai" ? " (AI-proposed)" : ""}`, placeHolder: m.text, ignoreFocusOut: true });
      if (act === "Edit") {
        const title = await vscode.window.showInputBox({ title: "Edit title", value: m.title, ignoreFocusOut: true, validateInput: (v) => (v.trim() ? undefined : "Required.") });
        if (title === undefined) continue;
        const text = await vscode.window.showInputBox({ title: "Edit note", value: m.text, ignoreFocusOut: true, validateInput: (v) => (v.trim() ? undefined : "Required.") });
        if (text === undefined) continue;
        const norm = normalizeMemoryInput(title, text);
        await memory.update({ ...m, title: norm.title, text: norm.text, ...(norm.tags ? { tags: norm.tags } : {}), origin: "user", updatedAt: nowIso() });
      } else if (act === "Copy") {
        await vscode.env.clipboard.writeText(`${m.title}: ${m.text}`);
        void vscode.window.showInformationMessage("Memory note copied to the clipboard.");
      } else if (act === "Delete") {
        await memory.remove(m.id);
      }
    }
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

  /** Create an email draft directly in the user's Outlook Drafts folder.
   *  Outlook's own Drafts is the review surface (the user finishes/sends it
   *  there), so the assistant skips the in-plugin Communications staging and
   *  approval — nothing is sent. Returns the web link + any unresolved
   *  recipients. */
  const createOutlookDraftDirect = async (
    to: string[],
    subject: string,
    body: string,
  ): Promise<{ webLink?: string; failures: string[] }> => {
    const client = await commsClientFor();
    if (!client) {
      throw new AppError(
        "Set up your Microsoft 365 sign-in for email first (connect a SharePoint site).",
        "config",
      );
    }
    const resolved = [];
    const failures: string[] = [];
    for (const r of to) {
      try {
        resolved.push(await client.resolveRecipient(r));
      } catch {
        failures.push(r);
      }
    }
    if (resolved.length === 0) {
      throw new AppError(`No recipients could be resolved in the directory: ${failures.join(", ")}.`, "config");
    }
    const created = await client.createMailDraft(resolved, subject, body);
    return { ...(created.webLink ? { webLink: created.webLink } : {}), failures };
  };
  context.subscriptions.push(
    ...tryRegister("communication tools", () =>
      registerCommsTools(outbox, createOutlookDraftDirect, telemetry, errors, nowIso),
    ),
  );

  // Teams Incoming Webhooks (ADR-0025 amendment): the no-admin-consent
  // delivery path. URLs embed a token, so they live in the keychain (never
  // settings/logs), behind one JSON handle.
  const TEAMS_WEBHOOKS_HANDLE = "teams:webhooks";
  const getTeamsWebhooks = async (): Promise<TeamsWebhook[]> => {
    const raw = await secrets.get(TEAMS_WEBHOOKS_HANDLE);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as TeamsWebhook[];
      return Array.isArray(parsed) ? parsed.filter((w) => w?.name && w?.url) : [];
    } catch {
      return [];
    }
  };
  const setTeamsWebhooks = (hooks: TeamsWebhook[]): Thenable<void> =>
    hooks.length > 0
      ? secrets.set(TEAMS_WEBHOOKS_HANDLE, JSON.stringify(hooks))
      : secrets.delete(TEAMS_WEBHOOKS_HANDLE);

  register("aiSharePoint.configureTeamsWebhook", async () => {
    const hooks = await getTeamsWebhooks();
    const pick = await vscode.window.showQuickPick(
      [
        { label: "$(add) Add a Teams channel webhook…", value: "add" as const },
        ...(hooks.length > 0
          ? [{ label: "$(trash) Remove a webhook…", value: "remove" as const }]
          : []),
      ],
      {
        ignoreFocusOut: true,
        title: `Teams webhooks (${hooks.length} configured) — no admin consent needed`,
      },
    );
    if (!pick) return;
    if (pick.value === "remove") {
      const target = await vscode.window.showQuickPick(
        hooks.map((w) => ({ label: w.name, description: safeUrl(w.url), w })),
        { ignoreFocusOut: true, title: "Remove which webhook?" },
      );
      if (!target) return;
      await setTeamsWebhooks(hooks.filter((w) => w !== target.w));
      void vscode.window.showInformationMessage(`Removed Teams webhook "${target.w.name}".`);
      return;
    }
    const url = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      password: true,
      title: "Teams Incoming Webhook URL",
      prompt:
        "In the Teams channel: ••• → Connectors → Incoming Webhook (or a Power Automate “Workflows” webhook). Create it, copy the URL, and paste it here. Stored only in your OS keychain. No app registration or admin consent required.",
      placeHolder: "https://<tenant>.webhook.office.com/webhookb2/…",
      validateInput: (v) => teamsWebhookUrlIssue(v),
    });
    if (!url?.trim()) return;
    if (!isKnownWebhookHost(url)) {
      const proceed = await vscode.window.showWarningMessage(
        "That host doesn't look like a standard Teams/Power-Automate webhook. Add it anyway?",
        "Add Anyway",
      );
      if (proceed !== "Add Anyway") return;
    }
    const name = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      title: "Name this channel webhook",
      placeHolder: "IT Ops · Alerts",
      value: "Teams channel",
    });
    if (!name?.trim()) return;
    await setTeamsWebhooks([...hooks.filter((w) => w.name !== name.trim()), { name: name.trim(), url: url.trim() }]);
    void vscode.window.showInformationMessage(
      `Teams webhook "${name.trim()}" saved. Test it (“AI SharePoint: Test Communication Method”) to enable it for sending.`,
    );
  });

  // Communications verification (ADR-0025 amendment): a method is offered for
  // sending only after a real end-to-end test — a coded message the user
  // confirms receiving — so consent/webhook/delivery is proven, not assumed.
  const VERIFIED_KEY = "aiSharePoint.commsVerified";
  const verifiedAt = (key: string): string | undefined =>
    context.globalState.get<Record<string, string>>(VERIFIED_KEY, {})[key];
  const markVerified = async (key: string): Promise<void> => {
    const map = { ...context.globalState.get<Record<string, string>>(VERIFIED_KEY, {}) };
    map[key] = nowIso();
    await context.globalState.update(VERIFIED_KEY, map);
  };
  const anyTeamsVerified = async (): Promise<boolean> =>
    Boolean(verifiedAt(verificationKey("teams-graph"))) ||
    (await getTeamsWebhooks()).some((w) => verifiedAt(verificationKey("teams-webhook", w.name)));

  /** Run one method's end-to-end test: send a coded message, have the user
   *  confirm the code, persist verification on success. Returns verified. */
  const runCommsTest = async (
    kind: CommsMethodKind,
    webhook?: TeamsWebhook,
  ): Promise<boolean> => {
    const code = generateVerificationCode();
    const label = kind === "outlook" ? "Outlook email" : webhook ? `Teams “${webhook.name}”` : "Teams";
    const { subject, body } = buildTestMessage(code, label);
    try {
      if (kind === "teams-webhook" && webhook) {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Posting a test to “${webhook.name}”…` },
          () => postTeamsWebhook(webhook.url, buildTeamsWebhookPayload({ body, title: subject })),
        );
      } else {
        const client = await commsClientFor();
        if (!client) return false;
        if (kind === "outlook") {
          // The test only CREATES a draft (Mail.ReadWrite) — it does NOT send.
          // The draft landing in the user's Drafts, with a code they read
          // back, proves the path end-to-end, and matches the approve-and-
          // release principle (the user releases every message themselves).
          // No Mail.Send needed, so admin-gated Send never blocks the test.
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: "Creating a test draft in your Outlook Drafts…" },
            async () => {
              const me = await client.myAddress();
              if (!me.address) throw new AppError("Could not determine your mailbox address.", "config");
              await client.createMailDraft([me], subject, body);
            },
          );
        } else {
          // Graph Teams can't message yourself in a oneOnOne — test against a
          // real recipient the user can check (a colleague, or a self-chat
          // where the tenant allows it).
          const ref = await vscode.window.showInputBox({
            ignoreFocusOut: true,
            title: "Teams test — recipient to message",
            prompt:
              "Direct Teams messaging can't post to a 1:1 chat with only yourself, so pick someone who can confirm the code (a willing colleague, or your own address if your tenant allows self-chat).",
            placeHolder: "colleague@corp.example",
            validateInput: (v) => recipientIssue(parseRecipients(v)),
          });
          if (!ref) return false;
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: "Sending a Teams test…" },
            async () => {
              const resolved = await client.resolveRecipient(parseRecipients(ref)[0]);
              await client.sendTeamsMessage([resolved], body);
            },
          );
        }
      }
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      // The AppError's own summary (e.g. the draft-created/send-failed
      // reconciliation) is the most specific explanation; fall back to the
      // scope-consent hint otherwise.
      const detail = err instanceof AppError && err.userSummary ? err.userSummary : explainCommsError(raw);
      void vscode.window.showWarningMessage(
        `${label} test didn't complete: ${raw}${detail ? ` — ${detail}` : ""}`,
      );
      return false;
    }
    const entered = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      title: `Confirm the ${label} test`,
      prompt: `Open ${kind === "teams-webhook" ? "the Teams channel" : kind === "outlook" ? "your Outlook Drafts folder" : "the Teams chat"}, find the test message, and enter the verification code from it.`,
      placeHolder: "e.g. ABC-D29",
    });
    if (entered === undefined) return false;
    if (!codeMatches(entered, code)) {
      void vscode.window.showWarningMessage(
        `That code didn't match — ${label} is not verified. The message may not have been delivered; re-test after checking.`,
      );
      return false;
    }
    await markVerified(verificationKey(kind, webhook?.name));
    telemetry.record("comms.verify", { kind });
    void vscode.window.showInformationMessage(
      kind === "outlook"
        ? "✓ Outlook verified — drafts will be placed in your Outlook Drafts for you to review and send."
        : `✓ ${label} verified end-to-end — it's now available for sending.`,
    );
    return true;
  };

  register("aiSharePoint.testCommsMethod", async () => {
    const webhooks = await getTeamsWebhooks();
    const pick = await vscode.window.showQuickPick(
      [
        {
          label: "$(mail) Outlook email (self-test with a code)",
          description: verifiedLabel(verifiedAt(verificationKey("outlook"))),
          run: () => runCommsTest("outlook"),
        },
        {
          label: "$(comment-discussion) Teams via Graph (Chat.ReadWrite)",
          description: verifiedLabel(verifiedAt(verificationKey("teams-graph"))),
          run: () => runCommsTest("teams-graph"),
        },
        ...webhooks.map((w) => ({
          label: `$(plug) Teams webhook — ${w.name}`,
          description: verifiedLabel(verifiedAt(verificationKey("teams-webhook", w.name))),
          run: () => runCommsTest("teams-webhook", w),
        })),
      ],
      { ignoreFocusOut: true, title: "Test which communication method? (sends a coded message you confirm)" },
    );
    if (!pick) return;
    await pick.run();
  });

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
    // A method must be proven before it's offered (ADR-0025 amendment).
    if (!(await anyTeamsVerified())) {
      const go = await vscode.window.showInformationMessage(
        "No Teams delivery method is verified yet. Test one end-to-end first (a coded message you confirm) — then drafting can target it.",
        "Test Teams Method",
      );
      if (go === "Test Teams Method") await vscode.commands.executeCommand("aiSharePoint.testCommsMethod");
      return;
    }
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
    if (!verifiedAt(verificationKey("outlook"))) {
      const go = await vscode.window.showInformationMessage(
        "Outlook isn't verified yet. Run a one-time end-to-end test (sends a coded email to yourself you confirm) before drafting.",
        "Test Outlook",
      );
      if (go === "Test Outlook" && !(await runCommsTest("outlook"))) return;
      if (go !== "Test Outlook") return;
    }
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

    // Only VERIFIED methods are offered as send options (ADR-0025
    // amendment): a delivery path must have passed its end-to-end test.
    // Teams has no Graph "draft" — Chat.ReadWrite posts live; Incoming
    // Webhooks are the no-consent alternative, each its own button.
    const allWebhooks = draft.channel === "teams" ? await getTeamsWebhooks() : [];
    const webhooks = allWebhooks.filter((w) => verifiedAt(verificationKey("teams-webhook", w.name)));
    const graphVerified =
      draft.channel === "teams"
        ? Boolean(verifiedAt(verificationKey("teams-graph")))
        : Boolean(verifiedAt(verificationKey("outlook")));
    const WEBHOOK_PREFIX = "Post to ";
    const sendLabel = draft.channel === "teams" ? "Send via Teams (Graph)" : "Send Email";
    const webhookButtons = webhooks.map((w) => `${WEBHOOK_PREFIX}${w.name}`);
    // Outlook is verified by a DRAFT test (no send), matching approve-and-
    // release: once verified, both "Save to Outlook Drafts" and one-click
    // "Send Email" are offered (Send still needs Mail.Send at click time;
    // the runtime hint guides if it's not granted). Teams: verified webhooks
    // and/or a verified Graph path.
    const sendButtons =
      draft.channel === "outlook"
        ? graphVerified
          ? ["Save to Outlook Drafts", sendLabel]
          : []
        : [...webhookButtons, ...(graphVerified ? [sendLabel] : [])];
    if (sendButtons.length === 0) {
      // Nothing verified for this channel — don't offer a dead send button.
      const go = await vscode.window.showWarningMessage(
        `No verified ${draft.channel === "teams" ? "Teams" : "Outlook"} method yet. Test one end-to-end first — a coded message you confirm.`,
        {
          modal: true,
          detail:
            draft.channel === "outlook"
              ? "The Outlook test places a coded draft in your Drafts folder (nothing is sent); confirm the code to enable it. The draft stays pending until then."
              : "The draft stays pending until a Teams method is verified.",
        },
        "Test a Method",
        "Keep Pending",
      );
      if (go === "Test a Method") await vscode.commands.executeCommand("aiSharePoint.testCommsMethod");
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      `Approve this ${draft.channel === "teams" ? "Teams message" : "email"}?`,
      {
        modal: true,
        detail:
          `To: ${draft.to.join(", ")}${draft.subject ? `\nSubject: ${draft.subject}` : ""}\n\nIt is sent from YOUR account${draft.origin === "agent" ? " (content was prepared by the assistant — review it)" : ""}. The full text is open in the editor behind this dialog.` +
          (draft.channel === "teams"
            ? webhooks.length > 0
              ? `\n\n“Post to …” delivers to a Teams CHANNEL via webhook (recipients are listed in the card, not messaged directly). ${graphVerified ? "“Send via Teams (Graph)” messages recipients directly." : ""}`
              : ``
            : ""),
      },
      ...sendButtons,
      "Discard Draft",
    );
    if (!choice) return; // stays pending
    if (choice === "Discard Draft") {
      await outbox.remove(draft.id);
      telemetry.record("comms.discard", { channel: draft.channel, origin: draft.origin });
      return;
    }
    // Webhook delivery: no Graph, no recipient resolution — post the card.
    if (choice.startsWith(WEBHOOK_PREFIX)) {
      const hook = webhooks.find((w) => `${WEBHOOK_PREFIX}${w.name}` === choice);
      if (!hook) return;
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Posting to “${hook.name}”…` },
        () =>
          postTeamsWebhook(
            hook.url,
            buildTeamsWebhookPayload({
              body: draft!.body,
              title: draft!.subject,
              to: draft!.to,
              origin: draft!.origin,
            }),
          ),
      );
      await outbox.remove(draft.id);
      telemetry.record("comms.send", { channel: "teams", origin: draft.origin, via: "webhook" });
      void vscode.window.showInformationMessage(`Posted to the “${hook.name}” Teams channel.`);
      return;
    }
    const maybeCommsClient = await commsClientFor();
    if (!maybeCommsClient) return;
    // Explicit annotation: narrowing doesn't flow into the nested function.
    const commsClient: CommsClient = maybeCommsClient;

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
          try {
            await commsClient.sendMailDraft(created.id);
          } catch (sendErr) {
            // The draft now exists server-side but was not sent. Delete it so a
            // retry doesn't pile up orphaned drafts in the user's mailbox, then
            // re-throw (the local outbox item is preserved for the retry).
            // Best-effort: if the send actually went through and only the
            // response was lost, the id is no longer a draft and this no-ops.
            await commsClient.deleteMailDraft(created.id).catch(() => undefined);
            throw sendErr;
          }
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

  // --- Lessons learned (ADR-0041): review / export / clear -----------------
  register("aiSharePoint.reviewLessons", async () => {
    const all = lessons.list();
    if (all.length === 0) {
      const enableLabel = "Enable Capture";
      const choice = await vscode.window.showInformationMessage(
        lessons.enabled()
          ? "No lessons captured yet. As you work with @sharepoint and it self-corrects, it notes anonymized, reusable lessons here that you can export for the plugin developer."
          : "Lesson capture is OFF. Turn on “aiSharePoint.lessons.capture” to let @sharepoint record anonymized, reusable interaction lessons you can later review and export.",
        ...(lessons.enabled() ? [] : [enableLabel]),
      );
      if (choice === enableLabel) {
        await vscode.workspace
          .getConfiguration("aiSharePoint")
          .update("lessons.capture", true, vscode.ConfigurationTarget.Global);
        void vscode.window.showInformationMessage(
          "Lesson capture enabled. @sharepoint will note anonymized lessons as it learns; review them here anytime.",
        );
      }
      return;
    }
    const ex = buildLessonsExport(all, {
      generatedAt: nowIso(),
      anonymousInstallId: installIds.get().id,
      extensionVersion: EXTENSION_VERSION,
    });
    const doc = await vscode.workspace.openTextDocument({
      content: lessonsToMarkdown(ex),
      language: "markdown",
    });
    await vscode.window.showTextDocument(doc, { preview: true });
    const choice = await vscode.window.showInformationMessage(
      `${all.length} anonymized lesson(s) captured. Nothing is transmitted — review here, then export a file to share with the developer.`,
      "Export…",
      "Remove Entries…",
      "Clear All",
    );
    if (choice === "Export…") {
      await vscode.commands.executeCommand("aiSharePoint.exportLessons");
    } else if (choice === "Clear All") {
      await vscode.commands.executeCommand("aiSharePoint.clearLessons");
    } else if (choice === "Remove Entries…") {
      const picks = await vscode.window.showQuickPick(
        all.map((l) => ({
          label: l.lesson.slice(0, 80),
          description: `${l.category} · ${l.count}×`,
          detail: l.trigger.slice(0, 100),
          id: l.id,
        })),
        {
          canPickMany: true,
          ignoreFocusOut: true,
          title: "Select lessons to REMOVE from the local ledger",
          placeHolder: "Checked entries are deleted; nothing is sent anywhere.",
        },
      );
      if (picks && picks.length > 0) {
        await lessons.remove(picks.map((p) => p.id));
        void vscode.window.showInformationMessage(`Removed ${picks.length} lesson(s) from the ledger.`);
      }
    }
  });

  register("aiSharePoint.exportLessons", async () => {
    const all = lessons.list();
    if (all.length === 0) {
      void vscode.window.showInformationMessage("No lessons captured yet — nothing to export.");
      return;
    }
    const identity = installIds.get();
    const ex = buildLessonsExport(all, {
      generatedAt: nowIso(),
      anonymousInstallId: identity.id,
      extensionVersion: EXTENSION_VERSION,
    });
    const json = JSON.stringify(ex, null, 2);
    const markdown = lessonsToMarkdown(ex);

    // Defense-in-depth gate: refuse to export anything secret-shaped, exactly
    // like the diagnostics bundle.
    const findings = scanForLeaks(json, [identity.id]);
    const blockers = findings.filter((f) => f.severity === "block");
    if (blockers.length > 0) {
      log.error(`Lessons export blocked by leak scan: ${blockers.map((f) => `${f.pattern}×${f.count}`).join(", ")}`);
      void vscode.window.showErrorMessage(
        `Lessons export blocked: the safety scan found ${blockers.length} pattern(s) that look like sensitive data (${blockers.map((f) => f.pattern).join(", ")}). Nothing was written.`,
      );
      return;
    }

    const previewDoc = await vscode.workspace.openTextDocument({ content: markdown, language: "markdown" });
    await vscode.window.showTextDocument(previewDoc, { preview: true });
    const warnNote =
      findings.length > 0
        ? ` Review note: ${findings.map((f) => `${f.count}× ${f.pattern}`).join(", ")} present (non-secret patterns, listed for transparency).`
        : "";
    const choice = await vscode.window.showInformationMessage(
      `Export ${ex.count} anonymized lesson(s)? This is the exact content that will be saved — the extension sends nothing.${warnNote}`,
      { modal: true },
      "Save File…",
      "Copy JSON to Clipboard",
    );
    if (!choice) return;
    if (choice === "Copy JSON to Clipboard") {
      await vscode.env.clipboard.writeText(json);
      telemetry.record("lessons.export", { via: "clipboard" });
      void vscode.window.showInformationMessage("Lessons JSON copied to clipboard.");
      return;
    }
    const stamp = nowIso().replace(/[-:]/g, "").slice(0, 13);
    const defaultUri = vscode.Uri.file(path.join(os.homedir(), `ai-sharepoint-lessons-${stamp}.json`));
    const target = await vscode.window.showSaveDialog({
      defaultUri,
      filters: { "Lessons (JSON)": ["json"] },
      title: "Save lessons file",
    });
    if (!target) return;
    await vscode.workspace.fs.writeFile(target, Buffer.from(json, "utf8"));
    const mdUri = target.with({ path: target.path.replace(/\.json$/i, "") + ".md" });
    await vscode.workspace.fs.writeFile(mdUri, Buffer.from(markdown, "utf8"));
    telemetry.record("lessons.export", { via: "file" });
    log.info(`Lessons exported (${ex.count}).`);
    const action = await vscode.window.showInformationMessage(
      "Lessons saved (JSON + Markdown). Share it with the plugin developer — e.g. attach it to a GitHub issue.",
      "Reveal in File Manager",
      "Copy Path",
    );
    if (action === "Reveal in File Manager") {
      await vscode.commands.executeCommand("revealFileInOS", target);
    } else if (action === "Copy Path") {
      await vscode.env.clipboard.writeText(target.fsPath);
    }
  });

  register("aiSharePoint.clearLessons", async () => {
    if (lessons.count() === 0) {
      void vscode.window.showInformationMessage("No lessons to clear.");
      return;
    }
    const ok = await vscode.window.showWarningMessage(
      `Delete all ${lessons.count()} captured lesson(s)? This can't be undone.`,
      { modal: true },
      "Delete All",
    );
    if (ok === "Delete All") {
      await lessons.clear();
      void vscode.window.showInformationMessage("Cleared all captured lessons.");
    }
  });

  // #4 — view/edit the words-to-avoid "memory" (corporate-proxy false positives).
  register("aiSharePoint.manageProxyTerms", async () => {
    for (;;) {
      const learned = blockedTerms.learned();
      const fromSettings = blockedTerms.configTerms().filter((t) => !learned.some((l) => l.toLowerCase() === t.toLowerCase()));
      const items: vscode.QuickPickItem[] = [
        { label: "$(add) Add word(s)…", alwaysShow: true },
        ...(learned.length > 0 ? [{ label: "Learned (click to remove)", kind: vscode.QuickPickItemKind.Separator } as vscode.QuickPickItem] : []),
        ...learned.map((t) => ({ label: t, description: "$(trash) remove" })),
        ...(fromSettings.length > 0 ? [{ label: "From settings (read-only)", kind: vscode.QuickPickItemKind.Separator } as vscode.QuickPickItem] : []),
        ...fromSettings.map((t) => ({ label: t, description: "aiSharePoint.proxy.blockedTerms" })),
      ];
      const pick = await vscode.window.showQuickPick(items, {
        title: `Proxy avoid-list — mode: ${blockedTerms.mode()} (${blockedTerms.terms().length} word(s))`,
        placeHolder: "Words a corporate proxy may block; defang mode auto-adjusts outgoing messages. Esc to close.",
      });
      if (!pick || pick.kind === vscode.QuickPickItemKind.Separator) return;
      if (pick.label.startsWith("$(add)")) {
        const input = await vscode.window.showInputBox({
          title: "Add word(s) to the proxy avoid-list",
          prompt: "Comma-separated words/phrases the proxy tends to block.",
          ignoreFocusOut: true,
        });
        if (input) {
          const added = await blockedTerms.add(...input.split(",").map((s) => s.trim()).filter(Boolean));
          void vscode.window.showInformationMessage(
            added.length > 0 ? `Added: ${added.join(", ")}.` : "Nothing added (already on the list).",
          );
        }
        continue;
      }
      if (learned.some((l) => l.toLowerCase() === pick.label.toLowerCase())) {
        await blockedTerms.remove(pick.label);
        void vscode.window.showInformationMessage(`Removed "${pick.label}" from the avoid-list.`);
        continue;
      }
      void vscode.window.showInformationMessage(`"${pick.label}" comes from settings — edit aiSharePoint.proxy.blockedTerms to change it.`);
    }
  });

  // #2 — review/curate the active project's AI-managed memory item by item
  // (today the edit flow only lets you wipe the whole blob).
  register("aiSharePoint.manageProjectMemory", async () => {
    const active = projects.active();
    if (!active) {
      void vscode.window.showInformationMessage(
        "No active project. Activate one in the Projects view to manage its AI-managed memory.",
      );
      return;
    }
    for (;;) {
      const notes = projects.aiNotes(active.id);
      const items: vscode.QuickPickItem[] = [
        { label: "$(add) Add a learning…", alwaysShow: true },
        ...(notes.length > 0
          ? [
              { label: "Saved learnings (click to remove)", kind: vscode.QuickPickItemKind.Separator } as vscode.QuickPickItem,
              ...notes.map((n) => ({ label: n, description: "$(trash) remove" })),
            ]
          : [{ label: "_No learnings saved yet._", kind: vscode.QuickPickItemKind.Separator } as vscode.QuickPickItem]),
      ];
      const pick = await vscode.window.showQuickPick(items, {
        title: `Project memory — ${active.name} (${notes.length} learning${notes.length === 1 ? "" : "s"})`,
        placeHolder: "AI-managed learnings, separate from your goals/instructions. Esc to close.",
      });
      if (!pick || pick.kind === vscode.QuickPickItemKind.Separator) return;
      if (pick.label.startsWith("$(add)")) {
        const input = await vscode.window.showInputBox({
          title: `Add a learning to "${active.name}" memory`,
          prompt: "One concise, durable learning (dedup-aware — near-duplicates are merged).",
          ignoreFocusOut: true,
        });
        if (input?.trim()) {
          const r = await projects.rememberAiContext(active.id, input.trim());
          void vscode.window.showInformationMessage(
            r?.status === "reinforced" ? "Reinforced an existing learning (no duplicate)." : "Learning saved to project memory.",
          );
        }
        continue;
      }
      const removed = await projects.forgetAiContext(active.id, pick.label);
      if (removed.length > 0) {
        const label = pick.label.length > 60 ? `${pick.label.slice(0, 60)}…` : pick.label;
        void vscode.window.showInformationMessage(`Removed "${label}" from project memory.`);
      }
    }
  });

  // #3 — show what @sharepoint has learned about each model's usable context.
  register("aiSharePoint.showModelLimits", async () => {
    const rows = modelLimits.list();
    if (rows.length === 0) {
      void vscode.window.showInformationMessage(
        "No model context limits learned yet — they're recorded automatically as you chat.",
      );
      return;
    }
    const lines = rows
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((r) => {
        const parts = [
          r.advertised ? `advertised ${r.advertised.toLocaleString()}` : undefined,
          r.effectiveCap ? `learned cap ${r.effectiveCap.toLocaleString()}` : undefined,
          r.knownGood ? `known-good ${r.knownGood.toLocaleString()}` : undefined,
        ].filter(Boolean);
        return `- **${r.key}** — ${parts.join(", ") || "no data"} _(input tokens)_`;
      });
    const doc = await vscode.workspace.openTextDocument({
      language: "markdown",
      content: `# Learned model context limits (#3)\n\n${lines.join(
        "\n",
      )}\n\n_“Learned cap” is recorded when a prompt overflows a model; “known-good” is the largest prompt that has succeeded. Prompts are budgeted to stay under the effective ceiling, trimming the lowest-value sections first._\n`,
    });
    await vscode.window.showTextDocument(doc, { preview: true });
  });

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
      telemetryEnv.installId = fresh.id; // keep external telemetry on the new id immediately
      telemetry.record("diagnostics.rotateId");
      void vscode.window.showInformationMessage(
        `New anonymous install ID: ${fresh.id}`,
      );
    }
  });

  register("aiSharePoint.copySupportInfo", async () => {
    // One-click support header for a ticket: version + environment + the
    // anonymous install id (the same id that tags diagnostics bundles, so
    // support can correlate). No site/account/PII — safe to paste anywhere.
    const info = [
      `AI SharePoint v${version}`,
      `Install ID: ${installIds.get().id}`,
      `VS Code: ${vscode.version}`,
      `OS: ${os.platform()} ${os.release()} (${os.arch()})`,
    ].join("\n");
    await vscode.env.clipboard.writeText(info);
    void vscode.window.showInformationMessage("Support info copied to the clipboard (version + environment + anonymous install ID — no PII).");
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

  register("aiSharePoint.manageTelemetry", async () => {
    // Connection details (incl. tokens) are stored in the OS keychain and never
    // shown again: secret fields are write-only and the menu only reports
    // set/not-set, never a saved value.
    for (;;) {
      const stored = await telemetryConfigStore.load();
      const cur: StoredTelemetryConfig = stored ?? { enabled: false };
      const st = telemetryStatus(stored);
      const items: Array<vscode.QuickPickItem & { action: string }> = [
        {
          label: st.enabled ? "$(check) Telemetry enabled" : "$(circle-slash) Telemetry disabled",
          description: st.active ? "actively sending" : st.enabled ? "enabled — configure an endpoint" : "click to enable",
          action: "toggle",
        },
        { label: "$(server) Splunk HEC URL", description: st.splunkUrl ?? "not set", action: "splunkUrl" },
        { label: "$(key) Splunk HEC token", description: st.splunkTokenSet ? "•••••• set" : "not set", action: "splunkToken" },
        { label: "$(dashboard) OTEL OTLP endpoint", description: st.otlpEndpoint ?? "not set", action: "otlpEndpoint" },
        { label: "$(key) OTEL auth header", description: st.otlpHeaderSet ? `•••••• set (${cur.otlpHeaderName})` : "not set", action: "otlpHeader" },
        { label: "$(beaker) Send a test event now", action: "test" },
        { label: "$(trash) Clear all telemetry settings", action: "clear" },
        { label: "$(close) Done", action: "done" },
      ];
      const pick = await vscode.window.showQuickPick(items, {
        ignoreFocusOut: true,
        title: "Usage Telemetry (Splunk / OTEL) — anonymized, opt-in",
        placeHolder: "Stored in your OS keychain — never shown again, never in settings or a diagnostics export.",
      });
      if (!pick || pick.action === "done") return;

      if (pick.action === "toggle") {
        await telemetryConfigStore.save({ ...cur, enabled: !cur.enabled });
      } else if (pick.action === "splunkUrl") {
        const v = await vscode.window.showInputBox({
          ignoreFocusOut: true,
          title: "Splunk HEC URL (blank to clear)",
          value: cur.splunkHecUrl ?? "",
          placeHolder: "https://splunk.corp.example:8088/services/collector/event",
        });
        if (v === undefined) continue;
        await telemetryConfigStore.save({ ...cur, splunkHecUrl: v.trim() || undefined });
      } else if (pick.action === "splunkToken") {
        const v = await vscode.window.showInputBox({
          ignoreFocusOut: true,
          password: true,
          title: "Splunk HEC token (write-only — never shown again)",
          placeHolder: cur.splunkHecToken ? "type to replace; leave blank to keep the current token" : "paste the HEC token",
        });
        if (v === undefined) continue;
        if (v.trim()) await telemetryConfigStore.save({ ...cur, splunkHecToken: v.trim() });
      } else if (pick.action === "otlpEndpoint") {
        const v = await vscode.window.showInputBox({
          ignoreFocusOut: true,
          title: "OTEL OTLP/HTTP endpoint (blank to clear)",
          value: cur.otlpEndpoint ?? "",
          placeHolder: "https://otel-collector.corp.example:4318",
        });
        if (v === undefined) continue;
        await telemetryConfigStore.save({ ...cur, otlpEndpoint: v.trim() || undefined });
      } else if (pick.action === "otlpHeader") {
        const name = await vscode.window.showInputBox({
          ignoreFocusOut: true,
          title: "OTLP auth header NAME (blank to clear the header)",
          value: cur.otlpHeaderName ?? "",
          placeHolder: "X-Api-Key",
        });
        if (name === undefined) continue;
        if (!name.trim()) {
          await telemetryConfigStore.save({ ...cur, otlpHeaderName: undefined, otlpHeaderValue: undefined });
        } else {
          const val = await vscode.window.showInputBox({
            ignoreFocusOut: true,
            password: true,
            title: `OTLP auth header VALUE for "${name.trim()}" (write-only)`,
            placeHolder: cur.otlpHeaderValue ? "type to replace; leave blank to keep the current value" : "paste the header value",
          });
          if (val === undefined) continue;
          await telemetryConfigStore.save({
            ...cur,
            otlpHeaderName: name.trim(),
            ...(val.trim() ? { otlpHeaderValue: val.trim() } : {}),
          });
        }
      } else if (pick.action === "test") {
        await refreshTelemetry();
        if (!telemetryConfig) {
          void vscode.window.showWarningMessage("Telemetry isn't active yet — enable it and configure a Splunk and/or OTEL endpoint first.");
          continue;
        }
        telemetry.record("telemetry.test", {});
        externalTelemetry.flush();
        void vscode.window.showInformationMessage("Sent a test telemetry event (opportunistic — verify it arrived in your Splunk / OTEL platform).");
        continue;
      } else if (pick.action === "clear") {
        const ok = await vscode.window.showWarningMessage(
          "Clear all telemetry connection settings, including the saved token?",
          { modal: true },
          "Clear",
        );
        if (ok !== "Clear") continue;
        await telemetryConfigStore.clear();
      }
      await refreshTelemetry();
      supportProvider.refresh();
    }
  });

  register("aiSharePoint.rebrandExtension", async () => {
    // Offer the user's current reference sources + projects as bake-in defaults
    // (non-secret descriptors only — credentials are never captured).
    await runRebrandFlow(log, {
      currentConnectors: contextSources
        .list()
        .filter((s) => s.role !== "managed")
        .map((s) => ({
          type: s.type,
          displayName: s.displayName,
          ...(s.alias ? { alias: s.alias } : {}),
          ...(s.description ? { description: s.description } : {}),
          baseUrl: s.baseUrl,
          deployment: s.deployment,
          authMethod: s.authMethod,
        })),
      currentProjects: projects.list().map((p) => ({
        name: p.name,
        ...(p.description ? { description: p.description } : {}),
        ...(p.goals ? { goals: p.goals } : {}),
        ...(p.instructions ? { instructions: p.instructions } : {}),
        ...(p.aiContext ? { aiContext: p.aiContext } : {}),
      })),
    });
  });

  register("aiSharePoint.openUserGuide", async () => {
    // A whitelabeled build can bake custom help for its target environment.
    const help = context.globalState.get<{ userGuide?: string }>("aiSharePoint.provisionedHelp");
    if (help?.userGuide) {
      const doc = await vscode.workspace.openTextDocument({ language: "markdown", content: help.userGuide });
      await vscode.window.showTextDocument(doc, { preview: true });
      return;
    }
    return openBundledDoc(context, "USER_GUIDE.md");
  });
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
  if (type === "github") {
    // All GitHub REST auth methods reduce to a Bearer token; they differ only in
    // how the token is obtained. github.com (cloud) and GHES (datacenter) both
    // support all three. Everything is stored in the OS keychain — none of this
    // ever touches the git credential manager.
    const isGhes = deployment === "datacenter";
    const origin = (() => {
      try {
        return new URL(baseUrl ?? "https://github.com").origin;
      } catch {
        return "https://github.com";
      }
    })();
    const providerId = isGhes ? "github-enterprise" : "github";
    const pick = await vscode.window.showQuickPick(
      [
        {
          label: "$(github) Sign in with GitHub (OAuth)",
          description: isGhes
            ? "browser sign-in via the GitHub Enterprise auth provider — no token to create"
            : "browser sign-in — no token to create (recommended)",
          value: "oauth" as const,
        },
        {
          label: "$(key) Personal access token",
          description: "classic or fine-grained, read-only — works on Cloud and Enterprise Server",
          value: "pat" as const,
        },
        {
          label: "$(server) GitHub App installation",
          description: "App ID + installation ID + private key — centrally managed, auto-rotating",
          value: "app" as const,
        },
      ],
      { ignoreFocusOut: true, title: "GitHub sign-in" },
    );
    if (!pick) return undefined;

    if (pick.value === "pat") {
      const secret = await vscode.window.showInputBox({
        ignoreFocusOut: true,
        title: "GitHub personal access token (read-only)",
        password: true,
        placeHolder: "github_pat_…  or  ghp_…",
        prompt: `Create a READ-ONLY token at ${origin}/settings/tokens (Settings → Developer settings → Personal access tokens). Fine-grained: Contents, Issues, Metadata = Read-only. Classic: the read-only "repo" scope. Stored only in your OS keychain; verified with a single read (lockout-safe).`,
      });
      if (!secret?.trim()) return undefined;
      return { method: "pat", secret: secret.trim() };
    }

    if (pick.value === "oauth") {
      const scopes = ["repo", "read:org"]; // GitHub OAuth scopes are coarse; the connector only ever reads.
      if (isGhes && baseUrl) {
        // VS Code's built-in GitHub Authentication extension serves the
        // "github-enterprise" provider only when this setting points at the
        // instance. Set it (global) if unset so sign-in can succeed.
        const cfg = vscode.workspace.getConfiguration();
        if (!cfg.get<string>("github-enterprise.uri")) {
          await cfg.update("github-enterprise.uri", origin, vscode.ConfigurationTarget.Global);
        }
      }
      try {
        const session = await vscode.authentication.getSession(providerId, scopes, { createIfNone: true });
        if (!session) return undefined;
      } catch (e) {
        void vscode.window.showErrorMessage(
          `GitHub sign-in failed: ${e instanceof Error ? e.message : String(e)}.${
            isGhes
              ? " For GitHub Enterprise Server, confirm the built-in GitHub Authentication supports your instance (the github-enterprise.uri setting)."
              : ""
          } You can use a personal access token instead.`,
        );
        return undefined;
      }
      return { method: "github-oauth", secret: JSON.stringify({ providerId, scopes }) };
    }

    // GitHub App installation.
    const appId = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      title: "GitHub App — App ID",
      placeHolder: "123456",
      prompt: `From your App's settings page (${origin}/settings/apps → your app → About).`,
      validateInput: (v) => (/^\d+$/.test(v.trim()) ? undefined : "The App ID is numeric."),
    });
    if (!appId) return undefined;
    const installationId = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      title: "GitHub App — Installation ID",
      placeHolder: "12345678",
      prompt: "Install the App on your org/repos, then read the number from the install URL (…/installations/<id>).",
      validateInput: (v) => (/^\d+$/.test(v.trim()) ? undefined : "The Installation ID is numeric."),
    });
    if (!installationId) return undefined;
    const keyUri = await vscode.window.showOpenDialog({
      title: "Select the GitHub App private key (.pem)",
      canSelectMany: false,
      filters: { "PEM private key": ["pem"] },
    });
    if (!keyUri || !keyUri[0]) return undefined;
    let privateKey: string;
    try {
      privateKey = Buffer.from(await vscode.workspace.fs.readFile(keyUri[0])).toString("utf8");
    } catch (e) {
      void vscode.window.showErrorMessage(`Could not read the private key file: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }
    if (!/BEGIN [A-Z ]*PRIVATE KEY/.test(privateKey)) {
      void vscode.window.showErrorMessage("That file doesn't look like a PEM private key (expected a -----BEGIN … PRIVATE KEY----- block).");
      return undefined;
    }
    return {
      method: "github-app",
      secret: JSON.stringify({ appId: appId.trim(), installationId: installationId.trim(), privateKey: privateKey.trim() }),
    };
  }
  if (type === "splunk") {
    // Splunk Web URL to open for SSO: the ?web= param if present, else the
    // typed browser URL, else the mgmt host on the default web port 8000.
    const splunkWebUrl = (() => {
      if (!baseUrl) return undefined;
      try {
        const u = new URL(baseUrl);
        const web = u.searchParams.get("web");
        if (web) return web;
        if (u.port === "8089") return `${u.protocol}//${u.hostname}:8000`;
        return `${u.protocol}//${u.host}`;
      } catch {
        return undefined;
      }
    })();
    const mode = await vscode.window.showQuickPick(
      [
        {
          label: "$(globe) Browser SSO session (recommended for SAML/SSO)",
          description: "sign in to Splunk Web in your browser; no token or password needed",
          value: "session" as const,
        },
        {
          label: "$(shield) Authentication token",
          description: "Splunk Web → Settings → Tokens — if you're allowed to create one",
          value: "pat" as const,
        },
        {
          label: "$(key) Username + password",
          description: "a least-privilege search-only account",
          value: "basic" as const,
        },
      ],
      { ignoreFocusOut: true, title: "Splunk sign-in" },
    );
    if (!mode) return undefined;
    if (mode.value === "session") {
      const cookieHelp = [
        "# Splunk session cookie — how to find it",
        "",
        "After signing in to Splunk Web with your SSO, copy the **value** of the cookie named",
        "**`splunkd_<port>`** — commonly **`splunkd_8000`** (this is exactly what worked in Edge",
        "for the pilot). It is your live session key; the value is a long opaque string.",
        "",
        "## Microsoft Edge / Google Chrome (Chromium)",
        "1. Press **F12** to open DevTools (or the **⋯** menu → *More tools → Developer tools*).",
        "2. Open the **Application** tab.",
        "3. Left sidebar: **Storage → Cookies →** click your Splunk host.",
        "4. Find the row named **`splunkd_<port>`** (e.g. `splunkd_8000`) and copy its **Value** cell.",
        "",
        "## Mozilla Firefox",
        "1. Press **F12**, then open the **Storage** tab (enable it via the DevTools **⋯** menu if hidden).",
        "2. **Cookies →** your Splunk host.",
        "3. Copy the **Value** of **`splunkd_<port>`**.",
        "",
        "## Safari",
        "1. **Safari → Settings → Advanced →** tick **“Show features for web developers”**.",
        "2. **Develop → Show Web Inspector → Storage** tab → **Cookies**.",
        "3. Copy the **Value** of **`splunkd_<port>`**.",
        "",
        "_Copy the value only — not the cookie name — then paste it back into VS Code._",
      ].join("\n");

      for (;;) {
        const choice = await vscode.window.showInformationMessage(
          splunkWebUrl
            ? `Sign in to Splunk Web (${splunkWebUrl}) with your SSO, then capture the splunkd_<port> session cookie (e.g. splunkd_8000).`
            : "Sign in to Splunk Web with your SSO, then capture the splunkd_<port> session cookie (e.g. splunkd_8000).",
          ...(splunkWebUrl ? ["Open Splunk Web"] : []),
          "How to find the cookie",
          "I have the cookie",
        );
        if (!choice) return undefined;
        if (choice === "Open Splunk Web" && splunkWebUrl) {
          await vscode.env.openExternal(vscode.Uri.parse(splunkWebUrl));
          continue;
        }
        if (choice === "How to find the cookie") {
          const doc = await vscode.workspace.openTextDocument({ language: "markdown", content: cookieHelp });
          await vscode.window.showTextDocument(doc, { preview: true });
          continue;
        }
        break; // "I have the cookie"
      }
      const secret = await vscode.window.showInputBox({
        ignoreFocusOut: true,
        title: "Splunk session key — the splunkd_<port> cookie value",
        password: true,
        placeHolder: "value of splunkd_8000 (Edge/Chrome: F12 → Application → Cookies)",
        prompt:
          "Edge/Chrome: F12 → Application → Storage → Cookies → your Splunk host → copy the Value of splunkd_<port> (e.g. splunkd_8000). Firefox: F12 → Storage → Cookies. Safari: enable the Develop menu → Web Inspector → Storage → Cookies. Use “How to find the cookie” above for full steps. Stored only in your OS keychain, verified once (lockout-safe); re-capture via Test Context Source when your Splunk session expires.",
      });
      if (!secret) return undefined;
      return { method: "splunk-session", secret: secret.trim() };
    }
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
                label: "$(globe) Browser session (SSO — recommended, no admin setup)",
                description: "sign in to ServiceNow in your browser, then paste your session cookies",
                value: "session" as const,
              },
            ]
          : []),
        ...(baseUrl && snowClientId
          ? [
              {
                label: "$(key) Browser OAuth sign-in",
                description: "needs an admin-created OAuth client (aiSharePoint.servicenow.oauthClientId)",
                value: "browser" as const,
              },
            ]
          : []),
        {
          label: "$(account) Basic — integration user + password",
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
    if (mode.value === "session") {
      const origin = (() => {
        try {
          return new URL(baseUrl!).origin;
        } catch {
          return baseUrl!;
        }
      })();
      const open = await vscode.window.showInformationMessage(
        `Sign in to ServiceNow (${origin}) with your SSO in the browser, then return here to capture the session.`,
        "Open ServiceNow",
        "I'm already signed in",
      );
      if (!open) return undefined;
      if (open === "Open ServiceNow") {
        await vscode.env.openExternal(vscode.Uri.parse(origin));
      }
      const secret = await vscode.window.showInputBox({
        ignoreFocusOut: true,
        title: "ServiceNow session cookies (from your signed-in browser)",
        password: true,
        placeHolder: "JSESSIONID=…; glide_user_route=…; BIGipServer…=…",
        prompt:
          "In the tab where you're signed in to ServiceNow: DevTools → Network → any request → the **Cookie request header**. RAW or parsed both work: right-click the header → Copy value, OR toggle the Raw view and copy the whole `Cookie: …` line — the wizard normalizes either (plus the Application/Storage cookies table rows and Firefox's Copy-All JSON). Read-only access only. Stored solely in your OS keychain, verified once (lockout-safe). Re-capture any time via Test Context Source.",
        validateInput: (v) => cookieStringIssue(v),
      });
      if (!secret) return undefined;
      const cleaned = cleanCookieString(secret);
      // Names-only capture diagnostic (values never shown): the immediate
      // tell when a paste lost the session cookies (pilot: "full set of
      // cookies" pastes arrived as DevTools table rows and failed opaquely).
      const names = cookieNames(cleaned);
      void vscode.window.showInformationMessage(
        `Captured ${names.length} session cookie(s): ${names.slice(0, 8).join(", ")}${names.length > 8 ? ", …" : ""}${names.some((n) => n.toUpperCase() === "JSESSIONID") ? "" : " — note: no JSESSIONID found; if verification fails, copy the Cookie header from the Network tab instead"}.`,
      );
      // Optional page CSRF token: some instances refuse cookie-authenticated
      // /api/now calls without X-UserToken — no cookie capture can fix that
      // (pilot: complete fresh cookies from two browsers still rejected).
      const userToken = await vscode.window.showInputBox({
        ignoreFocusOut: true,
        password: true,
        title: "Optional — X-UserToken (g_ck), if your instance requires it (Enter to skip)",
        placeHolder: "Enter to skip — needed only when complete cookies still get “User Not Authenticated”",
        prompt:
          "Some instances require the page CSRF token for API calls even with valid session cookies. In the SAME signed-in tab: DevTools → **Console** → type `g_ck` → Enter → copy the printed value (no quotes). It rotates with the session and is re-captured the same way.",
        validateInput: (v) => userTokenIssue(v),
      });
      if (userToken === undefined) return undefined;
      return {
        method: "snow-session",
        secret: buildSnowSessionSecret(cleaned, userToken.trim().replace(/^["']|["']$/g, "")),
      };
    }
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
  if (type === "splunkobs") {
    const secret = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      title: "Splunk Observability Cloud access token",
      password: true,
      placeHolder: "org access token with API authentication scope",
      prompt:
        "Splunk Observability → Settings → Access Tokens (API scope). Sent as X-SF-TOKEN; stored only in your OS keychain; verified with a single read (lockout-safe).",
    });
    if (!secret) return undefined;
    return { method: "sfx-token", secret: secret.trim() };
  }
  if (type === "grafana") {
    const mode = await vscode.window.showQuickPick(
      [
        {
          label: "$(shield) Service account token (recommended)",
          description: "Administration → Service accounts → Add token (Viewer role is enough)",
          value: "pat" as const,
        },
        {
          label: "$(key) Username + password",
          description: "self-hosted basic auth — a least-privilege Viewer account",
          value: "basic" as const,
        },
      ],
      { ignoreFocusOut: true, title: "Grafana sign-in" },
    );
    if (!mode) return undefined;
    if (mode.value === "pat") {
      const secret = await vscode.window.showInputBox({
        ignoreFocusOut: true,
        title: "Grafana service account token",
        password: true,
        placeHolder: "glsa_…",
        prompt:
          "Administration → Service accounts → Add service account (Viewer) → Add token. Stored only in your OS keychain; verified with a single read (lockout-safe).",
      });
      if (!secret) return undefined;
      return { method: "pat", secret: secret.trim() };
    }
    const username = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      title: "Grafana user",
      placeHolder: "viewer.readonly",
      prompt: "Use a least-privilege Viewer account where available.",
    });
    if (!username) return undefined;
    const secret = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      title: "Grafana password",
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
      prompt:
        "From `gcloud auth print-access-token` — or, with NO gcloud/GCP access (Entra/Azure AD SSO users): on your corporate search page press F12 → Network → run a search → click the search request → Request Headers → copy the `Authorization: Bearer …` value WITHOUT the word Bearer. It's your own session's token (~1 h; re-paste via Test Context Source). Stored only in your OS keychain.",
      validateInput: (v) => (v.trim().replace(/^bearer\s+/i, "") ? undefined : "Paste the token value"),
    });
    if (!secret) return undefined;
    return { method: "pat", secret: secret.trim().replace(/^bearer\s+/i, "") };
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
