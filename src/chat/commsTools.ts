import * as vscode from "vscode";
import { releaseExpired, expiredNotice } from "../branding/releaseExpiry";
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
 * Communication Channels chat tool (ADR-0025, amended). Two paths by channel:
 *  - **Outlook** → the draft is created **directly in the user's Outlook Drafts
 *    folder**. Outlook's own Drafts is the review-and-send surface, so there's
 *    no in-plugin staging or approval prompt — nothing is ever sent.
 *  - **Teams** → Teams posts live (no draft folder), so it is staged in the
 *    Communications outbox behind a confirmation and the user's separate
 *    per-draft approval there. The agent has zero send paths.
 */
export function registerCommsTools(
  outbox: OutboxStore,
  createOutlookDraft: (to: string[], subject: string, body: string) => Promise<{ webLink?: string; failures: string[] }>,
  telemetry: TelemetryService,
  errors: ErrorReportStore,
  nowIso: () => string,
): vscode.Disposable[] {
  const text = (s: string) => new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(s)]);
  return [
    vscode.lm.registerTool<{
      channel: "teams" | "outlook";
      to: string;
      subject?: string;
      body: string;
      reason?: string;
    }>("aisharepoint_draft_communication", {
      prepareInvocation(options) {
        const i = options.input;
        if (i.channel !== "teams") {
          // Outlook: straight to the Outlook Drafts folder (the review surface),
          // so no blocking approval prompt — just announce it.
          return { invocationMessage: `Saving an email draft to ${i.to} in your Outlook Drafts…` };
        }
        return {
          invocationMessage: `Preparing a Teams message to ${i.to}`,
          confirmationMessages: {
            title: `Prepare a Teams message to ${i.to}?`,
            message: new vscode.MarkdownString(
              [
                `**To:** ${i.to}`,
                "",
                "```",
                i.body.length > 600 ? `${i.body.slice(0, 600)}…` : i.body,
                "```",
                ...(i.reason ? [`_${i.reason}_`] : []),
                "",
                "Teams posts live, so this only **queues** a draft in the **Communications** outbox — nothing is sent until you approve that specific draft there.",
              ].join("\n"),
            ),
          },
        };
      },
      async invoke(options) {
        if (releaseExpired()) return text(expiredNotice());
        telemetry.record("tool.invoke", { tool: "aisharepoint_draft_communication" });
        try {
          const input = options.input;
          const to = parseRecipients(input.to ?? "");
          const subject = input.subject?.trim() ?? "";
          const body = (input.body ?? "").slice(0, MAX_BODY_CHARS);
          if (to.length === 0) return text("At least one recipient is required.");
          if (!body.trim()) return text("A message body is required.");

          if (input.channel !== "teams") {
            const { webLink, failures } = await createOutlookDraft(to, subject, body);
            telemetry.record("comms.saveDraft", { channel: "outlook", via: "agent" });
            const unresolved = failures.length ? ` (couldn't resolve: ${failures.join(", ")})` : "";
            return text(
              `Saved an email draft to ${to.join(", ")} in the user's Outlook **Drafts** folder${unresolved} — nothing was sent. Tell the user to review and send it from Outlook.${webLink ? ` Open: ${webLink}` : ""}`,
            );
          }

          // Teams: stage in the outbox for the user's approval (it sends live).
          const draft: CommDraft = {
            id: crypto.randomUUID(),
            channel: "teams",
            to,
            ...(subject ? { subject } : {}),
            body,
            createdAt: nowIso(),
            origin: "agent",
            ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
          };
          const issue = draftIssue(draft);
          if (issue) return text(`The draft is not valid: ${issue}`);
          await outbox.add(draft);
          telemetry.record("comms.draft", { channel: "teams", via: "agent" });
          return text(
            `Teams draft queued in the Communications outbox for ${draft.to.join(", ")}. It will NOT be sent until the user reviews and approves it there — tell the user to open the Communications view.`,
          );
        } catch (err) {
          errors.capture("tool:aisharepoint_draft_communication", err);
          return text(`Could not prepare the communication: ${redactError(err).message}`);
        }
      },
    }),
  ];
}
