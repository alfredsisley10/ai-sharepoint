import * as vscode from "vscode";
import { ContextSource, Project } from "./types";

export type { Project } from "./types";
export { INSTRUCTIONS_MAX_CHARS } from "./types";


const PROJECTS_KEY = "aiSharePoint.projects";
const ACTIVE_KEY = "aiSharePoint.activeProjectId";


export class ProjectsStore {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly state: vscode.Memento) {}

  list(): Project[] {
    return [...(this.state.get<Project[]>(PROJECTS_KEY) ?? [])].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  get(id: string): Project | undefined {
    return this.list().find((p) => p.id === id);
  }

  async upsert(project: Project): Promise<void> {
    const next = this.list().filter((p) => p.id !== project.id);
    next.push(project);
    await this.state.update(PROJECTS_KEY, next);
    this.emitter.fire();
  }

  async remove(id: string): Promise<void> {
    await this.state.update(PROJECTS_KEY, this.list().filter((p) => p.id !== id));
    if (this.activeId() === id) await this.setActive(undefined);
    this.emitter.fire();
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
    this.emitter.fire();
  }

  /** Scope a source list to the active project (no project = everything). */
  scope(sources: ContextSource[]): ContextSource[] {
    const active = this.active();
    if (!active) return sources;
    const ids = new Set(active.sourceIds);
    return sources.filter((s) => ids.has(s.id));
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
      await this.state.update(PROJECTS_KEY, next);
      this.emitter.fire();
    }
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
