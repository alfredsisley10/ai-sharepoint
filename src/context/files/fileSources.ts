import type { FileKind } from "./fileContent";

/**
 * Registered file context sources: local or OneDrive/shared SharePoint files the
 * assistant may read for context — spreadsheets (CSV/TSV, .xlsx, .xls), Word
 * (.docx), PDF, and plain text. We store only a pointer (path or Graph ref) +
 * label + detected kind — never the file content. Pure types + list ops here;
 * the vscode persistence wrapper is in fileSourcesStore.ts.
 */

export type FileLocation =
  | { kind: "local"; path: string }
  | { kind: "graph"; connectionHandle: string; driveId: string; itemId: string; webUrl?: string };

export interface FileSource {
  id: string;
  label: string;
  location: FileLocation;
  /** File kind detected from the name/extension (csv/tsv/xlsx/xls/docx/pdf/text). */
  kind: FileKind;
  addedAt: string;
}

/** Legacy shape: pre-0.100 builds stored the field as `tabular`. */
interface LegacyFileSource {
  kind?: FileKind;
  tabular?: FileKind;
}

/** Normalize a possibly-legacy persisted record so callers always see `kind`. */
export function normalizeFileSource(raw: FileSource): FileSource {
  const legacy = raw as FileSource & LegacyFileSource;
  return { ...raw, kind: legacy.kind ?? legacy.tabular ?? "unknown" };
}

export function withFile(items: FileSource[], item: FileSource): FileSource[] {
  return [...items.filter((f) => f.id !== item.id), item];
}

export function withoutFile(items: FileSource[], id: string): FileSource[] {
  return items.filter((f) => f.id !== id);
}

/** Dedup key: local path (case-folded) or the Graph item id, so the same file
 *  isn't registered twice. */
export function fileLocationKey(loc: FileLocation): string {
  return loc.kind === "local" ? `local:${loc.path.toLowerCase()}` : `graph:${loc.itemId}`;
}

/** Find an already-registered source with the same location. */
export function findByLocation(items: FileSource[], loc: FileLocation): FileSource | undefined {
  const key = fileLocationKey(loc);
  return items.find((f) => fileLocationKey(f.location) === key);
}

/** A short human description of where a source lives (for tree/tooltip). */
export function describeLocation(loc: FileLocation): string {
  return loc.kind === "local" ? loc.path : loc.webUrl || `OneDrive/SharePoint item ${loc.itemId}`;
}
