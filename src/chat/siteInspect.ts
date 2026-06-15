import { htmlToText } from "../context/http";

/**
 * Read-only site inspection (pilot): an authoritative, component-by-page
 * breakdown must be available for ANY connection — reference (read-only)
 * included. Managed onboarding exists to CHANGE a site, never as a
 * prerequisite for reading it. These pure summarizers turn Graph's
 * columnDefinition and sitePage canvasLayout payloads into compact,
 * model-friendly structures (bounded text, no raw HTML).
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

export interface WebPartSummary {
  kind: "text" | "standard" | "unknown";
  title?: string;
  /** Standard web parts: the webPartType id when no title identifies it. */
  type?: string;
  /** Text web parts: HTML stripped and capped. */
  text?: string;
}

const TEXT_CAP = 400;

function summarizeWebPart(wp: Obj): WebPartSummary {
  const odata = s(wp["@odata.type"]);
  if (odata.includes("textWebPart") || typeof wp.innerHtml === "string") {
    return {
      kind: "text",
      ...(typeof wp.innerHtml === "string" && wp.innerHtml
        ? { text: htmlToText(wp.innerHtml, TEXT_CAP) }
        : {}),
    };
  }
  if (odata.includes("standardWebPart") || wp.webPartType !== undefined) {
    const data = (wp.data ?? {}) as Obj;
    const title = s(data.title) || s((data.properties as Obj | undefined)?.title);
    const description = s(data.description);
    return {
      kind: "standard",
      ...(title ? { title } : {}),
      ...(description && description !== title ? { text: description.slice(0, TEXT_CAP) } : {}),
      ...(s(wp.webPartType) && !title ? { type: s(wp.webPartType) } : {}),
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
