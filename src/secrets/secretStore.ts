import * as vscode from "vscode";

/**
 * Thin wrapper over VS Code's SecretStorage (backed by the OS keychain).
 *
 * Per ADR / PLAN §6, all secret material — tokens, refresh tokens, MSAL token
 * caches, passwords — flows through here and never touches workspace files,
 * settings, logs, or the repo. Callers store and reference secrets by a stable
 * key handle; the value is resolved on the local machine only.
 */
export class SecretStore {
  private static readonly PREFIX = "aiSharePoint:";

  constructor(private readonly storage: vscode.SecretStorage) {}

  private key(handle: string): string {
    return `${SecretStore.PREFIX}${handle}`;
  }

  get(handle: string): Thenable<string | undefined> {
    return this.storage.get(this.key(handle));
  }

  set(handle: string, value: string): Thenable<void> {
    return this.storage.store(this.key(handle), value);
  }

  delete(handle: string): Thenable<void> {
    return this.storage.delete(this.key(handle));
  }
}
