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
