import * as vscode from "vscode";
import { SourceSchema } from "./db/schemaIndex";

/**
 * Per-source schema persistence (ADR-0024): one JSON file per source under
 * the extension's global storage. Schema catalogs are non-secret metadata
 * (table/column names + types) but can be large, so they live on disk, not
 * in Memento state. Removed with the source.
 */
export class SchemaStore {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly memory = new Map<string, SourceSchema>();
  private loaded = false;

  constructor(private readonly storageUri: vscode.Uri) {}

  private dir(): vscode.Uri {
    return vscode.Uri.joinPath(this.storageUri, "schemas");
  }

  private file(sourceId: string): vscode.Uri {
    // Source ids are UUIDs — path-safe by construction.
    return vscode.Uri.joinPath(this.dir(), `${sourceId}.json`);
  }

  /** Load everything once (cheap: small JSON files) so views can render
   *  schema status synchronously. */
  async preload(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const entries = await vscode.workspace.fs.readDirectory(this.dir());
      for (const [name, kind] of entries) {
        if (kind !== vscode.FileType.File || !name.endsWith(".json")) continue;
        const id = name.slice(0, -".json".length);
        try {
          const raw = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.dir(), name));
          this.memory.set(id, JSON.parse(Buffer.from(raw).toString("utf8")) as SourceSchema);
        } catch {
          // Corrupt cache entry — ignored; a refresh rebuilds it.
        }
      }
      this.emitter.fire();
    } catch {
      // Directory doesn't exist yet — nothing cached.
    }
  }

  /** Synchronous view of what preload/set have seen this session. */
  getSync(sourceId: string): SourceSchema | undefined {
    return this.memory.get(sourceId);
  }

  async set(sourceId: string, schema: SourceSchema): Promise<void> {
    this.memory.set(sourceId, schema);
    await vscode.workspace.fs.createDirectory(this.dir());
    await vscode.workspace.fs.writeFile(
      this.file(sourceId),
      Buffer.from(JSON.stringify(schema), "utf8"),
    );
    this.emitter.fire();
  }

  async remove(sourceId: string): Promise<void> {
    this.memory.delete(sourceId);
    await vscode.workspace.fs.delete(this.file(sourceId)).then(
      () => undefined,
      () => undefined,
    );
    this.emitter.fire();
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
