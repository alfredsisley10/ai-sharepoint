import * as vscode from "vscode";
import { ContextSource, Project, normSiteUrl, scopeMembers, rememberNote, forgetNotes, listNotes } from "./types";
import { MementoListStore } from "./mementoListStore";

export type { Project } from "./types";
export {
  INSTRUCTIONS_MAX_CHARS,
  GOALS_MAX_CHARS,
  AI_CONTEXT_MAX_CHARS,
  appendAiNote,
  rememberNote,
  forgetNotes,
  listNotes,
} from "./types";


const PROJECTS_KEY = "aiSharePoint.projects";
const ACTIVE_KEY = "aiSharePoint.activeProjectId";


export class ProjectsStore extends MementoListStore<Project> {
  constructor(state: vscode.Memento) {
    super(state, PROJECTS_KEY);
  }

  list(): Project[] {
    return [...this.all()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): Project | undefined {
    return this.list().find((p) => p.id === id);
  }

  async upsert(project: Project): Promise<void> {
    const next = this.list().filter((p) => p.id !== project.id);
    next.push(project);
    await this.persist(next);
  }

  async remove(id: string): Promise<void> {
    await this.persist(this.list().filter((p) => p.id !== id));
    if (this.activeId() === id) await this.setActive(undefined);
  }

  activeId(): string | undefined {
    return this.state.get<string>(ACTIVE_KEY) || undefined;
  }

  active(): Project | undefined {
    const id = this.activeId();
    return id ? this.get(id) : undefined;
  }

  async setActive(id: string | undefined): Promise<void> {
    await this.state.update(ACTIVE_KEY, id ?? "");
    this.notify();
  }

  /** Scope a source list to the active project (no project = everything). */
  scope(sources: ContextSource[]): ContextSource[] {
    const active = this.active();
    if (!active) return sources;
    const ids = new Set(active.sourceIds);
    return sources.filter((s) => ids.has(s.id));
  }

  /**
   * Scope SharePoint sites to the active project, by `siteUrl`.
   *
   * Back-compat matters here: `siteUrls` is additive, so a project saved before
   * sites could be scoped has it undefined. Treating that as "no sites" would
   * silently empty the Sites view for every existing project, so an absent
   * field means UNSCOPED (all sites), while an explicitly empty array means the
   * user deselected them all.
   */
  scopeSites<T extends { siteUrl: string }>(sites: T[]): T[] {
    const active = this.active();
    if (!active) return sites;
    return scopeMembers(sites, active.siteUrls?.map(normSiteUrl), (s) => normSiteUrl(s.siteUrl));
  }

  /** Scope attached file sources to the active project, by id. Absent field ⇒
   *  unscoped, for the same back-compat reason as `scopeSites`. */
  scopeFiles<T extends { id: string }>(files: T[]): T[] {
    const active = this.active();
    if (!active) return files;
    return scopeMembers(files, active.fileSourceIds, (f) => f.id);
  }

  /** AI-managed: dedup-aware remember — reports whether the note was newly
   *  added or merged into (reinforced) an existing near-duplicate. Returns
   *  undefined when the project is gone. */
  async rememberAiContext(
    projectId: string,
    note: string,
  ): Promise<{ status: "added" | "reinforced" } | undefined> {
    const project = this.get(projectId);
    if (!project) return undefined;
    const r = rememberNote(project.aiContext, note);
    await this.upsert({ ...project, aiContext: r.text || undefined });
    return { status: r.status };
  }

  /** AI-managed: forget notes matching a query. Returns the removed notes. */
  async forgetAiContext(projectId: string, query: string): Promise<string[]> {
    const project = this.get(projectId);
    if (!project) return [];
    const r = forgetNotes(project.aiContext, query);
    if (r.removed.length > 0) {
      await this.upsert({ ...project, aiContext: r.text || undefined });
    }
    return r.removed;
  }

  /** AI-managed: the project's saved learnings as individual items. */
  aiNotes(projectId: string): string[] {
    return listNotes(this.get(projectId)?.aiContext);
  }

  /** Replace/clear a project's AI-managed context (user reset). */
  async setAiContext(projectId: string, aiContext: string | undefined): Promise<void> {
    const project = this.get(projectId);
    if (!project) return;
    await this.upsert({ ...project, aiContext: aiContext?.trim() || undefined });
  }

  /** Drop a removed source from every project's membership. */
  async forgetSource(sourceId: string): Promise<void> {
    let changed = false;
    const next = this.list().map((p) => {
      if (!p.sourceIds.includes(sourceId)) return p;
      changed = true;
      return { ...p, sourceIds: p.sourceIds.filter((x) => x !== sourceId) };
    });
    if (changed) {
      await this.persist(next);
    }
  }

  /** Drop a removed SharePoint site from every project's membership (URL-keyed,
   *  trailing-slash/case tolerant — the same normalization `scopeSites` uses). */
  async forgetSite(siteUrl: string): Promise<void> {
    const target = normSiteUrl(siteUrl);
    let changed = false;
    const next = this.list().map((p) => {
      if (!p.siteUrls?.some((u) => normSiteUrl(u) === target)) return p;
      changed = true;
      return { ...p, siteUrls: p.siteUrls.filter((u) => normSiteUrl(u) !== target) };
    });
    if (changed) await this.persist(next);
  }

  /** Drop a removed file source from every project's membership. */
  async forgetFileSource(fileSourceId: string): Promise<void> {
    let changed = false;
    const next = this.list().map((p) => {
      if (!p.fileSourceIds?.includes(fileSourceId)) return p;
      changed = true;
      return { ...p, fileSourceIds: p.fileSourceIds.filter((x) => x !== fileSourceId) };
    });
    if (changed) await this.persist(next);
  }
}
