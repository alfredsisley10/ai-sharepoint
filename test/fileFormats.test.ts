import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as zlib from "zlib";
import { decodeRk, parseSst, parseWorkbookStream, parseCfb, readXls } from "../src/context/files/xls";
import { parseLiteralString, extractContentText, extractPdfText } from "../src/context/files/pdf";
import { decodeText, looksBinary } from "../src/context/files/text";
import {
  detectFileKind,
  readFileContent,
  renderFileContent,
  summarizeFileContent,
  describeKind,
} from "../src/context/files/fileContent";

const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n & 0xffff); return b; };
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const f64 = (n: number) => { const b = Buffer.alloc(8); b.writeDoubleLE(n); return b; };

// --- BIFF (legacy .xls record layer) -------------------------------------

const biffRec = (type: number, data: Buffer) => Buffer.concat([u16(type), u16(data.length), data]);
/** A BIFF8 short Unicode string: 1-byte cch, 1-byte grbit(0=compressed), chars. */
const shortStr = (s: string) => Buffer.concat([Buffer.from([s.length, 0]), Buffer.from(s, "latin1")]);
/** An SST entry: 2-byte cch, 1-byte grbit(0), compressed chars. */
const sstStr = (s: string) => Buffer.concat([u16(s.length), Buffer.from([0]), Buffer.from(s, "latin1")]);
const rkInt = (n: number) => (n << 2) | 2; // RK encoding for an integer

test("decodeRk handles integers, the /100 flag, and IEEE doubles", () => {
  assert.equal(decodeRk(rkInt(30) >>> 0), 30);
  assert.equal(decodeRk(((250 << 2) | 2 | 1) >>> 0), 2.5); // fInt + fX100
  const b = Buffer.alloc(8);
  b.writeDoubleLE(1.5, 0);
  assert.equal(decodeRk(b.readUInt32LE(4) & 0xfffffffc), 1.5); // float path (low bits zero)
});

test("parseSst reads strings, including one split across a CONTINUE boundary", () => {
  // Two strings; the second ("WORLD") starts in the SST record and continues in
  // a CONTINUE segment whose leading byte is a fresh option flag (compressed).
  const head = Buffer.concat([u32(2), u32(2), sstStr("HELLO"), u16(5), Buffer.from([0]), Buffer.from("WO", "latin1")]);
  const cont = Buffer.concat([Buffer.from([0]), Buffer.from("RLD", "latin1")]); // grbit byte + remaining chars
  assert.deepEqual(parseSst([head, cont]), ["HELLO", "WORLD"]);
});

test("parseWorkbookStream reads EVERY worksheet with names, resolving the SST", () => {
  const sst = Buffer.concat([u32(2), u32(2), sstStr("Name"), sstStr("Ann")]);
  const stream = Buffer.concat([
    biffRec(0x0809, Buffer.concat([u16(0x0600), u16(0x0005)])), // globals BOF
    biffRec(0x0085, Buffer.concat([u32(0), Buffer.from([0, 0]), shortStr("One")])), // BOUNDSHEET worksheet
    biffRec(0x0085, Buffer.concat([u32(0), Buffer.from([0, 0]), shortStr("Two")])),
    biffRec(0x00fc, sst), // SST
    biffRec(0x0809, Buffer.concat([u16(0x0600), u16(0x0010)])), // sheet One BOF (worksheet)
    biffRec(0x00fd, Buffer.concat([u16(0), u16(0), u16(0), u32(0)])), // LABELSST (0,0)=SST[0]
    biffRec(0x027e, Buffer.concat([u16(1), u16(0), u16(0), u32(rkInt(30))])), // RK (1,0)=30
    biffRec(0x0203, Buffer.concat([u16(1), u16(1), u16(0), f64(45.5)])), // NUMBER (1,1)=45.5
    biffRec(0x000a, Buffer.alloc(0)), // EOF
    biffRec(0x0809, Buffer.concat([u16(0x0600), u16(0x0010)])), // sheet Two BOF
    biffRec(0x00fd, Buffer.concat([u16(0), u16(0), u16(0), u32(1)])), // LABELSST (0,0)=SST[1]
    biffRec(0x000a, Buffer.alloc(0)),
  ]);
  assert.deepEqual(parseWorkbookStream(stream), [
    { name: "One", rows: [["Name", ""], ["30", "45.5"]] },
    { name: "Two", rows: [["Ann"]] },
  ]);
});

// --- CFB container (build a minimal one, store a "Workbook" stream) -------

function makeCfb(streamName: string, data: Buffer): Buffer {
  const SS = 512;
  // Pad the stream to a big-sector multiple ≥ mini cutoff so it's read via the big FAT.
  const padLen = Math.max(4096, Math.ceil(data.length / SS) * SS);
  const payload = Buffer.concat([data, Buffer.alloc(padLen - data.length)]);
  const nData = padLen / SS;

  const header = Buffer.alloc(SS, 0);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(header, 0);
  header.writeUInt16LE(0x003e, 24); // minor
  header.writeUInt16LE(3, 26); // major (v3 → 512-byte sectors)
  header.writeUInt16LE(0xfffe, 28); // byte order
  header.writeUInt16LE(9, 30); // sector shift
  header.writeUInt16LE(6, 32); // mini sector shift
  header.writeUInt32LE(0, 40); // num dir sectors
  header.writeUInt32LE(1, 44); // num FAT sectors
  header.writeUInt32LE(1, 48); // first dir sector
  header.writeUInt32LE(4096, 56); // mini cutoff
  header.writeUInt32LE(0xfffffffe, 60); // first mini FAT (none)
  header.writeUInt32LE(0, 64); // num mini FAT
  header.writeUInt32LE(0xfffffffe, 68); // first DIFAT (none)
  header.writeUInt32LE(0, 72); // num DIFAT
  for (let i = 0; i < 109; i++) header.writeUInt32LE(i === 0 ? 0 : 0xffffffff, 76 + i * 4); // DIFAT[0]=FAT in sector 0

  // FAT sector (sector 0): 0=FATSECT, 1=dir(ENDOFCHAIN), data chain 2..end.
  const fat = Buffer.alloc(SS, 0xff);
  fat.writeUInt32LE(0xfffffffd, 0); // sector 0 holds the FAT
  fat.writeUInt32LE(0xfffffffe, 4); // dir sector ends its chain
  for (let i = 0; i < nData; i++) {
    const sec = 2 + i;
    fat.writeUInt32LE(i === nData - 1 ? 0xfffffffe : sec + 1, sec * 4);
  }

  // Directory sector (sector 1): root entry + the stream entry.
  const dir = Buffer.alloc(SS, 0);
  const writeEntry = (off: number, name: string, type: number, start: number, size: number) => {
    const nm = Buffer.from(name, "utf16le");
    nm.copy(dir, off);
    dir.writeUInt16LE(nm.length + 2, off + 64); // name length incl. null
    dir.writeUInt8(type, off + 66);
    dir.writeUInt8(1, off + 67); // color
    dir.writeUInt32LE(0xffffffff, off + 68); // left
    dir.writeUInt32LE(0xffffffff, off + 72); // right
    dir.writeUInt32LE(0xffffffff, off + 76); // child
    dir.writeUInt32LE(start, off + 116);
    dir.writeUInt32LE(size, off + 120);
  };
  writeEntry(0, "Root Entry", 5, 0xfffffffe, 0);
  writeEntry(128, streamName, 2, 2, payload.length);

  return Buffer.concat([header, fat, dir, payload]);
}

test("parseCfb + readXls extract the Workbook stream end-to-end", () => {
  const sst = Buffer.concat([u32(1), u32(1), sstStr("Hi")]);
  const wb = Buffer.concat([
    biffRec(0x0809, Buffer.concat([u16(0x0600), u16(0x0005)])),
    biffRec(0x0085, Buffer.concat([u32(0), Buffer.from([0, 0]), shortStr("S1")])),
    biffRec(0x00fc, sst),
    biffRec(0x0809, Buffer.concat([u16(0x0600), u16(0x0010)])),
    biffRec(0x00fd, Buffer.concat([u16(0), u16(0), u16(0), u32(0)])),
    biffRec(0x000a, Buffer.alloc(0)),
  ]);
  const cfb = makeCfb("Workbook", wb);
  assert.ok(parseCfb(cfb).readByName("Workbook"), "CFB exposes the Workbook stream");
  assert.deepEqual(readXls(cfb), [{ name: "S1", rows: [["Hi"]] }]);
});

// --- PDF -----------------------------------------------------------------

test("parseLiteralString decodes escapes, octal, and nested parens", () => {
  assert.deepEqual(parseLiteralString("a\\(b\\)c)", 0), ["a(b)c", 8]);
  assert.equal(parseLiteralString("\\110\\151)", 0)[0], "Hi"); // octal 110=H, 151=i
  assert.equal(parseLiteralString("x(y)z)", 0)[0], "x(y)z"); // nested
});

test("extractContentText pulls Tj/TJ text with line breaks", () => {
  assert.equal(extractContentText("BT (Hello) Tj T* (World) Tj ET"), "Hello\nWorld");
  assert.equal(extractContentText("BT [(Ab)-20(cd)] TJ ET"), "Abcd");
});

test("extractPdfText handles uncompressed and FlateDecode content streams", () => {
  const plain = Buffer.from("%PDF-1.4\n<< /Length 22 >>\nstream\nBT (Hello World) Tj ET\nendstream\n%%EOF", "latin1");
  assert.equal(extractPdfText(plain), "Hello World");

  const deflated = zlib.deflateSync(Buffer.from("BT (Zipped text) Tj ET", "latin1"));
  const pdf = Buffer.concat([
    Buffer.from("%PDF-1.5\n<< /Filter /FlateDecode /Length " + deflated.length + " >>\nstream\n", "latin1"),
    deflated,
    Buffer.from("\nendstream\n%%EOF", "latin1"),
  ]);
  assert.equal(extractPdfText(pdf), "Zipped text");
});

test("extractPdfText returns empty for a PDF with no text content (e.g. scanned)", () => {
  const pdf = Buffer.from("%PDF-1.4\n<< /Length 5 >>\nstream\n\x00\x01\x02\x03\x04\nendstream\n%%EOF", "latin1");
  assert.equal(extractPdfText(pdf), "");
});

// --- text ----------------------------------------------------------------

test("decodeText strips a BOM; looksBinary flags NUL / control-heavy buffers", () => {
  assert.equal(decodeText(Buffer.from("﻿hello", "utf8")), "hello");
  assert.equal(looksBinary(Buffer.from("plain text\nwith lines\t too")), false);
  assert.equal(looksBinary(Buffer.from([0x48, 0x00, 0x49])), true); // NUL
  assert.equal(looksBinary(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 11])), true); // control-heavy
  assert.equal(looksBinary(Buffer.alloc(0)), false); // empty is "text"
});

// --- fileContent (kind detection, dispatch, render) ----------------------

test("detectFileKind classifies by extension; unknown for binaries", () => {
  assert.equal(detectFileKind("a.CSV"), "csv");
  assert.equal(detectFileKind("a.xlsx"), "xlsx");
  assert.equal(detectFileKind("a.xls"), "xls");
  assert.equal(detectFileKind("a.docx"), "docx");
  assert.equal(detectFileKind("report.pdf"), "pdf");
  assert.equal(detectFileKind("notes.txt"), "text");
  assert.equal(detectFileKind("readme.md"), "text");
  assert.equal(detectFileKind("image.png"), "unknown");
});

test("readFileContent dispatches to table vs text and rejects binaries", () => {
  assert.deepEqual(readFileContent("csv", Buffer.from("a,b\n1,2")), {
    kind: "table",
    sheets: [{ name: "", rows: [["a", "b"], ["1", "2"]] }],
  });
  assert.deepEqual(readFileContent("text", Buffer.from("plain")), { kind: "text", text: "plain" });
  assert.throws(() => readFileContent("text", Buffer.from([0, 1, 2, 3])), /binary/i);
});

test("renderFileContent renders text, single-sheet, and multi-sheet workbooks", () => {
  assert.match(renderFileContent("Notes", { kind: "text", text: "hello world" }), /^# Notes\n\nhello world/);
  const single = renderFileContent("Data", { kind: "table", sheets: [{ name: "S", rows: [["a"], ["1"]] }] });
  assert.match(single, /# Data/);
  const multi = renderFileContent("Book", {
    kind: "table",
    sheets: [{ name: "First", rows: [["a"]] }, { name: "Second", rows: [["b"]] }],
  });
  assert.match(multi, /## First/);
  assert.match(multi, /## Second/);
  assert.match(multi, /2 sheets/);
});

test("summarizeFileContent + describeKind give friendly summaries", () => {
  assert.equal(summarizeFileContent({ kind: "text", text: "abcd" }), "4 characters");
  assert.match(summarizeFileContent({ kind: "text", text: "   " }), /no extractable text/);
  assert.equal(
    summarizeFileContent({ kind: "table", sheets: [{ name: "a", rows: [["1"]] }, { name: "b", rows: [["2"], ["3"]] }] }),
    "2 sheets, 3 rows total",
  );
  assert.equal(describeKind("xls"), "Excel (legacy)");
  assert.equal(describeKind("docx"), "Word");
});
