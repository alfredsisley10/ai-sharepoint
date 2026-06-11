import * as vscode from "vscode";
import { redactError } from "../core/redaction";
import { classifyError, ErrorCode } from "../core/errors";

/**
 * Local error-report store (ADR-0018). Every handled error is captured as a
 * redacted, classified report; duplicates are coalesced with a count. Reports
 * never leave the machine except inside an explicitly exported diagnostics
 * bundle (which is previewed and leak-scanned first).
 */

export interface ErrorReport {
  firstAt: string;
  lastAt: string;
  /** Where it happened — a command/feature id, never user data. */
  context: string;
  code: ErrorCode;
  name: string;
  message: string;
  stack?: string;
  count: number;
}

interface ErrorState {
  version: 1;
  reports: ErrorReport[];
}

const KEY = "aiSharePoint.errorReports";
const REPORT_CAP = 100;

export class ErrorReportStore {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private state: ErrorState;

  constructor(
    private readonly memento: vscode.Memento,
    private readonly now: () => string,
  ) {
    const raw = this.memento.get<ErrorState>(KEY);
    this.state = raw && raw.version === 1 ? raw : { version: 1, reports: [] };
  }

  private enabled(): boolean {
    return vscode.workspace
      .getConfiguration("aiSharePoint")
      .get<boolean>("diagnostics.errorCapture", true);
  }

  /** Capture an error. Returns its classified code for the caller's UX. */
  capture(context: string, err: unknown): ErrorCode {
    const code = classifyError(err);
    if (!this.enabled() || code === "auth.cancelled") {
      return code; // user-cancelled flows are not errors worth reporting
    }
    const safe = redactError(err);
    const at = this.now();
    const existing = this.state.reports.find(
      (r) =>
        r.context === context && r.code === code && r.message === safe.message,
    );
    if (existing) {
      existing.count += 1;
      existing.lastAt = at;
      if (!existing.stack && safe.stack) existing.stack = safe.stack;
    } else {
      this.state.reports.push({
        firstAt: at,
        lastAt: at,
        context,
        code,
        name: safe.name,
        message: safe.message,
        stack: safe.stack,
        count: 1,
      });
      if (this.state.reports.length > REPORT_CAP) {
        this.state.reports.sort((a, b) => a.lastAt.localeCompare(b.lastAt));
        this.state.reports.splice(0, this.state.reports.length - REPORT_CAP);
      }
    }
    void this.memento.update(KEY, this.state);
    this.emitter.fire();
    return code;
  }

  list(): ErrorReport[] {
    return [...this.state.reports].sort((a, b) =>
      b.lastAt.localeCompare(a.lastAt),
    );
  }

  count(): number {
    return this.state.reports.length;
  }

  async clear(): Promise<void> {
    this.state = { version: 1, reports: [] };
    await this.memento.update(KEY, this.state);
    this.emitter.fire();
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
