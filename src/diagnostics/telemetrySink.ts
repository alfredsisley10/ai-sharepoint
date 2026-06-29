/**
 * External telemetry — payload shaping and the anonymization guarantee (pure).
 *
 * The extension can OPTIONALLY forward anonymized usage counters to a Splunk HEC
 * endpoint and/or an OTEL (OTLP/HTTP) metrics platform. This module holds the
 * pure, unit-tested parts: the strict sanitizer that guarantees only short
 * categorical tokens ever leave the machine (no freeform text, PII, paths, URLs,
 * emails, or error bodies), the environment descriptor, and the Splunk HEC /
 * OTLP metrics payload builders. The runtime sender (externalTelemetry.ts) does
 * the opportunistic, fail-silent HTTP.
 */

/** Deployment/environment descriptor attached to every export. All values are
 *  non-identifying: product version, host OS type/version, editor version, and
 *  the rotatable anonymous install id (adoption counting, never a user id). */
export interface TelemetryEnv {
  extVersion: string;
  extChannel?: string;
  vscodeVersion: string;
  osType: string;
  osVersion: string;
  osPlatform: string;
  /** Anonymous, rotatable install id (ADR-0018) — distinct-install counting. */
  installId: string;
}

// A dimension KEY must be a short lowerCamel/dotted identifier; a VALUE must be a
// short categorical token. Anything else (spaces, "/", "@", "://", long strings)
// is DROPPED — this is what makes "never sends freeform/sensitive data" a
// guarantee rather than a convention.
const SAFE_KEY = /^[a-z][A-Za-z0-9_.]{0,40}$/;
const SAFE_VALUE = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Reduce arbitrary event props to safe categorical dimensions. Numbers and
 * booleans pass (stringified); strings pass ONLY if they're a short categorical
 * token; everything else is dropped. Output keys/values are export-safe.
 */
export function sanitizeDimensions(
  props: Record<string, string | number | boolean> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!props) return out;
  for (const [k, v] of Object.entries(props)) {
    if (!SAFE_KEY.test(k)) continue;
    if (typeof v === "number") {
      if (Number.isFinite(v)) out[k] = String(v);
    } else if (typeof v === "boolean") {
      out[k] = String(v);
    } else if (typeof v === "string" && SAFE_VALUE.test(v)) {
      out[k] = v;
    }
    // anything else: dropped
  }
  return out;
}

/** Env as export-safe dimensions (each value re-checked against SAFE_VALUE). */
export function envDimensions(env: TelemetryEnv): Record<string, string> {
  const raw: Record<string, string> = {
    extVersion: env.extVersion,
    vscodeVersion: env.vscodeVersion,
    osType: env.osType,
    osVersion: env.osVersion,
    osPlatform: env.osPlatform,
    installId: env.installId,
    ...(env.extChannel ? { extChannel: env.extChannel } : {}),
  };
  const safe: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (SAFE_KEY.test(k) && SAFE_VALUE.test(v)) safe[k] = v;
  }
  return safe;
}

/** A Splunk HEC event payload (POST to the collector's /event endpoint). */
export function splunkHecEvent(
  event: string,
  dims: Record<string, string>,
  env: TelemetryEnv,
  timeSec: number,
  sourcetype = "aisharepoint:event",
): Record<string, unknown> {
  return {
    time: timeSec,
    sourcetype,
    event: { event, ...envDimensions(env), ...dims },
  };
}

/** One accumulated counter series. */
export interface CounterSeries {
  event: string;
  dims: Record<string, string>;
  count: number;
}

function otlpAttrs(dims: Record<string, string>): Array<Record<string, unknown>> {
  return Object.entries(dims).map(([key, value]) => ({ key, value: { stringValue: value } }));
}

/**
 * Build an OTLP/HTTP JSON metrics payload: a single monotonic Sum
 * `aisharepoint.events` whose data points are the per-event(+dims) counts.
 * Cumulative temporality (aggregationTemporality=2) with a fixed start time.
 * Times are unix-nanosecond strings. Hand-rolled — no OpenTelemetry SDK
 * dependency (keeps the bundle pure-JS and small).
 */
export function otlpCounterMetrics(
  series: CounterSeries[],
  env: TelemetryEnv,
  startTimeUnixNano: string,
  timeUnixNano: string,
  scopeName = "ai-sharepoint",
): Record<string, unknown> {
  return {
    resourceMetrics: [
      {
        resource: { attributes: otlpAttrs({ "service.name": scopeName, "service.version": env.extVersion, ...envDimensions(env) }) },
        scopeMetrics: [
          {
            scope: { name: scopeName, version: env.extVersion },
            metrics: [
              {
                name: "aisharepoint.events",
                unit: "1",
                sum: {
                  aggregationTemporality: 2, // CUMULATIVE
                  isMonotonic: true,
                  dataPoints: series.map((s) => ({
                    asInt: String(s.count),
                    startTimeUnixNano,
                    timeUnixNano,
                    attributes: otlpAttrs({ event: s.event, ...s.dims }),
                  })),
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

/** Stable key for accumulating a counter series (event + sorted dims). */
export function seriesKey(event: string, dims: Record<string, string>): string {
  const parts = Object.keys(dims)
    .sort()
    .map((k) => `${k}=${dims[k]}`);
  return [event, ...parts].join("|");
}
