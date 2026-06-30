import * as vscode from "vscode";
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
export class PromptStore {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly state: vscode.Memento) {}

  list(): PromptItem[] {
    return this.state.get<PromptItem[]>(KEY) ?? [];
  }

  listForScope(scope: PromptScope): PromptItem[] {
    return listPromptsForScope(this.list(), scope);
  }

  get(id: string): PromptItem | undefined {
    return this.list().find((p) => p.id === id);
  }

  private async save(next: PromptItem[]): Promise<void> {
    await this.state.update(KEY, next);
    this.emitter.fire();
  }

  add(item: PromptItem): Promise<void> {
    return this.save(withPrompt(this.list(), item));
  }

  update(item: PromptItem): Promise<void> {
    return this.save(withUpdatedPrompt(this.list(), item));
  }

  remove(id: string): Promise<void> {
    return this.save(withoutPrompt(this.list(), id));
  }

  removeForScope(scope: PromptScope): Promise<void> {
    return this.save(withoutPromptScope(this.list(), scope));
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
