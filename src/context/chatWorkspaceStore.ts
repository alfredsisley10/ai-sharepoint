import * as vscode from "vscode";
import { Project } from "./types";
import { redactText } from "../core/redaction";
import {
  WorkspaceManifest,
  WorkspaceTurn,
  emptyManifest,
  foldTurn,
  renderSummary,
  renderTurn,
  slugify,
  transcriptHeader,
} from "./chatWorkspace";

/**
 * Filesystem + redaction layer for project chat workspaces (ADR-0048). Writes
 * the manifest, SUMMARY, and per-session transcripts that chatWorkspace.ts
 * (pure) renders. Opt-in: nothing is written for a project until `create()` runs
 * (via the "Start Project Workspace" command), after which `enabled()` gates the
 * per-turn mirroring in the chat path.
 */

const ENABLED_KEY = "aiSharePoint.chatWorkspaces";
const GITIGNORE_LINE = ".ai-sharepoint/";

const enc = new TextEncoder();
const dec = new TextDecoder();

export class ChatWorkspaceStore {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  /** Serialize writes per project so interleaved turns can't clobber the
   *  manifest/summary (read-modify-write on the manifest). */
  private chains = new Map<string, Promise<unknown>>();

  constructor(
    private readonly memento: vscode.Memento,
    private readonly globalStorageUri: vscode.Uri,
    private readonly now: () => string,
  ) {}

  /** Project ids with an active workspace (sync — safe in the chat hot path). */
  private enabledIds(): string[] {
    return this.memento.get<string[]>(ENABLED_KEY, []);
  }

  enabled(projectId: string): boolean {
    return this.enabledIds().includes(projectId);
  }

  private async setEnabled(projectId: string, on: boolean): Promise<void> {
    const cur = new Set(this.enabledIds());
    if (on) cur.add(projectId);
    else cur.delete(projectId);
    await this.memento.update(ENABLED_KEY, [...cur]);
    this.emitter.fire();
  }

  /** Workspace root for a project: `<folder>/.ai-sharepoint/projects/<slug>` when
   *  a folder is open, else under the extension's global storage. */
  baseUri(project: Project): vscode.Uri {
    const slug = slugify(project.name);
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    return folder
      ? vscode.Uri.joinPath(folder, ".ai-sharepoint", "projects", slug)
      : vscode.Uri.joinPath(this.globalStorageUri, "chat-workspaces", slug);
  }

  summaryUri(project: Project): vscode.Uri {
    return vscode.Uri.joinPath(this.baseUri(project), "SUMMARY.md");
  }

  private manifestUri(project: Project): vscode.Uri {
    return vscode.Uri.joinPath(this.baseUri(project), "manifest.json");
  }

  private async readText(uri: vscode.Uri): Promise<string | undefined> {
    try {
      return dec.decode(await vscode.workspace.fs.readFile(uri));
    } catch {
      return undefined;
    }
  }

  private async writeText(uri: vscode.Uri, text: string): Promise<void> {
    await vscode.workspace.fs.writeFile(uri, enc.encode(text));
  }

  private async loadManifest(project: Project): Promise<WorkspaceManifest> {
    const raw = await this.readText(this.manifestUri(project));
    if (raw) {
      try {
        const m = JSON.parse(raw) as WorkspaceManifest;
        if (m && m.version === 1 && Array.isArray(m.sessions)) return m;
      } catch {
        /* corrupt — fall through to a fresh manifest */
      }
    }
    return emptyManifest(project.id, project.name, this.now());
  }

  /** Serialize an operation on a project's on-disk state. */
  private queue<T>(projectId: string, op: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(projectId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(op);
    this.chains.set(projectId, next);
    return next;
  }

  /** Create (or re-enable) a project's chat workspace and return its folder. */
  async create(project: Project): Promise<vscode.Uri> {
    return this.queue(project.id, async () => {
      const base = this.baseUri(project);
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(base, "sessions"));
      const manifest = await this.loadManifest(project);
      await this.writeText(this.manifestUri(project), JSON.stringify(manifest, null, 2));
      await this.writeText(this.summaryUri(project), renderSummary(manifest, project));
      await this.ensureGitignored();
      await this.setEnabled(project.id, true);
      return base;
    });
  }

  async disable(projectId: string): Promise<void> {
    await this.setEnabled(projectId, false);
  }

  /**
   * Mirror one completed chat turn into the workspace: append to the session
   * transcript and regenerate the manifest + SUMMARY. No-op (and never throws
   * into the chat path) unless the project's workspace is enabled. `newSession`
   * starts a fresh session file (first turn of a conversation).
   */
  async recordTurn(project: Project, turn: WorkspaceTurn, newSession: boolean): Promise<void> {
    if (!this.enabled(project.id)) return;
    const safe: WorkspaceTurn = {
      at: turn.at,
      model: turn.model,
      prompt: redactText(turn.prompt),
      reply: redactText(turn.reply),
    };
    await this.queue(project.id, async () => {
      const loaded = await this.loadManifest(project);
      const { manifest, session } = foldTurn(loaded, safe, newSession, this.now());
      const fileUri = vscode.Uri.joinPath(this.baseUri(project), session.file);
      let existing = session.turns === 1 ? "" : (await this.readText(fileUri)) ?? "";
      if (!existing) existing = transcriptHeader(session, project.name);
      await this.writeText(fileUri, existing + renderTurn(safe, session.turns));
      await this.writeText(this.manifestUri(project), JSON.stringify(manifest, null, 2));
      await this.writeText(this.summaryUri(project), renderSummary(manifest, project));
      this.emitter.fire();
    });
  }

  /** Append `.ai-sharepoint/` to the workspace root .gitignore (idempotent) so
   *  chat content isn't committed by accident. No-op without a workspace folder. */
  private async ensureGitignored(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!folder) return;
    const gi = vscode.Uri.joinPath(folder, ".gitignore");
    const cur = await this.readText(gi);
    if (cur === undefined) {
      await this.writeText(gi, `${GITIGNORE_LINE}\n`).catch(() => undefined);
      return;
    }
    if (cur.split(/\r?\n/).some((l) => l.trim() === GITIGNORE_LINE || l.trim() === ".ai-sharepoint")) return;
    const sep = cur.endsWith("\n") ? "" : "\n";
    await this.writeText(gi, `${cur}${sep}${GITIGNORE_LINE}\n`).catch(() => undefined);
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
