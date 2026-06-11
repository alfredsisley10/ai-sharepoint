import { ContextBookmark } from "./types";

/**
 * Pure bookmark list operations (ADR-0010). The vscode-backed BookmarksStore
 * is a thin wrapper around these, so the logic is unit-testable without the
 * extension host.
 */

export function listForSource(
  all: ContextBookmark[],
  sourceId: string,
): ContextBookmark[] {
  return all
    .filter((b) => b.sourceId === sourceId)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function resolveBookmark(
  all: ContextBookmark[],
  name: string,
  sourceId?: string,
): ContextBookmark | undefined {
  const ref = name.trim().toLowerCase();
  return all.find(
    (b) => b.name.toLowerCase() === ref && (!sourceId || b.sourceId === sourceId),
  );
}

/** Add (or replace a same-source same-name) bookmark. */
export function withBookmark(
  all: ContextBookmark[],
  bookmark: ContextBookmark,
): ContextBookmark[] {
  return [
    ...all.filter(
      (b) => !(b.sourceId === bookmark.sourceId && b.name === bookmark.name),
    ),
    bookmark,
  ];
}

export function withoutBookmark(
  all: ContextBookmark[],
  id: string,
): ContextBookmark[] {
  return all.filter((b) => b.id !== id);
}

export function withoutSource(
  all: ContextBookmark[],
  sourceId: string,
): ContextBookmark[] {
  return all.filter((b) => b.sourceId !== sourceId);
}
