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
  readXlsxSheets,
  parseWorkbookSheets,
  parseRels,
} from "../src/context/files/xlsx";
import { detectTabularKind, renderTable, readTabularBuffer } from "../src/context/files/tabular";
import { readDocx, extractDocumentXmlText } from "../src/context/files/docx";
import { withFile, withoutFile, findByLocation, fileLocationKey, normalizeFileSource } from "../src/context/files/fileSources";
import type { FileSource } from "../src/context/files/fileSources";
import { encodeSharingUrl, driveItemToRef } from "../src/context/files/graphFiles";

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
  // Same path via the tabular dispatcher (now returns named sheets).
  assert.deepEqual(readTabularBuffer("xlsx", buf), [{ name: "Sheet 1", rows: [["Name", "Age"], ["Ann", "30"]] }]);
});

test("parseWorkbookSheets + parseRels map sheet names to worksheet files", () => {
  const wb = `<workbook><sheets><sheet name="Budget" sheetId="1" r:id="rId1"/><sheet name="Q&amp;A" sheetId="2" r:id="rId2"/></sheets></workbook>`;
  assert.deepEqual(parseWorkbookSheets(wb), [{ name: "Budget", rid: "rId1" }, { name: "Q&A", rid: "rId2" }]);
  const rels = `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>`;
  assert.equal(parseRels(rels).get("rId2"), "worksheets/sheet2.xml");
});

test("readXlsxSheets reads EVERY worksheet, named and in workbook order", () => {
  const shared = `<sst><si><t>A</t></si><si><t>B</t></si></sst>`;
  const wb = `<workbook><sheets><sheet name="First" sheetId="1" r:id="rId1"/><sheet name="Second" sheetId="2" r:id="rId2"/></sheets></workbook>`;
  const rels = `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>`;
  const s1 = `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>`;
  const s2 = `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>1</v></c></row></sheetData></worksheet>`;
  const buf = makeZip([
    { name: "xl/sharedStrings.xml", data: Buffer.from(shared) },
    { name: "xl/workbook.xml", data: Buffer.from(wb) },
    { name: "xl/_rels/workbook.xml.rels", data: Buffer.from(rels) },
    { name: "xl/worksheets/sheet1.xml", data: Buffer.from(s1) },
    { name: "xl/worksheets/sheet2.xml", data: Buffer.from(s2) },
  ]);
  const sheets = readXlsxSheets(buf);
  assert.deepEqual(sheets, [
    { name: "First", rows: [["A"]] },
    { name: "Second", rows: [["B"]] },
  ]);
});

// --- .docx (ZIP of XML; built with the same makeZip helper) --------------

test("extractDocumentXmlText pulls paragraph text, tabs, and breaks; entities decoded", () => {
  const xml = `<w:document><w:body>
    <w:p><w:r><w:t>Hello</w:t></w:r><w:tab/><w:r><w:t xml:space="preserve">world &amp; co</w:t></w:r></w:p>
    <w:p><w:r><w:t>Line two</w:t></w:r><w:br/><w:r><w:t>after break</w:t></w:r></w:p>
  </w:body></w:document>`;
  assert.equal(extractDocumentXmlText(xml), "Hello\tworld & co\nLine two\nafter break");
});

test("readDocx reads word/document.xml from the archive", () => {
  const doc = `<w:document><w:body><w:p><w:r><w:t>Contract text</w:t></w:r></w:p></w:body></w:document>`;
  const buf = makeZip([
    { name: "[Content_Types].xml", data: Buffer.from("<Types/>") },
    { name: "word/document.xml", data: Buffer.from(doc) },
  ]);
  assert.equal(readDocx(buf), "Contract text");
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

test("encodeSharingUrl produces a Graph base64url 'u!' id", () => {
  // base64url: + → -, / → _, no padding, prefixed with "u!".
  assert.equal(encodeSharingUrl("https://x?a=1&b=2/c+d"), "u!" + Buffer.from("https://x?a=1&b=2/c+d").toString("base64").replace(/=+$/, "").replace(/\//g, "_").replace(/\+/g, "-"));
  assert.match(encodeSharingUrl("https://contoso.sharepoint.com/:x:/g/abc"), /^u!/);
});

test("driveItemToRef reads a /shares result and a sharedWithMe (remoteItem) shape", () => {
  const shares = driveItemToRef({ id: "IT", name: "Book.xlsx", webUrl: "https://w", parentReference: { driveId: "DR" } });
  assert.deepEqual(shares, { driveId: "DR", itemId: "IT", name: "Book.xlsx", webUrl: "https://w" });
  const shared = driveItemToRef({ id: "local", name: "Data.csv", remoteItem: { id: "RID", parentReference: { driveId: "RDR" } } });
  assert.equal(shared?.driveId, "RDR");
  assert.equal(shared?.itemId, "RID");
  assert.equal(driveItemToRef({ name: "x" }), undefined, "incomplete → undefined");
});

test("file source ops: add/replace/remove, dedup by location", () => {
  const a: FileSource = { id: "1", label: "A", location: { kind: "local", path: "/x/A.csv" }, kind: "csv", addedAt: "t" };
  let items = withFile([], a);
  assert.equal(items.length, 1);
  // same location (case-folded) is found for dedup
  assert.ok(findByLocation(items, { kind: "local", path: "/X/a.csv" }));
  assert.equal(fileLocationKey({ kind: "graph", connectionHandle: "h", driveId: "d", itemId: "IT" }), "graph:IT");
  items = withoutFile(items, "1");
  assert.equal(items.length, 0);
});

test("normalizeFileSource upgrades legacy {tabular} records to {kind}", () => {
  // Pre-0.100 builds stored the field as `tabular`.
  const legacy = { id: "1", label: "Old", location: { kind: "local", path: "/x.csv" }, tabular: "csv", addedAt: "t" } as unknown as FileSource;
  assert.equal(normalizeFileSource(legacy).kind, "csv");
  const current: FileSource = { id: "2", label: "New", location: { kind: "local", path: "/y.docx" }, kind: "docx", addedAt: "t" };
  assert.equal(normalizeFileSource(current).kind, "docx");
  const neither = { id: "3", label: "?", location: { kind: "local", path: "/z" }, addedAt: "t" } as unknown as FileSource;
  assert.equal(normalizeFileSource(neither).kind, "unknown");
});
