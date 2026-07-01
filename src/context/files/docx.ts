import { unzipSync, strFromU8 } from "fflate";
import { decodeXmlEntities } from "./xlsx";

/**
 * Dependency-light .docx text extractor: a .docx is a ZIP of XML; we unzip with
 * fflate (already a dependency, pure JS) and pull the readable text out of
 * `word/document.xml`. WordprocessingML keeps run text in `<w:t>`, paragraphs in
 * `<w:p>`, and explicit breaks in `<w:tab/>`/`<w:br/>`/`<w:cr/>`; we map those to
 * tabs/newlines so the assistant sees the document's prose with its line
 * structure. Formatting, images, headers/footers, and comments are intentionally
 * dropped — this is read-only context, not a faithful render. Pure + unit-tested.
 */

const MAX_CHARS = 2_000_000; // safety cap; the renderer bounds what's shown

/** Extract a paragraph's text, in document order: `<w:t>` run text plus explicit
 *  tab (`<w:tab/>`) and break (`<w:br/>`/`<w:cr/>`) characters. Paragraph/run
 *  *property* blocks are stripped first so tab-STOP definitions inside `<w:pPr>`
 *  aren't mistaken for literal tabs. */
function paragraphText(p: string): string {
  const body = p
    .replace(/<w:pPr>[\s\S]*?<\/w:pPr>/g, "")
    .replace(/<w:rPr>[\s\S]*?<\/w:rPr>/g, "");
  let out = "";
  const re = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/?>|<w:(?:br|cr)\b[^>]*\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    if (m[1] !== undefined) out += m[1]; // <w:t> run text (may be empty)
    else if (m[0].startsWith("<w:tab")) out += "\t";
    else out += "\n"; // <w:br/> or <w:cr/>
  }
  return decodeXmlEntities(out);
}

/** Extract readable text from a `word/document.xml` string. Paragraphs become
 *  lines; everything else (styling, drawings) is ignored. */
export function extractDocumentXmlText(xml: string): string {
  const paras: string[] = [];
  const re = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
  let m: RegExpExecArray | null;
  let total = 0;
  while ((m = re.exec(xml)) && total < MAX_CHARS) {
    const line = paragraphText(m[1]);
    total += line.length + 1;
    paras.push(line);
  }
  // Collapse runs of blank lines (Word emits many empty paragraphs) to at most one.
  return paras.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Read a .docx buffer into plain text. Throws a clear error if the archive has
 *  no main document part (e.g. a renamed non-Word file). */
export function readDocx(buf: Buffer): string {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(buf));
  } catch {
    throw new Error("Not a valid .docx (could not read the Office Open XML archive). If this is a legacy .doc, save it as .docx and re-add.");
  }
  const doc = files["word/document.xml"];
  if (!doc) throw new Error("This .docx has no word/document.xml part — it may be corrupt or not a Word document.");
  return extractDocumentXmlText(strFromU8(doc));
}
