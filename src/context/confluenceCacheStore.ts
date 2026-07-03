import * as vscode from "vscode";
import { ConfluenceContentCache, ConfluencePageCacheEntry } from "./adapters/confluenceCache";

/**
 * Persists the Confluence content cache (ADR-0042) — one JSON file per source
 * under global storage, same disk pattern as CatalogStore/SchemaStore (a space
 * snapshot can be large, so disk rather than globalState). Rehydrates a
 * `ConfluenceContentCache` per source for repeated review passes + drift checks.
 */
export class ConfluenceCacheStore {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly memory = new Map<string, ConfluencePageCacheEntry[]>();
  private loaded = false;

  constructor(private readonly storageUri: vscode.Uri) {}

  private dir(): vscode.Uri {
    return vscode.Uri.joinPath(this.storageUri, "confluence-cache");
  }

  private file(sourceId: string): vscode.Uri {
    return vscode.Uri.joinPath(this.dir(), `${sourceId}.json`);
  }

  async preload(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const entries = await vscode.workspace.fs.readDirectory(this.dir());
      for (const [name, kind] of entries) {
        if (kind !== vscode.FileType.File || !name.endsWith(".json")) continue;
        try {
          const raw = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.dir(), name));
          this.memory.set(name.slice(0, -".json".length), JSON.parse(Buffer.from(raw).toString("utf8")) as ConfluencePageCacheEntry[]);
        } catch {
          // Corrupt entry — a re-cache rebuilds it.
        }
      }
      this.emitter.fire();
    } catch {
      // No cache directory yet.
    }
  }

  /** Rehydrate the content cache for a source (empty when none cached). */
  getCache(sourceId: string): ConfluenceContentCache {
    return new ConfluenceContentCache(sourceId, this.memory.get(sourceId) ?? []);
  }

  async saveCache(sourceId: string, cache: ConfluenceContentCache): Promise<void> {
    const entries = cache.serialize();
    this.memory.set(sourceId, entries);
    await vscode.workspace.fs.createDirectory(this.dir());
    await vscode.workspace.fs.writeFile(this.file(sourceId), Buffer.from(JSON.stringify(entries), "utf8"));
    this.emitter.fire();
  }

  cachedCount(sourceId: string): number {
    return (this.memory.get(sourceId) ?? []).length;
  }

  async remove(sourceId: string): Promise<void> {
    this.memory.delete(sourceId);
    try {
      await vscode.workspace.fs.delete(this.file(sourceId));
    } catch {
      // Nothing persisted yet.
    }
    this.emitter.fire();
  }
}
