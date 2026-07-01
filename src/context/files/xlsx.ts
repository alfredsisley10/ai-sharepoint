import * as zlib from "zlib";
import { Sheet } from "./sheet";

/**
 * Dependency-free .xlsx reader: pulls EVERY worksheet into rows of strings for
 * tabular context. An .xlsx is a ZIP of XML; we read the central directory,
 * inflate the entries we need (Node's built-in zlib — no native module), and
 * scan `sharedStrings.xml`, `workbook.xml` (sheet names + order), its rels (the
 * name→file mapping), and each `sheetN.xml`.
 *
 * Scope (deliberately small, documented): all worksheets, values rendered as
 * text (shared strings, inline strings, numbers, booleans). Formulas resolve to
 * their cached value. The XML scanners are pure and unit-tested; the ZIP layer
 * is exercised end-to-end with a fixture built in the tests.
 */

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function decodeXmlEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (_m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _m;
    }
    return XML_ENTITIES[e] ?? _m;
  });
}

/** Concatenate the text of every `<t>` inside a fragment (handles rich-run `<r>`). */
function joinText(fragment: string): string {
  let out = "";
  const re = /<t[^>]*>([\s\S]*?)<\/t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fragment))) out += m[1];
  return decodeXmlEntities(out);
}

/** Parse `xl/sharedStrings.xml` into the ordered shared-string table. */
export function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  const re = /<si>([\s\S]*?)<\/si>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(joinText(m[1]));
  return out;
}

/** Column letters ("A", "AB") → zero-based index. */
export function columnToIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) {
    if (ch < "A" || ch > "Z") break;
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n - 1;
}

export const XLSX_MAX_ROWS = 1000;
export const XLSX_MAX_COLS = 64;

/** Parse a worksheet's XML into rows of strings, resolving shared strings and
 *  preserving column gaps (by the cell `r=` reference). Bounded for safety. */
export function parseSheet(xml: string, shared: string[]): string[][] {
  const rows: string[][] = [];
  const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g;
  let rm: RegExpExecArray | null;
  while ((rm = rowRe.exec(xml)) && rows.length < XLSX_MAX_ROWS) {
    const cells: string[] = [];
    const cellRe = /<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm: RegExpExecArray | null;
    while ((cm = cellRe.exec(rm[1]))) {
      const attrs = cm[1] || "";
      const inner = cm[2] || "";
      const refMatch = /r="([A-Z]+)\d+"/.exec(attrs);
      const col = refMatch ? columnToIndex(refMatch[1]) : cells.length;
      const typeMatch = /t="([^"]+)"/.exec(attrs);
      const type = typeMatch ? typeMatch[1] : "n";
      let value = "";
      if (type === "s") {
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
        const idx = v ? Number(v[1]) : NaN;
        value = Number.isInteger(idx) && shared[idx] !== undefined ? shared[idx] : "";
      } else if (type === "inlineStr") {
        value = joinText(inner);
      } else if (type === "str") {
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
        value = v ? decodeXmlEntities(v[1]) : "";
      } else if (type === "b") {
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
        value = v && v[1].trim() === "1" ? "TRUE" : "FALSE";
      } else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
        value = v ? decodeXmlEntities(v[1]) : "";
      }
      if (col >= 0 && col < XLSX_MAX_COLS) {
        while (cells.length < col) cells.push("");
        cells[col] = value;
      }
    }
    rows.push(cells);
  }
  return rows;
}

// --- Minimal ZIP reader (central directory) ------------------------------

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localHeaderOffset: number;
}

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;

/** Locate + parse the central directory, returning each entry's metadata. */
function readCentralDirectory(buf: Buffer): ZipEntry[] {
  // Find EOCD (scan back from the end; comment is usually empty).
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 0xffff; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a valid .xlsx (no ZIP end-of-central-directory).");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== CEN_SIG) break;
    const method = buf.readUInt16LE(off + 10);
    const compressedSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localHeaderOffset = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    entries.push({ name, method, compressedSize, localHeaderOffset });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Inflate (or copy) one entry's bytes to a UTF-8 string. */
function readEntry(buf: Buffer, entry: ZipEntry): string {
  // Local header: name + extra lengths live at offset+26/+28 and may differ
  // from the central record, so read them here to find the data start.
  const lo = entry.localHeaderOffset;
  const nameLen = buf.readUInt16LE(lo + 26);
  const extraLen = buf.readUInt16LE(lo + 28);
  const start = lo + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return data.toString("utf8"); // stored
  if (entry.method === 8) return zlib.inflateRawSync(data).toString("utf8"); // deflate
  throw new Error(`Unsupported ZIP compression method ${entry.method}.`);
}

/** Parse `xl/workbook.xml` <sheet> elements into ordered {name, rid} pairs. */
export function parseWorkbookSheets(xml: string): { name: string; rid: string }[] {
  const out: { name: string; rid: string }[] = [];
  const re = /<sheet\b[^>]*?\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const tag = m[0];
    const name = /\bname="([^"]*)"/.exec(tag)?.[1] ?? "";
    const rid = /\br:id="([^"]*)"/i.exec(tag)?.[1] ?? "";
    out.push({ name: decodeXmlEntities(name), rid });
  }
  return out;
}

/** Parse `xl/_rels/workbook.xml.rels` into a relationship-id → target map. */
export function parseRels(xml: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /<Relationship\b[^>]*?\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const tag = m[0];
    const id = /\bId="([^"]*)"/.exec(tag)?.[1];
    const target = /\bTarget="([^"]*)"/.exec(tag)?.[1];
    if (id && target) map.set(id, target);
  }
  return map;
}

/** A rels Target (relative to xl/) → its central-directory entry name. */
function relTargetToEntry(target: string): string {
  if (target.startsWith("/")) return target.slice(1); // absolute within the package
  return "xl/" + target.replace(/^\.\//, "");
}

/** Read EVERY worksheet of an .xlsx buffer, in workbook order, with names. */
export function readXlsxSheets(buf: Buffer): Sheet[] {
  const entries = readCentralDirectory(buf);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const sharedEntry = byName.get("xl/sharedStrings.xml");
  const shared = sharedEntry ? parseSharedStrings(readEntry(buf, sharedEntry)) : [];

  const sheets: Sheet[] = [];
  // Preferred path: workbook.xml gives names + order, its rels give name→file.
  const wbEntry = byName.get("xl/workbook.xml");
  const relsEntry = byName.get("xl/_rels/workbook.xml.rels");
  if (wbEntry && relsEntry) {
    const wbSheets = parseWorkbookSheets(readEntry(buf, wbEntry));
    const rels = parseRels(readEntry(buf, relsEntry));
    for (const ws of wbSheets) {
      const target = rels.get(ws.rid);
      const entry = target ? byName.get(relTargetToEntry(target)) : undefined;
      if (!entry) continue;
      sheets.push({ name: ws.name || `Sheet ${sheets.length + 1}`, rows: parseSheet(readEntry(buf, entry), shared) });
    }
  }
  // Fallback: every sheetN.xml in numeric order with generic names.
  if (sheets.length === 0) {
    const sheetEntries = entries
      .map((e) => e.name)
      .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
      .sort((a, b) => Number(a.match(/sheet(\d+)\.xml$/)![1]) - Number(b.match(/sheet(\d+)\.xml$/)![1]));
    sheetEntries.forEach((n, i) => sheets.push({ name: `Sheet ${i + 1}`, rows: parseSheet(readEntry(buf, byName.get(n)!), shared) }));
  }
  if (sheets.length === 0) throw new Error("No worksheet found in the .xlsx.");
  return sheets;
}

/** Read the first worksheet of an .xlsx buffer into rows (back-compat helper). */
export function readXlsx(buf: Buffer): string[][] {
  return readXlsxSheets(buf)[0]?.rows ?? [];
}
