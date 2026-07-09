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
  renderKnowledgeEntry,
  hasKnowledge,
  buildResumeBrief,
  buildResumeSeedPrompt,
  slugify,
  transcriptHeader,
} from "./chatWorkspace";
import {
  SpaceDossier,
  DossierPage,
  groupByOwner,
  groupBySuggestedOwner,
  renderSuggestedOwnerOutreachDraft,
  renderInventoryJson,
  renderInventoryMarkdown,
  renderOwnersMarkdown,
  renderOutreachDraft,
  renderCurrentContent,
  renderRecommendedScaffold,
  dossierSheets,
  flagsFor,
  pageFolderName,
} from "./spaceDossier";
import { buildXlsx } from "./files/xlsxWrite";
import { sheetToCsv } from "./files/sheet";
import { ensureGitignored } from "./files/gitignore";

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

  private async exists(uri: vscode.Uri): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(uri);
      return true;
    } catch {
      return false;
    }
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
  async recordTurn(project: Project, turn: WorkspaceTurn, newSession: boolean, conversationKey?: string): Promise<void> {
    if (!this.enabled(project.id)) return;
    const CAP = 8000;
    const safe: WorkspaceTurn = {
      at: turn.at,
      model: turn.model,
      prompt: redactText(turn.prompt),
      reply: redactText(turn.reply),
      ...(turn.context?.trim() ? { context: redactText(turn.context).slice(0, CAP) } : {}),
      ...(turn.toolResults?.length
        ? { toolResults: turn.toolResults.map((t) => ({ name: t.name, detail: redactText(t.detail).slice(0, CAP) })) }
        : {}),
    };
    await this.queue(project.id, async () => {
      const loaded = await this.loadManifest(project);
      const { manifest, session } = foldTurn(loaded, safe, newSession, this.now(), conversationKey);
      const fileUri = vscode.Uri.joinPath(this.baseUri(project), session.file);
      let existing = session.turns === 1 ? "" : (await this.readText(fileUri)) ?? "";
      if (!existing) existing = transcriptHeader(session, project.name);
      await this.writeText(fileUri, existing + renderTurn(safe, session.turns));
      // Knowledge cache: the connected context + tool results, so a later chat
      // (or a resume) can reuse what was gathered instead of re-fetching.
      if (hasKnowledge(safe)) {
        const kUri = vscode.Uri.joinPath(this.baseUri(project), "context", `${session.id}.md`);
        const kExisting = (await this.readText(kUri)) ?? `# ${project.name} — cached context (session ${session.id})\n\n`;
        await this.writeText(kUri, kExisting + renderKnowledgeEntry(safe, session.turns));
      }
      await this.writeText(this.manifestUri(project), JSON.stringify(manifest, null, 2));
      await this.writeText(this.summaryUri(project), renderSummary(manifest, project));
      this.emitter.fire();
    });
  }

  /** Write RESUME.md (a compact restart brief) and return it plus a short seed
   *  prompt to prefill a new chat. Used by "Resume Chat from Project Workspace". */
  async writeResume(project: Project): Promise<{ uri: vscode.Uri; seedPrompt: string } | undefined> {
    if (!this.enabled(project.id)) return undefined;
    return this.queue(project.id, async () => {
      const manifest = await this.loadManifest(project);
      const uri = vscode.Uri.joinPath(this.baseUri(project), "RESUME.md");
      await this.writeText(uri, buildResumeBrief(manifest, project));
      return { uri, seedPrompt: buildResumeSeedPrompt(manifest, project.name) };
    });
  }

  /** The `space/<KEY>/` folder within a project's workspace. */
  dossierUri(project: Project, spaceKey: string): vscode.Uri {
    const safe = spaceKey.replace(/[^A-Za-z0-9._-]/g, "-") || "space";
    return vscode.Uri.joinPath(this.baseUri(project), "space", safe);
  }

  /**
   * Write a Confluence space dossier into the project workspace: the inventory
   * (markdown + JSON), the by-owner view, an .xlsx workbook, and (optionally)
   * outreach drafts — one per owner with flagged pages, plus one per SUGGESTED
   * target owner (pages with no owner tag whose owner detection proposed a
   * contributor, so ownership can be established). Ensures the
   * workspace exists first. Returns the dossier folder. Content is derived from
   * the user's own Confluence read — not redacted (owner emails are needed for
   * coordination).
   */
  async writeDossier(
    project: Project,
    dossier: SpaceDossier,
    opts: { outreach?: boolean } = {},
  ): Promise<vscode.Uri> {
    return this.queue(project.id, async () => {
      if (!this.enabled(project.id)) await this.setEnabled(project.id, true);
      const dir = this.dossierUri(project, dossier.spaceKey);
      await vscode.workspace.fs.createDirectory(dir);
      await this.ensureGitignored();
      await this.writeText(vscode.Uri.joinPath(dir, "inventory.md"), renderInventoryMarkdown(dossier));
      await this.writeText(vscode.Uri.joinPath(dir, "inventory.json"), renderInventoryJson(dossier));
      await this.writeText(vscode.Uri.joinPath(dir, "owners.md"), renderOwnersMarkdown(dossier));
      const sheets = dossierSheets(dossier);
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, "dossier.xlsx"), buildXlsx(sheets));
      // CSV alongside the workbook for tools/imports that prefer it (Pages =
      // the page inventory, Owners = the per-owner rollup).
      for (const s of sheets) {
        await this.writeText(vscode.Uri.joinPath(dir, `${s.name.toLowerCase()}.csv`), sheetToCsv(s));
      }

      // Per-page tracking for pages whose current content was cached: refresh
      // current.md every run, but write the recommended-revision scaffold only
      // once so an owner/assistant's edits survive a re-run.
      for (const p of dossier.pages) {
        if (p.content === undefined) continue;
        const pageDir = vscode.Uri.joinPath(dir, "pages", pageFolderName(p.id));
        await vscode.workspace.fs.createDirectory(pageDir);
        await this.writeText(vscode.Uri.joinPath(pageDir, "current.md"), renderCurrentContent(p));
        const recUri = vscode.Uri.joinPath(pageDir, "recommended.md");
        if (!(await this.exists(recUri))) {
          await this.writeText(recUri, renderRecommendedScaffold(p));
        }
      }

      if (opts.outreach) {
        const outreachDir = vscode.Uri.joinPath(dir, "outreach");
        await vscode.workspace.fs.createDirectory(outreachDir);
        for (const group of groupByOwner(dossier)) {
          if (group.owner.sam === "(unassigned)") continue;
          if (!group.pages.some((p) => flagsFor(p).flagged)) continue;
          const file = `${group.owner.sam.replace(/[^A-Za-z0-9._-]/g, "-") || "owner"}.md`;
          await this.writeText(
            vscode.Uri.joinPath(outreachDir, file),
            renderOutreachDraft(group, dossier.spaceKey, dossier.generatedAt),
          );
        }
        // SUGGESTED target owners get their own drafts (establish-ownership
        // asks, distinct from the fix-your-pages asks above). The `-suggested`
        // suffix keeps them from colliding with an assigned-owner draft for
        // the same person.
        for (const group of groupBySuggestedOwner(dossier)) {
          const file = `${group.sam.replace(/[^A-Za-z0-9._-]/g, "-") || "owner"}-suggested.md`;
          await this.writeText(
            vscode.Uri.joinPath(outreachDir, file),
            renderSuggestedOwnerOutreachDraft(group, dossier.spaceKey, dossier.generatedAt),
          );
        }
      }
      this.emitter.fire();
      return dir;
    });
  }

  /** The recommended-revision file for a page within a space dossier. */
  recommendedRevisionUri(project: Project, spaceKey: string, pageId: string): vscode.Uri {
    return vscode.Uri.joinPath(this.dossierUri(project, spaceKey), "pages", pageFolderName(pageId), "recommended.md");
  }

  /**
   * Save a recommended revision for a page (e.g. one the assistant proposed
   * during a chat), so it can be shown to the owner during outreach. Writes both
   * `current.md` (if content is supplied) and `recommended.md`, creating the page
   * folder as needed. Overwrites the recommended file — this is a deliberate save.
   */
  async saveRecommendedRevision(
    project: Project,
    spaceKey: string,
    page: { id: string; title: string; url: string; current?: string; recommendation: string },
  ): Promise<vscode.Uri> {
    return this.queue(project.id, async () => {
      if (!this.enabled(project.id)) await this.setEnabled(project.id, true);
      const pageDir = vscode.Uri.joinPath(this.dossierUri(project, spaceKey), "pages", pageFolderName(page.id));
      await vscode.workspace.fs.createDirectory(pageDir);
      await this.ensureGitignored();
      const dp: DossierPage = {
        id: page.id,
        title: page.title,
        url: page.url,
        owners: [],
        hasOwnerLabel: false,
        brokenLinks: 0,
        issues: [],
        ...(page.current !== undefined ? { content: page.current } : {}),
      };
      if (page.current !== undefined) {
        await this.writeText(vscode.Uri.joinPath(pageDir, "current.md"), renderCurrentContent(dp));
      }
      const body = [
        `# Recommended revision — ${page.title}`,
        "",
        `_${page.url} · draft for owner review._`,
        "",
        "## Recommended revision",
        "",
        page.recommendation.trim(),
        "",
      ].join("\n");
      const recUri = vscode.Uri.joinPath(pageDir, "recommended.md");
      await this.writeText(recUri, body);
      this.emitter.fire();
      return recUri;
    });
  }

  /** Append `.ai-sharepoint/` to the workspace root .gitignore (idempotent) so
   *  chat content isn't committed by accident. No-op without a workspace folder. */
  private async ensureGitignored(): Promise<void> {
    await ensureGitignored(vscode.workspace.workspaceFolders?.[0]?.uri, GITIGNORE_LINE);
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
