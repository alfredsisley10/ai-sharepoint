import { parseCsv } from "./csv";
import { readXlsxSheets } from "./xlsx";
import { Sheet } from "./sheet";

/**
 * Tabular file context: detect a local file's kind, parse it to named sheets, and
 * render bounded Markdown tables for the assistant. CSV/TSV (one sheet) and .xlsx
 * (every sheet) are supported here; .xls is handled by ./xls. Pure except the
 * dispatch in `readTabularBuffer`.
 */

export type TabularKind = "csv" | "tsv" | "xlsx" | "unknown";

export function detectTabularKind(fileName: string): TabularKind {
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  if (ext === "csv") return "csv";
  if (ext === "tsv" || ext === "tab") return "tsv";
  if (ext === "xlsx") return "xlsx";
  return "unknown";
}

export const TABLE_MAX_ROWS = 200;
export const TABLE_MAX_COLS = 32;
export const CELL_MAX = 200;

function escapeCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").slice(0, CELL_MAX);
}

/** Render rows as a Markdown table (first row = header), bounded for size. No
 *  heading — the caller adds the file/sheet title. */
export function renderRows(rows: string[][]): string {
  if (rows.length === 0) return "_Empty._";
  const cols = Math.min(TABLE_MAX_COLS, Math.max(...rows.map((r) => r.length)));
  const shown = rows.slice(0, TABLE_MAX_ROWS);
  const pad = (r: string[]) => Array.from({ length: cols }, (_, i) => escapeCell(r[i] ?? ""));
  const header = pad(shown[0]);
  const body = shown.slice(1).map(pad);
  const lines = [
    `_${rows.length} row(s) × ${Math.max(...rows.map((r) => r.length))} column(s). Read-only context._`,
    "",
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...body.map((r) => `| ${r.join(" | ")} |`),
  ];
  const extraRows = rows.length - shown.length;
  const extraCols = Math.max(...rows.map((r) => r.length)) - cols;
  const notes: string[] = [];
  if (extraRows > 0) notes.push(`${extraRows} more row(s) not shown`);
  if (extraCols > 0) notes.push(`${extraCols} more column(s) not shown`);
  if (notes.length) lines.push("", `_…${notes.join("; ")}._`);
  return lines.join("\n");
}

/** Render a single-sheet table with a top-level heading. */
export function renderTable(label: string, rows: string[][]): string {
  if (rows.length === 0) return `# ${label}\n\n_Empty file._`;
  return `# ${label}\n\n${renderRows(rows)}`;
}

/** Parse a file's bytes into named sheets by kind. `xlsx` needs the raw Buffer;
 *  the text kinds accept the decoded string (callers pass utf8). CSV/TSV are a
 *  single unnamed sheet; .xlsx returns every worksheet. */
export function readTabularBuffer(kind: TabularKind, buf: Buffer): Sheet[] {
  if (kind === "xlsx") return readXlsxSheets(buf);
  const rows = parseCsv(buf.toString("utf8")); // parseCsv sniffs tab/semicolon too
  return [{ name: "", rows }];
}
