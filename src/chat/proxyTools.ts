import * as vscode from "vscode";
import { BlockedTermsStore } from "../diagnostics/blockedTermsStore";
import { TelemetryService } from "../diagnostics/telemetry";
import { ErrorReportStore } from "../diagnostics/errorReports";
import { redactError } from "../core/redaction";
import { releaseExpired, expiredNotice } from "../branding/releaseExpiry";

/**
 * Proxy avoid-list management as a chat tool (#4) — lets the user grow the
 * words-to-avoid "memory" conversationally ("add 'foo' to the proxy block
 * list", "what words are we avoiding?"). Non-destructive: it edits a local list
 * only. Config-supplied terms are read-only here (edited in settings.json).
 */
export function registerProxyTools(
  terms: BlockedTermsStore,
  telemetry: TelemetryService,
  errors: ErrorReportStore,
): vscode.Disposable[] {
  const text = (s: string) => new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(s)]);

  return [
    vscode.lm.registerTool<{ action?: "add" | "remove" | "list"; terms?: string[] }>(
      "aisharepoint_avoid_term",
      {
        prepareInvocation(o) {
          const a = o.input.action ?? (o.input.terms?.length ? "add" : "list");
          return {
            invocationMessage:
              a === "add"
                ? "Adding word(s) to the proxy avoid-list"
                : a === "remove"
                  ? "Removing a word from the proxy avoid-list"
                  : "Listing the proxy avoid-list",
          };
        },
        async invoke(o) {
          if (releaseExpired()) return text(expiredNotice());
          telemetry.record("tool.invoke", { tool: "aisharepoint_avoid_term" });
          try {
            const action = o.input.action ?? (o.input.terms?.length ? "add" : "list");
            const list = o.input.terms ?? [];
            if (action === "add") {
              if (list.length === 0) return text("No words supplied to add.");
              const added = await terms.add(...list);
              telemetry.record("proxy.term.add", { count: added.length });
              return text(
                added.length === 0
                  ? `Nothing added — those word(s) are already on the avoid-list. Current mode: ${terms.mode()}.`
                  : `Added ${added.length} word(s) to the proxy avoid-list: ${added.join(", ")}. ${
                      terms.mode() === "defang"
                        ? "Defang mode is on, so future messages with these words are auto-adjusted to slip past the proxy."
                        : "Tip: set `aiSharePoint.proxy.mode` to `defang` to auto-adjust future messages."
                    }`,
              );
            }
            if (action === "remove") {
              if (list.length === 0) return text("No word supplied to remove.");
              const removed: string[] = [];
              for (const t of list) if (await terms.remove(t)) removed.push(t);
              return text(
                removed.length > 0
                  ? `Removed from the avoid-list: ${removed.join(", ")}.`
                  : `None of those were on the learned avoid-list (config-supplied terms are edited in settings.json).`,
              );
            }
            const all = terms.terms();
            const learned = new Set(terms.learned().map((t) => t.toLowerCase()));
            return text(
              all.length === 0
                ? `The proxy avoid-list is empty. Mode: ${terms.mode()}. Add words here or in \`aiSharePoint.proxy.blockedTerms\`.`
                : `Proxy avoid-list (mode: ${terms.mode()}) — ${all.length} word(s):\n${all
                    .map((t) => `- ${t}${learned.has(t.toLowerCase()) ? "" : " (from settings)"}`)
                    .join("\n")}`,
            );
          } catch (err) {
            errors.capture("tool:aisharepoint_avoid_term", err);
            return text(`Could not update the avoid-list: ${redactError(err).message}`);
          }
        },
      },
    ),
  ];
}
