import * as vscode from "vscode";
import {
  MemoryItem,
  MemoryScope,
  listForScope,
  withMemory,
  withUpdatedMemory,
  withoutMemory,
  withoutScope,
} from "./memory";

const KEY = "aiSharePoint.memoryItems";

/**
 * Persists per-entity memory (non-secret notes attached to a reference source or
 * managed site). Global state so it survives folder switches, like the other
 * user-level resources. Pure logic lives in memory.ts; this is the vscode wrapper.
 */
export class MemoryStore {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly state: vscode.Memento) {}

  list(): MemoryItem[] {
    return this.state.get<MemoryItem[]>(KEY) ?? [];
  }

  listForScope(scope: MemoryScope): MemoryItem[] {
    return listForScope(this.list(), scope);
  }

  get(id: string): MemoryItem | undefined {
    return this.list().find((m) => m.id === id);
  }

  private async save(next: MemoryItem[]): Promise<void> {
    await this.state.update(KEY, next);
    this.emitter.fire();
  }

  add(item: MemoryItem): Promise<void> {
    return this.save(withMemory(this.list(), item));
  }

  update(item: MemoryItem): Promise<void> {
    return this.save(withUpdatedMemory(this.list(), item));
  }

  remove(id: string): Promise<void> {
    return this.save(withoutMemory(this.list(), id));
  }

  removeForScope(scope: MemoryScope): Promise<void> {
    return this.save(withoutScope(this.list(), scope));
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
