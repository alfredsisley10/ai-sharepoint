import * as vscode from "vscode";
import { redactText, redactError } from "./redaction";

/**
 * Central logger: a VS Code LogOutputChannel (user-controllable level via the
 * gear menu / `Developer: Set Log Level`) with redaction applied to every
 * message before it is written. No other code writes log lines directly.
 */
export class Logger {
  readonly channel: vscode.LogOutputChannel;

  constructor(name: string) {
    this.channel = vscode.window.createOutputChannel(name, { log: true });
  }

  trace(msg: string): void {
    this.channel.trace(redactText(msg));
  }

  debug(msg: string): void {
    this.channel.debug(redactText(msg));
  }

  info(msg: string): void {
    this.channel.info(redactText(msg));
  }

  warn(msg: string): void {
    this.channel.warn(redactText(msg));
  }

  error(msg: string, err?: unknown): void {
    if (err === undefined) {
      this.channel.error(redactText(msg));
      return;
    }
    const safe = redactError(err);
    this.channel.error(
      redactText(`${msg}: ${safe.name}: ${safe.message}`) +
        (safe.stack ? `\n${safe.stack}` : ""),
    );
  }

  show(preserveFocus = false): void {
    this.channel.show(preserveFocus);
  }

  dispose(): void {
    this.channel.dispose();
  }
}
