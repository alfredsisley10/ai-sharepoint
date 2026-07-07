import * as vscode from "vscode";

const dec = new TextDecoder();
const enc = new TextEncoder();

async function tryWrite(uri: vscode.Uri, text: string): Promise<void> {
  try {
    await vscode.workspace.fs.writeFile(uri, enc.encode(text));
  } catch {
    // best-effort — never let a .gitignore write break the caller
  }
}

/**
 * Ensure `line` (e.g. `"ai-sharepoint-exports/"` or `".ai-sharepoint/"`) is
 * present in the workspace-root `.gitignore`, so locally-written data — chat
 * transcripts, dossiers, or data exports — isn't committed to the user's repo by
 * accident. Idempotent (matches the line with or without a trailing slash),
 * best-effort (never throws), and a no-op without a workspace folder. The single
 * shared definition used by the chat workspace and the export commands.
 */
export async function ensureGitignored(folder: vscode.Uri | undefined, line: string): Promise<void> {
  if (!folder) return;
  const gi = vscode.Uri.joinPath(folder, ".gitignore");
  const bare = line.replace(/\/$/, "");
  let cur: string | undefined;
  try {
    cur = dec.decode(await vscode.workspace.fs.readFile(gi));
  } catch {
    cur = undefined;
  }
  if (cur === undefined) {
    await tryWrite(gi, `${line}\n`);
    return;
  }
  if (cur.split(/\r?\n/).some((l) => l.trim() === line || l.trim() === bare)) return;
  const sep = cur.endsWith("\n") ? "" : "\n";
  await tryWrite(gi, `${cur}${sep}${line}\n`);
}
