import * as vscode from "vscode";

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
}

const KEY = "aiSharePoint.siteConnections";

/** Persists site connection descriptors (non-secret) in extension state. */
export class SitesStore {
  constructor(private readonly state: vscode.Memento) {}

  list(): SiteConnection[] {
    return this.state.get<SiteConnection[]>(KEY) ?? [];
  }

  async upsert(connection: SiteConnection): Promise<void> {
    const all = this.list().filter((c) => c.siteUrl !== connection.siteUrl);
    all.push(connection);
    await this.state.update(KEY, all);
  }

  async remove(siteUrl: string): Promise<void> {
    await this.state.update(
      KEY,
      this.list().filter((c) => c.siteUrl !== siteUrl),
    );
  }
}
