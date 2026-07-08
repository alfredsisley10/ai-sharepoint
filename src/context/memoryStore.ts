import * as vscode from "vscode";
import { MementoListStore } from "./mementoListStore";
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
export class MemoryStore extends MementoListStore<MemoryItem> {
  constructor(state: vscode.Memento) {
    super(state, KEY);
  }

  list(): MemoryItem[] {
    return this.all();
  }

  listForScope(scope: MemoryScope): MemoryItem[] {
    return listForScope(this.list(), scope);
  }

  get(id: string): MemoryItem | undefined {
    return this.list().find((m) => m.id === id);
  }

  add(item: MemoryItem): Promise<void> {
    return this.persist(withMemory(this.list(), item));
  }

  update(item: MemoryItem): Promise<void> {
    return this.persist(withUpdatedMemory(this.list(), item));
  }

  remove(id: string): Promise<void> {
    return this.persist(withoutMemory(this.list(), id));
  }

  removeForScope(scope: MemoryScope): Promise<void> {
    return this.persist(withoutScope(this.list(), scope));
  }
}
