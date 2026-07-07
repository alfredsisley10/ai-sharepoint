import * as vscode from "vscode";
import { ProjectsStore } from "../context/projectsStore";
import { ContextSourcesStore } from "../context/sourcesStore";
import { ContextService } from "../context/contextService";
import { ChatWorkspaceStore } from "../context/chatWorkspaceStore";
import { WorkItemsStore } from "../context/workItemsStore";
import { ContextSource, Project } from "../context/types";
import { summarizeDossier, dossierWorkItemSeeds } from "../context/spaceDossier";
import { TelemetryService } from "../diagnostics/telemetry";
import { ErrorReportStore } from "../diagnostics/errorReports";
import { redactError } from "../core/redaction";
import { releaseExpired, expiredNotice } from "../branding/releaseExpiry";

/**
 * Chat tools for the project-workspace + Confluence space-dossier flow (ADR-0048).
 *
 * These close the gap where the chat OFFERED the cleanup flow (via the workspace
 * suggestion + the "Build space dossier" follow-ups) but couldn't actually run
 * it — everything was command-only. Now the assistant can start a workspace,
 * build a space dossier (owners + stale/data-quality flags → work items + owner
 * outreach), and read the workspace summary to resume. All local operational
 * state (files under the project workspace + the local work backlog), so — like
 * the work-item tools — they are not approval-gated.
 */

export interface DossierDeps {
  contextService: ContextService;
  chatWorkspace: ChatWorkspaceStore;
  workItems: WorkItemsStore;
}

/** Build a dossier for a space, write it into the project workspace, and open a
 *  (de-duplicated) work item per flagged page. Shared by the command and the
 *  chat tool. Returns the dossier, its folder, and how many work items opened. */
export async function buildDossierInto(
  project: Project,
  source: ContextSource,
  spaceKey: string,
  deps: DossierDeps,
  onProgress?: (done: number, total: number) => void,
): Promise<{ dir: vscode.Uri; flagged: number; created: number; total: number; captured: number; truncated: boolean }> {
  const dossier = await deps.contextService.buildConfluenceSpaceDossier(source, spaceKey, { ...(onProgress ? { onProgress } : {}) });
  const dir = await deps.chatWorkspace.writeDossier(project, dossier, { outreach: true });
  const existingRefs = new Set(
    deps.workItems
      .list()
      .filter((w) => w.tags?.includes(spaceKey) && w.target.ref)
      .map((w) => w.target.ref),
  );
  const seeds = dossierWorkItemSeeds(dossier, source.alias ?? source.displayName).filter((s) => !existingRefs.has(s.target.ref));
  for (const seed of seeds) await deps.workItems.create(seed).catch(() => undefined);
  const s = summarizeDossier(dossier);
  return { dir, flagged: s.flagged, created: seeds.length, total: s.totalPages, captured: s.captured, truncated: s.truncated };
}

export function registerDossierTools(
  projects: ProjectsStore,
  sources: ContextSourcesStore,
  contextService: ContextService,
  chatWorkspace: ChatWorkspaceStore,
  workItems: WorkItemsStore,
  telemetry: TelemetryService,
  errors: ErrorReportStore,
): vscode.Disposable[] {
  const text = (s: string) => new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(s)]);
  const guard = <I>(name: string, run: (i: I) => Promise<string>) => ({
    async invoke(options: vscode.LanguageModelToolInvocationOptions<I>) {
      if (releaseExpired()) return text(expiredNotice());
      try {
        return text(await run(options.input));
      } catch (e) {
        errors.capture(name, e);
        return text(`Error: ${redactError(e instanceof Error ? e : new Error(String(e))).message}`);
      }
    },
  });

  const confluenceInProject = (hint?: string): ContextSource | undefined => {
    const scoped = projects.scope(sources.list()).filter((s) => s.type === "confluence");
    if (!hint) return scoped[0];
    const h = hint.trim().toLowerCase();
    return (
      scoped.find((s) => s.alias?.toLowerCase() === h) ??
      scoped.find((s) => s.displayName.toLowerCase() === h) ??
      scoped.find((s) => s.displayName.toLowerCase().includes(h)) ??
      scoped[0]
    );
  };

  return [
    vscode.lm.registerTool<{ enable?: boolean }>(
      "aisharepoint_start_project_workspace",
      guard("aisharepoint_start_project_workspace", async () => {
        const project = projects.active();
        if (!project) return "No active project — create/activate one in the Projects view first, then retry.";
        if (chatWorkspace.enabled(project.id)) return `The "${project.name}" project already has a chat workspace; each turn is mirrored there.`;
        const base = await chatWorkspace.create(project);
        telemetry.record("project.workspace", { action: "start" });
        return `Started a chat workspace for "${project.name}" at ${base.fsPath}. From now on this conversation is mirrored there (transcript + rolling SUMMARY + cached context) so it survives the chat's context window and can be resumed.`;
      }),
    ),

    vscode.lm.registerTool<{ spaceKey: string; source?: string }>(
      "aisharepoint_build_space_dossier",
      guard("aisharepoint_build_space_dossier", async (i) => {
        const project = projects.active();
        if (!project) return "No active project — the dossier is saved into a project workspace, so create/activate one first (Projects view), then retry.";
        if (!i.spaceKey?.trim()) return "A Confluence spaceKey is required (Space Settings → Space Details → Key).";
        const source = confluenceInProject(i.source);
        if (!source) return "No Confluence source is available in this project — add one (Add Context Source) and include it in the project.";
        const r = await buildDossierInto(project, source, i.spaceKey.trim(), { contextService, chatWorkspace, workItems });
        telemetry.record("project.dossier", { space: "redacted" });
        return [
          `Built a content dossier for Confluence space ${i.spaceKey.trim()} into the "${project.name}" workspace (${r.dir.fsPath}).`,
          `Reviewed ${r.captured}/${r.total} page(s)${r.truncated ? " (capped)" : ""}; ${r.flagged} flagged (stale / no active owner / data-quality). Opened ${r.created} new remediation work item(s).`,
          `Artifacts: inventory.md (+ .json), owners.md (grouped by owner), dossier.xlsx, and per-owner outreach drafts under outreach/. Recommended-revision scaffolds are under pages/<id>/.`,
          `Next: use list_work_items to see the backlog, resolve_page_owners / review_page_currency for detail, recommend_page_revision to propose fixes, and draft_communication to reach owners.`,
        ].join(" ");
      }),
    ),

    vscode.lm.registerTool<Record<string, never>>(
      "aisharepoint_workspace_summary",
      guard("aisharepoint_workspace_summary", async () => {
        const project = projects.active();
        if (!project) return "No active project.";
        if (!chatWorkspace.enabled(project.id)) return `The "${project.name}" project has no chat workspace yet — call start_project_workspace to begin tracking, or ask the user to run "Start Project Workspace".`;
        const uri = chatWorkspace.summaryUri(project);
        try {
          const bytes = await vscode.workspace.fs.readFile(uri);
          const md = new TextDecoder().decode(bytes);
          return `Current "${project.name}" workspace SUMMARY (use it to resume without re-fetching):\n\n${md.slice(0, 6000)}`;
        } catch {
          return `The "${project.name}" workspace has no SUMMARY yet — it fills in as the conversation is mirrored.`;
        }
      }),
    ),
  ];
}
