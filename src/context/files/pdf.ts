import * as zlib from "zlib";

/**
 * Best-effort, dependency-free PDF text extractor for read-only context. A PDF's
 * visible text lives in content streams as text-showing operators; we locate
 * every `stream … endstream`, inflate FlateDecode ones (Node's built-in zlib),
 * and pull the strings out of `Tj` / `TJ` / `'` / `"` operators, decoding bytes
 * as Latin1/WinAnsi.
 *
 * Documented limits (best-effort, like the .xlsx/.xls readers): text using
 * embedded CID/subset fonts with custom encodings may decode imperfectly, and
 * SCANNED/image-only PDFs contain no text at all — those yield an empty result,
 * which the caller surfaces as a clear "no extractable text" message rather than
 * an error. The string/operator scanners are pure and unit-tested.
 */

const MAX_CHARS = 2_000_000;

/** Decode a PDF hex string ("48656C6C6F") to its Latin1 characters. */
function decodeHex(hex: string): string {
  const clean = hex.replace(/[^0-9a-fA-F]/g, "");
  let out = "";
  for (let i = 0; i + 1 < clean.length; i += 2) out += String.fromCharCode(parseInt(clean.substr(i, 2), 16));
  if (clean.length % 2 === 1) out += String.fromCharCode(parseInt(clean[clean.length - 1] + "0", 16));
  return out;
}

/** Parse a PDF literal string body starting just after "(", returning the
 *  decoded text and the index just past the closing ")". Handles escapes,
 *  octal codes, line continuations, and nested parentheses. */
export function parseLiteralString(s: string, start: number): [string, number] {
  let depth = 1;
  let out = "";
  let i = start;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") {
      const nx = s[i + 1];
      if (nx === "n") { out += "\n"; i += 2; continue; }
      if (nx === "r") { out += "\r"; i += 2; continue; }
      if (nx === "t") { out += "\t"; i += 2; continue; }
      if (nx === "b") { out += "\b"; i += 2; continue; }
      if (nx === "f") { out += "\f"; i += 2; continue; }
      if (nx === "(" || nx === ")" || nx === "\\") { out += nx; i += 2; continue; }
      if (nx >= "0" && nx <= "7") {
        let oct = nx;
        i += 2;
        for (let k = 0; k < 2 && s[i] >= "0" && s[i] <= "7"; k++) oct += s[i++];
        out += String.fromCharCode(parseInt(oct, 8) & 0xff);
        continue;
      }
      if (nx === "\n") { i += 2; continue; } // line continuation
      if (nx === "\r") { i += 2; if (s[i] === "\n") i++; continue; }
      out += nx ?? "";
      i += 2;
      continue;
    }
    if (c === "(") { depth++; out += c; i++; continue; }
    if (c === ")") { depth--; if (depth === 0) { i++; break; } out += c; i++; continue; }
    out += c;
    i++;
  }
  return [out, i];
}

/** Extract readable text from one decoded content stream by walking its
 *  text-showing operators. New lines on `T*`/`'`/`"`/`ET`; spaces on `Td`/`TD`. */
export function extractContentText(content: string): string {
  const lines: string[] = [];
  let line = "";
  const flush = () => {
    if (line.trim()) lines.push(line.replace(/\s+$/g, ""));
    line = "";
  };
  let i = 0;
  const n = content.length;
  while (i < n) {
    const ch = content[i];
    if (ch === "(") {
      const [str, ni] = parseLiteralString(content, i + 1);
      line += str;
      i = ni;
      continue;
    }
    if (ch === "<" && content[i + 1] !== "<") {
      const end = content.indexOf(">", i + 1);
      if (end > 0) {
        line += decodeHex(content.slice(i + 1, end));
        i = end + 1;
        continue;
      }
    }
    if (ch === "[") {
      // TJ array: collect its strings, ignore the numeric kerning adjustments.
      i++;
      while (i < n && content[i] !== "]") {
        const c2 = content[i];
        if (c2 === "(") {
          const [str, ni] = parseLiteralString(content, i + 1);
          line += str;
          i = ni;
          continue;
        }
        if (c2 === "<") {
          const end = content.indexOf(">", i + 1);
          if (end > 0) { line += decodeHex(content.slice(i + 1, end)); i = end + 1; continue; }
        }
        i++;
      }
      i++; // past ']'
      continue;
    }
    if (/[A-Za-z'"*]/.test(ch)) {
      let j = i;
      while (j < n && /[A-Za-z0-9*'"]/.test(content[j])) j++;
      const op = content.slice(i, j);
      if (op === "T*" || op === "'" || op === '"' || op === "ET") flush();
      else if (op === "Td" || op === "TD") line += " ";
      i = j;
      continue;
    }
    i++;
  }
  flush();
  return lines.join("\n");
}

/** Inflate a possibly-zlib / raw-deflate buffer; undefined if neither works. */
function tryInflate(raw: Buffer): string | undefined {
  for (const fn of [zlib.inflateSync, zlib.inflateRawSync] as const) {
    try {
      return fn(raw).toString("latin1");
    } catch {
      /* try the next */
    }
  }
  return undefined;
}

/** Extract text from a PDF buffer. Returns "" when there's no extractable text
 *  (e.g. a scanned/image-only document). */
export function extractPdfText(buf: Buffer): string {
  const s = buf.toString("latin1");
  const re = /stream(?:\r\n|\r|\n)/g;
  const parts: string[] = [];
  let total = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) && total < MAX_CHARS) {
    const dataStart = m.index + m[0].length;
    const endIdx = s.indexOf("endstream", dataStart);
    if (endIdx < 0) break;
    // Trim the EOL that precedes "endstream".
    let dataEnd = endIdx;
    if (s[dataEnd - 1] === "\n") dataEnd--;
    if (s[dataEnd - 1] === "\r") dataEnd--;
    const dictRegion = s.slice(Math.max(0, m.index - 400), m.index);
    const raw = buf.subarray(dataStart, dataEnd);
    const decoded = /\/FlateDecode\b/.test(dictRegion) ? tryInflate(raw) : raw.toString("latin1");
    re.lastIndex = endIdx + "endstream".length;
    if (!decoded) continue;
    if (!/\bBT\b|\bTj\b|\bTJ\b/.test(decoded)) continue; // not a text content stream
    const text = extractContentText(decoded);
    if (text.trim()) {
      parts.push(text);
      total += text.length;
    }
  }
  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
