/**
 * Pure ledger model + aggregation for the Copilot usage meter (ADR-0003).
 *
 * v2 fixes the unbounded-array ledger from Phase 0 (REVIEW C7): usage is
 * compacted into per-day aggregates (with per-model and per-label breakdowns)
 * plus a small capped tail of recent raw records for the dashboard/bundle.
 * No prompt or response text is ever stored — counts and token totals only.
 */

export interface UsageRecord {
  /** ISO timestamp (UTC). */
  at: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  /** multiplier × 1 request = premium-request units charged. */
  premiumUnits: number;
  /** Task label, e.g. "askCopilot", "chat", "tool:getSiteOverview". */
  label?: string;
  /** False when the request failed/was cancelled mid-stream (still billed). */
  ok: boolean;
}

export interface SliceAgg {
  requests: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  premiumUnits: number;
}

export interface DayAgg extends SliceAgg {
  /** YYYY-MM-DD (UTC). */
  day: string;
  byModel: Record<string, SliceAgg>;
  byLabel: Record<string, SliceAgg>;
}

export interface LedgerV2 {
  version: 2;
  days: DayAgg[];
  /** Most recent raw records, newest last, capped. */
  recent: UsageRecord[];
}

/** Phase 0 shape, migrated on first load. */
interface LedgerV1 {
  records?: Array<Partial<UsageRecord>>;
}

export const RECENT_CAP = 200;
export const DAYS_CAP = 400; // ~13 months

export function emptyLedger(): LedgerV2 {
  return { version: 2, days: [], recent: [] };
}

function emptySlice(): SliceAgg {
  return { requests: 0, failures: 0, inputTokens: 0, outputTokens: 0, premiumUnits: 0 };
}

function addTo(slice: SliceAgg, rec: UsageRecord): void {
  slice.requests += 1;
  if (!rec.ok) slice.failures += 1;
  slice.inputTokens += rec.inputTokens;
  slice.outputTokens += rec.outputTokens;
  slice.premiumUnits += rec.premiumUnits;
}

/** Migrate any persisted shape (v1 array, v2, or garbage) to v2. */
export function migrateLedger(raw: unknown): LedgerV2 {
  if (!raw || typeof raw !== "object") return emptyLedger();
  const obj = raw as LedgerV2 & LedgerV1;
  if (obj.version === 2 && Array.isArray(obj.days) && Array.isArray(obj.recent)) {
    return obj;
  }
  const ledger = emptyLedger();
  if (Array.isArray(obj.records)) {
    for (const r of obj.records) {
      if (!r || typeof r.at !== "string") continue;
      recordInto(ledger, {
        at: r.at,
        modelId: r.modelId ?? "unknown",
        inputTokens: r.inputTokens ?? 0,
        outputTokens: r.outputTokens ?? 0,
        premiumUnits: r.premiumUnits ?? 0,
        label: r.label,
        ok: true,
      });
    }
  }
  return ledger;
}

/** Append a record, updating aggregates and enforcing caps. Mutates ledger. */
export function recordInto(ledger: LedgerV2, rec: UsageRecord): void {
  const day = rec.at.slice(0, 10);
  let agg = ledger.days.find((d) => d.day === day);
  if (!agg) {
    agg = { day, byModel: {}, byLabel: {}, ...emptySlice() };
    ledger.days.push(agg);
    ledger.days.sort((a, b) => a.day.localeCompare(b.day));
    if (ledger.days.length > DAYS_CAP) {
      ledger.days.splice(0, ledger.days.length - DAYS_CAP);
    }
  }
  addTo(agg, rec);
  addTo((agg.byModel[rec.modelId] ??= emptySlice()), rec);
  const label = rec.label ?? "other";
  addTo((agg.byLabel[label] ??= emptySlice()), rec);

  ledger.recent.push(rec);
  if (ledger.recent.length > RECENT_CAP) {
    ledger.recent.splice(0, ledger.recent.length - RECENT_CAP);
  }
}

function daysInMonth(ledger: LedgerV2, nowIso: string): DayAgg[] {
  const month = nowIso.slice(0, 7);
  return ledger.days.filter((d) => d.day.slice(0, 7) === month);
}

/** Total premium-request units in the current calendar month (UTC). */
export function monthUnits(ledger: LedgerV2, nowIso: string): number {
  return daysInMonth(ledger, nowIso).reduce((s, d) => s + d.premiumUnits, 0);
}

/** Total requests in the current calendar month (UTC). */
export function monthRequests(ledger: LedgerV2, nowIso: string): number {
  return daysInMonth(ledger, nowIso).reduce((s, d) => s + d.requests, 0);
}

/** Failed/cancelled requests this month. */
export function monthFailures(ledger: LedgerV2, nowIso: string): number {
  return daysInMonth(ledger, nowIso).reduce((s, d) => s + d.failures, 0);
}

export function todayRequests(ledger: LedgerV2, nowIso: string): number {
  const day = nowIso.slice(0, 10);
  return ledger.days.find((d) => d.day === day)?.requests ?? 0;
}

export function todayUnits(ledger: LedgerV2, nowIso: string): number {
  const day = nowIso.slice(0, 10);
  return ledger.days.find((d) => d.day === day)?.premiumUnits ?? 0;
}

function mergeBreakdown(
  days: DayAgg[],
  pick: (d: DayAgg) => Record<string, SliceAgg>,
): Array<{ key: string } & SliceAgg> {
  const merged = new Map<string, SliceAgg>();
  for (const d of days) {
    for (const [key, slice] of Object.entries(pick(d))) {
      const into = merged.get(key) ?? emptySlice();
      into.requests += slice.requests;
      into.failures += slice.failures;
      into.inputTokens += slice.inputTokens;
      into.outputTokens += slice.outputTokens;
      into.premiumUnits += slice.premiumUnits;
      merged.set(key, into);
    }
  }
  return [...merged.entries()]
    .map(([key, slice]) => ({ key, ...slice }))
    .sort((a, b) => b.premiumUnits - a.premiumUnits || b.requests - a.requests);
}

/** This month's usage by model, highest premium spend first. */
export function monthByModel(ledger: LedgerV2, nowIso: string) {
  return mergeBreakdown(daysInMonth(ledger, nowIso), (d) => d.byModel);
}

/** This month's usage by task label, highest premium spend first. */
export function monthByLabel(ledger: LedgerV2, nowIso: string) {
  return mergeBreakdown(daysInMonth(ledger, nowIso), (d) => d.byLabel);
}

/** Daily premium-unit/request series for the trailing `n` days (oldest first). */
export function dailySeries(
  ledger: LedgerV2,
  nowIso: string,
  n: number,
): Array<{ day: string; premiumUnits: number; requests: number }> {
  const out: Array<{ day: string; premiumUnits: number; requests: number }> = [];
  const end = new Date(`${nowIso.slice(0, 10)}T00:00:00Z`).getTime();
  for (let i = n - 1; i >= 0; i--) {
    const day = new Date(end - i * 86_400_000).toISOString().slice(0, 10);
    const agg = ledger.days.find((d) => d.day === day);
    out.push({
      day,
      premiumUnits: agg?.premiumUnits ?? 0,
      requests: agg?.requests ?? 0,
    });
  }
  return out;
}
