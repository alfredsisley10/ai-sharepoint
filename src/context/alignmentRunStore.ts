import * as vscode from "vscode";
import { AlignmentRun } from "./alignmentRun";

/**
 * Durable storage for alignment runs (ADR-0049) — one JSON file per run under
 * `globalStorage`, mirroring the ADR-0042 content-cache store's shape.
 *
 * A run is checkpointed after **every** candidate stage transition, so the write
 * path is deliberately tiny and always full-document: the run is small (page
 * metadata + verdicts, never page bodies — those live in the content caches),
 * and a whole-file write is atomic enough for a single-writer, per-run file
 * while being immune to partial-merge bugs across a restart.
 *
 * Runs are non-secret (page titles/URLs, names, emails already visible to the
 * signed-in user) and stay local: never in settings, never in a diagnostics
 * export, never in the reference-config share.
 */
export class AlignmentRunStore {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly memory = new Map<string, AlignmentRun>();
  private loaded = false;

  constructor(private readonly storageUri: vscode.Uri) {}

  private dir(): vscode.Uri {
    return vscode.Uri.joinPath(this.storageUri, "alignment-runs");
  }

  private file(runId: string): vscode.Uri {
    return vscode.Uri.joinPath(this.dir(), `${runId}.json`);
  }

  /** Load every persisted run once. A corrupt file is skipped rather than
   *  failing activation — one bad run must not cost the user the others. */
  async preload(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const entries = await vscode.workspace.fs.readDirectory(this.dir());
      for (const [name, kind] of entries) {
        if (kind !== vscode.FileType.File || !name.endsWith(".json")) continue;
        try {
          const raw = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.dir(), name));
          const run = JSON.parse(Buffer.from(raw).toString("utf8")) as AlignmentRun;
          if (run?.id) this.memory.set(run.id, run);
        } catch {
          // Unreadable/corrupt run file — skip it.
        }
      }
    } catch {
      // No runs directory yet.
    }
    this.emitter.fire();
  }

  list(): AlignmentRun[] {
    return [...this.memory.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(runId: string): AlignmentRun | undefined {
    return this.memory.get(runId);
  }

  /** Runs with work left — what "Resume" offers after a restart. */
  resumable(): AlignmentRun[] {
    return this.list().filter((r) => r.status !== "complete");
  }

  /** The checkpoint. Called after every stage transition. */
  async save(run: AlignmentRun): Promise<void> {
    this.memory.set(run.id, run);
    await vscode.workspace.fs.createDirectory(this.dir());
    await vscode.workspace.fs.writeFile(this.file(run.id), Buffer.from(JSON.stringify(run), "utf8"));
    this.emitter.fire();
  }

  async remove(runId: string): Promise<void> {
    this.memory.delete(runId);
    try {
      await vscode.workspace.fs.delete(this.file(runId));
    } catch {
      // Nothing persisted yet.
    }
    this.emitter.fire();
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
