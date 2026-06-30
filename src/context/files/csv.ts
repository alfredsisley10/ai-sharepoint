/**
 * Minimal, dependency-free CSV/TSV parser (RFC 4180-ish): handles quoted fields,
 * embedded commas/newlines, and "" escapes. Used to read a local spreadsheet
 * into tabular context for the assistant. Pure — unit-tested.
 */

/** Parse CSV text into rows of string cells. `delimiter` defaults to comma; pass
 *  "\t" for TSV. Trailing blank line is ignored; CRLF and LF both work. */
export function parseDelimited(text: string, delimiter = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let started = false; // any char seen on the current row (so we keep "" cells)

  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
    started = false;
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      started = true;
    } else if (c === delimiter) {
      pushField();
      started = true;
    } else if (c === "\n") {
      pushRow();
    } else if (c === "\r") {
      // swallow; the \n (if any) closes the row
    } else {
      field += c;
      started = true;
    }
  }
  // Flush the last field/row unless the input ended exactly on a newline.
  if (started || field.length > 0 || row.length > 0) pushRow();
  return rows;
}

/** Sniff a delimiter from the header line — comma, tab, or semicolon. */
export function sniffDelimiter(text: string): string {
  const firstLine = text.slice(0, text.indexOf("\n") === -1 ? text.length : text.indexOf("\n"));
  const counts: Record<string, number> = {
    ",": (firstLine.match(/,/g) || []).length,
    "\t": (firstLine.match(/\t/g) || []).length,
    ";": (firstLine.match(/;/g) || []).length,
  };
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best && best[1] > 0 ? best[0] : ",";
}

/** Parse with an auto-sniffed delimiter. */
export function parseCsv(text: string): string[][] {
  return parseDelimited(text, sniffDelimiter(text));
}
