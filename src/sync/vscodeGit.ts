import * as vscode from "vscode";
import { AppError } from "../core/errors";

/**
 * Thin, duck-typed view of the VS Code Git extension API (ADR-0019 §1).
 * Using the user's own git means credentials (credential manager, SSH,
 * enterprise SSO/PATs) work for github.com and GHES with zero secrets held
 * by this extension, and every operation shows in the Source Control UI.
 */

export interface GitRemote {
  name: string;
  fetchUrl?: string;
  pushUrl?: string;
}

export interface GitCommit {
  hash: string;
  message: string;
  authorDate?: Date;
  commitDate?: Date;
}

export interface GitRepository {
  rootUri: vscode.Uri;
  state: {
    HEAD?: { name?: string };
    remotes: GitRemote[];
    /** Uncommitted working-tree changes (used as a clean-tree guard). */
    workingTreeChanges?: unknown[];
    indexChanges?: unknown[];
  };
  add(paths: string[]): Promise<void>;
  commit(message: string): Promise<void>;
  push(remoteName?: string, branchName?: string, setUpstream?: boolean): Promise<void>;
  addRemote(name: string, url: string): Promise<void>;
  createBranch(name: string, checkout: boolean): Promise<void>;
  checkout(treeish: string): Promise<void>;
  /** Commit history (newest first). */
  log(options?: { maxEntries?: number }): Promise<GitCommit[]>;
  /** File content at a ref, e.g. show("abc123", "lists/x.json"). */
  show(ref: string, path: string): Promise<string>;
}

interface GitApi {
  repositories: GitRepository[];
  init(root: vscode.Uri): Promise<GitRepository | null>;
  openRepository(root: vscode.Uri): Promise<GitRepository | null>;
}

export async function getGitApi(): Promise<GitApi> {
  const ext = vscode.extensions.getExtension<{ getAPI(version: 1): GitApi }>(
    "vscode.git",
  );
  if (!ext) {
    throw new AppError(
      "The built-in Git extension is unavailable (disabled, or git is not installed).",
      "config",
      "Git is required for site sync — install git and enable VS Code's Git extension.",
    );
  }
  const exports = ext.isActive ? ext.exports : await ext.activate();
  return exports.getAPI(1);
}

function findByRoot(api: GitApi, folder: vscode.Uri): GitRepository | undefined {
  const want = folder.fsPath.replace(/[\\/]+$/, "");
  return api.repositories.find(
    (r) => r.rootUri.fsPath.replace(/[\\/]+$/, "") === want,
  );
}

/**
 * Open the repo at `folder`, initializing one when none exists. Hardened for
 * the pilot failure "Could not initialize a Git repository": the Git
 * extension can create the repo on disk yet decline/delay opening it
 * (Restricted Mode, folder outside the workspace, async repository scan), so
 * this guards trust up front, retries discovery with backoff after init, and
 * fails with concrete remediation instead of a bare error.
 */
export async function openOrInitRepository(
  folder: vscode.Uri,
): Promise<GitRepository> {
  if (vscode.workspace.isTrusted === false) {
    throw new AppError(
      "Git operations are disabled in Restricted Mode.",
      "config",
      "This window is in Restricted Mode — choose “Trust” (Manage Workspace Trust) and retry.",
    );
  }
  const api = await getGitApi();

  const existing = (await api.openRepository(folder)) ?? findByRoot(api, folder);
  if (existing) return existing;

  let initError: string | undefined;
  try {
    const created = await api.init(folder);
    if (created) return created;
  } catch (err) {
    initError = err instanceof Error ? err.message : String(err);
  }

  // init() returning null/throwing does not always mean failure on disk —
  // the extension may simply not have opened the new repo yet. Retry
  // discovery briefly before giving up.
  for (let attempt = 0; attempt < 6; attempt++) {
    await new Promise((r) => setTimeout(r, 350));
    const found = (await api.openRepository(folder)) ?? findByRoot(api, folder);
    if (found) return found;
  }

  // Distinguish "git init never happened" from "repo exists but VS Code
  // won't open it" — the remediation differs.
  let gitDirExists = false;
  try {
    await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder, ".git"));
    gitDirExists = true;
  } catch {
    // no .git — init genuinely failed
  }
  if (gitDirExists) {
    throw new AppError(
      `The repository at ${folder.fsPath} was initialized but VS Code's Git extension did not open it (folders outside the current workspace are not always auto-detected).`,
      "config",
      "Add the site repository folder to your workspace (File → Add Folder to Workspace…) or open it as the workspace folder, then retry.",
    );
  }
  throw new AppError(
    `Could not initialize a Git repository in ${folder.fsPath}${initError ? `: ${initError}` : ""}.`,
    "config",
    "Check that git is installed and on PATH (run “git --version” in a terminal), that the folder is writable, and that VS Code's Git extension is enabled (setting git.enabled).",
  );
}
