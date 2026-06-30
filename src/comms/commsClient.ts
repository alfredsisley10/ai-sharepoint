import { SharePointClient } from "../auth/sharePointClient";
import {
  OutlookReadScope,
  MailMessageView,
  CalendarEventView,
  messagesPath,
  calendarViewPath,
} from "./outlookWorkspace";
import { DriveItemRef, encodeSharingUrl, driveItemToRef } from "../context/files/graphFiles";
import { AppError } from "../core/errors";
import { MailFormat, ComposedAttachment, buildMessageBody, buildFileAttachment } from "./mailCompose";
import {
  TeamsMessageView,
  TeamsChatRaw,
  chatLabel,
  chatsListPath,
  chatMessagesPath,
  channelsListPath,
  channelMessagesPath,
} from "./teamsScope";

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
// Read-only Outlook workspace (ADR-0025 extension). Reads are strictly
// least-privilege: Mail.Read / Calendars.Read. Designating the workspace folder
// reuses the draft scope (Mail.ReadWrite — already consented for sending), and
// the optional move-replies rule needs MailboxSettings.ReadWrite.
const MAIL_READ_SCOPES = ["https://graph.microsoft.com/Mail.Read"];
const CALENDAR_READ_SCOPES = ["https://graph.microsoft.com/Calendars.Read"];
const MAILBOX_RULE_SCOPES = ["https://graph.microsoft.com/MailboxSettings.ReadWrite"];
// Read OneDrive + shared SharePoint files the user can already access.
const FILES_READ_SCOPES = ["https://graph.microsoft.com/Files.Read.All"];
// Read-only, SCOPED Teams messages (ADR-0025 extension). Chats use the delegated
// Chat.Read; channels additionally need Channel.ReadBasic.All + ChannelMessage.Read.All
// (the message-read scope may require admin consent in some tenants).
const TEAMS_CHAT_READ_SCOPES = [...DIRECTORY_SCOPES, "https://graph.microsoft.com/Chat.Read"];
const TEAMS_CHANNEL_READ_SCOPES = [
  "https://graph.microsoft.com/Team.ReadBasic.All",
  "https://graph.microsoft.com/Channel.ReadBasic.All",
  "https://graph.microsoft.com/ChannelMessage.Read.All",
];
const GRAPH_V1 = "https://graph.microsoft.com/v1.0";

export interface MailFolderRef {
  id: string;
  displayName: string;
  totalItemCount?: number;
}

export interface TeamsChatRef {
  id: string;
  label: string;
  chatType?: string;
}

export interface NamedRef {
  id: string;
  displayName: string;
}

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

  /** Create an Outlook draft in the user's mailbox (nothing is sent). Defaults to
   *  plain text with no attachments (back-compatible); pass `opts` for HTML/Rich
   *  Text bodies and file attachments. */
  async createMailDraft(
    recipients: ResolvedRecipient[],
    subject: string,
    body: string,
    opts?: { format?: MailFormat; attachments?: ComposedAttachment[] },
  ): Promise<{ id: string; webLink?: string }> {
    const attachments = opts?.attachments ?? [];
    return this.request<{ id: string; webLink?: string }>(
      "POST",
      "/me/messages",
      {
        subject,
        body: buildMessageBody(opts?.format ?? "text", body),
        toRecipients: recipients.map((r) => ({ emailAddress: { address: r.address } })),
        ...(attachments.length ? { attachments: attachments.map(buildFileAttachment) } : {}),
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

  // --- Read-only Outlook workspace (ADR-0025 extension) --------------------

  /** List the user's mail folders (top level) — used to pick/find a workspace. */
  async listMailFolders(): Promise<MailFolderRef[]> {
    const res = await this.request<{ value: MailFolderRef[] }>(
      "GET",
      "/me/mailFolders?$select=id,displayName,totalItemCount&$top=100",
      undefined,
      MAIL_READ_SCOPES,
    );
    return res.value ?? [];
  }

  /** Create a mail folder (the workspace). Reuses the draft scope, already
   *  consented for sending — no new read/write consent prompt. */
  createMailFolder(displayName: string): Promise<MailFolderRef> {
    return this.request<MailFolderRef>(
      "POST",
      "/me/mailFolders",
      { displayName },
      MAIL_DRAFT_SCOPES,
    );
  }

  /** Read recent messages within the active scope (folder or whole mailbox).
   *  Strictly read-only (Mail.Read). Newest first. */
  async readMessages(scope: OutlookReadScope, folderId: string, top: number): Promise<MailMessageView[]> {
    const res = await this.request<{ value: MailMessageView[] }>(
      "GET",
      messagesPath(scope, folderId, top),
      undefined,
      MAIL_READ_SCOPES,
    );
    return res.value ?? [];
  }

  /** Read calendar events in [startIso, endIso] (read-only, Calendars.Read). */
  async readCalendar(startIso: string, endIso: string, top: number): Promise<CalendarEventView[]> {
    const res = await this.request<{ value: CalendarEventView[] }>(
      "GET",
      calendarViewPath(startIso, endIso, top),
      undefined,
      CALENDAR_READ_SCOPES,
    );
    return res.value ?? [];
  }

  /** Create an inbox rule that moves messages whose subject matches into the
   *  workspace folder (the "replies follow the thread" workflow). */
  createMessageRule(rule: object): Promise<{ id: string }> {
    return this.request<{ id: string }>(
      "POST",
      "/me/mailFolders/inbox/messageRules",
      rule,
      MAILBOX_RULE_SCOPES,
    );
  }

  // --- OneDrive / shared SharePoint files (read-only context) --------------

  /** Resolve a sharing link (OneDrive/SharePoint "shared with you" URL) to a
   *  stable drive-item reference. Read-only (Files.Read.All). */
  async resolveSharedItem(sharingUrl: string): Promise<DriveItemRef> {
    const item = await this.request<Record<string, unknown>>(
      "GET",
      `/shares/${encodeSharingUrl(sharingUrl)}/driveItem?$select=id,name,webUrl,parentReference`,
      undefined,
      FILES_READ_SCOPES,
    );
    const ref = driveItemToRef(item);
    if (!ref) throw new AppError("That link didn't resolve to a file we can read.", "graph.error");
    return ref;
  }

  /** List the files shared with the signed-in user (read-only). */
  async listSharedWithMe(): Promise<DriveItemRef[]> {
    const res = await this.request<{ value: Record<string, unknown>[] }>(
      "GET",
      "/me/drive/sharedWithMe",
      undefined,
      FILES_READ_SCOPES,
    );
    return (res.value ?? []).map((v) => driveItemToRef(v)).filter((r): r is DriveItemRef => Boolean(r));
  }

  /** Download a drive item's raw bytes (read-only). Uses an authenticated fetch
   *  because the content endpoint returns binary, not JSON. */
  async downloadDriveItem(driveId: string, itemId: string): Promise<Buffer> {
    const token = await this.acquire(FILES_READ_SCOPES);
    const url = `${GRAPH_V1}/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}/content`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, redirect: "follow" });
    if (!res.ok) {
      throw new AppError(`Microsoft Graph returned ${res.status} downloading the file.`, res.status === 403 ? "graph.forbidden" : "graph.error");
    }
    return Buffer.from(await res.arrayBuffer());
  }

  // --- Read-only, scoped Teams messages (ADR-0025 extension) ---------------

  /** List the signed-in user's chats with friendly labels (read-only, Chat.Read).
   *  Used to pick a chat to register as a readable scope. */
  async listMyChats(top = 50): Promise<TeamsChatRef[]> {
    const myId = await this.myUserId();
    const res = await this.request<{ value: TeamsChatRaw[] }>("GET", chatsListPath(top), undefined, TEAMS_CHAT_READ_SCOPES);
    return (res.value ?? [])
      .filter((c) => typeof c.id === "string")
      .map((c) => ({ id: c.id as string, label: chatLabel(c, myId), ...(c.chatType ? { chatType: c.chatType } : {}) }));
  }

  /** Read recent messages from one chat (read-only). */
  async readChatMessages(chatId: string, top: number): Promise<TeamsMessageView[]> {
    const res = await this.request<{ value: TeamsMessageView[] }>("GET", chatMessagesPath(chatId, top), undefined, TEAMS_CHAT_READ_SCOPES);
    return res.value ?? [];
  }

  /** List the teams the user has joined (read-only) — to pick a channel scope. */
  async listJoinedTeams(): Promise<NamedRef[]> {
    const res = await this.request<{ value: NamedRef[] }>("GET", "/me/joinedTeams?$select=id,displayName", undefined, TEAMS_CHANNEL_READ_SCOPES);
    return res.value ?? [];
  }

  /** List a team's channels (read-only). */
  async listChannels(teamId: string): Promise<NamedRef[]> {
    const res = await this.request<{ value: NamedRef[] }>("GET", channelsListPath(teamId), undefined, TEAMS_CHANNEL_READ_SCOPES);
    return res.value ?? [];
  }

  /** Read recent messages from one team channel (read-only). */
  async readChannelMessages(teamId: string, channelId: string, top: number): Promise<TeamsMessageView[]> {
    const res = await this.request<{ value: TeamsMessageView[] }>("GET", channelMessagesPath(teamId, channelId, top), undefined, TEAMS_CHANNEL_READ_SCOPES);
    return res.value ?? [];
  }
}
