import * as vscode from "vscode";
import { CommDraft } from "./outbox";

const KEY = "aiSharePoint.commsOutbox";

/** Pending communication drafts (non-secret descriptors). A draft leaves the
 *  outbox only by being sent (after explicit approval) or discarded. */
export class OutboxStore {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly state: vscode.Memento) {}

  list(): CommDraft[] {
    return [...(this.state.get<CommDraft[]>(KEY) ?? [])].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  }

  get(id: string): CommDraft | undefined {
    return this.list().find((d) => d.id === id);
  }

  private async save(next: CommDraft[]): Promise<void> {
    await this.state.update(KEY, next);
    this.emitter.fire();
  }

  add(draft: CommDraft): Promise<void> {
    return this.save([...this.list(), draft]);
  }

  update(draft: CommDraft): Promise<void> {
    return this.save(this.list().map((d) => (d.id === draft.id ? draft : d)));
  }

  remove(id: string): Promise<void> {
    return this.save(this.list().filter((d) => d.id !== id));
  }

  count(): number {
    return this.list().length;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
