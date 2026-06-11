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
import { AppError, classifyError } from "../core/errors";

/**
 * One façade over all adapters: lockout gating (ADR-0009) before every
 * network attempt, read-through caching (ADR-0011), caps (ADR-0012), and
 * stored-credential-only operation for background/agent reads.
 */
export class ContextService {
  constructor(
    private readonly store: ContextSourcesStore,
    private readonly cache: TtlCache,
  ) {}

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
      switch (source.type) {
        case "ldap":
          return verifyLdap(source, credential, this.ldapTls(), caps);
        case "jira":
          return verifyJira(source, credential, caps);
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

  async search(source: ContextSource, query: string): Promise<ContextSearchHit[]> {
    const caps = this.caps();
    return this.cache.getOrLoad(
      TtlCache.key(source.id, "search", `${caps.maxResults}:${query}`),
      this.ttlMs(),
      async () => {
        const credential = await this.storedCredential(source);
        return this.tracked(source, false, () => {
          switch (source.type) {
            case "ldap":
              return searchLdap(source, credential, query, this.ldapTls(), caps);
            case "jira":
              return searchJira(source, credential, query, caps);
            default:
              return searchConfluence(source, credential, query, caps);
          }
        });
      },
    );
  }

  async getItem(source: ContextSource, id: string): Promise<ContextItem> {
    const caps = this.caps();
    return this.cache.getOrLoad(
      TtlCache.key(source.id, "item", id),
      this.ttlMs(),
      async () => {
        const credential = await this.storedCredential(source);
        return this.tracked(source, false, () => {
          switch (source.type) {
            case "ldap":
              return getLdapEntry(source, credential, id, this.ldapTls(), caps);
            case "jira":
              return getJiraIssue(source, credential, id, caps);
            default:
              return getConfluencePage(source, credential, id, caps);
          }
        });
      },
    );
  }
}
