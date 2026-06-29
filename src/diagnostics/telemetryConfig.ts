import { SecretStore } from "../secrets/secretStore";
import { ExternalTelemetryConfig } from "./externalTelemetry";

/**
 * External-telemetry connection config — stored ONLY in the OS keychain, never
 * in VS Code settings, so it is not viewable in settings.json and never appears
 * in a diagnostics export. The management command (Support & Diagnostics) is the
 * sole editor; it sets secrets write-only and never displays a saved token.
 */

export interface StoredTelemetryConfig {
  enabled: boolean;
  splunkHecUrl?: string;
  splunkHecToken?: string;
  otlpEndpoint?: string;
  /** A single auth header for OTLP (e.g. "X-Api-Key" / a tenant header). */
  otlpHeaderName?: string;
  otlpHeaderValue?: string;
}

/**
 * Map the stored config to the effective sink config — or undefined when off or
 * nothing usable is configured (so the sink no-ops). Pure.
 */
export function effectiveTelemetryConfig(stored: StoredTelemetryConfig | undefined): ExternalTelemetryConfig | undefined {
  if (!stored?.enabled) return undefined;
  const cfg: ExternalTelemetryConfig = {};
  if (stored.splunkHecUrl?.trim() && stored.splunkHecToken?.trim()) {
    cfg.splunk = { url: stored.splunkHecUrl.trim(), token: stored.splunkHecToken.trim() };
  }
  if (stored.otlpEndpoint?.trim()) {
    const headers =
      stored.otlpHeaderName?.trim() && stored.otlpHeaderValue
        ? { [stored.otlpHeaderName.trim()]: stored.otlpHeaderValue }
        : undefined;
    cfg.otlp = { endpoint: stored.otlpEndpoint.trim(), ...(headers ? { headers } : {}) };
  }
  return cfg.splunk || cfg.otlp ? cfg : undefined;
}

/** Non-secret status for the management UI / support view — NEVER any secret value. */
export interface TelemetryStatus {
  enabled: boolean;
  splunkUrl?: string;
  splunkTokenSet: boolean;
  otlpEndpoint?: string;
  otlpHeaderSet: boolean;
  /** Whether telemetry would actually send (enabled + a usable endpoint). */
  active: boolean;
}

export function telemetryStatus(stored: StoredTelemetryConfig | undefined): TelemetryStatus {
  return {
    enabled: Boolean(stored?.enabled),
    splunkUrl: stored?.splunkHecUrl || undefined,
    splunkTokenSet: Boolean(stored?.splunkHecToken),
    otlpEndpoint: stored?.otlpEndpoint || undefined,
    otlpHeaderSet: Boolean(stored?.otlpHeaderName && stored?.otlpHeaderValue),
    active: Boolean(effectiveTelemetryConfig(stored)),
  };
}

/** Keychain-backed store for the telemetry connection config. */
export class TelemetryConfigStore {
  private static readonly HANDLE = "telemetry.externalConfig";

  constructor(private readonly secrets: SecretStore) {}

  async load(): Promise<StoredTelemetryConfig | undefined> {
    const raw = await this.secrets.get(TelemetryConfigStore.HANDLE);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as StoredTelemetryConfig;
    } catch {
      return undefined;
    }
  }

  async save(cfg: StoredTelemetryConfig): Promise<void> {
    await this.secrets.set(TelemetryConfigStore.HANDLE, JSON.stringify(cfg));
  }

  async clear(): Promise<void> {
    await this.secrets.delete(TelemetryConfigStore.HANDLE);
  }
}
