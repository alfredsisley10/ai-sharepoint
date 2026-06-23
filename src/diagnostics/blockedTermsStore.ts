import * as vscode from "vscode";
import { ProxyMode, normalizeTerms } from "../core/proxyShield";

/**
 * The words-to-avoid list (#4): a CONFIG list (`aiSharePoint.proxy.blockedTerms`,
 * team-settable in settings.json) merged with a LEARNED list the user grows at
 * runtime (chat tool / command), persisted locally in globalState — the
 * "memory" half of the feature. Mode comes from `aiSharePoint.proxy.mode`.
 */
const KEY = "aiSharePoint.proxyLearnedTerms";
const LEARNED_CAP = 200;

export class BlockedTermsStore {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly memento: vscode.Memento) {}

  private cfg<T>(key: string, fallback: T): T {
    return vscode.workspace.getConfiguration("aiSharePoint").get<T>(key, fallback);
  }

  mode(): ProxyMode {
    const m = this.cfg<string>("proxy.mode", "warn");
    return m === "defang" || m === "off" ? m : "warn";
  }

  configTerms(): string[] {
    return normalizeTerms(this.cfg<string[]>("proxy.blockedTerms", []));
  }

  learned(): string[] {
    return this.memento.get<string[]>(KEY, []);
  }

  /** Config + learned, normalized and de-duplicated. */
  terms(): string[] {
    return normalizeTerms([...this.configTerms(), ...this.learned()]);
  }

  /** Add to the LEARNED list (config terms are edited in settings). Returns the
   *  terms that were newly added (not already present in config or learned). */
  async add(...incoming: string[]): Promise<string[]> {
    const existing = new Set(this.terms().map((t) => t.toLowerCase()));
    const added = normalizeTerms(incoming).filter((t) => !existing.has(t.toLowerCase()));
    if (added.length === 0) return [];
    const merged = normalizeTerms([...this.learned(), ...added]).slice(-LEARNED_CAP);
    await this.memento.update(KEY, merged);
    this.emitter.fire();
    return added;
  }

  /** Remove a LEARNED term (case-insensitive). Returns true if one was removed. */
  async remove(term: string): Promise<boolean> {
    const t = term.trim().toLowerCase();
    const next = this.learned().filter((x) => x.toLowerCase() !== t);
    if (next.length === this.learned().length) return false;
    await this.memento.update(KEY, next);
    this.emitter.fire();
    return true;
  }

  async clearLearned(): Promise<void> {
    await this.memento.update(KEY, []);
    this.emitter.fire();
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
