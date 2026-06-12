/**
 * Pure ledger model + aggregation for the Copilot activity meter (ADR-0003,
 * amended): factual, locally measured counts ONLY — requests, failures, and
 * token totals. Premium-unit estimates and the monthly-allowance gauge were
 * removed: without an authoritative source (the GitHub bill) those numbers
 * misled users, so the extension no longer computes or stores them.
 *
 * v3 drops the estimated premiumUnits fields from v2 (which itself fixed the
 * unbounded-array ledger from Phase 0, REVIEW C7): usage is compacted into
 * per-day aggregates (with per-model and per-label breakdowns) plus a small
 * capped tail of recent raw records for the dashboard/bundle. No prompt or
 * response text is ever stored — counts and token totals only.
 */

export interface UsageRecord {
  /** ISO timestamp (UTC). */
  at: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
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
}

export interface DayAgg extends SliceAgg {
  /** YYYY-MM-DD (UTC). */
  day: string;
  byModel: Record<string, SliceAgg>;
  byLabel: Record<string, SliceAgg>;
}

export interface LedgerV3 {
  version: 3;
  days: DayAgg[];
  /** Most recent raw records, newest last, capped. */
  recent: UsageRecord[];
}

/** Earlier persisted shapes, migrated on first load. */
interface LedgerV1 {
  records?: Array<Partial<UsageRecord>>;
}
interface LedgerV2 {
  version?: number;
  days?: Array<Partial<DayAgg> & { day?: string; premiumUnits?: number }>;
  recent?: Array<Partial<UsageRecord>>;
}

export const RECENT_CAP = 200;
export const DAYS_CAP = 400; // ~13 months

export function emptyLedger(): LedgerV3 {
  return { version: 3, days: [], recent: [] };
}

function emptySlice(): SliceAgg {
  return { requests: 0, failures: 0, inputTokens: 0, outputTokens: 0 };
}

function addTo(slice: SliceAgg, rec: UsageRecord): void {
  slice.requests += 1;
  if (!rec.ok) slice.failures += 1;
  slice.inputTokens += rec.inputTokens;
  slice.outputTokens += rec.outputTokens;
}

/** Migrate any persisted shape (v1 array, v2 with premium-unit estimates,
 *  v3, or garbage) to v3. v2's estimated premiumUnits are dropped — they
 *  were never authoritative. */
export function migrateLedger(raw: unknown): LedgerV3 {
  if (!raw || typeof raw !== "object") return emptyLedger();
  const version = (raw as { version?: unknown }).version;
  const obj = raw as LedgerV2 & LedgerV1;
  if (version === 3 && Array.isArray(obj.days) && Array.isArray(obj.recent)) {
    return raw as LedgerV3;
  }
  const ledger = emptyLedger();
  // v2 → v3: copy the day aggregates and recent tail, dropping the
  // estimated premiumUnits fields everywhere.
  if (version === 2 && Array.isArray(obj.days)) {
    for (const d of obj.days) {
      if (!d || typeof d.day !== "string") continue;
      const day: DayAgg = {
        day: d.day,
        requests: d.requests ?? 0,
        failures: d.failures ?? 0,
        inputTokens: d.inputTokens ?? 0,
        outputTokens: d.outputTokens ?? 0,
        byModel: stripSlices(d.byModel),
        byLabel: stripSlices(d.byLabel),
      };
      ledger.days.push(day);
    }
    ledger.days.sort((a, b) => a.day.localeCompare(b.day));
    if (Array.isArray(obj.recent)) {
      for (const r of obj.recent) {
        if (!r || typeof r.at !== "string") continue;
        ledger.recent.push({
          at: r.at,
          modelId: r.modelId ?? "unknown",
          inputTokens: r.inputTokens ?? 0,
          outputTokens: r.outputTokens ?? 0,
          label: r.label,
          ok: r.ok !== false,
        });
      }
      if (ledger.recent.length > RECENT_CAP) {
        ledger.recent.splice(0, ledger.recent.length - RECENT_CAP);
      }
    }
    return ledger;
  }
  if (Array.isArray(obj.records)) {
    for (const r of obj.records) {
      if (!r || typeof r.at !== "string") continue;
      recordInto(ledger, {
        at: r.at,
        modelId: r.modelId ?? "unknown",
        inputTokens: r.inputTokens ?? 0,
        outputTokens: r.outputTokens ?? 0,
        label: r.label,
        ok: true,
      });
    }
  }
  return ledger;
}

function stripSlices(
  raw: Record<string, Partial<SliceAgg> & { premiumUnits?: number }> | undefined,
): Record<string, SliceAgg> {
  const out: Record<string, SliceAgg> = {};
  for (const [key, s] of Object.entries(raw ?? {})) {
    out[key] = {
      requests: s?.requests ?? 0,
      failures: s?.failures ?? 0,
      inputTokens: s?.inputTokens ?? 0,
      outputTokens: s?.outputTokens ?? 0,
    };
  }
  return out;
}

/** Append a record, updating aggregates and enforcing caps. Mutates ledger. */
export function recordInto(ledger: LedgerV3, rec: UsageRecord): void {
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

function daysInMonth(ledger: LedgerV3, nowIso: string): DayAgg[] {
  const month = nowIso.slice(0, 7);
  return ledger.days.filter((d) => d.day.slice(0, 7) === month);
}

/** Total requests in the current calendar month (UTC). */
export function monthRequests(ledger: LedgerV3, nowIso: string): number {
  return daysInMonth(ledger, nowIso).reduce((s, d) => s + d.requests, 0);
}

/** Failed/cancelled requests this month. */
export function monthFailures(ledger: LedgerV3, nowIso: string): number {
  return daysInMonth(ledger, nowIso).reduce((s, d) => s + d.failures, 0);
}

export function todayRequests(ledger: LedgerV3, nowIso: string): number {
  const day = nowIso.slice(0, 10);
  return ledger.days.find((d) => d.day === day)?.requests ?? 0;
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
      merged.set(key, into);
    }
  }
  return [...merged.entries()]
    .map(([key, slice]) => ({ key, ...slice }))
    .sort((a, b) => b.requests - a.requests || b.outputTokens - a.outputTokens);
}

/** This month's activity by model, most requests first. */
export function monthByModel(ledger: LedgerV3, nowIso: string) {
  return mergeBreakdown(daysInMonth(ledger, nowIso), (d) => d.byModel);
}

/** This month's activity by task label, most requests first. */
export function monthByLabel(ledger: LedgerV3, nowIso: string) {
  return mergeBreakdown(daysInMonth(ledger, nowIso), (d) => d.byLabel);
}

/** Daily request series for the trailing `n` days (oldest first). */
export function dailySeries(
  ledger: LedgerV3,
  nowIso: string,
  n: number,
): Array<{ day: string; requests: number; failures: number }> {
  const out: Array<{ day: string; requests: number; failures: number }> = [];
  const end = new Date(`${nowIso.slice(0, 10)}T00:00:00Z`).getTime();
  for (let i = n - 1; i >= 0; i--) {
    const day = new Date(end - i * 86_400_000).toISOString().slice(0, 10);
    const agg = ledger.days.find((d) => d.day === day);
    out.push({
      day,
      requests: agg?.requests ?? 0,
      failures: agg?.failures ?? 0,
    });
  }
  return out;
}
