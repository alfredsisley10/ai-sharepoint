import * as vscode from "vscode";
import * as crypto from "node:crypto";
import {
  Lesson,
  LessonInput,
  normalizeLesson,
  lessonKey,
  mergeLesson,
} from "./lessons";

/**
 * Local, opt-in ledger of anonymized lessons learned (ADR-0041). Mirrors
 * TelemetryService: memento-backed, capped, and **nothing is ever transmitted**
 * — capture is local and export is an explicit, reviewable user action.
 *
 * Capture is governed by `aiSharePoint.lessons.capture` (boolean, default
 * FALSE). Because lessons derive from interaction content — even after the
 * pure-module scrubbing — the consent posture is stricter than usage telemetry:
 * strictly opt-in, off until the user turns it on.
 */

interface LessonsState {
  version: 1;
  lessons: Lesson[];
}

const KEY = "aiSharePoint.lessons";
const CAP = 1_000;

export class LessonsStore {
  private state: LessonsState;
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(
    private readonly memento: vscode.Memento,
    private readonly extensionVersion: string,
    private readonly now: () => string,
  ) {
    const raw = this.memento.get<LessonsState>(KEY);
    this.state = raw && raw.version === 1 ? raw : { version: 1, lessons: [] };
  }

  /** Opt-in gate. Default OFF — lessons are captured only after the user
   *  explicitly enables `aiSharePoint.lessons.capture`. */
  enabled(): boolean {
    return vscode.workspace
      .getConfiguration("aiSharePoint")
      .get<boolean>("lessons.capture", false);
  }

  /** Capture one lesson. Returns the outcome so the tool can report honestly.
   *  Scrubs + normalizes (pure) before anything touches storage; a repeat of
   *  an existing lesson merges (count++) instead of duplicating. */
  async capture(input: Partial<LessonInput>): Promise<{ stored: boolean; merged: boolean; reason?: string }> {
    if (!this.enabled()) return { stored: false, merged: false, reason: "disabled" };
    const clean = normalizeLesson(input);
    if (!clean) return { stored: false, merged: false, reason: "empty" };

    const at = this.now();
    const key = lessonKey(clean);
    const idx = this.state.lessons.findIndex((l) => lessonKey(l) === key);
    let merged = false;
    if (idx >= 0) {
      this.state.lessons[idx] = mergeLesson(this.state.lessons[idx], clean, at);
      merged = true;
    } else {
      this.state.lessons.push({
        id: crypto.randomUUID(),
        ...clean,
        count: 1,
        firstAt: at,
        lastAt: at,
        version: this.extensionVersion,
      });
      // Cap: when over, drop the least-observed, oldest entries.
      if (this.state.lessons.length > CAP) {
        this.state.lessons.sort((a, b) => b.count - a.count || b.lastAt.localeCompare(a.lastAt));
        this.state.lessons.length = CAP;
      }
    }
    await this.memento.update(KEY, this.state);
    this.emitter.fire();
    return { stored: true, merged };
  }

  list(): Lesson[] {
    return [...this.state.lessons].sort(
      (a, b) => b.count - a.count || a.firstAt.localeCompare(b.firstAt),
    );
  }

  count(): number {
    return this.state.lessons.length;
  }

  async remove(ids: string[]): Promise<void> {
    const drop = new Set(ids);
    this.state.lessons = this.state.lessons.filter((l) => !drop.has(l.id));
    await this.memento.update(KEY, this.state);
    this.emitter.fire();
  }

  async clear(): Promise<void> {
    this.state = { version: 1, lessons: [] };
    await this.memento.update(KEY, this.state);
    this.emitter.fire();
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
