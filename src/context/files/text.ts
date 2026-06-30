/**
 * Plain-text file context: decode bytes to a string and a cheap binary sniff so
 * the "add file" flow can accept arbitrary text-based files (.txt, .md, .log,
 * .json, .xml, source, config…) while rejecting binaries that would render as
 * garbage. Pure + unit-tested.
 */

/** Decode a buffer as UTF-8, stripping a leading BOM if present. */
export function decodeText(buf: Buffer): string {
  let s = buf.toString("utf8");
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1); // UTF-8/UTF-16 BOM
  return s;
}

/**
 * Heuristic: does this buffer look like a binary (non-text) file? A NUL byte in
 * the first chunk is the classic signal; we also reject when a high share of the
 * sampled bytes are non-printable control characters (excluding tab/newline/CR).
 * Conservative on purpose — false "binary" is a clear error message, whereas a
 * false "text" would dump mojibake into the chat.
 */
export function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  if (n === 0) return false; // empty file is "text" (renders as empty)
  let suspicious = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b === 0) return true; // NUL → definitely binary
    // Allow tab(9), LF(10), CR(13), and everything printable (>=32). Count the
    // remaining C0 control bytes as suspicious.
    if (b < 9 || (b > 13 && b < 32)) suspicious++;
  }
  return suspicious / n > 0.1;
}
