import * as vscode from "vscode";
import { OutboxStore } from "../comms/outboxStore";
import {
  CommDraft,
  parseRecipients,
  draftIssue,
  MAX_BODY_CHARS,
} from "../comms/outbox";
import { TelemetryService } from "../diagnostics/telemetry";
import { ErrorReportStore } from "../diagnostics/errorReports";
import { redactError } from "../core/redaction";

/**
 * Communication Channels chat tool (ADR-0025). The assistant can only
 * PREPARE a draft into the outbox — behind VS Code's tool confirmation —
 * and sending requires the user's separate, per-draft approval in the
 * Communications view. Two human gates, zero agent send paths.
 */
export function registerCommsTools(
  outbox: OutboxStore,
  telemetry: TelemetryService,
  errors: ErrorReportStore,
  nowIso: () => string,
): vscode.Disposable[] {
  const text = (s: string) =>
    new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(s)]);
  return [
    // Channel test = its own bounded transaction (pilot): draft-to-self with
    // a code, user confirms, draft removed — never chains into a new draft.
    vscode.lm.registerTool<Record<string, never>>("aisharepoint_test_outlook_channel", {
      prepareInvocation() {
        return {
          invocationMessage: "Testing the Outlook channel (draft to yourself)",
          confirmationMessages: {
            title: "Test the Outlook channel?",
            message: new vscode.MarkdownString(
              [
                "Creates a draft **addressed to you alone** containing a verification code — **nothing is sent**.",
                "You confirm the code from your Outlook **Drafts** folder, then the test draft is removed.",
                "",
                "_A self-contained check: it never starts a real email._",
              ].join("\n"),
            ),
          },
        };
      },
      async invoke() {
        telemetry.record("tool.invoke", { tool: "aisharepoint_test_outlook_channel" });
        try {
          const outcome = await vscode.commands.executeCommand<
            "verified" | "cancelled" | undefined
          >("aiSharePoint.testOutlookChannel");
          if (outcome === "verified") {
            return text(
              "Outlook channel test PASSED — the user confirmed the code from their Drafts folder, the test draft was removed, and nothing was sent. The test transaction is COMPLETE: report the result and stop. Do NOT prepare a draft or ask for a recipient now — composing a message is a separate transaction the user starts explicitly.",
            );
          }
          if (outcome === "cancelled") {
            return text(
              "The user cancelled the Outlook channel test (any test draft was cleaned up; nothing was sent). Do not retry on your own and do not start drafting anything — wait for the user's next request.",
            );
          }
          return text(
            "The Outlook channel test could not complete — the user already saw the error and remediation. Do not start drafting anything; let the user decide the next step.",
          );
        } catch (err) {
          errors.capture("tool:aisharepoint_test_outlook_channel", err);
          return text(`The Outlook channel test failed to run: ${redactError(err).message}`);
        }
      },
    }),
    vscode.lm.registerTool<{
      channel: "teams" | "outlook";
      to: string;
      subject?: string;
      body: string;
      reason?: string;
    }>("aisharepoint_draft_communication", {
      prepareInvocation(options) {
        const i = options.input;
        return {
          invocationMessage: "Preparing a communication draft",
          confirmationMessages: {
            title: `Prepare a ${i.channel === "teams" ? "Teams message" : "draft email"} to ${i.to}?`,
            message: new vscode.MarkdownString(
              [
                `**Channel:** ${i.channel === "teams" ? "Microsoft Teams chat" : "Outlook email"}`,
                `**To:** ${i.to}`,
                ...(i.subject ? [`**Subject:** ${i.subject}`] : []),
                "",
                "```",
                i.body.length > 600 ? `${i.body.slice(0, 600)}…` : i.body,
                "```",
                ...(i.reason ? [`_${i.reason}_`] : []),
                "",
                "This only places a draft in the **Communications** outbox — nothing is sent until you approve that specific draft there.",
              ].join("\n"),
            ),
          },
        };
      },
      async invoke(options) {
        telemetry.record("tool.invoke", { tool: "aisharepoint_draft_communication" });
        try {
          const input = options.input;
          const draft: CommDraft = {
            id: crypto.randomUUID(),
            channel: input.channel === "teams" ? "teams" : "outlook",
            to: parseRecipients(input.to ?? ""),
            ...(input.subject?.trim() ? { subject: input.subject.trim() } : {}),
            body: (input.body ?? "").slice(0, MAX_BODY_CHARS),
            createdAt: nowIso(),
            origin: "agent",
            ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
          };
          const issue = draftIssue(draft);
          if (issue) {
            return new vscode.LanguageModelToolResult([
              new vscode.LanguageModelTextPart(`The draft is not valid: ${issue}`),
            ]);
          }
          await outbox.add(draft);
          telemetry.record("comms.draft", { channel: draft.channel, via: "agent" });
          return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(
              `Draft queued in the Communications outbox for ${draft.to.join(", ")} (${draft.channel}). It will NOT be sent until the user reviews and approves it there — tell the user to open the Communications view to send or discard it.`,
            ),
          ]);
        } catch (err) {
          errors.capture("tool:aisharepoint_draft_communication", err);
          return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(
              `Could not queue the draft: ${redactError(err).message}`,
            ),
          ]);
        }
      },
    }),
  ];
}
