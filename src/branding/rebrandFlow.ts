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
  repackageCommand,
  SUPPORT_PHRASE,
  SECURITY_PHRASE,
} from "./rebrand";
import {
  DeepBrandConfig,
  BrandToken,
  buildBrandTokens,
  applyBrandTokens,
  validateDeepBrand,
  camelize,
} from "./brandTokens";

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const HANDLE_RE = /^[a-z0-9][a-z0-9-]*$/;
const msg = (e: unknown) => redactError(e).message;

// Dirs never rewritten. src/branding holds the rebrand engine itself — rewriting
// it would corrupt the find-tokens; test/ isn't shipped and references tokens.
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "out-test",
  "test",
  "scripts",
  ".git",
  ".github",
  ".vscode",
  ".vscode-test",
]);
const REWRITE_EXTS = new Set([".ts", ".md", ".json", ".svg", ".html", ".css"]);
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * "Rebrand This Extension" (Support & Diagnostics). Applies a new identity AND,
 * optionally, a full product rename (display name, chat handle, and — greenfield
 * only — the internal identifier namespaces) across the extension's SOURCE tree,
 * then offers to repackage. The executable counterpart to REBRANDING.md.
 */
export async function runRebrandFlow(log: Logger): Promise<void> {
  const start = await vscode.window.showInformationMessage(
    "Rebrand (white-label) this extension",
    {
      modal: true,
      detail:
        "Applies a new identity and (optionally) a full product rename — display name, chat handle, even the internal identifiers — across the extension's SOURCE files, then can build a fresh .vsix. You need the extension's source folder; the installed copy can't rebrand itself.",
    },
    "Continue",
  );
  if (start !== "Continue") return;

  const root = await resolveSourceRoot();
  if (!root) return;

  const pkgUri = vscode.Uri.joinPath(root, "package.json");
  let pkgRaw: string;
  let pkg: {
    publisher?: string;
    name?: string;
    displayName?: string;
    description?: string;
    contributes?: { chatParticipants?: Array<{ name?: string }> };
  };
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
  const currentHandle = pkg.contributes?.chatParticipants?.[0]?.name ?? "sharepoint";

  // --- gather the new identity + product naming -----------------------------
  const publisher = await ask("Publisher ID — forms the permanent extension ID (lowercase, hyphens)", before.publisher, (v) =>
    ID_RE.test(v) ? undefined : "Lowercase letters, digits, and hyphens only (e.g. contoso).",
  );
  if (publisher === undefined) return;
  const name = await ask("Internal name — also part of the extension ID (lowercase, hyphens)", before.name, (v) =>
    ID_RE.test(v) ? undefined : "Lowercase letters, digits, and hyphens only (e.g. contoso-docs).",
  );
  if (name === undefined) return;
  const displayName = await ask('Product display name (replaces "AI SharePoint" everywhere)', before.displayName);
  if (displayName === undefined) return;
  const handle = await ask("Chat handle without @ (replaces @sharepoint)", currentHandle, (v) =>
    HANDLE_RE.test(v) ? undefined : "Lowercase letters, digits, and hyphens only (e.g. contosodocs).",
  );
  if (handle === undefined) return;
  const description = await ask("Description", before.description);
  if (description === undefined) return;

  // --- depth: cosmetic vs full identifier rename ----------------------------
  const depth = await vscode.window.showQuickPick(
    [
      {
        label: "Product name & handle only",
        description: "recommended — safe on any deployment",
        detail: "Renames everything users see; internal identifiers and stored data/settings are untouched.",
        deep: false,
      },
      {
        label: "Also rename internal identifiers",
        description: "advanced — GREENFIELD ONLY",
        detail: "Renames aiSharePoint.* / aisharepoint_* namespaces too. Changes settings & data keys — existing installs lose their data.",
        deep: true,
      },
    ],
    { title: "How deep should the rename go?", placeHolder: "Choose the rebrand depth", ignoreFocusOut: true },
  );
  if (!depth) return;
  const renameIdentifiers = depth.deep;

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
  const deep: DeepBrandConfig = {
    displayName: after.displayName,
    handle: handle.trim(),
    renameIdentifiers,
    kebabName: after.name,
    idNamespace: camelize(after.name),
  };

  const errors = [...validateBrandConfig(after), ...validateDeepBrand(deep)];
  if (errors.length > 0) {
    void vscode.window.showErrorMessage(`Rebrand cancelled — ${errors.join(" ")}`);
    return;
  }

  // --- greenfield warnings (data-scoping changes) ---------------------------
  if (identityChanged(before, after) || renameIdentifiers) {
    const reasons: string[] = [];
    if (identityChanged(before, after)) {
      reasons.push(`• Extension ID: ${extensionId(before.publisher, before.name)} → ${extensionId(after.publisher, after.name)}`);
    }
    if (renameIdentifiers) {
      reasons.push("• Settings keys and stored-data keys (aiSharePoint.* → " + deep.idNamespace + ".*)");
    }
    const ok = await vscode.window.showWarningMessage(
      "This changes identifiers that scope stored data — GREENFIELD ONLY",
      {
        modal: true,
        detail:
          `${reasons.join("\n")}\n\nVS Code keys all stored connectors, projects, settings, and saved credentials to these identifiers. Any machine that already has this extension will start EMPTY after upgrading — old data is stranded, not deleted. Only continue for a brand-new deployment.`,
      },
      "I understand — continue",
    );
    if (ok !== "I understand — continue") return;
  }

  // --- confirm --------------------------------------------------------------
  const summary = [
    ...summarizeBrand(before, after),
    currentHandle !== deep.handle ? `Chat handle: @${currentHandle} → @${deep.handle}` : "",
    renameIdentifiers ? `Internal namespace: aiSharePoint.* → ${deep.idNamespace}.*` : "Internal identifiers: unchanged",
  ].filter(Boolean);
  const apply = await vscode.window.showInformationMessage(
    "Apply this rebrand across the source tree?",
    { modal: true, detail: summary.join("\n") },
    "Apply",
  );
  if (apply !== "Apply") return;

  // --- apply ----------------------------------------------------------------
  const tokens = buildBrandTokens(deep);
  const written: string[] = [];
  const skipped: string[] = [];

  // package.json: brand tokens, then identity fields, then participant name/fullName.
  try {
    let text = applyBrandTokens(pkgRaw, tokens);
    text = rebrandPackageJson(text, after);
    text = text.split('"name": "sharepoint"').join(`"name": ${JSON.stringify(deep.handle)}`);
    text = text.split('"fullName": "SharePoint"').join(`"fullName": ${JSON.stringify(after.displayName)}`);
    await writeText(pkgUri, text);
    written.push("package.json");
  } catch (e) {
    log.error("rebrand: package.json", e);
    void vscode.window.showErrorMessage(`Could not update package.json: ${msg(e)}. No files were changed.`);
    return;
  }

  // Whole-tree brand-token rewrite (src, docs, README, etc.).
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Rebranding source files…" },
    async () => {
      const result = await rewriteTree(root, tokens, log);
      written.push(`${result.changed} source file(s)`);
      if (result.errors > 0) skipped.push(`${result.errors} file(s) unreadable`);
    },
  );

  // LICENSE: brand tokens (renames "AI SharePoint contributors"), then explicit holder.
  await editFile(
    root,
    "LICENSE",
    (t) => {
      let r = applyBrandTokens(t, tokens);
      if (after.licenseHolder) r = rebrandLicense(r, after.licenseHolder);
      return r;
    },
    written,
    skipped,
    log,
  );

  // Distributor contact placeholders.
  if (after.supportContact || after.securityContact) {
    await editFile(
      root,
      "SUPPORT.md",
      (t) => replacePhrase(replacePhrase(t, SUPPORT_PHRASE, after.supportContact).text, SECURITY_PHRASE, after.securityContact).text,
      written,
      skipped,
      log,
    );
  }
  if (after.securityContact) {
    await editFile(root, "docs/SECURITY.md", (t) => replacePhrase(t, SECURITY_PHRASE, after.securityContact).text, written, skipped, log);
  }

  // Optional icon swap.
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

  log.info(`Rebranded to "${after.displayName}" (${extensionId(after.publisher, after.name)})${renameIdentifiers ? `, namespace ${deep.idNamespace}` : ""}`);

  // --- finish ---------------------------------------------------------------
  const detail = [
    `Updated: ${written.join(", ")}.`,
    skipped.length ? `Skipped: ${skipped.join(", ")}.` : "",
    "",
    renameIdentifiers
      ? "Internal identifiers were renamed — run the unit tests (they reference the old names) and recompile before shipping."
      : "Recompile to bake the new product name into the bundle.",
  ]
    .filter(Boolean)
    .join("\n");
  const next = await vscode.window.showInformationMessage(
    `Rebrand applied: "${after.displayName}".`,
    { modal: true, detail },
    "Repackage now",
    "Open REBRANDING.md",
  );
  if (next === "Repackage now") {
    const term = vscode.window.createTerminal({ name: "Rebrand & package", cwd: root });
    term.show();
    // Pick a chaining syntax the resolved shell understands — Windows PowerShell
    // 5.1 rejects `&&`, so this is not hardcoded. See repackageCommand.
    term.sendText(repackageCommand(vscode.env.shell));
  } else if (next === "Open REBRANDING.md") {
    try {
      await vscode.window.showTextDocument(vscode.Uri.joinPath(root, "REBRANDING.md"));
    } catch {
      /* doc may be absent in older copies */
    }
  }
}

// --- tree rewrite ----------------------------------------------------------

async function rewriteTree(
  root: vscode.Uri,
  tokens: BrandToken[],
  log: Logger,
): Promise<{ changed: number; scanned: number; errors: number }> {
  let changed = 0;
  let scanned = 0;
  let errors = 0;

  async function walk(dir: vscode.Uri): Promise<void> {
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(dir);
    } catch (e) {
      errors++;
      log.error("rebrand: readdir", e);
      return;
    }
    for (const [n, type] of entries) {
      if (type === vscode.FileType.Directory) {
        if (SKIP_DIRS.has(n)) continue;
        if (dir.path.endsWith("/src") && n === "branding") continue; // engine self-protection
        await walk(vscode.Uri.joinPath(dir, n));
        continue;
      }
      if (n === "package.json" || n === "package-lock.json") continue; // package.json handled explicitly
      const ext = n.slice(n.lastIndexOf("."));
      if (!REWRITE_EXTS.has(ext)) continue;
      const uri = vscode.Uri.joinPath(dir, n);
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > MAX_FILE_BYTES) continue;
        scanned++;
        const text = await readText(uri);
        const out = applyBrandTokens(text, tokens);
        if (out !== text) {
          await writeText(uri, out);
          changed++;
        }
      } catch (e) {
        errors++;
        log.error(`rebrand: ${n}`, e);
      }
    }
  }

  await walk(root);
  return { changed, scanned, errors };
}

// --- helpers ---------------------------------------------------------------

async function resolveSourceRoot(): Promise<vscode.Uri | undefined> {
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (await looksLikeSource(folder.uri)) {
      const use = await vscode.window.showInformationMessage(
        "Use the extension source in this workspace folder?",
        { modal: true, detail: folder.uri.fsPath },
        "Use this folder",
        "Pick another…",
      );
      if (use === "Use this folder") return folder.uri;
      if (use === undefined) return undefined;
      break;
    }
  }
  const picked = await vscode.window.showOpenDialog({
    title: "Select the extension source folder (containing package.json)",
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
  });
  if (!picked || !picked[0]) return undefined;
  if (await looksLikeSource(picked[0], true)) return picked[0];
  void vscode.window.showErrorMessage("That folder isn't the extension source (no package.json with contributes). Pick the source root.");
  return undefined;
}

/** Identify the extension source structurally (no hardcoded brand name, so it
 *  survives a prior rename): a package.json with `contributes`, alongside the
 *  rebranding guide or a chat-participant contribution. */
async function looksLikeSource(dir: vscode.Uri, lenient = false): Promise<boolean> {
  try {
    const json = JSON.parse(await readText(vscode.Uri.joinPath(dir, "package.json")));
    if (!json?.contributes) return false;
    if (lenient) return true;
    try {
      await vscode.workspace.fs.stat(vscode.Uri.joinPath(dir, "REBRANDING.md"));
      return true;
    } catch {
      return !!json.contributes.chatParticipants;
    }
  } catch {
    return false;
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
      skipped.push(`${rel} (no change)`);
      return;
    }
    await writeText(uri, after);
    written.push(rel);
  } catch (e) {
    log.error(`rebrand: ${rel}`, e);
    skipped.push(`${rel} (${msg(e)})`);
  }
}
