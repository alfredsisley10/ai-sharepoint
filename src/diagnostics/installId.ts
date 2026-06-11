import * as vscode from "vscode";
import { newAnonymousId } from "../core/anonymize";

export interface InstallIdentity {
  /** Random UUID identifying this installation in exported bundles.
   *  Deliberately NOT vscode.env.machineId — rotatable, and never tied to
   *  hardware or the VS Code telemetry identity. */
  id: string;
  /** Salt for all pseudonymizing hashes in bundles. Never exported. */
  salt: string;
  createdAt: string;
}

const KEY = "aiSharePoint.installIdentity";

/** Manages the anonymous installation identity (ADR-0018). */
export class InstallIdStore {
  constructor(private readonly state: vscode.Memento) {}

  get(): InstallIdentity {
    const existing = this.state.get<InstallIdentity>(KEY);
    if (existing?.id && existing.salt) {
      return existing;
    }
    const fresh: InstallIdentity = {
      id: newAnonymousId(),
      salt: newAnonymousId(),
      createdAt: new Date().toISOString(),
    };
    void this.state.update(KEY, fresh);
    return fresh;
  }

  /** Rotate id + salt: severs correlation with every previously exported bundle. */
  async rotate(): Promise<InstallIdentity> {
    const fresh: InstallIdentity = {
      id: newAnonymousId(),
      salt: newAnonymousId(),
      createdAt: new Date().toISOString(),
    };
    await this.state.update(KEY, fresh);
    return fresh;
  }
}
