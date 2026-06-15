import { SharePointClient } from "../auth/sharePointClient";

/**
 * Graph client for Communication Channels (ADR-0025). Send-capable scopes
 * are requested ONLY here — never by read paths — so consent is incremental
 * and deliberate, mirroring the write-back client (ADR-0021). Construction
 * is never silent-only: sending is always an explicit, just-approved act.
 *
 *  - User.ReadBasic.All → recipient resolution (id + display name)
 *  - Chat.ReadWrite     → create the chat + post the message (Teams)
 *  - Mail.ReadWrite     → create a draft in the user's mailbox (Outlook)
 *  - Mail.Send          → send that draft (only on "Send" approval)
 */
const DIRECTORY_SCOPES = ["https://graph.microsoft.com/User.ReadBasic.All"];
const TEAMS_SCOPES = [...DIRECTORY_SCOPES, "https://graph.microsoft.com/Chat.ReadWrite"];
const MAIL_DRAFT_SCOPES = ["https://graph.microsoft.com/Mail.ReadWrite"];
const MAIL_SEND_SCOPES = [...MAIL_DRAFT_SCOPES, "https://graph.microsoft.com/Mail.Send"];

export interface ResolvedRecipient {
  id: string;
  displayName: string;
  address: string;
}

export class CommsClient extends SharePointClient {
  /** Resolve an email/UPN to a directory user — both a validity check
   *  ("am I really messaging who I think?") and the id Teams needs. */
  async resolveRecipient(ref: string): Promise<ResolvedRecipient> {
    const u = await this.request<{
      id: string;
      displayName?: string;
      mail?: string;
      userPrincipalName?: string;
    }>(
      "GET",
      `/users/${encodeURIComponent(ref)}?$select=id,displayName,mail,userPrincipalName`,
      undefined,
      DIRECTORY_SCOPES,
    );
    return {
      id: u.id,
      displayName: u.displayName ?? ref,
      address: u.mail ?? u.userPrincipalName ?? ref,
    };
  }

  async myUserId(): Promise<string> {
    const me = await this.request<{ id: string }>(
      "GET",
      "/me?$select=id",
      undefined,
      DIRECTORY_SCOPES,
    );
    return me.id;
  }

  /** The signed-in user's own mailbox address — the destination for the
   *  Outlook end-to-end self-test (verification, ADR-0025 amendment). */
  async myAddress(): Promise<ResolvedRecipient> {
    const me = await this.request<{ id: string; displayName?: string; mail?: string; userPrincipalName?: string }>(
      "GET",
      "/me?$select=id,displayName,mail,userPrincipalName",
      undefined,
      DIRECTORY_SCOPES,
    );
    return {
      id: me.id,
      displayName: me.displayName ?? "you",
      address: me.mail ?? me.userPrincipalName ?? "",
    };
  }

  /** Create (or reuse, for oneOnOne Graph dedupes) the chat, then post. */
  async sendTeamsMessage(recipients: ResolvedRecipient[], body: string): Promise<void> {
    const myId = await this.myUserId();
    const member = (id: string) => ({
      "@odata.type": "#microsoft.graph.aadUserConversationMember",
      roles: ["owner"],
      "user@odata.bind": `https://graph.microsoft.com/v1.0/users('${id}')`,
    });
    const chat = await this.request<{ id: string }>(
      "POST",
      "/chats",
      {
        chatType: recipients.length === 1 ? "oneOnOne" : "group",
        members: [member(myId), ...recipients.map((r) => member(r.id))],
      },
      TEAMS_SCOPES,
    );
    await this.request(
      "POST",
      `/chats/${chat.id}/messages`,
      { body: { contentType: "text", content: body } },
      TEAMS_SCOPES,
    );
  }

  /** Create an Outlook draft in the user's mailbox (nothing is sent). */
  async createMailDraft(
    recipients: ResolvedRecipient[],
    subject: string,
    body: string,
  ): Promise<{ id: string; webLink?: string }> {
    return this.request<{ id: string; webLink?: string }>(
      "POST",
      "/me/messages",
      {
        subject,
        body: { contentType: "Text", content: body },
        toRecipients: recipients.map((r) => ({ emailAddress: { address: r.address } })),
      },
      MAIL_DRAFT_SCOPES,
    );
  }

  /** Send a previously created mailbox draft — the approval's "Send" path. */
  sendMailDraft(messageId: string): Promise<void> {
    return this.request(
      "POST",
      `/me/messages/${encodeURIComponent(messageId)}/send`,
      undefined,
      MAIL_SEND_SCOPES,
    );
  }

  /** Remove a mailbox draft — channel-test cleanup. Same scope as creating it. */
  deleteMailDraft(messageId: string): Promise<void> {
    return this.request(
      "DELETE",
      `/me/messages/${encodeURIComponent(messageId)}`,
      undefined,
      MAIL_DRAFT_SCOPES,
    );
  }
}
