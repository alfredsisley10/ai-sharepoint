import { zipSync, strToU8 } from "fflate";
import { Sheet } from "./sheet";

/**
 * Minimal .xlsx WRITER (the reader lives in `xlsx.ts`). An .xlsx is a ZIP of
 * XML parts; we emit the smallest valid workbook — one worksheet per sheet with
 * `inlineStr` cells (no shared-string table, no styles beyond a bold header
 * flag), zipped with fflate. Enough for the oversight/summary exports (tabular
 * string data), and round-trips through our own reader. Pure.
 */

const HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** 0-based column index → Excel column letters (0→A, 26→AA). */
export function columnLetters(index: number): string {
  let n = index;
  let out = "";
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/** Excel sheet-name rules: ≤31 chars, no []:*?/\ and not blank. */
export function sanitizeSheetName(name: string, fallback: string): string {
  const cleaned = (name || "").replace(/[[\]:*?/\\]/g, " ").trim().slice(0, 31);
  return cleaned || fallback;
}

function cellXml(value: string, ref: string, bold: boolean): string {
  // Empty cells are omitted entirely (Excel infers them).
  if (value === "") return "";
  return `<c r="${ref}"${bold ? ' s="1"' : ""} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
}

function sheetXml(rows: string[][], headerRow: boolean): string {
  const body = rows
    .map((row, r) => {
      const cells = row.map((v, c) => cellXml(v ?? "", `${columnLetters(c)}${r + 1}`, headerRow && r === 0)).join("");
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join("");
  return `${HEADER}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

const STYLES = `${HEADER}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf/><xf fontId="1" applyFont="1"/></cellXfs></styleSheet>`;

/**
 * Build an .xlsx workbook from named sheets of string rows. `headerRow: true`
 * bolds the first row of each sheet. Returns the zipped bytes. When two sheets
 * would collide on a sanitized name, later ones are suffixed.
 */
export function buildXlsx(sheets: Sheet[], opts: { headerRow?: boolean } = {}): Uint8Array {
  const used = new Set<string>();
  const named = sheets.map((s, i) => {
    let name = sanitizeSheetName(s.name, `Sheet${i + 1}`);
    let n = 2;
    while (used.has(name.toLowerCase())) name = sanitizeSheetName(`${s.name} ${n++}`, `Sheet${i + 1}`);
    used.add(name.toLowerCase());
    return { name, rows: s.rows };
  });

  const files: Record<string, Uint8Array> = {};
  files["[Content_Types].xml"] =
    strToU8(`${HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${named
      .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
      .join("")}</Types>`);
  files["_rels/.rels"] = strToU8(
    `${HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  );
  files["xl/workbook.xml"] = strToU8(
    `${HEADER}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${named
      .map((s, i) => `<sheet name="${xmlEscape(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join("")}</sheets></workbook>`,
  );
  files["xl/_rels/workbook.xml.rels"] = strToU8(
    `${HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${named
      .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
      .join("")}<Relationship Id="rId${named.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
  );
  files["xl/styles.xml"] = strToU8(STYLES);
  named.forEach((s, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(s.rows, opts.headerRow ?? true));
  });

  return zipSync(files, { level: 6 });
}
