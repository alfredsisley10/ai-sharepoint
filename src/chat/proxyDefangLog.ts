/**
 * Session-scoped log of proxy-defang reports. When the chat participant rewrites
 * an outgoing prompt (proxy.mode = defang), it stashes the rendered "what was
 * changed" Markdown here under a short id and offers a button; the
 * `showProxyDefangDetails` command retrieves it by id and opens it read-only.
 *
 * Kept tiny and in-memory on purpose: the detail is transient transparency, not
 * persisted data (it can quote the user's prompt), and it's capped so it can't
 * grow unbounded across a long session.
 */

const MAX_REPORTS = 30;
const reports = new Map<string, string>();
const order: string[] = [];
let seq = 0;

/** Store a rendered report; returns its id (for a command argument). */
export function recordDefangReport(markdown: string): string {
  const id = `defang-${++seq}`;
  reports.set(id, markdown);
  order.push(id);
  while (order.length > MAX_REPORTS) {
    const evicted = order.shift();
    if (evicted) reports.delete(evicted);
  }
  return id;
}

/** Retrieve a stored report, or undefined if it aged out / never existed. */
export function getDefangReport(id: string): string | undefined {
  return reports.get(id);
}

/** Test-only: clear the in-memory log. */
export function _resetDefangReports(): void {
  reports.clear();
  order.length = 0;
  seq = 0;
}
