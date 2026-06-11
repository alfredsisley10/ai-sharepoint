import * as vscode from "vscode";
import { SecretStore } from "../secrets/secretStore";

/** A non-secret SharePoint connection descriptor (PLAN §5). Credentials live in
 *  the keychain, referenced only by the cache handle. */
export interface SiteConnection {
  siteUrl: string;
  displayName: string;
  /** managed = full sync/Git lifecycle; reference = read-only context (§9). */
  role: "managed" | "reference";
  authProviderId: string;
  /** SecretStore handle for this connection's MSAL token cache. */
  cacheHandle: string;
  /** Tenant hostname, e.g. contoso.sharepoint.com (non-secret). */
  tenantHost: string;
  /** Account (UPN) that last authenticated this connection, if known. */
  account?: string;
  addedAt?: string;
  lastVerifiedAt?: string;
}

const KEY = "aiSharePoint.siteConnections";

/**
 * Persists site connection descriptors (non-secret).
 *
 * v2: stored in **global** state — connections are user-level resources and
 * must survive switching folders (REVIEW C10). A one-time migration copies any
 * Phase 0 connections out of workspaceState. Fires onDidChange for the UI.
 */
export class SitesStore {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(
    private readonly state: vscode.Memento,
    legacyWorkspaceState?: vscode.Memento,
  ) {
    if (legacyWorkspaceState) {
      void this.migrateFrom(legacyWorkspaceState);
    }
  }

  private async migrateFrom(legacy: vscode.Memento): Promise<void> {
    const old = legacy.get<SiteConnection[]>(KEY);
    if (old && old.length > 0 && this.list().length === 0) {
      await this.state.update(
        KEY,
        old.map((c) => ({
          ...c,
          tenantHost: c.tenantHost ?? safeHost(c.siteUrl),
        })),
      );
      await legacy.update(KEY, undefined);
      this.emitter.fire();
    }
  }

  list(): SiteConnection[] {
    return this.state.get<SiteConnection[]>(KEY) ?? [];
  }

  get(siteUrl: string): SiteConnection | undefined {
    return this.list().find((c) => c.siteUrl === siteUrl);
  }

  async upsert(connection: SiteConnection): Promise<void> {
    const all = this.list().filter((c) => c.siteUrl !== connection.siteUrl);
    all.push(connection);
    all.sort((a, b) => a.displayName.localeCompare(b.displayName));
    await this.state.update(KEY, all);
    this.emitter.fire();
  }

  async setRole(siteUrl: string, role: SiteConnection["role"]): Promise<void> {
    const conn = this.get(siteUrl);
    if (conn) {
      await this.upsert({ ...conn, role });
    }
  }

  async markVerified(siteUrl: string, at: string, account?: string): Promise<void> {
    const conn = this.get(siteUrl);
    if (conn) {
      await this.upsert({
        ...conn,
        lastVerifiedAt: at,
        account: account ?? conn.account,
      });
    }
  }

  /**
   * Remove a connection. The keychain cache blob is wiped too unless another
   * connection still shares the same handle (offboarding — REVIEW S4).
   */
  async remove(siteUrl: string, secrets?: SecretStore): Promise<void> {
    const conn = this.get(siteUrl);
    const remaining = this.list().filter((c) => c.siteUrl !== siteUrl);
    await this.state.update(KEY, remaining);
    if (
      conn &&
      secrets &&
      !remaining.some((c) => c.cacheHandle === conn.cacheHandle)
    ) {
      await secrets.delete(conn.cacheHandle);
    }
    this.emitter.fire();
  }

  /** Wipe a connection's cached credentials but keep the descriptor. */
  async signOut(siteUrl: string, secrets: SecretStore): Promise<void> {
    const conn = this.get(siteUrl);
    if (conn) {
      await secrets.delete(conn.cacheHandle);
      await this.upsert({ ...conn, account: undefined, lastVerifiedAt: undefined });
    }
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "unknown";
  }
}
