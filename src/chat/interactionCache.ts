import * as vscode from "vscode";

/**
 * A tiny LOCAL cache of the most recent @sharepoint turn so an interrupted chat
 * can be intelligently restarted. If a corporate proxy blocks the response, or
 * the connection drops, or the prompt overflows the model's real context limit,
 * the turn's request (and which context sections it carried) survive here — the
 * "Restart last request" command re-opens the chat prefilled with it.
 *
 * Workspace-scoped, single most-recent record, never exported (it can quote the
 * user's prompt — same posture as the wire log: local-only, never in diagnostics
 * bundles). Pure record-shaping; this is a thin Memento wrapper.
 */

export type InteractionStatus = "started" | "completed" | "interrupted";

export interface InteractionRecord {
  /** The user's original prompt text (for restart). */
  prompt: string;
  /** Labels of the context sections that were assembled (not their content). */
  contextLabels: string[];
  /** Model the turn used (family/id). */
  modelKey: string;
  status: InteractionStatus;
  /** When interrupted: the classified failure (overflow/blocked/transient/…). */
  failureKind?: string;
  ts: string;
}

const KEY = "aiSharePoint.lastInteraction";

export class InteractionCache {
  constructor(
    private readonly state: vscode.Memento,
    private readonly now: () => string,
  ) {}

  /** Checkpoint the start of a turn (overwrites the previous record). */
  async begin(rec: { prompt: string; contextLabels: string[]; modelKey: string }): Promise<void> {
    const record: InteractionRecord = { ...rec, status: "started", ts: this.now() };
    await this.state.update(KEY, record);
  }

  /** Mark how the current turn ended. No-op if there's no open record. */
  async finish(status: InteractionStatus, failureKind?: string): Promise<void> {
    const cur = this.last();
    if (!cur) return;
    await this.state.update(KEY, { ...cur, status, ...(failureKind ? { failureKind } : {}), ts: this.now() });
  }

  last(): InteractionRecord | undefined {
    return this.state.get<InteractionRecord>(KEY);
  }

  async clear(): Promise<void> {
    await this.state.update(KEY, undefined);
  }
}
