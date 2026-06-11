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

export interface GitRepository {
  rootUri: vscode.Uri;
  state: {
    HEAD?: { name?: string };
    remotes: GitRemote[];
  };
  add(paths: string[]): Promise<void>;
  commit(message: string): Promise<void>;
  push(remoteName?: string, branchName?: string, setUpstream?: boolean): Promise<void>;
  addRemote(name: string, url: string): Promise<void>;
  createBranch(name: string, checkout: boolean): Promise<void>;
  checkout(treeish: string): Promise<void>;
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

/** Open the repo at `folder`, initializing one when none exists. */
export async function openOrInitRepository(
  folder: vscode.Uri,
): Promise<GitRepository> {
  const api = await getGitApi();
  const existing = await api.openRepository(folder);
  if (existing) return existing;
  const created = await api.init(folder);
  if (!created) {
    throw new AppError(
      `Could not initialize a Git repository in ${folder.fsPath}.`,
      "unknown",
    );
  }
  return created;
}
