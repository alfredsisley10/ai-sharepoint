import {
  TelemetryEnv,
  CounterSeries,
  sanitizeDimensions,
  splunkHecEvent,
  otlpCounterMetrics,
  seriesKey,
} from "./telemetrySink";

/**
 * Opportunistic external telemetry sink — forwards anonymized usage counters to
 * a Splunk HEC endpoint and/or an OTEL (OTLP/HTTP) metrics platform.
 *
 * Opt-in: does nothing unless an endpoint is configured. **Opportunistic:** every
 * send is timeout-bounded and fire-and-forget; if the endpoint is down or slow
 * the client is never blocked and never sees an error. Anonymization is enforced
 * upstream by telemetrySink.sanitizeDimensions (categorical tokens only).
 */

export interface ExternalTelemetryConfig {
  splunk?: { url: string; token: string };
  otlp?: { endpoint: string; headers?: Record<string, string> };
}

interface Deps {
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
  timeoutMs?: number;
  flushMs?: number;
}

export class ExternalTelemetry {
  private readonly counters = new Map<string, CounterSeries>();
  private readonly startMs: number;
  private timer?: ReturnType<typeof setInterval>;
  private readonly fetchImpl: typeof fetch;
  private readonly nowMs: () => number;
  private readonly timeoutMs: number;
  private readonly flushMs: number;

  constructor(
    private readonly env: TelemetryEnv,
    private readonly getConfig: () => ExternalTelemetryConfig | undefined,
    deps: Deps = {},
  ) {
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.nowMs = deps.nowMs ?? (() => Date.now());
    this.timeoutMs = deps.timeoutMs ?? 5000;
    this.flushMs = deps.flushMs ?? 60_000;
    this.startMs = this.nowMs();
  }

  /** Begin periodic OTLP metric flushing (runtime only; no-op without OTLP). */
  start(): void {
    if (this.timer || !this.getConfig()?.otlp) return;
    this.timer = setInterval(() => this.flush(), this.flushMs);
    (this.timer as { unref?: () => void }).unref?.(); // never keep the host alive
  }

  /** Record one event for export. Never throws, never blocks. */
  emit(event: string, props?: Record<string, string | number | boolean>): void {
    const cfg = this.getConfig();
    if (!cfg || (!cfg.splunk && !cfg.otlp)) return;
    const dims = sanitizeDimensions(props);
    if (cfg.splunk) this.sendSplunk(cfg.splunk, event, dims);
    if (cfg.otlp) {
      const key = seriesKey(event, dims);
      const existing = this.counters.get(key);
      if (existing) existing.count += 1;
      else this.counters.set(key, { event, dims, count: 1 });
    }
  }

  /** Send the cumulative counters to the OTLP metrics endpoint (fire-and-forget). */
  flush(): void {
    const cfg = this.getConfig();
    if (!cfg?.otlp || this.counters.size === 0) return;
    const start = String(this.startMs * 1_000_000); // unix nanos
    const now = String(this.nowMs() * 1_000_000);
    const body = otlpCounterMetrics([...this.counters.values()], this.env, start, now);
    this.post(this.otlpUrl(cfg.otlp.endpoint), { "Content-Type": "application/json", ...(cfg.otlp.headers ?? {}) }, body);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.flush(); // best-effort final export
  }

  private otlpUrl(endpoint: string): string {
    const base = endpoint.replace(/\/+$/, "");
    return /\/v1\/metrics$/.test(base) ? base : `${base}/v1/metrics`;
  }

  private sendSplunk(splunk: { url: string; token: string }, event: string, dims: Record<string, string>): void {
    const body = splunkHecEvent(event, dims, this.env, Math.floor(this.nowMs() / 1000));
    this.post(splunk.url, { "Content-Type": "application/json", Authorization: `Splunk ${splunk.token}` }, body);
  }

  /** Opportunistic POST: timeout-bounded, fire-and-forget, all errors swallowed. */
  private post(url: string, headers: Record<string, string>, body: unknown): void {
    let signal: AbortSignal | undefined;
    try {
      signal = AbortSignal.timeout(this.timeoutMs);
    } catch {
      signal = undefined;
    }
    void Promise.resolve()
      .then(() => this.fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body), signal }))
      .catch(() => {
        /* opportunistic: a down/slow/misconfigured endpoint must never affect the client */
      });
  }
}

/** Read the external-telemetry config from VS Code settings (opt-in). Returns
 *  undefined unless the master switch is on AND at least one endpoint is set. */
export function readExternalTelemetryConfig(
  get: <T>(key: string, fallback: T) => T,
): ExternalTelemetryConfig | undefined {
  if (!get<boolean>("telemetry.enabled", false)) return undefined;
  const cfg: ExternalTelemetryConfig = {};
  const splunkUrl = get<string>("telemetry.splunkHec.url", "").trim();
  const splunkToken = get<string>("telemetry.splunkHec.token", "").trim();
  if (splunkUrl && splunkToken) cfg.splunk = { url: splunkUrl, token: splunkToken };
  const otlpEndpoint = get<string>("telemetry.otlp.endpoint", "").trim();
  if (otlpEndpoint) {
    const headers = get<Record<string, string>>("telemetry.otlp.headers", {});
    cfg.otlp = { endpoint: otlpEndpoint, ...(headers && typeof headers === "object" ? { headers } : {}) };
  }
  return cfg.splunk || cfg.otlp ? cfg : undefined;
}
