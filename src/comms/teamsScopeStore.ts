import * as vscode from "vscode";
import { TeamsScopeEntry, TeamsScope, teamsScopeKey } from "./teamsScope";

const KEY = "aiSharePoint.teamsScopes";

/**
 * Persists the read-only Teams scopes a user has registered (chats/channels
 * @sharepoint may read). Global state — survives folder switches like other
 * user-level resources. Holds only ids/labels, never message content or tokens.
 * Multiple scopes may be registered (per connection); deduped by scope key.
 */
export class TeamsScopeStore {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly state: vscode.Memento) {}

  list(): TeamsScopeEntry[] {
    return this.state.get<TeamsScopeEntry[]>(KEY) ?? [];
  }

  listForConnection(connectionHandle: string): TeamsScopeEntry[] {
    return this.list().filter((s) => s.connectionHandle === connectionHandle);
  }

  get(id: string): TeamsScopeEntry | undefined {
    return this.list().find((s) => s.id === id);
  }

  findByScope(scope: TeamsScope): TeamsScopeEntry | undefined {
    const key = teamsScopeKey(scope);
    return this.list().find((s) => teamsScopeKey(s.scope) === key);
  }

  private async save(next: TeamsScopeEntry[]): Promise<void> {
    await this.state.update(KEY, next);
    this.emitter.fire();
  }

  /** Add a scope (replacing any with the same scope key). */
  async add(entry: TeamsScopeEntry): Promise<void> {
    const key = teamsScopeKey(entry.scope);
    await this.save([...this.list().filter((s) => teamsScopeKey(s.scope) !== key), entry]);
  }

  async remove(id: string): Promise<void> {
    await this.save(this.list().filter((s) => s.id !== id));
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
