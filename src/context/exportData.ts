/**
 * Workspace export of context-search results (ADR-0031). Chat results are
 * deliberately capped — good for context budgets, wrong for "give me the
 * data". Exports run the same read-only query with bigger bounds and write
 * EVERY row to a file in the workspace, so the dataset reaches the user
 * while Copilot only ever sees the file path and a row count.
 * Pure serialization/naming here; I/O stays with the caller.
 */

/** Export row bound — generous for datasets, still memory-safe. */
export const EXPORT_MAX_ROWS = 50_000;

/** Exports may legitimately read a lot — give them more runway than chat. */
export const EXPORT_TIMEOUT_MS = 120_000;

/** Workspace-relative folder all exports land in. */
export const EXPORT_DIR = "ai-sharepoint-exports";

const csvCell = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  const s =
    v instanceof Date
      ? v.toISOString()
      : typeof v === "object"
        ? JSON.stringify(v)
        : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** RFC-4180 CSV; the header is the union of keys in first-seen order, so
 *  ragged rows (NULL-omitting drivers, varied hit meta) stay aligned. */
export function rowsToCsv(rows: Array<Record<string, unknown>>): string {
  const columns: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!columns.includes(key)) columns.push(key);
    }
  }
  const lines = [columns.map(csvCell).join(",")];
  for (const row of rows) {
    lines.push(columns.map((c) => csvCell(row[c])).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

/** Deterministic, filesystem-safe export name: <source>-<UTC stamp>.<ext>.
 *  The caller supplies ext by data shape (csv for tabular, json for docs). */
export function exportFileName(sourceName: string, ext: "csv" | "json", nowIso: string): string {
  const slug =
    sourceName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "source";
  const stamp = nowIso.replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
  return `${slug}-${stamp}.${ext}`;
}

/** Constrain a caller-proposed file name to a bare name inside the export
 *  folder (no separators/traversal), keeping the required extension. */
export function sanitizeExportFileName(
  proposed: string,
  ext: "csv" | "json",
): string | undefined {
  const bare = proposed.trim().replace(new RegExp(`\\.${ext}$`, "i"), "");
  if (!bare || !/^[\w][\w .-]{0,80}$/.test(bare) || /[/\\]|\.\./.test(bare)) {
    return undefined;
  }
  return `${bare}.${ext}`;
}
