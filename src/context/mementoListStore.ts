import * as vscode from "vscode";

/**
 * Base for the array-backed Memento stores. Bookmarks, projects, work items,
 * prompts, and learned memory all repeated the same shell: an `EventEmitter`
 * fired on every write, `get<T[]>(KEY) ?? []` to read, `update(KEY, next)` +
 * fire to persist, and a `dispose()` that tears down the emitter. This holds
 * that shell once; each store keeps only its own domain methods (which layer
 * the already-unit-tested pure ops on top of `all()` / `persist()`).
 *
 * Subclasses call `super(state, KEY)` and expose a public `list()` (so any
 * per-store ordering stays theirs); `all()` and `persist()` are protected.
 */
export abstract class MementoListStore<T> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(
    protected readonly state: vscode.Memento,
    private readonly key: string,
  ) {}

  /** The raw stored list (empty when unset). */
  protected all(): T[] {
    return this.state.get<T[]>(this.key) ?? [];
  }

  /** Replace the whole list and notify listeners. */
  protected async persist(next: T[]): Promise<void> {
    await this.state.update(this.key, next);
    this.notify();
  }

  /** Fire the change event — for subclasses that also write auxiliary keys
   *  (e.g. an "active id") through `this.state` directly. */
  protected notify(): void {
    this.emitter.fire();
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
