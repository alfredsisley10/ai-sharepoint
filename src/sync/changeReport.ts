import { FileMap, MANAGED_PATH } from "./serializer";
import { scanForLeaks, LeakFinding } from "../diagnostics/bundle";

/**
 * Pure diff + gate logic for the preview → approve → apply pipeline
 * (ADR-0019 §5/§6). Compares a freshly serialized FileMap against the files
 * currently on disk and runs the pre-commit content gates.
 */

export interface ChangeReport {
  added: string[];
  updated: string[];
  /** Managed paths present on disk but absent from the new snapshot. */
  removed: string[];
  unchanged: number;
  /** Block-severity content findings (secrets embedded in site content). */
  leakFindings: LeakFinding[];
  /** Files ≥ the GitHub hard limit (100 MB) — block. */
  oversize: string[];
  /** Files ≥ the GitHub warn threshold (50 MB). */
  large: string[];
}

export const WARN_FILE_BYTES = 50 * 1024 * 1024;
export const BLOCK_FILE_BYTES = 100 * 1024 * 1024;

/**
 * Unlike diagnostics bundles (which must be anonymous), a site repo
 * legitimately contains its own tenant URLs, names, and contact emails — the
 * sync gate blocks only *credential-shaped* content embedded in site data.
 */
const CREDENTIAL_PATTERNS = new Set([
  "jwt",
  "pem-block",
  "bearer-credential",
  "secret-assignment",
  "authcode-in-url",
]);

export function buildChangeReport(
  next: FileMap,
  existing: ReadonlyMap<string, string>,
): ChangeReport {
  const report: ChangeReport = {
    added: [],
    updated: [],
    removed: [],
    unchanged: 0,
    leakFindings: [],
    oversize: [],
    large: [],
  };

  for (const [path, content] of next) {
    const current = existing.get(path);
    if (current === undefined) {
      report.added.push(path);
    } else if (current === content) {
      report.unchanged += 1;
    } else {
      report.updated.push(path);
    }

    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes >= BLOCK_FILE_BYTES) report.oversize.push(path);
    else if (bytes >= WARN_FILE_BYTES) report.large.push(path);

    const blockers = scanForLeaks(content).filter(
      (f) => f.severity === "block" && CREDENTIAL_PATTERNS.has(f.pattern),
    );
    if (blockers.length > 0) {
      report.leakFindings.push(
        ...blockers.map((f) => ({ ...f, sample: `${path}: ${f.sample}` })),
      );
    }
  }

  for (const path of existing.keys()) {
    if (MANAGED_PATH.test(path) && !next.has(path)) {
      report.removed.push(path);
    }
  }

  report.added.sort();
  report.updated.sort();
  report.removed.sort();
  return report;
}

export function isBlocked(report: ChangeReport): boolean {
  return report.leakFindings.length > 0 || report.oversize.length > 0;
}

export function hasChanges(report: ChangeReport): boolean {
  return report.added.length + report.updated.length + report.removed.length > 0;
}

/** Structured commit message (ADR-0019 §4). */
export function commitMessageFor(siteName: string, report: ChangeReport): string {
  const parts = [
    report.added.length ? `+${report.added.length}` : "",
    report.updated.length ? `~${report.updated.length}` : "",
    report.removed.length ? `-${report.removed.length}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `SharePoint pull: ${siteName} — ${parts || "no changes"} file(s)`;
}
