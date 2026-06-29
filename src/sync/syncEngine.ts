import * as vscode from "vscode";
import * as path from "node:path";
import { SiteConnection } from "../auth/sitesStore";
import { SiteAccess } from "../auth/siteAccess";
import { serializeSite, FileMap, MANAGED_PATH, SiteSnapshotInput } from "./serializer";
import { buildChangeReport, ChangeReport } from "./changeReport";
import { Logger } from "../core/log";

/**
 * Pull pipeline (PLAN §7 slice 1, ADR-0019 §6): gather live site → serialize
 * deterministically → diff against the working tree → caller previews/
 * confirms → apply (write + delete) and return the staged paths for commit.
 * No silent writes: apply() is only called after explicit user confirmation.
 */
export class SyncEngine {
  constructor(
    private readonly access: SiteAccess,
    private readonly log: Logger,
  ) {}

  /** Read the live site (read-only Graph calls; silent failures degrade). */
  async gatherSnapshot(
    conn: SiteConnection,
    progress?: (msg: string) => void,
  ): Promise<SiteSnapshotInput> {
    const client = this.access.clientFor(conn);
    progress?.("Resolving site…");
    const site = await client.getSite(conn.siteUrl);

    // Any collection that overflows the pagination cap makes the whole snapshot
    // an incomplete view — write-back then refuses deletions (ADR-0021 §4).
    let truncated = false;
    const markTruncated = () => {
      truncated = true;
    };

    progress?.("Reading lists…");
    const lists = await client.getLists(site.id, markTruncated);
    const listsWithColumns: SiteSnapshotInput["lists"] = [];
    for (const list of lists) {
      let columns: unknown[] = [];
      try {
        columns = await client.getListColumns(site.id, list.id, markTruncated);
      } catch {
        this.log.warn(`Columns unreadable for a list; schema captured without columns.`);
      }
      listsWithColumns.push({
        id: list.id,
        displayName: list.displayName,
        template: list.template,
        columns,
      });
    }

    progress?.("Reading pages…");
    let pages: SiteSnapshotInput["pages"] = [];
    let pagesUnavailable = false;
    try {
      const pageList = await client.getPages(site.id, markTruncated);
      for (const page of pageList) {
        progress?.(`Reading page: ${page.title}`);
        try {
          const full = await client.getPageContent(site.id, page.id);
          pages.push({
            id: page.id,
            title: full.title ?? page.title,
            name: full.name,
            pageLayout: full.pageLayout,
            canvasLayout: full.canvasLayout,
          });
        } catch {
          pages.push({ id: page.id, title: page.title }); // metadata only
        }
      }
    } catch {
      pagesUnavailable = true;
      pages = [];
    }

    return { site, lists: listsWithColumns, pages, pagesUnavailable, truncated };
  }

  /** Serialize + diff against the folder. Pure read — writes nothing. */
  async plan(
    conn: SiteConnection,
    folder: string,
    progress?: (msg: string) => void,
  ): Promise<{ files: FileMap; report: ChangeReport }> {
    const snapshot = await this.gatherSnapshot(conn, progress);
    progress?.("Serializing…");
    const files = serializeSite(snapshot);
    const existing = await this.readRepoFiles(folder);
    return { files, report: buildChangeReport(files, existing) };
  }

  /** Apply a confirmed plan; returns absolute paths to stage in git. */
  async apply(
    folder: string,
    files: FileMap,
    report: ChangeReport,
  ): Promise<string[]> {
    const staged: string[] = [];
    for (const rel of [...report.added, ...report.updated]) {
      const target = vscode.Uri.file(path.join(folder, rel));
      await vscode.workspace.fs.writeFile(
        target,
        Buffer.from(files.get(rel)!, "utf8"),
      );
      staged.push(target.fsPath);
    }
    for (const rel of report.removed) {
      const target = vscode.Uri.file(path.join(folder, rel));
      try {
        await vscode.workspace.fs.delete(target);
      } catch {
        // Already gone — staging the path below records the deletion anyway.
      }
      staged.push(target.fsPath);
    }
    return staged;
  }

  /** Current on-disk content of all sync-managed paths under the folder.
   *  Public: write-back parses these same files as the desired state. */
  async readRepoFiles(folder: string): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const root = vscode.Uri.file(folder);
    const tryRead = async (rel: string) => {
      try {
        const bytes = await vscode.workspace.fs.readFile(
          vscode.Uri.joinPath(root, ...rel.split("/")),
        );
        out.set(rel, Buffer.from(bytes).toString("utf8"));
      } catch {
        // missing — fine
      }
    };
    await tryRead(".aisharepoint/site.json");
    for (const dir of ["lists", "pages"]) {
      try {
        const entries = await vscode.workspace.fs.readDirectory(
          vscode.Uri.joinPath(root, dir),
        );
        for (const [name, type] of entries) {
          const rel = `${dir}/${name}`;
          if (type === vscode.FileType.File && MANAGED_PATH.test(rel)) {
            await tryRead(rel);
          }
        }
      } catch {
        // directory missing — fine
      }
    }
    return out;
  }
}
