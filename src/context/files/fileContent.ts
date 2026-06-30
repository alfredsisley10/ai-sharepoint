import { Sheet } from "./sheet";
import { TabularKind, detectTabularKind, readTabularBuffer, renderRows, renderTable } from "./tabular";
import { readXls } from "./xls";
import { readDocx } from "./docx";
import { extractPdfText } from "./pdf";
import { decodeText, looksBinary } from "./text";

/**
 * Unifies every supported file kind behind one read + render path. Tabular files
 * (CSV/TSV, .xlsx, .xls) become one-or-many named sheets rendered as Markdown
 * tables; document/text files (.docx, .pdf, plain text) become bounded text. The
 * "add file" flow detects the kind once and stores it; reads dispatch on it here.
 */

export type FileKind = TabularKind | "xls" | "docx" | "pdf" | "text"; // plus "unknown" from TabularKind

export type FileContent = { kind: "table"; sheets: Sheet[] } | { kind: "text"; text: string };

/** Extensions read as plain UTF-8 text. Unknown extensions are also accepted as
 *  text by the add flow (guarded by a binary sniff), so this list only needs the
 *  common ones for a confident, no-sniff classification. */
const TEXT_EXTS = new Set([
  "txt", "text", "md", "markdown", "log", "json", "xml", "yaml", "yml",
  "ini", "cfg", "conf", "config", "properties", "html", "htm", "rst", "tex", "sql", "csvx",
]);

/** Classify a file by name. Returns "unknown" for types we don't recognize; the
 *  add flow may still try those as text. */
export function detectFileKind(fileName: string): FileKind {
  const tab = detectTabularKind(fileName);
  if (tab !== "unknown") return tab; // csv / tsv / xlsx
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  if (ext === "xls") return "xls";
  if (ext === "docx") return "docx";
  if (ext === "pdf") return "pdf";
  if (TEXT_EXTS.has(ext)) return "text";
  return "unknown";
}

/** A short human label for a kind (tree description / pickers). */
export function describeKind(kind: FileKind): string {
  switch (kind) {
    case "csv": return "CSV";
    case "tsv": return "TSV";
    case "xlsx": return "Excel";
    case "xls": return "Excel (legacy)";
    case "docx": return "Word";
    case "pdf": return "PDF";
    case "text": return "text";
    default: return "file";
  }
}

/** Read a file's bytes into content by kind. Throws (with a user-facing message)
 *  for unsupported/binary input so callers can degrade gracefully. */
export function readFileContent(kind: FileKind, buf: Buffer): FileContent {
  switch (kind) {
    case "csv":
    case "tsv":
    case "xlsx":
      return { kind: "table", sheets: readTabularBuffer(kind, buf) };
    case "xls":
      return { kind: "table", sheets: readXls(buf) };
    case "docx":
      return { kind: "text", text: readDocx(buf) };
    case "pdf":
      return { kind: "text", text: extractPdfText(buf) };
    case "text":
      if (looksBinary(buf)) {
        throw new Error(
          "This looks like a binary file, not text. Supported: text/CSV/TSV, Excel (.xlsx/.xls), Word (.docx), and PDF. If it's a legacy Office file (.doc/.xls), save it as .docx/.xlsx and re-add.",
        );
      }
      return { kind: "text", text: decodeText(buf) };
    default:
      throw new Error("Unsupported file type.");
  }
}

export const TEXT_MAX_CHARS = 12_000;

/** Render extracted text with a heading, bounded for chat. */
export function renderText(label: string, text: string): string {
  const norm = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const capped = norm.length > TEXT_MAX_CHARS ? norm.slice(0, TEXT_MAX_CHARS) : norm;
  const body = capped.trim() || "_No readable text found (the file may be empty, or a scanned/image-only PDF)._";
  const lines = [`# ${label}`, "", body];
  if (norm.length > TEXT_MAX_CHARS) {
    lines.push("", `_…truncated (${norm.length - TEXT_MAX_CHARS} more characters not shown). Read-only context._`);
  }
  return lines.join("\n");
}

/** A short one-line summary of what was read, for the "added"/"read" toasts. */
export function summarizeFileContent(content: FileContent): string {
  if (content.kind === "text") {
    const len = content.text.trim().length;
    return len ? `${len} characters` : "no extractable text — the file may be scanned/image-only";
  }
  const sheets = content.sheets.length;
  const rows = content.sheets.reduce((n, s) => n + s.rows.length, 0);
  return sheets > 1 ? `${sheets} sheets, ${rows} rows total` : `${rows} row(s)`;
}

/** Render any FileContent to Markdown: a table per sheet (every sheet of a
 *  workbook, each under its name) or bounded text. */
export function renderFileContent(label: string, content: FileContent): string {
  if (content.kind === "text") return renderText(label, content.text);
  const sheets = content.sheets;
  if (sheets.length <= 1) return renderTable(label, sheets[0]?.rows ?? []);
  const parts = [`# ${label}`, "", `_Workbook — ${sheets.length} sheets. Read-only context._`];
  for (const sh of sheets) {
    parts.push("", `## ${sh.name || "Sheet"}`, "", sh.rows.length ? renderRows(sh.rows) : "_Empty sheet._");
  }
  return parts.join("\n");
}
