import * as vscode from "vscode";
import {
  DirectoryCacheEntry,
  DEFAULT_DIRECTORY_TTL_MS,
  pruneEntries,
  buildDirectoryCacheExport,
  isDirectoryCacheExport,
  mergeDirectoryCache,
} from "./directoryCache";

const KEY = "aiSharePoint.directoryCache";

/**
 * Persists the user-directory lookup cache (ADR-0041). Global state so the
 * (slowly-moving, non-secret) directory data survives restarts and folder
 * switches, cutting LDAP/Graph lookups during ownership work. In-memory Map for
 * synchronous reads; writes persist. Exportable/importable for backup.
 */
export class DirectoryCacheStore {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly memory = new Map<string, DirectoryCacheEntry>();
  private loaded = false;

  constructor(
    private readonly state: vscode.Memento,
    private readonly ttlMs: number = DEFAULT_DIRECTORY_TTL_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private ensure(): void {
    if (this.loaded) return;
    this.loaded = true;
    for (const e of this.state.get<DirectoryCacheEntry[]>(KEY) ?? []) {
      if (e?.sam) this.memory.set(e.sam.toLowerCase(), e);
    }
  }

  get(sam: string): DirectoryCacheEntry | undefined {
    this.ensure();
    return this.memory.get(sam.toLowerCase());
  }

  async put(entry: DirectoryCacheEntry): Promise<void> {
    this.ensure();
    this.memory.set(entry.sam.toLowerCase(), entry);
    await this.persist();
  }

  private async persist(): Promise<void> {
    await this.state.update(KEY, [...this.memory.values()]);
    this.emitter.fire();
  }

  /** Drop expired entries (call periodically / on activation). */
  async prune(): Promise<void> {
    this.ensure();
    const kept = pruneEntries([...this.memory.values()], this.now(), this.ttlMs);
    if (kept.length === this.memory.size) return;
    this.memory.clear();
    for (const e of kept) this.memory.set(e.sam.toLowerCase(), e);
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

  /** Serialize for backup. */
  export(exportedAt: string): string {
    this.ensure();
    return JSON.stringify(buildDirectoryCacheExport([...this.memory.values()], exportedAt), null, 2);
  }

  /** Import a prior cache, keeping the fresher record per user. */
  async import(rawJson: string): Promise<{ merged: number }> {
    this.ensure();
    const parsed = JSON.parse(rawJson) as unknown;
    if (!isDirectoryCacheExport(parsed)) throw new Error("Not a directory-cache/v1 export.");
    const merged = mergeDirectoryCache([...this.memory.values()], parsed.entries);
    this.memory.clear();
    for (const e of merged) this.memory.set(e.sam.toLowerCase(), e);
    await this.persist();
    return { merged: parsed.entries.length };
  }
}
