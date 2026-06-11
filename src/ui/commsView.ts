import * as vscode from "vscode";
import { OutboxStore } from "../comms/outboxStore";
import { CommDraft, draftLabel } from "../comms/outbox";

/**
 * Communications view (ADR-0025): the outbox of prepared-but-unsent drafts.
 * Every row is a pending approval — clicking opens the review/send flow.
 */
export class CommsTreeProvider implements vscode.TreeDataProvider<CommDraft> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly outbox: OutboxStore) {
    outbox.onDidChange(() => this.emitter.fire());
  }

  getTreeItem(draft: CommDraft): vscode.TreeItem {
    const item = new vscode.TreeItem(draftLabel(draft));
    item.id = draft.id;
    item.description = `${draft.channel === "teams" ? "Teams" : "Outlook"} → ${draft.to.join(", ")}`;
    item.iconPath = new vscode.ThemeIcon(
      draft.channel === "teams" ? "comment-discussion" : "mail",
      new vscode.ThemeColor("charts.yellow"),
    );
    item.contextValue = "comm-draft";
    item.tooltip = new vscode.MarkdownString(
      [
        `**${draft.channel === "teams" ? "Teams chat" : "Outlook email"} draft** — _pending your approval; nothing has been sent_`,
        "",
        `| | |`,
        `|---|---|`,
        `| To | ${draft.to.join(", ")} |`,
        ...(draft.subject ? [`| Subject | ${draft.subject.replace(/\|/g, "\\|")} |`] : []),
        `| Prepared | ${draft.createdAt} by ${draft.origin === "agent" ? "@sharepoint (assistant)" : "you"} |`,
        ...(draft.reason ? [`| Why | ${draft.reason.replace(/\|/g, "\\|")} |`] : []),
        "",
        "```",
        draft.body.length > 400 ? `${draft.body.slice(0, 400)}…` : draft.body,
        "```",
      ].join("\n"),
    );
    item.command = {
      command: "aiSharePoint.reviewCommDraft",
      title: "Review & Send",
      arguments: [draft],
    };
    return item;
  }

  getChildren(node?: CommDraft): CommDraft[] {
    return node ? [] : this.outbox.list();
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
