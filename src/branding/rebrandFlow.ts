import * as vscode from "vscode";
import { Logger } from "../core/log";
import { redactError } from "../core/redaction";
import {
  BrandConfig,
  validateBrandConfig,
  rebrandPackageJson,
  rebrandLicense,
  replacePhrase,
  summarizeBrand,
  identityChanged,
  extensionId,
  SUPPORT_PHRASE,
  SECURITY_PHRASE,
} from "./rebrand";

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const msg = (e: unknown) => redactError(e).message;

/**
 * "Rebrand This Extension" (Support & Diagnostics). A guided flow that applies a
 * new white-label identity to the extension's SOURCE tree and offers to
 * repackage — the executable counterpart to REBRANDING.md. An installed
 * extension can't repackage itself, so this operates on the source folder
 * (auto-detected in the workspace, or chosen by the user).
 */
export async function runRebrandFlow(log: Logger): Promise<void> {
  const start = await vscode.window.showInformationMessage(
    "Rebrand (white-label) this extension",
    {
      modal: true,
      detail:
        "Applies a new identity to the extension's SOURCE files (package.json, LICENSE, support/security docs, icon) and can build a fresh .vsix. You need the extension's source folder open or available — the installed copy can't rebrand itself.",
    },
    "Continue",
  );
  if (start !== "Continue") return;

  const root = await resolveSourceRoot();
  if (!root) return;

  const pkgUri = vscode.Uri.joinPath(root, "package.json");
  let pkgRaw: string;
  let pkg: { publisher?: string; name?: string; displayName?: string; description?: string };
  try {
    pkgRaw = await readText(pkgUri);
    pkg = JSON.parse(pkgRaw);
  } catch (e) {
    void vscode.window.showErrorMessage(`Could not read a valid package.json there: ${msg(e)}`);
    return;
  }

  const before: BrandConfig = {
    publisher: pkg.publisher ?? "",
    name: pkg.name ?? "",
    displayName: pkg.displayName ?? "",
    description: pkg.description ?? "",
  };

  // --- collect the new identity (prefilled with current values) -------------
  const publisher = await ask("Publisher ID — forms the permanent extension ID (lowercase, hyphens)", before.publisher, (v) =>
    ID_RE.test(v) ? undefined : "Lowercase letters, digits, and hyphens only (e.g. contoso).",
  );
  if (publisher === undefined) return;
  const name = await ask("Internal name — also part of the extension ID (lowercase, hyphens)", before.name, (v) =>
    ID_RE.test(v) ? undefined : "Lowercase letters, digits, and hyphens only (e.g. ai-sharepoint).",
  );
  if (name === undefined) return;
  const displayName = await ask("Display name (shown in the Extensions view)", before.displayName);
  if (displayName === undefined) return;
  const description = await ask("Description", before.description);
  if (description === undefined) return;
  const licenseHolder = await ask("License copyright holder — blank to leave unchanged", "", undefined, true);
  if (licenseHolder === undefined) return;
  const supportContact = await ask("Support contact (email/URL/team) — blank to leave unchanged", "", undefined, true);
  if (supportContact === undefined) return;
  const securityContact = await ask("Security contact (email/URL) — blank to leave unchanged", "", undefined, true);
  if (securityContact === undefined) return;

  const after: BrandConfig = {
    publisher: publisher.trim(),
    name: name.trim(),
    displayName: displayName.trim(),
    description: description.trim(),
    licenseHolder: licenseHolder.trim() || undefined,
    supportContact: supportContact.trim() || undefined,
    securityContact: securityContact.trim() || undefined,
  };

  const errors = validateBrandConfig(after);
  if (errors.length > 0) {
    void vscode.window.showErrorMessage(`Rebrand cancelled — ${errors.join(" ")}`);
    return;
  }

  // --- the dangerous case: identity (data-scoping) change -------------------
  if (identityChanged(before, after)) {
    const ok = await vscode.window.showWarningMessage(
      `Change the extension ID  ${extensionId(before.publisher, before.name)} → ${extensionId(after.publisher, after.name)}?`,
      {
        modal: true,
        detail:
          "VS Code keys ALL stored connectors, projects, and saved credentials to the extension ID. Any machine that already has this extension and upgrades to the new ID will start EMPTY — the old data is stranded (not deleted). Only change the identity for a brand-new deployment. (Cosmetic fields like display name and icon are safe to change anytime.)",
      },
      "Change the identity",
    );
    if (ok !== "Change the identity") return;
  }

  const changes = summarizeBrand(before, after);
  if (changes.length === 0) {
    void vscode.window.showInformationMessage("Nothing to change — the identity already matches.");
    return;
  }
  const apply = await vscode.window.showInformationMessage(
    "Apply this rebrand to the source files?",
    { modal: true, detail: changes.join("\n") },
    "Apply",
  );
  if (apply !== "Apply") return;

  // --- apply edits ----------------------------------------------------------
  const written: string[] = [];
  const skipped: string[] = [];
  try {
    await writeText(pkgUri, rebrandPackageJson(pkgRaw, after));
    written.push("package.json");
  } catch (e) {
    log.error("rebrand: package.json", e);
    void vscode.window.showErrorMessage(`Could not update package.json: ${msg(e)}. No files were changed.`);
    return;
  }

  if (after.licenseHolder) {
    await editFile(root, "LICENSE", (t) => rebrandLicense(t, after.licenseHolder!), written, skipped, log);
  }
  if (after.supportContact || after.securityContact) {
    await editFile(
      root,
      "SUPPORT.md",
      (t) => {
        let r = replacePhrase(t, SUPPORT_PHRASE, after.supportContact).text;
        r = replacePhrase(r, SECURITY_PHRASE, after.securityContact).text;
        return r;
      },
      written,
      skipped,
      log,
    );
  }
  if (after.securityContact) {
    await editFile(root, "docs/SECURITY.md", (t) => replacePhrase(t, SECURITY_PHRASE, after.securityContact).text, written, skipped, log);
  }

  // optional icon swap
  const icon = await vscode.window.showOpenDialog({
    title: "Select a new icon PNG (Cancel to keep the current icon)",
    canSelectMany: false,
    filters: { Images: ["png"] },
  });
  if (icon && icon[0]) {
    try {
      const bytes = await vscode.workspace.fs.readFile(icon[0]);
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root, "media", "icon.png"), bytes);
      written.push("media/icon.png");
    } catch (e) {
      log.error("rebrand: icon", e);
      skipped.push("media/icon.png (copy failed)");
    }
  }

  log.info(`Rebranded ${written.join(", ")} → ${extensionId(after.publisher, after.name)}`);

  // --- finish: offer to repackage ------------------------------------------
  const detail = [
    `Updated: ${written.join(", ")}.`,
    skipped.length ? `Skipped: ${skipped.join(", ")}.` : "",
    "",
    "Repackage to produce the rebranded .vsix.",
  ]
    .filter(Boolean)
    .join("\n");
  const next = await vscode.window.showInformationMessage(
    `Rebrand applied to ${written.length} file(s).`,
    { modal: true, detail },
    "Repackage now",
    "Open REBRANDING.md",
  );
  if (next === "Repackage now") {
    const term = vscode.window.createTerminal({ name: "Rebrand & package", cwd: root });
    term.show();
    term.sendText("npm install && npm run package");
  } else if (next === "Open REBRANDING.md") {
    try {
      await vscode.window.showTextDocument(vscode.Uri.joinPath(root, "REBRANDING.md"));
    } catch {
      /* doc may not exist in older copies */
    }
  }
}

// --- helpers ---------------------------------------------------------------

async function resolveSourceRoot(): Promise<vscode.Uri | undefined> {
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    try {
      const raw = await readText(vscode.Uri.joinPath(folder.uri, "package.json"));
      const json = JSON.parse(raw);
      if (json?.name === "ai-sharepoint" || json?.displayName === "AI SharePoint") {
        const use = await vscode.window.showInformationMessage(
          `Use the extension source in this workspace folder?`,
          { modal: true, detail: folder.uri.fsPath },
          "Use this folder",
          "Pick another…",
        );
        if (use === "Use this folder") return folder.uri;
        if (use === undefined) return undefined;
        break;
      }
    } catch {
      /* not this folder */
    }
  }
  const picked = await vscode.window.showOpenDialog({
    title: "Select the extension source folder (containing package.json)",
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
  });
  if (!picked || !picked[0]) return undefined;
  try {
    const json = JSON.parse(await readText(vscode.Uri.joinPath(picked[0], "package.json")));
    if (!json?.publisher && !json?.name) throw new Error("no publisher/name");
    return picked[0];
  } catch {
    void vscode.window.showErrorMessage("That folder doesn't contain a usable package.json. Pick the extension's source root.");
    return undefined;
  }
}

async function ask(
  prompt: string,
  value: string,
  validate?: (v: string) => string | undefined,
  allowEmpty = false,
): Promise<string | undefined> {
  return vscode.window.showInputBox({
    prompt,
    value,
    ignoreFocusOut: true,
    validateInput: (v) => {
      const t = v.trim();
      if (!t) return allowEmpty ? undefined : "Required.";
      return validate?.(t);
    },
  });
}

async function readText(uri: vscode.Uri): Promise<string> {
  return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
}

async function writeText(uri: vscode.Uri, text: string): Promise<void> {
  await vscode.workspace.fs.writeFile(uri, Buffer.from(text, "utf8"));
}

async function editFile(
  root: vscode.Uri,
  rel: string,
  transform: (text: string) => string,
  written: string[],
  skipped: string[],
  log: Logger,
): Promise<void> {
  const uri = vscode.Uri.joinPath(root, ...rel.split("/"));
  try {
    const before = await readText(uri);
    const after = transform(before);
    if (after === before) {
      skipped.push(`${rel} (no matching placeholder)`);
      return;
    }
    await writeText(uri, after);
    written.push(rel);
  } catch (e) {
    log.error(`rebrand: ${rel}`, e);
    skipped.push(`${rel} (${msg(e)})`);
  }
}
