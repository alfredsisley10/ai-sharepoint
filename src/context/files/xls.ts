/**
 * Dependency-free legacy .xls reader (BIFF8 inside an OLE2 / Compound File
 * Binary container) — just enough to pull the first worksheet into rows of
 * strings for read-only context, mirroring the .xlsx reader's deliberately small
 * scope.
 *
 * Two layers, separately unit-tested:
 *   1. CFB: parse the compound-file container (FAT, directory, mini-stream) and
 *      extract the "Workbook" (BIFF8) or "Book" (BIFF5/7) stream.
 *   2. BIFF: walk the record stream, build the Shared String Table (handling the
 *      fiddly CONTINUE split + compressed/uncompressed runs), and read the first
 *      worksheet's cells (LABELSST / RK / NUMBER / MULRK / LABEL / BOOLERR /
 *      FORMULA+STRING) into a grid.
 *
 * Best-effort by design: rich-text runs / phonetic data are skipped, dates show
 * as their serial number, and anything outside the common record set is ignored.
 * Throws a clear "save as .xlsx" error when the container or workbook can't be
 * read, so callers degrade gracefully rather than crash.
 */

import { Sheet } from "./sheet";

const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;

export interface CfbReader {
  readByName(name: string): Buffer | undefined;
}

/** Parse a Compound File Binary buffer into a by-name stream reader. */
export function parseCfb(buf: Buffer): CfbReader {
  if (buf.length < 512 || buf.readUInt32LE(0) !== 0xe011cfd0 || buf.readUInt32LE(4) !== 0xe11ab1a1) {
    throw new Error("Not a valid .xls (missing the OLE2 compound-file signature).");
  }
  const sectorShift = buf.readUInt16LE(30);
  const sectorSize = 1 << sectorShift; // normally 512
  const miniSectorSize = 1 << buf.readUInt16LE(32); // normally 64
  const dirStart = buf.readUInt32LE(48);
  const miniCutoff = buf.readUInt32LE(56);
  const miniFatStart = buf.readUInt32LE(60);
  const firstDifat = buf.readUInt32LE(68);
  const numDifat = buf.readUInt32LE(72);

  const sectorOffset = (s: number): number => 512 + s * sectorSize;
  const readSector = (s: number): Buffer => buf.subarray(sectorOffset(s), sectorOffset(s) + sectorSize);

  // --- DIFAT → list of FAT sector numbers --------------------------------
  const fatSectors: number[] = [];
  for (let i = 0; i < 109; i++) {
    const s = buf.readUInt32LE(76 + i * 4);
    if (s !== FREESECT && s !== ENDOFCHAIN) fatSectors.push(s);
  }
  let difatSector = firstDifat;
  for (let n = 0; n < numDifat && difatSector !== ENDOFCHAIN && difatSector !== FREESECT; n++) {
    const sec = readSector(difatSector);
    const per = sectorSize / 4;
    for (let i = 0; i < per - 1; i++) {
      const s = sec.readUInt32LE(i * 4);
      if (s !== FREESECT && s !== ENDOFCHAIN) fatSectors.push(s);
    }
    difatSector = sec.readUInt32LE((per - 1) * 4); // last entry chains to the next DIFAT sector
  }

  // --- FAT (one big array of next-sector pointers) -----------------------
  const fat: number[] = [];
  for (const fs of fatSectors) {
    const sec = readSector(fs);
    for (let i = 0; i < sectorSize / 4; i++) fat.push(sec.readUInt32LE(i * 4));
  }

  const readChain = (start: number): Buffer => {
    const parts: Buffer[] = [];
    let s = start;
    const seen = new Set<number>();
    while (s !== ENDOFCHAIN && s !== FREESECT && s < fat.length && !seen.has(s)) {
      seen.add(s);
      parts.push(readSector(s));
      s = fat[s];
    }
    return Buffer.concat(parts);
  };

  // --- Directory entries -------------------------------------------------
  const dir = readChain(dirStart);
  interface Entry {
    name: string;
    type: number;
    start: number;
    size: number;
  }
  const entries: Entry[] = [];
  for (let off = 0; off + 128 <= dir.length; off += 128) {
    const nameLen = dir.readUInt16LE(off + 64);
    if (nameLen < 2) continue;
    const name = dir.toString("utf16le", off, off + nameLen - 2);
    const type = dir.readUInt8(off + 66);
    const start = dir.readUInt32LE(off + 116);
    const size = dir.readUInt32LE(off + 120);
    entries.push({ name, type, start, size });
  }

  // Root entry (type 5) holds the mini-stream (start + size) in the big FAT.
  const root = entries.find((e) => e.type === 5);
  const miniStream = root ? readChain(root.start).subarray(0, root.size) : Buffer.alloc(0);

  // Mini-FAT, for streams smaller than the cutoff (stored in the mini-stream).
  const miniFatBytes = miniFatStart === ENDOFCHAIN ? Buffer.alloc(0) : readChain(miniFatStart);
  const miniFat: number[] = [];
  for (let i = 0; i + 4 <= miniFatBytes.length; i += 4) miniFat.push(miniFatBytes.readUInt32LE(i));

  const readMiniChain = (start: number, size: number): Buffer => {
    const parts: Buffer[] = [];
    let s = start;
    const seen = new Set<number>();
    while (s !== ENDOFCHAIN && s !== FREESECT && s < miniFat.length && !seen.has(s)) {
      seen.add(s);
      parts.push(miniStream.subarray(s * miniSectorSize, s * miniSectorSize + miniSectorSize));
      s = miniFat[s];
    }
    return Buffer.concat(parts).subarray(0, size);
  };

  const readEntry = (e: Entry): Buffer =>
    e.size < miniCutoff ? readMiniChain(e.start, e.size) : readChain(e.start).subarray(0, e.size);

  return {
    readByName(name: string): Buffer | undefined {
      const e = entries.find((x) => x.type === 2 && x.name === name);
      return e ? readEntry(e) : undefined;
    },
  };
}

// --- BIFF8 record layer ----------------------------------------------------

const REC = {
  BOF: 0x0809,
  EOF: 0x000a,
  BOUNDSHEET: 0x0085,
  SST: 0x00fc,
  CONTINUE: 0x003c,
  LABELSST: 0x00fd,
  LABEL: 0x0204,
  RK: 0x027e,
  MULRK: 0x00bd,
  NUMBER: 0x0203,
  BOOLERR: 0x0205,
  FORMULA: 0x0006,
  STRING: 0x0207,
} as const;

interface BiffRecord {
  type: number;
  data: Buffer;
}

/** Split a workbook stream into its (type,length,data) records. */
export function parseRecords(buf: Buffer): BiffRecord[] {
  const out: BiffRecord[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const type = buf.readUInt16LE(off);
    const len = buf.readUInt16LE(off + 2);
    const data = buf.subarray(off + 4, off + 4 + len);
    out.push({ type, data });
    off += 4 + len;
  }
  return out;
}

/** Decode an RK-encoded number (used by RK and MULRK cells). */
export function decodeRk(rk: number): number {
  const div100 = (rk & 1) !== 0;
  let val: number;
  if (rk & 2) {
    val = rk >> 2; // signed 30-bit integer
  } else {
    const b = Buffer.alloc(8);
    b.writeInt32LE(rk & 0xfffffffc, 4); // top 30 bits = high word of an IEEE double; low bits 0
    val = b.readDoubleLE(0);
  }
  return div100 ? val / 100 : val;
}

/**
 * Parse a Shared String Table from the SST record's data plus the data of every
 * CONTINUE record that followed it. The hard part: a string's character array
 * can be split across a record boundary, and the continuation restarts with a
 * 1-byte option flag that may switch between 8-bit (compressed) and 16-bit
 * (uncompressed) — so we read character-by-character across segments.
 */
export function parseSst(segments: Buffer[]): string[] {
  const strings: string[] = [];
  if (segments.length === 0) return strings;
  // Logical cursor over the concatenated segments, remembering segment bounds.
  let si = 0;
  let off = 0;
  const norm = () => {
    while (si < segments.length && off >= segments[si].length) {
      si++;
      off = 0;
    }
  };
  const atEnd = () => {
    norm();
    return si >= segments.length;
  };
  const byte = () => {
    norm();
    return segments[si][off++];
  };
  const u16 = () => byte() | (byte() << 8);
  const u32 = () => u16() | (u16() << 16);
  const skip = (n: number) => {
    for (let i = 0; i < n && !atEnd(); i++) byte();
  };

  const nUnique = u32(); // [0]=nTotal (ignored), [4]=nUnique
  const realUnique = u32();
  void nUnique;
  for (let n = 0; n < realUnique && !atEnd(); n++) {
    const cch = u16();
    let grbit = byte();
    let high = (grbit & 0x01) !== 0;
    const rich = (grbit & 0x08) !== 0;
    const ext = (grbit & 0x04) !== 0;
    const cRun = rich ? u16() : 0;
    const cbExt = ext ? u32() : 0;
    let s = "";
    norm();
    let curSeg = si;
    let i = 0;
    while (i < cch) {
      norm();
      if (si !== curSeg) {
        // Crossed into a CONTINUE segment mid-string → its first byte is a new
        // option flag for the remaining characters (only the high-byte bit matters).
        grbit = byte();
        high = (grbit & 0x01) !== 0;
        norm();
        curSeg = si;
      }
      s += high ? String.fromCharCode(byte() | (byte() << 8)) : String.fromCharCode(byte());
      i++;
    }
    skip(cRun * 4 + cbExt); // rich-run formatting + phonetic data: not needed for text
    strings.push(s);
  }
  return strings;
}

/** Read a BIFF8 short Unicode string (1-byte length) — used for sheet names. */
function readShortUnicode(data: Buffer, pos: number): string {
  const cch = data.readUInt8(pos);
  const grbit = data.readUInt8(pos + 1);
  const high = (grbit & 0x01) !== 0;
  let s = "";
  let p = pos + 2;
  for (let i = 0; i < cch; i++) {
    s += high ? String.fromCharCode(data.readUInt16LE(p)) : String.fromCharCode(data.readUInt8(p));
    p += high ? 2 : 1;
  }
  return s;
}

const XLS_MAX_ROWS = 1000;
const XLS_MAX_COLS = 64;

function numToStr(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(10)));
}

/** Convert a sparse (row→col→value) grid into bounded rows of strings. */
function gridToRows(grid: Map<number, Map<number, string>>): string[][] {
  if (grid.size === 0) return [];
  const maxRow = Math.min(XLS_MAX_ROWS - 1, Math.max(...grid.keys()));
  let maxCol = 0;
  for (const row of grid.values()) for (const c of row.keys()) maxCol = Math.max(maxCol, c);
  maxCol = Math.min(XLS_MAX_COLS - 1, maxCol);
  const rows: string[][] = [];
  for (let r = 0; r <= maxRow; r++) {
    const row = grid.get(r);
    const cells: string[] = [];
    for (let c = 0; c <= maxCol; c++) cells.push(row?.get(c) ?? "");
    rows.push(cells);
  }
  while (rows.length && rows[rows.length - 1].every((x) => x === "")) rows.pop();
  return rows;
}

/**
 * Walk a workbook stream's records and return EVERY worksheet's cells as named
 * sheets. SST and the BOUNDSHEET directory live in the globals substream (before
 * any sheet), so a single linear pass resolves shared strings and sheet names
 * before the worksheet cells use them. Sheets are emitted in substream order,
 * which matches the order of the worksheet BOUNDSHEET records.
 */
export function parseWorkbookStream(buf: Buffer): Sheet[] {
  const records = parseRecords(buf);
  let sst: string[] = [];
  let collectingSst = false;
  let sstSegs: Buffer[] = [];
  let bofCount = 0;
  const sheetNames: string[] = []; // worksheet BOUNDSHEET names, in order
  const sheets: Sheet[] = [];
  let cur: { name: string; grid: Map<number, Map<number, string>> } | undefined;
  let sheetIndex = 0;
  let lastStringCell: { r: number; c: number } | undefined;

  const sstAt = (i: number) => (i >= 0 && i < sst.length ? sst[i] : "");
  const put = (r: number, c: number, v: string) => {
    if (!cur || r >= XLS_MAX_ROWS || c >= XLS_MAX_COLS) return;
    let row = cur.grid.get(r);
    if (!row) cur.grid.set(r, (row = new Map()));
    row.set(c, v);
  };

  const handleCell = (rec: BiffRecord): void => {
    const d = rec.data;
    switch (rec.type) {
      case REC.LABELSST:
        put(d.readUInt16LE(0), d.readUInt16LE(2), sstAt(d.readUInt32LE(6)));
        break;
      case REC.RK:
        put(d.readUInt16LE(0), d.readUInt16LE(2), numToStr(decodeRk(d.readUInt32LE(6))));
        break;
      case REC.NUMBER:
        put(d.readUInt16LE(0), d.readUInt16LE(2), numToStr(d.readDoubleLE(6)));
        break;
      case REC.MULRK: {
        const r = d.readUInt16LE(0);
        const first = d.readUInt16LE(2);
        const count = (d.length - 6) / 6; // each: xf(2)+rk(4); trailing last-col(2)
        for (let i = 0; i < count; i++) put(r, first + i, numToStr(decodeRk(d.readUInt32LE(6 + i * 6 + 2))));
        break;
      }
      case REC.LABEL:
        put(d.readUInt16LE(0), d.readUInt16LE(2), readShortUnicodeWide(d, 6));
        break;
      case REC.BOOLERR:
        put(d.readUInt16LE(0), d.readUInt16LE(2), d.readUInt8(7) ? "#ERR" : d.readUInt8(6) ? "TRUE" : "FALSE");
        break;
      case REC.FORMULA: {
        const r = d.readUInt16LE(0);
        const c = d.readUInt16LE(2);
        // String result: bytes 6 (==0) and 12-13 (==0xFFFF); text follows in STRING.
        if (d.readUInt8(6) === 0 && d.readUInt16LE(12) === 0xffff) lastStringCell = { r, c };
        else put(r, c, numToStr(d.readDoubleLE(6)));
        break;
      }
      case REC.STRING:
        if (lastStringCell) {
          put(lastStringCell.r, lastStringCell.c, readWideString16(d, 0));
          lastStringCell = undefined;
        }
        break;
    }
  };

  for (const rec of records) {
    if (collectingSst) {
      if (rec.type === REC.CONTINUE) {
        sstSegs.push(rec.data);
        continue;
      }
      sst = parseSst(sstSegs);
      collectingSst = false;
      sstSegs = [];
    }
    switch (rec.type) {
      case REC.BOF: {
        bofCount++;
        const dt = rec.data.length >= 4 ? rec.data.readUInt16LE(2) : 0;
        if (bofCount > 1 && dt === 0x0010) {
          const name = sheetNames[sheetIndex] || `Sheet ${sheetIndex + 1}`;
          sheetIndex++;
          cur = { name, grid: new Map() };
        }
        break;
      }
      case REC.SST:
        collectingSst = true;
        sstSegs = [rec.data];
        break;
      case REC.BOUNDSHEET:
        // dt at offset 5: 0 = worksheet. Record names for worksheet substreams.
        if (rec.data.length >= 6 && rec.data.readUInt8(5) === 0) sheetNames.push(readShortUnicode(rec.data, 6));
        break;
      case REC.EOF:
        if (cur) {
          sheets.push({ name: cur.name, rows: gridToRows(cur.grid) });
          cur = undefined;
        }
        break;
      default:
        if (cur) handleCell(rec);
    }
  }
  if (cur) sheets.push({ name: cur.name, rows: gridToRows(cur.grid) }); // unterminated last sheet
  return sheets;
}

/** BIFF8 LABEL string: 2-byte cch then 1-byte grbit then chars. */
function readShortUnicodeWide(data: Buffer, pos: number): string {
  const cch = data.readUInt16LE(pos);
  return readChars(data, pos + 2, cch);
}

/** BIFF8 STRING-record string: 2-byte cch then 1-byte grbit then chars. */
function readWideString16(data: Buffer, pos: number): string {
  const cch = data.readUInt16LE(pos);
  return readChars(data, pos + 2, cch);
}

function readChars(data: Buffer, grbitPos: number, cch: number): string {
  const high = (data.readUInt8(grbitPos) & 0x01) !== 0;
  let s = "";
  let p = grbitPos + 1;
  for (let i = 0; i < cch && p < data.length; i++) {
    s += high ? String.fromCharCode(data.readUInt16LE(p)) : String.fromCharCode(data.readUInt8(p));
    p += high ? 2 : 1;
  }
  return s;
}

/** Read a legacy .xls buffer into every worksheet's rows of strings. Converts any
 *  low-level corruption (a valid signature wrapping a malformed structure) into a
 *  clean, actionable message instead of a raw RangeError. */
export function readXls(buf: Buffer): Sheet[] {
  try {
    const cfb = parseCfb(buf);
    const wb = cfb.readByName("Workbook") ?? cfb.readByName("Book");
    if (!wb) {
      throw new Error("No Workbook stream found in the .xls — it may be corrupt. If it's very old, re-save it as .xlsx.");
    }
    return parseWorkbookStream(wb);
  } catch (e) {
    // Preserve the already-actionable messages; wrap anything lower-level.
    const msg = e instanceof Error ? e.message : String(e);
    if (/valid \.xls|Workbook stream|re-save/i.test(msg)) throw e;
    throw new Error("Could not read this .xls — the file appears corrupt or uses an unsupported variant. Open it in Excel and “Save As” .xlsx, then re-add.");
  }
}
