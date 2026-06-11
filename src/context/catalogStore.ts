import * as vscode from "vscode";
import { SourceCatalog } from "./catalogCache";

/** Per-source pre-cached catalog persistence — same disk pattern as
 *  SchemaStore (global storage, one JSON per source, wiped with the source). */
export class CatalogStore {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly memory = new Map<string, SourceCatalog>();
  private loaded = false;

  constructor(private readonly storageUri: vscode.Uri) {}

  private dir(): vscode.Uri {
    return vscode.Uri.joinPath(this.storageUri, "catalogs");
  }

  private file(sourceId: string): vscode.Uri {
    return vscode.Uri.joinPath(this.dir(), `${sourceId}.json`);
  }

  async preload(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const entries = await vscode.workspace.fs.readDirectory(this.dir());
      for (const [name, kind] of entries) {
        if (kind !== vscode.FileType.File || !name.endsWith(".json")) continue;
        try {
          const raw = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.dir(), name));
          this.memory.set(
            name.slice(0, -".json".length),
            JSON.parse(Buffer.from(raw).toString("utf8")) as SourceCatalog,
          );
        } catch {
          // Corrupt entry — a refresh rebuilds it.
        }
      }
      this.emitter.fire();
    } catch {
      // No cache directory yet.
    }
  }

  getSync(sourceId: string): SourceCatalog | undefined {
    return this.memory.get(sourceId);
  }

  async set(sourceId: string, catalog: SourceCatalog): Promise<void> {
    this.memory.set(sourceId, catalog);
    await vscode.workspace.fs.createDirectory(this.dir());
    await vscode.workspace.fs.writeFile(
      this.file(sourceId),
      Buffer.from(JSON.stringify(catalog), "utf8"),
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
