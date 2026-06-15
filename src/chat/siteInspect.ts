import { htmlToText } from "../context/http";

/**
 * Read-only site inspection (pilot): an authoritative, component-by-page
 * breakdown must be available for ANY connection — reference (read-only)
 * included. Managed onboarding exists to CHANGE a site, never as a
 * prerequisite for reading it. These pure summarizers turn Graph's
 * columnDefinition and sitePage canvasLayout payloads into compact,
 * model-friendly structures (bounded text, no raw HTML).
 *
 * The web-part summarizer reads the RENDERED content of a modern page so the
 * model can review what users actually see: text and headings from Text web
 * parts, link targets (Quick Links, Hero tiles, Call to action, …), and the
 * lists embedded by List/Highlighted-content web parts. First-party web parts
 * expose a uniform `serverProcessedContent` (the same structure SharePoint
 * search indexes) — `searchablePlainTexts` and `links` — which we mine
 * generically instead of hard-coding every web part's bespoke property schema.
 */

type Obj = Record<string, unknown>;

const s = (v: unknown): string => (v === null || v === undefined ? "" : String(v));

/** Graph columnDefinition → { name, type, required } using the type facet. */
export function describeColumn(col: Obj): { name: string; type: string; required?: boolean } {
  const facets = [
    "text",
    "choice",
    "number",
    "dateTime",
    "lookup",
    "personOrGroup",
    "boolean",
    "currency",
    "calculated",
    "hyperlinkOrPicture",
    "thumbnail",
    "contentApprovalStatus",
    "term",
  ];
  const type = facets.find((f) => col[f] !== undefined && col[f] !== null) ?? "unknown";
  return {
    name: s(col.displayName) || s(col.name) || "(unnamed)",
    type,
    ...(col.required === true ? { required: true } : {}),
  };
}

/**
 * Stable first-party web-part type ids (the GUID SharePoint stores in
 * `webPartType`). Mapping to friendly names lets the model reason about a
 * page's composition ("a Hero, two Quick Links, an embedded Announcements
 * list") instead of opaque GUIDs. Unknown ids fall back to a short label.
 */
const WEBPART_TYPES: Record<string, string> = {
  "d1d91016-032f-456d-98a4-721247c305e8": "Image",
  "7b317bca-c919-4982-af2f-8399173e5a1e": "Image gallery",
  "c4bd7b2f-7b6e-4599-8485-16504575f590": "Hero",
  "c70391ea-0b10-4ee9-b2b4-006d3fcad0cd": "Quick links",
  "f92bf067-bc19-489e-a556-7fe95f508720": "List",
  "6676088b-e28e-4a90-b9cb-d0d0303cd2eb": "List properties",
  "8c88f208-6c77-4bdb-86a0-0c47b4316588": "News",
  "daf0b71c-6de8-4ef7-b511-faae7c388708": "Highlighted content",
  "20745d7d-8581-4a6c-bf26-68279bc123fc": "Events",
  "7f718435-ee4d-431c-bdbf-9c4ff326f46e": "People",
  "91a50c94-865f-4f5c-8b4e-e49659e69772": "Quick chart",
  "0f087d7f-520e-42b7-89c0-496aaf979d58": "Button",
  "df8e44e7-edd5-46d5-90da-aca1539313b8": "Call to action",
  "1ef5ed11-ce7b-44be-bc5e-4abd55101d16": "Markdown",
  "490d7c76-1bce-4f4d-99eb-4b517f9bb50a": "Embed",
  "b7dd04e1-19ce-4b24-9132-b60a1c2b910d": "File viewer",
  "cbe7b0a9-3504-44dd-a3a3-0e5cacd07788": "Page properties",
  "e377ea37-9047-43b9-8cdb-a761be2f8e09": "Bing maps",
  "2161a1c6-db61-4731-b97c-3cdb303f7cbb": "Divider",
  "8654b779-4886-46d4-8ffb-b5ed960ee986": "Spacer",
  "71c19a43-d08c-4178-8218-4582abe7adc4": "Document library",
  "f6fdf4f8-4a24-437b-a127-32e66a5dd9b4": "Twitter",
  "544dd15b-cf3c-441b-96da-004d5a8cea1d": "Yammer / Viva Engage",
  "275c0095-a77e-4f6d-a2a0-6a7626911518": "Stream",
};

const TEXT_CAP = 400;
const MAX_HEADINGS_PER_PART = 12;
const MAX_LINKS_PER_PART = 20;

/** Unique, non-empty, trimmed values, capped to `max`. */
function capList(values: Array<string | undefined | null>, max: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    const t = s(v).replace(/\s+/g, " ").trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

/** Heading text (h1–h6) from a Text web part's innerHtml. */
export function extractHtmlHeadings(html: string): string[] {
  const heads: string[] = [];
  const re = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const text = htmlToText(m[2], 120);
    if (text) heads.push(text);
  }
  return capList(heads, MAX_HEADINGS_PER_PART);
}

/** Real link targets (href values) from a Text web part's innerHtml. */
export function extractHtmlLinks(html: string): string[] {
  const links: string[] = [];
  const re = /href\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const href = m[1].trim();
    if (href && !/^(javascript:|#)/i.test(href)) links.push(href);
  }
  return capList(links, MAX_LINKS_PER_PART);
}

/** URL-ish values from a serverProcessedContent.links map (the indexed link
 *  targets for Quick Links, Hero tiles, Call to action, News, etc.). */
function linksFromServerContent(spc: Obj | undefined): string[] {
  const links = (spc?.links ?? {}) as Obj;
  const vals = Object.values(links)
    .map(s)
    .filter((v) => /^(https?:|\/)/i.test(v));
  return capList(vals, MAX_LINKS_PER_PART);
}

/** Searchable plain texts (headings, tile titles, captions) a first-party web
 *  part publishes for indexing — our generic source of on-page text. */
function textsFromServerContent(spc: Obj | undefined): string[] {
  const texts = (spc?.searchablePlainTexts ?? {}) as Obj;
  return capList(Object.values(texts).map(s), MAX_HEADINGS_PER_PART);
}

export interface WebPartSummary {
  kind: "text" | "standard" | "unknown";
  /** Friendly type name (Hero, Quick links, List…) or the raw id when unknown. */
  type?: string;
  title?: string;
  /** Text web parts: HTML stripped and capped. Standard parts: description. */
  text?: string;
  /** Headings / section titles / tile captions visible in the part. */
  headings?: string[];
  /** Link targets the part points users to. */
  links?: string[];
  /** For List / Highlighted-content web parts: the embedded list view. */
  list?: { id?: string; title?: string };
}

function summarizeWebPart(wp: Obj): WebPartSummary {
  const odata = s(wp["@odata.type"]);
  if (odata.includes("textWebPart") || typeof wp.innerHtml === "string") {
    const html = typeof wp.innerHtml === "string" ? wp.innerHtml : "";
    const headings = extractHtmlHeadings(html);
    const links = extractHtmlLinks(html);
    const text = html ? htmlToText(html, TEXT_CAP) : "";
    return {
      kind: "text",
      type: "Text",
      ...(text ? { text } : {}),
      ...(headings.length ? { headings } : {}),
      ...(links.length ? { links } : {}),
    };
  }
  if (odata.includes("standardWebPart") || wp.webPartType !== undefined) {
    const data = (wp.data ?? {}) as Obj;
    const props = (data.properties ?? {}) as Obj;
    const spc = data.serverProcessedContent as Obj | undefined;
    const typeId = s(wp.webPartType).toLowerCase();
    const typeName =
      WEBPART_TYPES[typeId] ?? (typeId ? `Web part ${typeId.slice(0, 8)}` : "Web part");
    const title = s(data.title) || s(props.title);
    const description = s(data.description);
    const headings = textsFromServerContent(spc);
    const links = linksFromServerContent(spc);
    // Embedded list view (List / List properties / Highlighted content scoped
    // to a list): surface which list so duplicated/abandoned lists show up.
    const listId = s(props.selectedListId) || s(props.listId);
    const listTitle = s(props.listTitle) || s(props.displayName);
    const isListy = typeName === "List" || typeName === "List properties" || !!listId;
    return {
      kind: "standard",
      type: typeName,
      ...(title ? { title } : {}),
      ...(description && description !== title ? { text: description.slice(0, TEXT_CAP) } : {}),
      ...(headings.length ? { headings } : {}),
      ...(links.length ? { links } : {}),
      ...(isListy && (listId || listTitle)
        ? { list: { ...(listId ? { id: listId } : {}), ...(listTitle ? { title: listTitle } : {}) } }
        : {}),
    };
  }
  return { kind: "unknown" };
}

export interface CanvasSummary {
  sections: Array<{
    layout?: string;
    emphasis?: string;
    columns: Array<{ width?: number; webParts: WebPartSummary[] }>;
  }>;
  verticalSection?: { webParts: WebPartSummary[] };
  webPartCount: number;
}

/** Graph sitePage canvasLayout → bounded sections/columns/web-parts tree. */
export function summarizeCanvas(canvasLayout: unknown): CanvasSummary {
  const canvas = (canvasLayout ?? {}) as Obj;
  let count = 0;
  const mapParts = (parts: unknown): WebPartSummary[] => {
    if (!Array.isArray(parts)) return [];
    return (parts as Obj[]).map((p) => {
      count += 1;
      return summarizeWebPart(p);
    });
  };
  const sections = Array.isArray(canvas.horizontalSections)
    ? (canvas.horizontalSections as Obj[]).map((sec) => ({
        ...(s(sec.layout) ? { layout: s(sec.layout) } : {}),
        ...(s(sec.emphasis) ? { emphasis: s(sec.emphasis) } : {}),
        columns: Array.isArray(sec.columns)
          ? (sec.columns as Obj[]).map((c) => ({
              ...(typeof c.width === "number" ? { width: c.width } : {}),
              webParts: mapParts(c.webparts ?? c.webParts),
            }))
          : [],
      }))
    : [];
  const vertical = canvas.verticalSection as Obj | undefined;
  const verticalSection = vertical
    ? { webParts: mapParts(vertical.webparts ?? vertical.webParts) }
    : undefined;
  return {
    sections,
    ...(verticalSection ? { verticalSection } : {}),
    webPartCount: count,
  };
}

/** Flatten every web part on a canvas into one list (reading order). */
function flattenWebParts(canvas: CanvasSummary): WebPartSummary[] {
  const parts: WebPartSummary[] = [];
  for (const sec of canvas.sections) for (const col of sec.columns) parts.push(...col.webParts);
  if (canvas.verticalSection) parts.push(...canvas.verticalSection.webParts);
  return parts;
}

export interface PageContentSummary {
  title: string;
  url: string;
  lastModified?: string;
  /** Page-level headings, in reading order (capped). */
  headings: string[];
  /** Concatenated visible text across the page (capped). */
  text: string;
  /** Every distinct link target on the page (capped). */
  links: string[];
  /** Web-part composition: friendly type → count. */
  webParts: Array<{ type: string; count: number }>;
  /** Lists/libraries embedded via List or Highlighted-content web parts. */
  embeddedLists: string[];
  webPartCount: number;
}

const PAGE_TEXT_CAP = 1500;
const PAGE_MAX_HEADINGS = 40;
const PAGE_MAX_LINKS = 60;

/**
 * Render a page's canvas into a compact, model-friendly content record — the
 * unit of a full-site content scan. Captures what a human would skim: the
 * headings, the running text, the outbound links, the web-part mix, and any
 * embedded lists — all bounded so an N-page scan stays chat-sized.
 */
export function summarizePageContent(
  meta: { title: string; webUrl: string; lastModified?: string },
  content: { canvasLayout?: unknown },
): PageContentSummary {
  const canvas = summarizeCanvas(content.canvasLayout);
  const parts = flattenWebParts(canvas);

  const headings: string[] = [];
  const links: string[] = [];
  const embeddedLists: string[] = [];
  const typeCounts = new Map<string, number>();
  const textChunks: string[] = [];

  for (const wp of parts) {
    const type = wp.type ?? wp.kind;
    typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
    if (wp.title) headings.push(wp.title);
    if (wp.headings) headings.push(...wp.headings);
    if (wp.text) textChunks.push(wp.text);
    if (wp.links) links.push(...wp.links);
    if (wp.list) embeddedLists.push(wp.list.title || wp.list.id || "(list)");
  }

  let text = textChunks.join(" • ").replace(/\s+/g, " ").trim();
  if (text.length > PAGE_TEXT_CAP) text = `${text.slice(0, PAGE_TEXT_CAP)}…`;

  return {
    title: meta.title,
    url: meta.webUrl,
    ...(meta.lastModified ? { lastModified: meta.lastModified } : {}),
    headings: capList(headings, PAGE_MAX_HEADINGS),
    text,
    links: capList(links, PAGE_MAX_LINKS),
    webParts: [...typeCounts.entries()].map(([type, count]) => ({ type, count })),
    embeddedLists: capList(embeddedLists, 20),
    webPartCount: canvas.webPartCount,
  };
}
