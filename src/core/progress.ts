/**
 * Human progress formatting for long-running operations (space dossier, site
 * scans, syncs): "12 of 40 pages (30%) · ~25s remaining", with a rate-based ETA
 * from elapsed time. Pure + unit-tested; the vscode `withProgress`/chat layers
 * render the strings.
 */

/** A compact duration: seconds under a minute, else minutes (rounded). */
export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s <= 1) return "1s";
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/**
 * "X of Y noun(s) (P%) · ~ETA remaining". ETA is projected from the average
 * time per completed item and omitted until there's a rate (done > 0) and work
 * remains. Falls back to a bare count when the total is unknown.
 */
export function progressMessage(done: number, total: number, elapsedMs: number, noun = "item"): string {
  const plural = (nn: number) => `${noun}${nn === 1 ? "" : "s"}`;
  if (total <= 0) return `${done} ${plural(done)}…`;
  const pct = Math.min(100, Math.max(0, Math.round((done / total) * 100)));
  let eta = "";
  if (done > 0 && done < total && elapsedMs > 0) {
    const remainingMs = (elapsedMs / done) * (total - done);
    eta = ` · ~${formatDuration(remainingMs)} remaining`;
  }
  return `${done} of ${total} ${plural(total)} (${pct}%)${eta}`;
}
