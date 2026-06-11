import * as vscode from "vscode";
import { redactText } from "../core/redaction";

/**
 * Local-only usage telemetry (ADR-0018).
 *
 * Records feature-usage counters and a small recent-event tail so users can
 * export them in a diagnostics bundle. **Nothing is ever transmitted by the
 * extension** — capture is local, export is an explicit user action.
 *
 * Capture policy (`aiSharePoint.diagnostics.usageCapture`):
 *  - "followVSCode" (default): capture only while VS Code telemetry is enabled,
 *    deferring to the org's telemetry stance even though we never send data.
 *  - "on" / "off": explicit override either way.
 */

export interface TelemetryEvent {
  at: string;
  name: string;
  props?: Record<string, string | number | boolean>;
}

interface TelemetryState {
  version: 1;
  /** day -> event name -> count */
  days: Record<string, Record<string, number>>;
  recent: TelemetryEvent[];
}

const KEY = "aiSharePoint.telemetry";
const RECENT_CAP = 500;
const DAYS_CAP = 90;
const PROP_VALUE_MAX = 64;

export class TelemetryService {
  private state: TelemetryState;

  constructor(
    private readonly memento: vscode.Memento,
    private readonly now: () => string,
  ) {
    const raw = this.memento.get<TelemetryState>(KEY);
    this.state =
      raw && raw.version === 1 ? raw : { version: 1, days: {}, recent: [] };
  }

  enabled(): boolean {
    const mode = vscode.workspace
      .getConfiguration("aiSharePoint")
      .get<string>("diagnostics.usageCapture", "followVSCode");
    if (mode === "on") return true;
    if (mode === "off") return false;
    return vscode.env.isTelemetryEnabled;
  }

  /** Record one event. Prop values are sanitized and length-capped. */
  record(name: string, props?: Record<string, string | number | boolean>): void {
    if (!this.enabled()) return;
    const at = this.now();
    const day = at.slice(0, 10);

    const dayCounts = (this.state.days[day] ??= {});
    dayCounts[name] = (dayCounts[name] ?? 0) + 1;

    const days = Object.keys(this.state.days).sort();
    while (days.length > DAYS_CAP) {
      delete this.state.days[days.shift()!];
    }

    let safeProps: TelemetryEvent["props"];
    if (props) {
      safeProps = {};
      for (const [k, v] of Object.entries(props)) {
        safeProps[k] =
          typeof v === "string"
            ? redactText(v).slice(0, PROP_VALUE_MAX)
            : v;
      }
    }
    this.state.recent.push({ at, name, props: safeProps });
    if (this.state.recent.length > RECENT_CAP) {
      this.state.recent.splice(0, this.state.recent.length - RECENT_CAP);
    }
    void this.memento.update(KEY, this.state);
  }

  /** Aggregated counters + recent tail for the diagnostics bundle. */
  snapshot(): { totalsByEvent: Record<string, number>; days: number; recent: TelemetryEvent[] } {
    const totals: Record<string, number> = {};
    for (const counts of Object.values(this.state.days)) {
      for (const [name, n] of Object.entries(counts)) {
        totals[name] = (totals[name] ?? 0) + n;
      }
    }
    return {
      totalsByEvent: totals,
      days: Object.keys(this.state.days).length,
      recent: [...this.state.recent],
    };
  }

  async clear(): Promise<void> {
    this.state = { version: 1, days: {}, recent: [] };
    await this.memento.update(KEY, this.state);
  }
}
