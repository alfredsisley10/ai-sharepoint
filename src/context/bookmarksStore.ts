import * as vscode from "vscode";
import { ContextBookmark } from "./types";
import {
  listForSource,
  resolveBookmark,
  withBookmark,
  withoutBookmark,
  withoutSource,
} from "./bookmarkOps";

const KEY = "aiSharePoint.contextBookmarks";

/**
 * Named, non-secret pointers to reusable queries/items per source (ADR-0010):
 * a saved CQL/JQL/LDAP filter, a page id, an issue key, a DN. Locators only —
 * credentials always stay in the keychain. Logic lives in bookmarkOps (pure,
 * tested); this is the vscode-backed persistence wrapper.
 */
export class BookmarksStore {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly state: vscode.Memento) {}

  list(): ContextBookmark[] {
    return this.state.get<ContextBookmark[]>(KEY) ?? [];
  }

  listForSource(sourceId: string): ContextBookmark[] {
    return listForSource(this.list(), sourceId);
  }

  resolve(name: string, sourceId?: string): ContextBookmark | undefined {
    return resolveBookmark(this.list(), name, sourceId);
  }

  private async save(next: ContextBookmark[]): Promise<void> {
    await this.state.update(KEY, next);
    this.emitter.fire();
  }

  add(bookmark: ContextBookmark): Promise<void> {
    return this.save(withBookmark(this.list(), bookmark));
  }

  remove(id: string): Promise<void> {
    return this.save(withoutBookmark(this.list(), id));
  }

  removeForSource(sourceId: string): Promise<void> {
    return this.save(withoutSource(this.list(), sourceId));
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
