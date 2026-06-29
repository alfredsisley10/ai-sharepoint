/**
 * Rebranding engine (white-label). Pure transforms that apply a new identity to
 * the extension's SOURCE files, plus validation. The VS Code flow
 * (rebrandFlow.ts) gathers the identity, calls these, writes the files, and
 * offers to repackage. Kept pure so the risky string edits are unit-tested.
 *
 * An installed extension cannot repackage itself, so rebranding necessarily
 * targets the source tree (auto-detected in the workspace or user-picked) and
 * produces a fresh `.vsix` via `npm run package`.
 */

import { ReleaseManifest } from "./releaseExpiry";

export interface BrandConfig {
  /** Forms the extension ID `publisher.name` — PERMANENT once deployed. */
  publisher: string;
  name: string;
  displayName: string;
  description: string;
  /** Optional cosmetic / contact fields. */
  licenseHolder?: string;
  supportContact?: string;
  securityContact?: string;
}

/** Marketplace publisher/name charset (lowercase alphanumeric + hyphen). */
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

export function validateBrandConfig(cfg: Partial<BrandConfig>): string[] {
  const errs: string[] = [];
  if (!cfg.publisher || !ID_RE.test(cfg.publisher)) {
    errs.push("Publisher must be lowercase letters, digits, or hyphens (e.g. contoso).");
  }
  if (!cfg.name || !ID_RE.test(cfg.name)) {
    errs.push("Name must be lowercase letters, digits, or hyphens (e.g. ai-sharepoint).");
  }
  if (!cfg.displayName || !cfg.displayName.trim()) errs.push("Display name is required.");
  if (!cfg.description || !cfg.description.trim()) errs.push("Description is required.");
  return errs;
}

/** The extension ID (`publisher.name`). */
export function extensionId(publisher: string, name: string): string {
  return `${publisher}.${name}`;
}

/** Whether the identity that scopes stored data/secrets is changing — the
 *  dangerous case that strands an existing deployment's data. */
export function identityChanged(before: BrandConfig, after: BrandConfig): boolean {
  return before.publisher !== after.publisher || before.name !== after.name;
}

/** Replace a top-level JSON string field's VALUE in place, preserving the file's
 *  formatting (so the rebrand diff stays small). Throws if the field is absent. */
function setTopLevelString(raw: string, key: string, value: string): string {
  // Match a 2-space-indented top-level "key": "string-value" (value may contain
  // escaped quotes); nested same-named keys are deeper-indented and won't match.
  const re = new RegExp(`^(  "${key}":\\s*)"(?:[^"\\\\]|\\\\.)*"`, "m");
  if (!re.test(raw)) throw new Error(`Could not find top-level "${key}" in package.json.`);
  return raw.replace(re, `$1${JSON.stringify(value)}`);
}

/**
 * Set the top-level `release` manifest in package.json text (the time-limited
 * white-label build control). Replaces an existing single-line `"release": {…}`
 * value in place (formatting preserved), or inserts one after `"version"` if
 * absent. Serialized compact so the rebrand diff stays a single line.
 */
export function setReleaseManifest(raw: string, manifest: ReleaseManifest): string {
  const value = JSON.stringify(manifest);
  const existing = /^(\s*"release":\s*)\{[^\n]*\}/m;
  if (existing.test(raw)) return raw.replace(existing, `$1${value}`);
  return raw.replace(/^(\s*"version":\s*"[^"]*",\n)/m, `$1  "release": ${value},\n`);
}

/**
 * Set the top-level `provisioning` manifest in package.json text (the first-run
 * seed payload: connectors, projects, settings, help). Replaces an existing
 * single-line `"provisioning": {…}` in place, else inserts after `"release"` if
 * present, else after `"version"`. Serialized compact (one line) to keep the
 * rebrand diff small. An empty/absent manifest is a no-op.
 */
export function setProvisioningManifest(raw: string, manifest: unknown): string {
  if (!manifest) return raw;
  const value = JSON.stringify(manifest);
  const existing = /^(\s*"provisioning":\s*)\{[\s\S]*?\}(?=,?\s*\n)/m;
  if (existing.test(raw)) return raw.replace(existing, `$1${value}`);
  const afterRelease = /^(\s*"release":\s*\{[^\n]*\},\n)/m;
  if (afterRelease.test(raw)) return raw.replace(afterRelease, `$1  "provisioning": ${value},\n`);
  return raw.replace(/^(\s*"version":\s*"[^"]*",\n)/m, `$1  "provisioning": ${value},\n`);
}

/** Apply publisher/name/displayName/description to package.json text. */
export function rebrandPackageJson(raw: string, cfg: BrandConfig): string {
  let out = raw;
  out = setTopLevelString(out, "publisher", cfg.publisher);
  out = setTopLevelString(out, "name", cfg.name);
  out = setTopLevelString(out, "displayName", cfg.displayName);
  out = setTopLevelString(out, "description", cfg.description);
  return out;
}

/** Replace the copyright holder (keeping or updating the year) in an MIT-style
 *  LICENSE. No-op (returns input) if no copyright line is found. */
export function rebrandLicense(text: string, holder: string, year?: string): string {
  return text.replace(
    /^(Copyright \(c\) )(\d{4}) .*$/m,
    (_m, prefix: string, yr: string) => `${prefix}${year || yr} ${holder}`,
  );
}

/** Sentinel phrases in the shipped support/security docs that name the contact. */
export const SUPPORT_PHRASE = "the support channel your distributor provides";
export const SECURITY_PHRASE = "the security contact your distributor provides";

/** Replace all occurrences of a phrase; reports whether anything changed (so the
 *  flow can note "already customized — left as-is"). */
export function replacePhrase(
  text: string,
  phrase: string,
  replacement: string | undefined,
): { text: string; changed: boolean } {
  if (!replacement || !replacement.trim() || !text.includes(phrase)) {
    return { text, changed: false };
  }
  return { text: text.split(phrase).join(replacement.trim()), changed: true };
}

/**
 * The shell command the rebrand flow types into a fresh terminal to install
 * dependencies and build the `.vsix`. Must be cross-platform: PowerShell only
 * gained the `&&` chaining operator in v7, so Windows PowerShell 5.1 — the
 * default Windows shell — rejects `npm install && npm run package` with
 * "the token '&&' is not a valid statement separator in this version". For
 * PowerShell we emit a `;`-separated form guarded on the install exit code,
 * which preserves the "only package if install succeeded" short-circuit and
 * works in both 5.1 and 7+. cmd.exe and POSIX shells (bash/zsh/fish on macOS &
 * Linux) all understand `&&`.
 *
 * @param shell the resolved default shell path (pass `vscode.env.shell`); may be
 *   undefined/empty in environments without shell detection, in which case the
 *   `&&` form is used (correct for macOS/Linux and Windows cmd.exe).
 */
export function repackageCommand(shell: string | undefined): string {
  const s = (shell ?? "").toLowerCase();
  const isPowerShell = s.includes("powershell") || s.includes("pwsh");
  return isPowerShell
    ? "npm install; if ($LASTEXITCODE -eq 0) { npm run package }"
    : "npm install && npm run package";
}

/** Human-readable summary of what a rebrand will change, for confirmation. */
export function summarizeBrand(before: BrandConfig, after: BrandConfig): string[] {
  const lines: string[] = [];
  const row = (label: string, a?: string, b?: string) => {
    if ((a ?? "") !== (b ?? "")) lines.push(`${label}: ${a || "—"} → ${b || "—"}`);
  };
  row("Publisher", before.publisher, after.publisher);
  row("Name", before.name, after.name);
  row("Display name", before.displayName, after.displayName);
  row("Description", before.description, after.description);
  row("License holder", before.licenseHolder, after.licenseHolder);
  row("Support contact", before.supportContact, after.supportContact);
  row("Security contact", before.securityContact, after.securityContact);
  return lines;
}
