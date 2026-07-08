import * as vscode from "vscode";
import { MementoListStore } from "./mementoListStore";
import {
  PromptItem,
  PromptScope,
  listPromptsForScope,
  withPrompt,
  withUpdatedPrompt,
  withoutPrompt,
  withoutPromptScope,
} from "./promptLibrary";

const KEY = "aiSharePoint.promptItems";

/**
 * Persists the Prompt Library (reusable prompt snippets, global or attached to a
 * site/source/project). Global state so it survives folder switches, like the
 * other user-level resources. Pure logic lives in promptLibrary.ts; this is the
 * vscode wrapper.
 */
export class PromptStore extends MementoListStore<PromptItem> {
  constructor(state: vscode.Memento) {
    super(state, KEY);
  }

  list(): PromptItem[] {
    return this.all();
  }

  listForScope(scope: PromptScope): PromptItem[] {
    return listPromptsForScope(this.list(), scope);
  }

  get(id: string): PromptItem | undefined {
    return this.list().find((p) => p.id === id);
  }

  add(item: PromptItem): Promise<void> {
    return this.persist(withPrompt(this.list(), item));
  }

  update(item: PromptItem): Promise<void> {
    return this.persist(withUpdatedPrompt(this.list(), item));
  }

  remove(id: string): Promise<void> {
    return this.persist(withoutPrompt(this.list(), id));
  }

  removeForScope(scope: PromptScope): Promise<void> {
    return this.persist(withoutPromptScope(this.list(), scope));
  }
}
