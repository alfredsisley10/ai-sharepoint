import * as vscode from "vscode";
import { OutlookWorkspace } from "./outlookWorkspace";

const KEY = "aiSharePoint.outlookWorkspaces";

/**
 * Persists the read-only Outlook workspace config per Microsoft 365 connection
 * (cacheHandle). Global state — survives folder switches like other user-level
 * resources. Holds only ids/names/scope, never mail content or tokens.
 */
export class OutlookWorkspaceStore {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly state: vscode.Memento) {}

  list(): OutlookWorkspace[] {
    return this.state.get<OutlookWorkspace[]>(KEY) ?? [];
  }

  get(connectionHandle: string): OutlookWorkspace | undefined {
    return this.list().find((w) => w.connectionHandle === connectionHandle);
  }

  private async save(next: OutlookWorkspace[]): Promise<void> {
    await this.state.update(KEY, next);
    this.emitter.fire();
  }

  /** Insert or replace the workspace for a connection (one per connection). */
  async upsert(ws: OutlookWorkspace): Promise<void> {
    await this.save([...this.list().filter((w) => w.connectionHandle !== ws.connectionHandle), ws]);
  }

  async remove(connectionHandle: string): Promise<void> {
    await this.save(this.list().filter((w) => w.connectionHandle !== connectionHandle));
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
