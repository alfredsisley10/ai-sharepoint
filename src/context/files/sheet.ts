/**
 * One worksheet of a tabular file: a name and its rows of string cells. A CSV/TSV
 * file is a single unnamed sheet; .xlsx/.xls workbooks carry many. Kept in its own
 * module so the parsers (xlsx, xls), the tabular layer, and the content layer can
 * all share the type without import cycles.
 */
export interface Sheet {
  /** Worksheet/tab name (empty for single-sheet formats like CSV). */
  name: string;
  rows: string[][];
}
