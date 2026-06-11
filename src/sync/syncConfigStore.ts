import * as vscode from "vscode";

/** Per-connection sync configuration (non-secret; ADR-0019). */
export interface SiteSyncConfig {
  siteUrl: string;
  /** Absolute path of the local site repository. */
  folder: string;
  remoteUrl?: string;
  /** Base branch pushes target / PRs merge into. */
  baseBranch: string;
  /** ADR-0004: "pr" pushes a sync branch + opens compare; "direct" pushes base. */
  reviewGate: "pr" | "direct";
}

const KEY = "aiSharePoint.syncConfigs";

export class SyncConfigStore {
  constructor(private readonly state: vscode.Memento) {}

  get(siteUrl: string): SiteSyncConfig | undefined {
    return (this.state.get<SiteSyncConfig[]>(KEY) ?? []).find(
      (c) => c.siteUrl === siteUrl,
    );
  }

  async set(config: SiteSyncConfig): Promise<void> {
    const all = (this.state.get<SiteSyncConfig[]>(KEY) ?? []).filter(
      (c) => c.siteUrl !== config.siteUrl,
    );
    all.push(config);
    await this.state.update(KEY, all);
  }

  async remove(siteUrl: string): Promise<void> {
    await this.state.update(
      KEY,
      (this.state.get<SiteSyncConfig[]>(KEY) ?? []).filter(
        (c) => c.siteUrl !== siteUrl,
      ),
    );
  }
}
