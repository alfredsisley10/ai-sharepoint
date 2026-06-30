import * as vscode from "vscode";
import { FileSource, withFile, withoutFile } from "./fileSources";

const KEY = "aiSharePoint.fileSources";

/**
 * Persists registered file context sources (local spreadsheets/CSVs and, later,
 * OneDrive/shared SharePoint files). Global state; stores only the pointer +
 * label + kind, never file content. Pure logic lives in fileSources.ts.
 */
export class FileSourcesStore {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly state: vscode.Memento) {}

  list(): FileSource[] {
    return this.state.get<FileSource[]>(KEY) ?? [];
  }

  get(id: string): FileSource | undefined {
    return this.list().find((f) => f.id === id);
  }

  private async save(next: FileSource[]): Promise<void> {
    await this.state.update(KEY, next);
    this.emitter.fire();
  }

  add(item: FileSource): Promise<void> {
    return this.save(withFile(this.list(), item));
  }

  remove(id: string): Promise<void> {
    return this.save(withoutFile(this.list(), id));
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
