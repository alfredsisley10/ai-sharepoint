import * as vscode from "vscode";
import { ContextBookmark } from "./types";
import { MementoListStore } from "./mementoListStore";
import {
  listForSource,
  resolveBookmark,
  withBookmark,
  withUpdatedBookmark,
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
export class BookmarksStore extends MementoListStore<ContextBookmark> {
  constructor(state: vscode.Memento) {
    super(state, KEY);
  }

  list(): ContextBookmark[] {
    return this.all();
  }

  listForSource(sourceId: string): ContextBookmark[] {
    return listForSource(this.list(), sourceId);
  }

  resolve(name: string, sourceId?: string): ContextBookmark | undefined {
    return resolveBookmark(this.list(), name, sourceId);
  }

  add(bookmark: ContextBookmark): Promise<void> {
    return this.persist(withBookmark(this.list(), bookmark));
  }

  update(bookmark: ContextBookmark): Promise<void> {
    return this.persist(withUpdatedBookmark(this.list(), bookmark));
  }

  remove(id: string): Promise<void> {
    return this.persist(withoutBookmark(this.list(), id));
  }

  removeForSource(sourceId: string): Promise<void> {
    return this.persist(withoutSource(this.list(), sourceId));
  }
}
