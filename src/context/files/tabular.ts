import { parseCsv } from "./csv";
import { readXlsx } from "./xlsx";

/**
 * Tabular file context: detect a local file's kind, parse it to rows, and render
 * a bounded Markdown table for the assistant. CSV/TSV and .xlsx are supported;
 * everything tabular collapses to `string[][]`. Pure except `readTabularBuffer`,
 * which dispatches on kind.
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

/** Render rows as a Markdown table (first row = header), bounded for size. */
export function renderTable(label: string, rows: string[][]): string {
  if (rows.length === 0) return `# ${label}\n\n_Empty file._`;
  const cols = Math.min(TABLE_MAX_COLS, Math.max(...rows.map((r) => r.length)));
  const shown = rows.slice(0, TABLE_MAX_ROWS);
  const pad = (r: string[]) => Array.from({ length: cols }, (_, i) => escapeCell(r[i] ?? ""));
  const header = pad(shown[0]);
  const body = shown.slice(1).map(pad);
  const lines = [
    `# ${label}`,
    "",
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

/** Parse a file's bytes into rows by kind. `xlsx` needs the raw Buffer; the
 *  text kinds accept the decoded string (callers pass utf8). */
export function readTabularBuffer(kind: TabularKind, buf: Buffer): string[][] {
  if (kind === "xlsx") return readXlsx(buf);
  const text = buf.toString("utf8");
  if (kind === "tsv") return parseCsv(text); // parseCsv sniffs tab too
  return parseCsv(text);
}
