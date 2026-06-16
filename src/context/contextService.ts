import * as vscode from "vscode";
import { ContextSourcesStore } from "./sourcesStore";
import { TtlCache } from "./cache";
import {
  ContextSource,
  ContextCredential,
  ContextSearchHit,
  ContextItem,
  ReadCaps,
  DEFAULT_CAPS,
} from "./types";
import { verifyConfluence, searchConfluence, getConfluencePage } from "./adapters/confluence";
import { verifyJira, searchJira, getJiraIssue } from "./adapters/jira";
import { verifyLdap, searchLdap, getLdapEntry, LdapTlsOptions } from "./ldap/ldapClient";
import { listConfluenceSpaces, listAllConfluenceSpaces } from "./adapters/confluence";
import {
  listJiraProjects,
  listJiraFavouriteFilters,
  listJsmQueues,
  listAllJiraProjects,
  listAllJsmQueues,
} from "./adapters/jira";
import { CatalogEntry, LoadCheckpoint } from "./catalogCache";
import { ContextBookmark } from "./types";
import { verifyDb, searchDb, searchDbRaw, browseDb, describeDb, sampleTableValues, probeJoinRate, estimateRowCounts, DbTlsOptions } from "./db/dbAdapters";
import { JoinProbeEnd, JoinProbeCounts, RowEstimates } from "./db/erDiagram";
import { verifyVertex, searchVertex, answerVertex, VertexAnswer } from "./adapters/vertexSearch";
import {
  verifyPowerBi,
  searchPowerBi,
  browsePowerBi,
  getAzPowerBiToken,
  PowerBiTokenGetter,
  POWERBI_SCOPES,
} from "./adapters/powerbi";
import {
  verifyM365Copilot,
  searchM365Copilot,
  GraphTokenGetter,
  scopesForSource,
} from "./adapters/m365copilot";
import {
  createConfluencePage,
  updateConfluencePage,
  getConfluencePageMeta,
  addConfluenceLabels,
  removeConfluenceLabel,
  ConfluenceWriteResult,
} from "./adapters/confluenceWrite";
import {
  getConfluencePageLabels,
  getConfluencePageContributors,
  getConfluenceSpaceContributors,
  resolveOwners,
  OwnerResolution,
} from "./adapters/confluenceOwnership";
import {
  archiveConfluencePage as archiveConfluencePageAdapter,
  removeConfluencePageFromSearch as removeConfluencePageFromSearchAdapter,
  moveConfluencePage as moveConfluencePageAdapter,
  MovePosition,
  ArchiveResult,
} from "./adapters/confluenceArchive";
import {
  reviewSpaceManageability,
  getCurrentConfluenceUser,
  prepareAccessRequestNote,
  ManageabilityReport,
} from "./adapters/confluenceEntitlements";
import { reviewPageCurrency, CurrencyReport } from "./adapters/confluenceCurrency";
import {
  getPageAncestors,
  getChildPages,
  getDescendantPages,
  getSpaceRootPages,
  getPageHierarchy,
  buildPageTree,
  HierarchyResult,
} from "./adapters/confluenceHierarchy";
import { checkWriteScope, describeWriteScope } from "./adapters/confluenceScope";
import {
  probeConfluenceWriteAccess,
  probeConfluenceFunctionality,
  WriteProbeResult,
  WriteProbeTarget,
  FunctionalityProbeResult,
} from "./adapters/confluenceProbe";
import {
  discoverConfluenceMacros,
  detectConfluenceApps,
  validateConfluencePageRendered,
  MACRO_CATALOG,
  CapabilityReport,
  RenderedValidation,
} from "./adapters/confluenceMacros";
import {
  verifyServiceNow,
  searchServiceNow,
  getServiceNowItem,
  browseServiceNowCandidates,
} from "./adapters/servicenow";
import { verifySplunk, searchSplunk, browseSplunkCandidates } from "./adapters/splunk";
import {
  verifySplunkObs,
  searchSplunkObs,
  getSplunkObsItem,
  browseSplunkObsCandidates,
} from "./adapters/splunkObservability";
import {
  verifyGrafana,
  searchGrafana,
  getGrafanaItem,
  browseGrafanaCandidates,
} from "./adapters/grafana";
import {
  snowTokensFromSecret,
  snowTokenExpired,
  refreshSnowTokens,
} from "./adapters/servicenowAuth";
import { SchemaCatalog, TableDef } from "./db/schemaIndex";
import { AppError, classifyError } from "../core/errors";

/** AAD token acquisition for sources that reuse the extension's Microsoft
 *  365 sign-in (method "aad-sso") — implemented by the extension layer,
 *  which owns the MSAL provider registry. */
export type AadTokenBroker = (
  credential: ContextCredential,
  interactive: boolean,
  scopes: string[],
) => Promise<string>;

/**
 * One façade over all adapters: lockout gating (ADR-0009) before every
 * network attempt, read-through caching (ADR-0011), caps (ADR-0012), and
 * stored-credential-only operation for background/agent reads.
 */
export class ContextService {
  constructor(
    private readonly store: ContextSourcesStore,
    private readonly cache: TtlCache,
    private readonly aadBroker?: AadTokenBroker,
  ) {}

  private powerBiTokens(credential: ContextCredential): PowerBiTokenGetter {
    // az-sso: live token from the user's `az login` session — the
    // no-admin-consent path (no MSAL broker involved). pat: pasted token.
    if (credential.method === "az-sso") {
      return () => getAzPowerBiToken();
    }
    if (credential.method === "pat") {
      return () => Promise.resolve(credential.secret);
    }
    const broker = this.aadBroker;
    if (!broker) {
      throw new AppError(
        "Power BI sources need the extension's Microsoft 365 sign-in (unavailable in this context).",
        "config",
      );
    }
    return (interactive) => broker(credential, interactive, POWERBI_SCOPES);
  }

  /** Microsoft 365 Copilot tokens: a pasted Graph token (pat) or the
   *  extension's reused Microsoft 365 sign-in (aad-sso), scoped to exactly the
   *  surfaces this source has enabled (documents, email, calendar, …). */
  private m365CopilotTokens(source: ContextSource, credential: ContextCredential): GraphTokenGetter {
    if (credential.method === "pat") {
      return () => Promise.resolve(credential.secret);
    }
    const broker = this.aadBroker;
    if (!broker) {
      throw new AppError(
        "Microsoft 365 Copilot sources need the extension's Microsoft 365 sign-in (unavailable in this context).",
        "config",
      );
    }
    const scopes = scopesForSource(source);
    return (interactive) => broker(credential, interactive, scopes);
  }

  private static powerBiAccountLabel(credential: ContextCredential): string {
    return credential.method === "az-sso"
      ? "Azure CLI SSO (Power BI)"
      : credential.method === "pat"
        ? "access token (Power BI)"
        : "Microsoft 365 (Power BI)";
  }

  /** snow-oauth credentials: refresh when near expiry (persisting the new
   *  tokens) and hand adapters an ephemeral bearer credential. */
  private async snowCredential(
    source: ContextSource,
    credential: ContextCredential,
  ): Promise<ContextCredential> {
    if (credential.method !== "snow-oauth") return credential;
    let tokens = snowTokensFromSecret(credential.secret);
    if (snowTokenExpired(tokens, Date.now())) {
      tokens = await refreshSnowTokens(source.baseUrl, tokens, Date.now());
      await this.store.setCredential(source.id, {
        method: "snow-oauth",
        secret: JSON.stringify(tokens),
      });
    }
    return { method: "pat", secret: tokens.accessToken };
  }

  caps(): ReadCaps {
    const cfg = vscode.workspace.getConfiguration("aiSharePoint");
    return {
      ...DEFAULT_CAPS,
      maxResults: Math.max(1, cfg.get<number>("context.maxResults", DEFAULT_CAPS.maxResults)),
    };
  }

  private ttlMs(): number {
    return (
      Math.max(0, vscode.workspace.getConfiguration("aiSharePoint").get<number>("context.cacheTtlMinutes", 15)) * 60_000
    );
  }

  private dbTls(): DbTlsOptions {
    const cfg = vscode.workspace.getConfiguration("aiSharePoint");
    return { caBundlePath: cfg.get<string>("ldap.caCertificatesFile", "").trim() || undefined };
  }

  private static readonly DB_TYPES = new Set(["mssql", "postgres", "mysql", "mongodb"]);

  private ldapTls(): LdapTlsOptions {
    const cfg = vscode.workspace.getConfiguration("aiSharePoint");
    return {
      rejectUnauthorized: cfg.get<boolean>("ldap.tlsRejectUnauthorized", true),
      useStartTls: cfg.get<boolean>("ldap.useStartTls", false),
      caBundlePath: cfg.get<string>("ldap.caCertificatesFile", "").trim() || undefined,
    };
  }

  private gate(source: ContextSource, fresh: boolean): void {
    const verdict = this.store.attemptAllowed(source.id, fresh);
    if (verdict.allowed) return;
    switch (verdict.reason) {
      case "circuit-open":
        throw new AppError(
          `"${source.displayName}" is locked out after repeated authentication failures (account-lockout protection, ADR-0009). Verify the credential with your administrator, then use "Reset Source Auth Lockout".`,
          "auth.failed",
          "Source locked out after repeated auth failures.",
        );
      case "credential-bad":
        throw new AppError(
          `The stored credential for "${source.displayName}" was rejected and will not be retried automatically. Run "Test Context Source" to enter a new one.`,
          "auth.failed",
          "Stored credential rejected — re-entry required.",
        );
      default:
        throw new AppError(
          `Retrying "${source.displayName}" too quickly — wait ${Math.ceil((verdict.waitMs ?? 0) / 1000)}s (backoff).`,
          "auth.failed",
          "Backoff in effect for this source.",
        );
    }
  }

  /** Run an adapter call with failure accounting. Auth failures count toward
   *  the circuit breaker; network errors never do (ADR-0009). */
  private async tracked<T>(
    source: ContextSource,
    fresh: boolean,
    run: () => Promise<T>,
  ): Promise<T> {
    this.gate(source, fresh);
    try {
      const result = await run();
      await this.store.noteSuccess(source.id);
      return result;
    } catch (err) {
      if (classifyError(err) === "auth.failed") {
        await this.store.noteAuthFailure(source.id);
      }
      throw err;
    }
  }

  /** Verify-on-connect / test (single deliberate read, ADR-0009). */
  async verify(
    source: ContextSource,
    credential: ContextCredential,
    fresh: boolean,
  ): Promise<{ account: string }> {
    const caps = this.caps();
    return this.tracked(source, fresh, () => {
      if (ContextService.DB_TYPES.has(source.type)) {
        return verifyDb(source, credential, this.dbTls(), caps);
      }
      switch (source.type) {
        case "ldap":
          return verifyLdap(source, credential, this.ldapTls(), caps);
        case "jira":
          return verifyJira(source, credential, caps);
        case "vertexai":
          return verifyVertex(source, credential, caps);
        case "powerbi":
          return verifyPowerBi(
            this.powerBiTokens(credential),
            caps,
            ContextService.powerBiAccountLabel(credential),
          );
        case "m365copilot":
          return verifyM365Copilot(source, this.m365CopilotTokens(source, credential), caps);
        case "servicenow":
          return this.snowCredential(source, credential).then((c) => verifyServiceNow(source, c, caps));
        case "splunk":
          return verifySplunk(source, credential, caps);
        case "splunkobs":
          return verifySplunkObs(source, credential, caps);
        case "grafana":
          return verifyGrafana(source, credential, caps);
        default:
          return verifyConfluence(source, credential, caps);
      }
    });
  }

  private async storedCredential(source: ContextSource): Promise<ContextCredential> {
    const credential = await this.store.getCredential(source.id);
    if (!credential) {
      throw new AppError(
        `No stored credential for "${source.displayName}" — run "Test Context Source" to supply one.`,
        "auth.failed",
        "Credential missing for this source.",
      );
    }
    return credential;
  }

  async search(
    source: ContextSource,
    query: string,
    opts?: { allowExpensive?: boolean },
  ): Promise<ContextSearchHit[]> {
    const caps = this.caps();
    return this.cache.getOrLoad(
      TtlCache.key(
        source.id,
        "search",
        `${caps.maxResults}:${opts?.allowExpensive ? "full:" : ""}${query}`,
      ),
      this.ttlMs(),
      async () => {
        const credential = await this.storedCredential(source);
        return this.tracked(source, false, () =>
          this.dispatchSearch(source, credential, query, caps, opts),
        );
      },
    );
  }

  private dispatchSearch(
    source: ContextSource,
    credential: ContextCredential,
    query: string,
    caps: ReadCaps,
    opts?: { allowExpensive?: boolean },
  ): Promise<ContextSearchHit[]> {
    if (ContextService.DB_TYPES.has(source.type)) {
      return searchDb(source, credential, query, this.dbTls(), caps, opts);
    }
    switch (source.type) {
      case "ldap":
        return searchLdap(source, credential, query, this.ldapTls(), caps);
      case "jira":
        return searchJira(source, credential, query, caps);
      case "vertexai":
        return searchVertex(source, credential, query, caps);
      case "powerbi":
        return searchPowerBi(source, this.powerBiTokens(credential), query, caps);
      case "m365copilot":
        return searchM365Copilot(source, this.m365CopilotTokens(source, credential), query, caps);
      case "servicenow":
        return this.snowCredential(source, credential).then((c) =>
          searchServiceNow(source, c, query, caps),
        );
      case "splunk":
        return searchSplunk(source, credential, query, caps);
      case "splunkobs":
        return searchSplunkObs(source, credential, query, caps);
      case "grafana":
        return searchGrafana(source, credential, query, caps);
      default:
        return searchConfluence(source, credential, query, caps);
    }
  }

  /** Export-grade search (ADR-0031): same queries, bigger bounds, RAW rows
   *  for file serialization — uncached (datasets are too big to keep, and an
   *  export should always be a fresh read). DB sources return raw rows/
   *  documents; other sources return their hits flattened to rows. */
  async searchForExport(
    source: ContextSource,
    query: string,
    exportCaps: { maxResults: number; timeoutMs: number },
  ): Promise<Array<Record<string, unknown>>> {
    const caps = { ...this.caps(), ...exportCaps };
    const credential = await this.storedCredential(source);
    return this.tracked(source, false, async () => {
      if (ContextService.DB_TYPES.has(source.type)) {
        return searchDbRaw(source, credential, query, this.dbTls(), caps);
      }
      const hits = await this.dispatchSearch(source, credential, query, caps);
      return hits.map((h) => ({
        title: h.title,
        url: h.url,
        ...(h.excerpt ? { excerpt: h.excerpt } : {}),
        ...(h.meta ?? {}),
      }));
    });
  }

  async getItem(source: ContextSource, id: string): Promise<ContextItem> {
    const caps = this.caps();
    return this.cache.getOrLoad(
      TtlCache.key(source.id, "item", id),
      this.ttlMs(),
      async () => {
        const credential = await this.storedCredential(source);
        return this.tracked(source, false, () => {
          if (ContextService.DB_TYPES.has(source.type)) {
            throw new AppError(
              "Database sources have no item fetch — use search with a read-only SELECT statement (or a MongoDB JSON spec).",
              "config",
            );
          }
          if (source.type === "vertexai") {
            throw new AppError(
              "Vertex AI Search has no item fetch — use search, or the vertex_answer tool for a grounded answer.",
              "config",
            );
          }
          if (source.type === "powerbi") {
            throw new AppError(
              'Power BI has no item fetch — use search with {"dataset": "...", "dax": "EVALUATE …"}.',
              "config",
            );
          }
          if (source.type === "splunk") {
            throw new AppError(
              "Splunk has no item fetch — use search with SPL (results carry the matching events).",
              "config",
            );
          }
          if (source.type === "m365copilot") {
            throw new AppError(
              "Microsoft 365 Copilot returns ranked grounding passages, not addressable items — use search with a natural-language query.",
              "config",
            );
          }
          switch (source.type) {
            case "servicenow":
              return this.snowCredential(source, credential).then((c) =>
                getServiceNowItem(source, c, id, caps),
              );
            case "ldap":
              return getLdapEntry(source, credential, id, this.ldapTls(), caps);
            case "jira":
              return getJiraIssue(source, credential, id, caps);
            case "splunkobs":
              return getSplunkObsItem(source, credential, id, caps);
            case "grafana":
              return getGrafanaItem(source, credential, id, caps);
            default:
              return getConfluencePage(source, credential, id, caps);
          }
        });
      },
    );
  }

  /** Create or update a Confluence page with the source's stored credential
   *  (the user's own API token — no admin OAuth consent). Lockout-gated like a
   *  read; never cached (writes are always live). The caller (the write tool)
   *  gates on explicit user approval before this runs. */
  async writeConfluencePage(
    source: ContextSource,
    op: {
      action: "create" | "update";
      spaceKey?: string;
      title: string;
      body: string;
      pageId?: string;
      parentId?: string;
    },
  ): Promise<ConfluenceWriteResult> {
    if (source.type !== "confluence") {
      throw new AppError("Page writes target a Confluence source.", "config");
    }
    const caps = this.caps();
    const credential = await this.storedCredential(source);
    const scope = source.writeScope;
    const refuse = (reason?: string): never => {
      throw new AppError(
        `This managed Confluence connector may only write within ${describeWriteScope(scope)}${reason ? ` — refused (${reason})` : ""}. Reads, ownership lookup and owner notifications across all of Confluence are unaffected.`,
        "config",
      );
    };
    return this.tracked(source, false, async () => {
      if (op.action === "update") {
        if (!op.pageId) throw new AppError("Updating a Confluence page needs its pageId.", "config");
        // For a space/page scope, resolve the target page's space BEFORE the
        // mutation so the guard runs first. This read is global (not gated by
        // the write scope) — it's just establishing where the page lives.
        let targetSpace: string | undefined;
        if (scope && scope.kind !== "instance") {
          targetSpace = (await getConfluencePageMeta(source, credential, op.pageId, caps.timeoutMs)).spaceKey;
        }
        const gate = checkWriteScope(scope, { action: "update", pageId: op.pageId, spaceKey: targetSpace });
        if (!gate.allowed) refuse(gate.reason);
        return updateConfluencePage(
          source,
          credential,
          { id: op.pageId, title: op.title, body: op.body },
          caps.timeoutMs,
        );
      }
      if (!op.spaceKey) throw new AppError("Creating a Confluence page needs a spaceKey.", "config");
      const gate = checkWriteScope(scope, { action: "create", spaceKey: op.spaceKey, parentId: op.parentId });
      if (!gate.allowed) refuse(gate.reason);
      return createConfluencePage(
        source,
        credential,
        { spaceKey: op.spaceKey, title: op.title, body: op.body, parentId: op.parentId },
        caps.timeoutMs,
      );
    });
  }

  /** Non-destructive write-access probe for a managed Confluence connector:
   *  create → update → delete a throwaway page within the connector's write
   *  scope, cleaning up after itself, so write-permission gaps surface at setup
   *  with the server's own reason. Lockout-gated like any call; never cached. */
  async probeConfluenceWrite(source: ContextSource): Promise<WriteProbeResult> {
    if (source.type !== "confluence") {
      throw new AppError("Write tests target a Confluence source.", "config");
    }
    const caps = this.caps();
    const credential = await this.storedCredential(source);
    const scope = source.writeScope;
    const target: WriteProbeTarget =
      scope?.kind === "space"
        ? { spaceKey: scope.spaceKey }
        : scope?.kind === "page"
          ? { parentId: scope.pageId }
          : {};
    return this.tracked(source, false, () =>
      probeConfluenceWriteAccess(source, credential, target, caps.timeoutMs, new Date().toISOString()),
    );
  }

  /** Discover the Confluence "Add more content" vocabulary available to this
   *  connector: the known catalog, the macros empirically in use in a sampled
   *  scope (the reliable "what's installed here" signal — needs only read
   *  access), and a best-effort list of installed apps. Lockout-gated. When no
   *  scope is given it falls back to the connector's own write scope so the
   *  sample reflects the space being managed. */
  async discoverConfluenceCapabilities(
    source: ContextSource,
    scope?: { spaceKey?: string; pageId?: string; subtree?: boolean },
  ): Promise<CapabilityReport> {
    if (source.type !== "confluence") {
      throw new AppError("Capability discovery targets a Confluence source.", "config");
    }
    const caps = this.caps();
    const credential = await this.storedCredential(source);
    const ws = source.writeScope;
    const effective =
      scope && (scope.spaceKey || scope.pageId)
        ? scope
        : ws?.kind === "space"
          ? { spaceKey: ws.spaceKey }
          : ws?.kind === "page"
            ? { pageId: ws.pageId }
            : {};
    return this.tracked(source, false, async () => {
      const { pagesSampled, used } = await discoverConfluenceMacros(source, credential, effective, caps);
      const apps = await detectConfluenceApps(source, credential, caps);
      return { pagesSampled, used, apps, catalog: MACRO_CATALOG };
    });
  }

  /** Manage a page's labels: list (read), add, or remove. Add/remove are
   *  mutations, so they respect the connector's write scope (the page must be in
   *  it); list is a global read. Lockout-gated. Returns the labels after the op. */
  async manageConfluenceLabels(
    source: ContextSource,
    op: { action: "add" | "remove" | "list"; pageId: string; labels?: string[] },
  ): Promise<{ action: string; labels: string[] }> {
    if (source.type !== "confluence") {
      throw new AppError("Label management targets a Confluence source.", "config");
    }
    const caps = this.caps();
    const credential = await this.storedCredential(source);
    const scope = source.writeScope;
    return this.tracked(source, false, async () => {
      if (op.action === "list") {
        return { action: "list", labels: await getConfluencePageLabels(source, credential, op.pageId, caps.timeoutMs) };
      }
      // Mutations: enforce the write scope (resolve the page's space first).
      if (scope && scope.kind !== "instance") {
        const meta = await getConfluencePageMeta(source, credential, op.pageId, caps.timeoutMs);
        const gate = checkWriteScope(scope, { action: "update", pageId: op.pageId, spaceKey: meta.spaceKey });
        if (!gate.allowed) {
          throw new AppError(
            `This managed Confluence connector may only write within ${describeWriteScope(scope)} — refused (${gate.reason}).`,
            "config",
          );
        }
      }
      if (!op.labels || op.labels.length === 0) {
        throw new AppError(`A label is required to ${op.action}.`, "config");
      }
      if (op.action === "add") {
        return { action: "add", labels: await addConfluenceLabels(source, credential, op.pageId, op.labels, caps.timeoutMs) };
      }
      for (const l of op.labels) await removeConfluenceLabel(source, credential, op.pageId, l, caps.timeoutMs);
      return { action: "remove", labels: await getConfluencePageLabels(source, credential, op.pageId, caps.timeoutMs) };
    });
  }

  /** Shared write-scope guard for page-targeted mutations (archive, remove,
   *  labels): resolve the page's space and refuse if it's outside the managed
   *  scope. Reads are global, so the meta lookup itself is never gated. */
  private async enforceConfluenceWriteScope(
    source: ContextSource,
    credential: ContextCredential,
    pageId: string,
    caps: ReadCaps,
  ): Promise<void> {
    const scope = source.writeScope;
    if (!scope || scope.kind === "instance") return;
    const meta = await getConfluencePageMeta(source, credential, pageId, caps.timeoutMs);
    const gate = checkWriteScope(scope, { action: "update", pageId, spaceKey: meta.spaceKey });
    if (!gate.allowed) {
      throw new AppError(
        `This managed Confluence connector may only write within ${describeWriteScope(scope)} — refused (${gate.reason}).`,
        "config",
      );
    }
  }

  /** Archive a page: move it under the space's "Archive" root (created if
   *  absent). A scoped, lockout-gated write — the first cleanup step. */
  async archiveConfluencePage(source: ContextSource, pageId: string): Promise<ArchiveResult> {
    if (source.type !== "confluence") throw new AppError("Archiving targets a Confluence source.", "config");
    const caps = this.caps();
    const credential = await this.storedCredential(source);
    return this.tracked(source, false, async () => {
      await this.enforceConfluenceWriteScope(source, credential, pageId, caps);
      return archiveConfluencePageAdapter(source, credential, pageId, caps.timeoutMs);
    });
  }

  /** Remove a page from search by blanking its CURRENT content (Confluence keeps
   *  every prior version for compliance — nothing is deleted). Scoped write. */
  async removeConfluencePageFromSearch(source: ContextSource, pageId: string): Promise<ConfluenceWriteResult> {
    if (source.type !== "confluence") throw new AppError("This targets a Confluence source.", "config");
    const caps = this.caps();
    const credential = await this.storedCredential(source);
    return this.tracked(source, false, async () => {
      await this.enforceConfluenceWriteScope(source, credential, pageId, caps);
      return removeConfluencePageFromSearchAdapter(source, credential, pageId, caps.timeoutMs);
    });
  }

  /** Move / re-parent a page: "append" makes it a child of the target (the
   *  common "move under" case); "before"/"after" reorder it as a sibling of the
   *  target. Scoped write — BOTH the page and the target must be within the
   *  managed scope, so a page can't be moved out of the managed space. Returns
   *  the page's new title + parent. */
  async moveConfluencePage(
    source: ContextSource,
    op: { pageId: string; parentId?: string; position?: MovePosition; targetId?: string },
  ): Promise<{ pageId: string; title: string; parentId?: string }> {
    if (source.type !== "confluence") throw new AppError("Moving pages targets a Confluence source.", "config");
    const position: MovePosition = op.position ?? "append";
    const target = position === "append" ? op.parentId ?? op.targetId : op.targetId ?? op.parentId;
    if (!target) {
      throw new AppError(
        position === "append"
          ? "Re-parenting needs the new parent page id (parentId)."
          : "Reordering needs the sibling page id to move before/after (targetId).",
        "config",
      );
    }
    if (target === op.pageId) throw new AppError("A page can't be moved relative to itself.", "config");
    const caps = this.caps();
    const credential = await this.storedCredential(source);
    return this.tracked(source, false, async () => {
      // The page being moved AND the target must both be in scope — this blocks
      // re-parenting a page under a page in another (unmanaged) space.
      await this.enforceConfluenceWriteScope(source, credential, op.pageId, caps);
      await this.enforceConfluenceWriteScope(source, credential, target, caps);
      await moveConfluencePageAdapter(source, credential, op.pageId, position, target, caps.timeoutMs);
      const meta = await getConfluencePageMeta(source, credential, op.pageId, caps.timeoutMs);
      return { pageId: meta.id, title: meta.title, ...(meta.parentId ? { parentId: meta.parentId } : {}) };
    });
  }

  /** Explore a page's HIERARCHY & RELATIONSHIPS: its breadcrumb (ancestors),
   *  immediate children ("context", default), just ancestors, just children, the
   *  full nested subtree, or — with a spaceKey and no pageId — the space's root
   *  pages. All listings are fully paginated (no truncation). Global READ. */
  async exploreConfluenceHierarchy(
    source: ContextSource,
    opts: { pageId?: string; spaceKey?: string; view?: "context" | "ancestors" | "children" | "subtree" },
  ): Promise<HierarchyResult> {
    if (source.type !== "confluence") throw new AppError("Hierarchy targets a Confluence source.", "config");
    const caps = this.caps();
    const credential = await this.storedCredential(source);
    const ws = source.writeScope;
    return this.tracked(source, false, async () => {
      if (!opts.pageId) {
        const spaceKey = opts.spaceKey ?? (ws?.kind === "space" ? ws.spaceKey : undefined);
        if (!spaceKey) {
          throw new AppError("Provide a pageId, or a spaceKey to list a space's root pages.", "config");
        }
        return { kind: "roots", spaceKey, roots: await getSpaceRootPages(source, credential, spaceKey, caps) };
      }
      const view = opts.view ?? "context";
      if (view === "ancestors") {
        return { kind: "ancestors", ancestors: await getPageAncestors(source, credential, opts.pageId, caps) };
      }
      if (view === "children") {
        const [anc, children] = await Promise.all([
          getPageAncestors(source, credential, opts.pageId, caps),
          getChildPages(source, credential, opts.pageId, caps),
        ]);
        return { kind: "children", page: anc.page, children };
      }
      if (view === "subtree") {
        const anc = await getPageAncestors(source, credential, opts.pageId, caps);
        const descendants = await getDescendantPages(source, credential, opts.pageId, caps);
        return { kind: "subtree", root: anc.page, tree: buildPageTree(anc.page, descendants), count: descendants.length };
      }
      return { kind: "context", hierarchy: await getPageHierarchy(source, credential, opts.pageId, caps) };
    });
  }

  /** Resolve a page's owner(s): the owner label if present, else the most
   *  prolific contributor on the page, else in the space. A global READ.
   *  Active-user filtering needs an LDAP/M365 directory (not wired here), so
   *  this treats contributors as candidates by activity volume. */
  async resolveConfluenceOwners(
    source: ContextSource,
    pageId: string,
  ): Promise<{ resolution: OwnerResolution; labels: string[]; directoryWired: false }> {
    if (source.type !== "confluence") throw new AppError("Ownership targets a Confluence source.", "config");
    const caps = this.caps();
    const credential = await this.storedCredential(source);
    return this.tracked(source, false, async () => {
      const meta = await getConfluencePageMeta(source, credential, pageId, caps.timeoutMs);
      const [labels, pageContributors] = await Promise.all([
        getConfluencePageLabels(source, credential, pageId, caps.timeoutMs),
        getConfluencePageContributors(source, credential, pageId, caps.timeoutMs),
      ]);
      const resolution = await resolveOwners({
        pageLabels: labels,
        pageContributors,
        spaceContributors: () =>
          meta.spaceKey
            ? getConfluenceSpaceContributors(source, credential, meta.spaceKey, caps.timeoutMs)
            : Promise.resolve([]),
        isActive: async () => true,
      });
      return { resolution, labels, directoryWired: false as const };
    });
  }

  /** Review whether the signed-in user can read+write every page in a space,
   *  and prepare an access-request note for the admins. Global READ. */
  async reviewConfluenceManageability(
    source: ContextSource,
    spaceKey?: string,
  ): Promise<{ report: ManageabilityReport; note: string }> {
    if (source.type !== "confluence") throw new AppError("Manageability targets a Confluence source.", "config");
    const caps = this.caps();
    const credential = await this.storedCredential(source);
    const ws = source.writeScope;
    const space = spaceKey ?? (ws?.kind === "space" ? ws.spaceKey : undefined);
    if (!space) throw new AppError("A space key is required (this connector isn't space-scoped).", "config");
    return this.tracked(source, false, async () => {
      const user = await getCurrentConfluenceUser(source, credential, caps.timeoutMs);
      const report = await reviewSpaceManageability(source, credential, space, user, caps);
      return { report, note: prepareAccessRequestNote(report) };
    });
  }

  /** Review a page's currency: broken links, owner tag, and age. Global READ.
   *  Owner-activity verification needs an LDAP/M365 directory (not wired here);
   *  owners are reported, activity left unverified. */
  async reviewConfluenceCurrency(source: ContextSource, pageId: string): Promise<CurrencyReport> {
    if (source.type !== "confluence") throw new AppError("Currency review targets a Confluence source.", "config");
    const caps = this.caps();
    const credential = await this.storedCredential(source);
    return this.tracked(source, false, () =>
      reviewPageCurrency(source, credential, pageId, async () => undefined, caps),
    );
  }

  /** Non-destructive CONTENT FUNCTIONALITY test: author a throwaway page of
   *  built-in rich elements, pull the rendered content to confirm they became
   *  real Confluence elements (no leaked shorthand), then delete it. The macro
   *  analogue of probeConfluenceWrite. Lockout-gated. */
  async probeConfluenceFunctionality(source: ContextSource): Promise<FunctionalityProbeResult> {
    if (source.type !== "confluence") {
      throw new AppError("Content tests target a Confluence source.", "config");
    }
    const caps = this.caps();
    const credential = await this.storedCredential(source);
    const scope = source.writeScope;
    const target: WriteProbeTarget =
      scope?.kind === "space"
        ? { spaceKey: scope.spaceKey }
        : scope?.kind === "page"
          ? { parentId: scope.pageId }
          : {};
    return this.tracked(source, false, () =>
      probeConfluenceFunctionality(source, credential, target, caps, new Date().toISOString()),
    );
  }

  /** Pull a page's TRUE RENDERED content (body.view) and validate it: flag any
   *  wiki/markdown shorthand that leaked as visible text (e.g. a literal "[TOC]"
   *  that never became a table of contents) and inventory the macros that
   *  actually rendered. The post-write confirmation that elements are as
   *  intended. Read-only, lockout-gated; not cached (validation must be live). */
  async validateConfluencePage(source: ContextSource, pageId: string): Promise<RenderedValidation> {
    if (source.type !== "confluence") {
      throw new AppError("Rendered validation targets a Confluence source.", "config");
    }
    const caps = this.caps();
    const credential = await this.storedCredential(source);
    return this.tracked(source, false, () =>
      validateConfluencePageRendered(source, credential, pageId, caps),
    );
  }

  /** Gemini-grounded answer from a Vertex AI Search app (the "analysis"
   *  surface — ADR-0026). Cached and lockout-gated like search. */
  async vertexAnswer(source: ContextSource, query: string): Promise<VertexAnswer> {
    if (source.type !== "vertexai") {
      throw new AppError("Grounded answers require a Vertex AI Search source.", "config");
    }
    const caps = this.caps();
    return this.cache.getOrLoad(
      TtlCache.key(source.id, "answer", query),
      this.ttlMs(),
      async () => {
        const credential = await this.storedCredential(source);
        return this.tracked(source, false, () => answerVertex(source, credential, query, caps));
      },
    );
  }

  /** Read the schema catalog a database connection can see (ADR-0024) —
   *  metadata only, lockout-gated, stored-credential. Persistence is the
   *  SchemaStore's job (this is not TTL-cached: schemas change rarely and
   *  refresh is explicit). */
  async loadSchemaCatalog(source: ContextSource, nowIso: string): Promise<SchemaCatalog> {
    if (!ContextService.DB_TYPES.has(source.type)) {
      throw new AppError("Schema catalogs apply to database sources only.", "config");
    }
    const credential = await this.storedCredential(source);
    return this.tracked(source, false, () =>
      describeDb(source, credential, this.dbTls(), this.caps(), nowIso),
    );
  }

  /**
   * Pre-cache the GLOBAL catalog of a Confluence/Jira source (pilot
   * request): all spaces / projects+filters+queues, fetched page-by-page
   * with the injected `checkpoint` awaited between requests so the user is
   * periodically asked to continue and the source is never hammered.
   * Lockout-gated like every read; persistence is the CatalogStore's job.
   */
  async precacheCatalog(
    source: ContextSource,
    checkpoint: LoadCheckpoint,
  ): Promise<{ entries: CatalogEntry[]; complete: boolean }> {
    const caps = this.caps();
    const credential = await this.storedCredential(source);
    return this.tracked(source, false, async () => {
      if (source.type === "confluence") {
        const { spaces, complete } = await listAllConfluenceSpaces(source, credential, caps, checkpoint);
        return {
          entries: spaces.map((sp) => ({
            name: sp.name,
            locator: `space = "${sp.key}" ORDER BY lastmodified DESC`,
            kind: "query" as const,
            detail: `Confluence space ${sp.key}`,
          })),
          complete,
        };
      }
      if (source.type === "jira") {
        const entries: CatalogEntry[] = [];
        const queueResult = await listAllJsmQueues(source, credential, caps, checkpoint);
        for (const q of queueResult.queues) {
          entries.push({ name: `${q.desk}: ${q.name}`, locator: q.jql, kind: "query", detail: "JSM queue" });
        }
        if (!queueResult.complete) return { entries, complete: false };
        const filters = await listJiraFavouriteFilters(source, credential, caps).catch(() => []);
        for (const f of filters) {
          entries.push({ name: f.name, locator: f.jql, kind: "query", detail: "Favourite filter" });
        }
        if (!(await checkpoint())) return { entries, complete: false };
        const projectResult = await listAllJiraProjects(source, credential, caps, checkpoint);
        for (const pr of projectResult.projects) {
          entries.push({
            name: `${pr.name} — recent issues`,
            locator: `project = "${pr.key}" ORDER BY updated DESC`,
            kind: "query",
            detail: `Project ${pr.key}`,
          });
        }
        return { entries, complete: projectResult.complete };
      }
      throw new AppError(
        "Catalog pre-caching applies to Confluence and Jira sources.",
        "config",
      );
    });
  }

  /** One join-rate probe (ADR-0030 "Build ER Diagram") — counts only,
   *  lockout-gated, stored-credential, capped like every read. "full"
   *  tests the complete join (small tables / escalated runs). */
  async probeJoin(
    source: ContextSource,
    from: JoinProbeEnd,
    to: JoinProbeEnd,
    sample: number | "full",
    cast = false,
  ): Promise<JoinProbeCounts> {
    if (!ContextService.DB_TYPES.has(source.type)) {
      throw new AppError("Join probing applies to database sources only.", "config");
    }
    const credential = await this.storedCredential(source);
    return this.tracked(source, false, () =>
      probeJoinRate(source, credential, this.dbTls(), this.caps(), from, to, sample, cast),
    );
  }

  /** Approximate per-table row counts (catalog statistics) — the sizing
   *  pass that plans the adaptive ER probe (ADR-0030 amendment). */
  async estimateRows(source: ContextSource): Promise<RowEstimates> {
    if (!ContextService.DB_TYPES.has(source.type)) {
      throw new AppError("Row estimation applies to database sources only.", "config");
    }
    const credential = await this.storedCredential(source);
    return this.tracked(source, false, () =>
      estimateRowCounts(source, credential, this.dbTls(), this.caps()),
    );
  }

  /** Content-type indexing: bounded row sample for one table, reduced to
   *  per-column distinct values locally (ADR-0024 amendment). */
  async sampleTable(source: ContextSource, table: TableDef): Promise<Record<string, string[]>> {
    if (!ContextService.DB_TYPES.has(source.type)) {
      throw new AppError("Content sampling applies to database sources only.", "config");
    }
    const credential = await this.storedCredential(source);
    return this.tracked(source, false, () =>
      sampleTableValues(source, credential, this.dbTls(), this.caps(), table),
    );
  }

  /**
   * Candidate bookmarks from the source's own catalog (Confluence spaces,
   * Jira favourite filters / JSM queues / projects). Feeds the guided
   * "Browse & Bookmark" picker; cached and lockout-gated like every read.
   */
  async browseCandidates(
    source: ContextSource,
  ): Promise<Array<Pick<ContextBookmark, "name" | "locator" | "kind"> & { detail: string }>> {
    const caps = this.caps();
    return this.cache.getOrLoad(
      TtlCache.key(source.id, "browse", "catalog"),
      this.ttlMs(),
      async () => {
        const credential = await this.storedCredential(source);
        return this.tracked(source, false, async () => {
          if (source.type === "confluence") {
            const spaces = await listConfluenceSpaces(source, credential, caps);
            return spaces.map((sp) => ({
              name: sp.name,
              locator: `space = "${sp.key}" ORDER BY lastmodified DESC`,
              kind: "query" as const,
              detail: `Confluence space ${sp.key}`,
            }));
          }
          if (source.type === "jira") {
            const out: Array<Pick<ContextBookmark, "name" | "locator" | "kind"> & { detail: string }> = [];
            const notes: string[] = [];
            const [queueResult, filters, projects] = await Promise.all([
              listJsmQueues(source, credential, caps),
              listJiraFavouriteFilters(source, credential, caps).catch((err) => {
                notes.push(`favourite filters: ${err instanceof Error ? err.message : String(err)}`);
                return [];
              }),
              listJiraProjects(source, credential, caps).catch((err) => {
                notes.push(`projects: ${err instanceof Error ? err.message : String(err)}`);
                return [];
              }),
            ]);
            if (queueResult.note) notes.push(`queues: ${queueResult.note}`);
            for (const q of queueResult.queues) {
              out.push({ name: `${q.desk}: ${q.name}`, locator: q.jql, kind: "query", detail: "JSM queue" });
            }
            for (const f of filters) {
              out.push({ name: f.name, locator: f.jql, kind: "query", detail: "Favourite filter" });
            }
            for (const pr of projects) {
              out.push({
                name: `${pr.name} — recent issues`,
                locator: `project = "${pr.key}" ORDER BY updated DESC`,
                kind: "query",
                detail: `Project ${pr.key}`,
              });
            }
            if (out.length === 0 && notes.length > 0) {
              // Empty because of denials, not because the instance is empty —
              // say exactly what was tried (pilot: silent [] looked broken).
              throw new AppError(
                `Jira returned nothing browsable: ${notes.join("; ")}.`,
                "config",
                "Queue listing requires a JSM agent license (the API also needs the experimental opt-in header, which is now sent). Favourite filters appear once you star filters in Jira. The search-then-bookmark path works regardless.",
              );
            }
            return out.slice(0, caps.maxResults * 2);
          }
          if (ContextService.DB_TYPES.has(source.type)) {
            return browseDb(source, credential, this.dbTls(), caps);
          }
          if (source.type === "powerbi") {
            return browsePowerBi(this.powerBiTokens(credential), caps);
          }
          if (source.type === "servicenow") {
            return this.snowCredential(source, credential).then((c) =>
              browseServiceNowCandidates(source, c, caps),
            );
          }
          if (source.type === "splunk") {
            return browseSplunkCandidates(source, credential, caps);
          }
          if (source.type === "splunkobs") {
            return browseSplunkObsCandidates(source, credential, caps);
          }
          if (source.type === "grafana") {
            return browseGrafanaCandidates(source, credential, caps);
          }
          return []; // LDAP: search-then-bookmark is the guided path
        });
      },
    );
  }
}
