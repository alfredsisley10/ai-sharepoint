/**
 * Rich email composition (ADR-0025 extension): build the Graph message `body`
 * and `attachments` for an Outlook draft in any format Outlook supports — HTML
 * (rich formatting), Rich Text (mapped to HTML — Graph has no RTF body type for
 * messages), or plain Text — plus file attachments. Pure + unit-tested; the
 * Graph POST lives in commsClient.createMailDraft.
 */

export type MailFormat = "html" | "text";

/** Map a user-facing format choice to our two Graph body types. "Rich Text" is
 *  Outlook's rich format, which Graph represents as HTML. */
export function normalizeMailFormat(choice: string): MailFormat {
  const c = choice.trim().toLowerCase();
  if (c === "text" || c === "plain" || c === "plain text") return "text";
  return "html"; // html, rich text → HTML
}

export function looksLikeHtml(s: string): boolean {
  return /<([a-z][a-z0-9]*)\b[^>]*>/i.test(s);
}

export function htmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Turn plain text into safe HTML (escape + newlines → <br>), so a draft the
 *  user typed as text still renders correctly when sent as HTML. */
export function plainToHtml(s: string): string {
  return htmlEscape(s).replace(/\r?\n/g, "<br>\n");
}

/** The Graph message `body` object for a format + content. HTML content that is
 *  already markup passes through; plain content is converted so it isn't shown
 *  as raw text. */
export function buildMessageBody(format: MailFormat, content: string): { contentType: "HTML" | "Text"; content: string } {
  if (format === "text") return { contentType: "Text", content };
  return { contentType: "HTML", content: looksLikeHtml(content) ? content : plainToHtml(content) };
}

export interface ComposedAttachment {
  name: string;
  contentType: string;
  /** base64-encoded file bytes. */
  base64: string;
  /** Raw byte length (pre-base64) for the size guard. */
  bytes: number;
}

// Graph's simple (non-upload-session) message POST caps total content; keep
// inline attachments comfortably under the documented ~3 MB ceiling.
export const ATTACHMENT_TOTAL_MAX = 3 * 1024 * 1024;

export function attachmentsTotalBytes(atts: ComposedAttachment[]): number {
  return atts.reduce((n, a) => n + a.bytes, 0);
}

/** A human problem string if the attachment set is too large to inline, else undefined. */
export function attachmentIssue(atts: ComposedAttachment[]): string | undefined {
  const total = attachmentsTotalBytes(atts);
  if (total > ATTACHMENT_TOTAL_MAX) {
    return `Attachments total ${(total / 1024 / 1024).toFixed(1)} MB — over the ${(ATTACHMENT_TOTAL_MAX / 1024 / 1024).toFixed(0)} MB inline limit. Attach fewer/smaller files (or attach them in Outlook).`;
  }
  return undefined;
}

const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  txt: "text/plain",
  md: "text/markdown",
  htm: "text/html",
  html: "text/html",
  json: "application/json",
  xml: "application/xml",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  zip: "application/zip",
};

/** Best-effort MIME type from a file name's extension. */
export function contentTypeForName(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

/** The Graph `fileAttachment` object for one attachment. */
export function buildFileAttachment(att: ComposedAttachment): {
  "@odata.type": "#microsoft.graph.fileAttachment";
  name: string;
  contentType: string;
  contentBytes: string;
} {
  return {
    "@odata.type": "#microsoft.graph.fileAttachment",
    name: att.name,
    contentType: att.contentType,
    contentBytes: att.base64,
  };
}
