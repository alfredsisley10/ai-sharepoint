import * as vscode from "vscode";
import {
  OwnershipCacheEntry,
  CachedOwnership,
  DEFAULT_OWNERSHIP_TTL_MS,
  ownershipKey,
  isFresh,
  pruneEntries,
  buildOwnershipCacheExport,
  isOwnershipCacheExport,
  mergeOwnershipCache,
} from "./ownershipCache";

const KEY = "aiSharePoint.ownershipCache";

/**
 * Persists resolved page-ownership results (info-sprawl cleanup). Global state
 * so a computed ownership map survives restarts and is shared via export.
 */
export class OwnershipCacheStore {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly memory = new Map<string, OwnershipCacheEntry>();
  private loaded = false;

  constructor(
    private readonly state: vscode.Memento,
    private readonly ttlMs: number = DEFAULT_OWNERSHIP_TTL_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private ensure(): void {
    if (this.loaded) return;
    this.loaded = true;
    for (const e of this.state.get<OwnershipCacheEntry[]>(KEY) ?? []) {
      if (e?.key) this.memory.set(e.key, e);
    }
  }

  /** Fresh cached ownership for a page, or undefined. */
  getFresh(sourceId: string, pageId: string): CachedOwnership | undefined {
    this.ensure();
    const entry = this.memory.get(ownershipKey(sourceId, pageId));
    return isFresh(entry, this.now(), this.ttlMs) ? entry!.value : undefined;
  }

  async put(sourceId: string, pageId: string, value: CachedOwnership): Promise<void> {
    this.ensure();
    this.memory.set(ownershipKey(sourceId, pageId), { key: ownershipKey(sourceId, pageId), value, at: this.now() });
    await this.persist();
  }

  private async persist(): Promise<void> {
    await this.state.update(KEY, [...this.memory.values()]);
    this.emitter.fire();
  }

  async prune(): Promise<void> {
    this.ensure();
    const kept = pruneEntries([...this.memory.values()], this.now(), this.ttlMs);
    if (kept.length === this.memory.size) return;
    this.memory.clear();
    for (const e of kept) this.memory.set(e.key, e);
    await this.persist();
  }

  async clear(): Promise<void> {
    this.ensure();
    this.memory.clear();
    await this.persist();
  }

  size(): number {
    this.ensure();
    return this.memory.size;
  }

  export(exportedAt: string): string {
    this.ensure();
    return JSON.stringify(buildOwnershipCacheExport([...this.memory.values()], exportedAt), null, 2);
  }

  async import(rawJson: string): Promise<{ merged: number }> {
    this.ensure();
    const parsed = JSON.parse(rawJson) as unknown;
    if (!isOwnershipCacheExport(parsed)) throw new Error("Not an ownership-cache/v1 export.");
    const merged = mergeOwnershipCache([...this.memory.values()], parsed.entries);
    this.memory.clear();
    for (const e of merged) this.memory.set(e.key, e);
    await this.persist();
    return { merged: parsed.entries.length };
  }
}
