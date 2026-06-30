import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as zlib from "zlib";
import { parseCsv, parseDelimited, sniffDelimiter } from "../src/context/files/csv";
import {
  parseSharedStrings,
  parseSheet,
  columnToIndex,
  decodeXmlEntities,
  readXlsx,
} from "../src/context/files/xlsx";
import { detectTabularKind, renderTable, readTabularBuffer } from "../src/context/files/tabular";
import { withFile, withoutFile, findByLocation, fileLocationKey } from "../src/context/files/fileSources";
import type { FileSource } from "../src/context/files/fileSources";

// --- CSV -----------------------------------------------------------------

test("parseDelimited handles quotes, embedded commas/newlines, and escapes", () => {
  const csv = 'a,b,c\n1,"two, with comma","line\nbreak"\n"q""x",,z';
  assert.deepEqual(parseDelimited(csv), [
    ["a", "b", "c"],
    ["1", "two, with comma", "line\nbreak"],
    ['q"x', "", "z"],
  ]);
});

test("sniffDelimiter picks tab/semicolon/comma; CRLF tolerated", () => {
  assert.equal(sniffDelimiter("a\tb\tc\n1\t2\t3"), "\t");
  assert.equal(sniffDelimiter("a;b;c"), ";");
  assert.equal(sniffDelimiter("a,b"), ",");
  assert.deepEqual(parseCsv("a,b\r\n1,2\r\n"), [["a", "b"], ["1", "2"]]);
});

// --- XLSX XML scanners ---------------------------------------------------

test("parseSharedStrings joins rich runs and decodes entities", () => {
  const xml = `<sst><si><t>Plain</t></si><si><r><t>Hello </t></r><r><t>&amp; bye</t></r></si></sst>`;
  assert.deepEqual(parseSharedStrings(xml), ["Plain", "Hello & bye"]);
});

test("columnToIndex maps spreadsheet letters", () => {
  assert.equal(columnToIndex("A"), 0);
  assert.equal(columnToIndex("Z"), 25);
  assert.equal(columnToIndex("AA"), 26);
  assert.equal(columnToIndex("AB"), 27);
});

test("decodeXmlEntities handles named + numeric refs", () => {
  assert.equal(decodeXmlEntities("a&amp;b&lt;c&#65;&#x42;"), "a&b<cAB");
});

test("parseSheet resolves shared/inline/number/bool cells and preserves column gaps", () => {
  const shared = ["Name", "Ann"];
  const xml = `<sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="inlineStr"><is><t>Note</t></is></c></row>
    <row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>30</v></c><c r="C2" t="b"><v>1</v></c></row>
  </sheetData>`;
  const rows = parseSheet(xml, shared);
  assert.deepEqual(rows[0], ["Name", "", "Note"], "gap at B preserved");
  assert.deepEqual(rows[1], ["Ann", "30", "TRUE"]);
});

// --- XLSX end-to-end (ZIP built here, no deps) ---------------------------

function u16(n: number): Buffer { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; }
function u32(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; }

function makeZip(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const comp = zlib.deflateRawSync(e.data);
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(8), u16(0), u16(0),
      u32(0), u32(comp.length), u32(e.data.length),
      u16(nameBuf.length), u16(0), nameBuf, comp,
    ]);
    const central = Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(8), u16(0), u16(0),
      u32(0), u32(comp.length), u32(e.data.length),
      u16(nameBuf.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nameBuf,
    ]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const localsBuf = Buffer.concat(locals);
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(cd.length), u32(localsBuf.length), u16(0),
  ]);
  return Buffer.concat([localsBuf, cd, eocd]);
}

test("readXlsx reads the first sheet end-to-end (real ZIP + deflate)", () => {
  const shared = `<sst><si><t>Name</t></si><si><t>Age</t></si><si><t>Ann</t></si></sst>`;
  const sheet = `<worksheet><sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
    <row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>30</v></c></row>
  </sheetData></worksheet>`;
  const buf = makeZip([
    { name: "xl/sharedStrings.xml", data: Buffer.from(shared) },
    { name: "xl/worksheets/sheet1.xml", data: Buffer.from(sheet) },
  ]);
  assert.deepEqual(readXlsx(buf), [["Name", "Age"], ["Ann", "30"]]);
  // Same path via the tabular dispatcher.
  assert.deepEqual(readTabularBuffer("xlsx", buf), [["Name", "Age"], ["Ann", "30"]]);
});

// --- tabular render + detect ---------------------------------------------

test("detectTabularKind by extension", () => {
  assert.equal(detectTabularKind("data.CSV"), "csv");
  assert.equal(detectTabularKind("sheet.xlsx"), "xlsx");
  assert.equal(detectTabularKind("x.tsv"), "tsv");
  assert.equal(detectTabularKind("notes.txt"), "unknown");
});

test("renderTable makes a header table, escapes pipes, and notes truncation", () => {
  const rows = [["a", "b"], ["1", "x|y"], ["2", "z"]];
  const md = renderTable("Data", rows);
  assert.match(md, /\| a \| b \|/);
  assert.match(md, /x\\\|y/, "pipes escaped");
  assert.match(md, /3 row\(s\)/);
  // Truncation note when more rows than the cap (cap is high; simulate small).
  const many = Array.from({ length: 250 }, (_, i) => [String(i)]);
  assert.match(renderTable("Big", many), /more row\(s\) not shown/);
});

// --- file source list ops ------------------------------------------------

test("file source ops: add/replace/remove, dedup by location", () => {
  const a: FileSource = { id: "1", label: "A", location: { kind: "local", path: "/x/A.csv" }, tabular: "csv", addedAt: "t" };
  let items = withFile([], a);
  assert.equal(items.length, 1);
  // same location (case-folded) is found for dedup
  assert.ok(findByLocation(items, { kind: "local", path: "/X/a.csv" }));
  assert.equal(fileLocationKey({ kind: "graph", driveId: "d", itemId: "IT" }), "graph:IT");
  items = withoutFile(items, "1");
  assert.equal(items.length, 0);
});
