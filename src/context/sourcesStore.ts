import * as vscode from "vscode";
import { SecretStore } from "../secrets/secretStore";
import { ContextSource, ContextCredential } from "./types";
import { resolveSourceRef } from "./sourceRef";
import {
  FailureState,
  canAttempt,
  recordAuthFailure,
  recordSuccess,
  AttemptVerdict,
} from "./authFailures";

const SOURCES_KEY = "aiSharePoint.contextSources";
const FAILURES_KEY = "aiSharePoint.contextAuthFailures";

const credentialHandle = (sourceId: string) => `context:${sourceId}:credential`;

/**
 * Non-secret source descriptors + persisted ADR-0009 failure state.
 * Credentials live only in the keychain, keyed by source id, wiped on remove.
 */
export class ContextSourcesStore {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(
    private readonly state: vscode.Memento,
    private readonly secrets: SecretStore,
    private readonly now: () => string,
  ) {}

  list(): ContextSource[] {
    return this.state.get<ContextSource[]>(SOURCES_KEY) ?? [];
  }

  get(id: string): ContextSource | undefined {
    return this.list().find((s) => s.id === id);
  }

  /** Resolve by id, alias, display name, type, or sole source — alias-aware
   *  matching shared with the chat tools (see sourceRef.ts). */
  resolve(reference?: string): ContextSource | undefined {
    return resolveSourceRef(this.list(), reference);
  }

  async upsert(source: ContextSource): Promise<void> {
    const all = this.list().filter((s) => s.id !== source.id);
    all.push(source);
    all.sort((a, b) => a.displayName.localeCompare(b.displayName));
    await this.state.update(SOURCES_KEY, all);
    this.emitter.fire();
  }

  async remove(id: string): Promise<void> {
    await this.state.update(
      SOURCES_KEY,
      this.list().filter((s) => s.id !== id),
    );
    await this.secrets.delete(credentialHandle(id));
    const failures = this.failures();
    if (failures[id]) {
      await this.state.update(FAILURES_KEY, recordSuccess(failures, id));
    }
    this.emitter.fire();
  }

  // --- credentials (keychain only) ---------------------------------------

  setCredential(id: string, credential: ContextCredential): Thenable<void> {
    return this.secrets.set(credentialHandle(id), JSON.stringify(credential));
  }

  async getCredential(id: string): Promise<ContextCredential | undefined> {
    const raw = await this.secrets.get(credentialHandle(id));
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as ContextCredential;
    } catch {
      return undefined;
    }
  }

  // --- ADR-0009 failure tracking ------------------------------------------

  private failures(): FailureState {
    return this.state.get<FailureState>(FAILURES_KEY) ?? {};
  }

  attemptAllowed(id: string, freshCredential = false): AttemptVerdict {
    return canAttempt(this.failures(), id, this.now(), freshCredential);
  }

  async noteAuthFailure(id: string): Promise<void> {
    await this.state.update(
      FAILURES_KEY,
      recordAuthFailure(this.failures(), id, this.now()),
    );
    this.emitter.fire();
  }

  async noteSuccess(id: string): Promise<void> {
    await this.state.update(FAILURES_KEY, recordSuccess(this.failures(), id));
    const source = this.get(id);
    if (source) {
      await this.upsert({ ...source, lastVerifiedAt: this.now() });
    }
  }

  async resetLockout(id: string): Promise<void> {
    await this.state.update(FAILURES_KEY, recordSuccess(this.failures(), id));
    this.emitter.fire();
  }

  isLockedOut(id: string): boolean {
    const verdict = this.attemptAllowed(id, true);
    return !verdict.allowed && verdict.reason === "circuit-open";
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
