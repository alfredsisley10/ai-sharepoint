/**
 * Desired-state parser (ADR-0021): turns a site repo's managed files back
 * into artifacts. Tolerant by design — a malformed file becomes a warning,
 * never a crash — because these files may be hand- or agent-edited. Pure.
 */

export interface DesiredColumn {
  name: string;
  displayName?: string;
  description?: string;
  required?: boolean;
  /** Facet payloads (text/choice/number/dateTime/…) passed through. */
  [facet: string]: unknown;
}

export interface DesiredList {
  /** Repo file path the artifact came from (for messages). */
  file: string;
  displayName: string;
  description: string;
  template: string;
  columns: DesiredColumn[];
}

export interface DesiredPage {
  file: string;
  title: string;
  /** Page file name, e.g. welcome.aspx (identity for matching). */
  name: string;
  pageLayout: string;
  canvasLayout: unknown | null;
}

export interface DesiredState {
  lists: DesiredList[];
  pages: DesiredPage[];
  warnings: string[];
}

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

/** Parse the managed files of a repo tree (path → content). */
export function parseDesiredState(files: ReadonlyMap<string, string>): DesiredState {
  const out: DesiredState = { lists: [], pages: [], warnings: [] };

  for (const [path, content] of files) {
    const isList = /^lists\/[^/]+\.json$/.test(path);
    const isPage = /^pages\/[^/]+\.json$/.test(path);
    if (!isList && !isPage) continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(content) as Record<string, unknown>;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("not an object");
      }
    } catch (err) {
      out.warnings.push(
        `${path}: unreadable JSON (${err instanceof Error ? err.message : String(err)}) — skipped.`,
      );
      continue;
    }

    if (isList) {
      const displayName = asString(parsed.displayName).trim();
      if (!displayName) {
        out.warnings.push(`${path}: missing displayName — skipped.`);
        continue;
      }
      const rawColumns = Array.isArray(parsed.columns) ? parsed.columns : [];
      const columns: DesiredColumn[] = [];
      for (const c of rawColumns) {
        if (c && typeof c === "object" && typeof (c as DesiredColumn).name === "string") {
          columns.push(c as DesiredColumn);
        } else {
          out.warnings.push(`${path}: a column without a "name" was skipped.`);
        }
      }
      out.lists.push({
        file: path,
        displayName,
        description: asString(parsed.description),
        template: asString(parsed.template, "genericList"),
        columns,
      });
    } else {
      const title = asString(parsed.title).trim();
      const name = asString(parsed.name).trim();
      if (!title && !name) {
        out.warnings.push(`${path}: page has neither title nor name — skipped.`);
        continue;
      }
      out.pages.push({
        file: path,
        title: title || name,
        name: name || `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.aspx`,
        pageLayout: asString(parsed.pageLayout, "article"),
        canvasLayout: "canvasLayout" in parsed ? (parsed.canvasLayout ?? null) : null,
      });
    }
  }

  out.lists.sort((a, b) => a.displayName.localeCompare(b.displayName));
  out.pages.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
