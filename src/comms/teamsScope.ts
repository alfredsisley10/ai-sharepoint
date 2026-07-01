/**
 * Read-only, SCOPED Teams message reading (ADR-0025 extension). Mirrors the
 * read-only Outlook workspace: the user designates one or more **scopes** — a
 * specific chat (1:1 / group) or a team channel — and @sharepoint may READ only
 * those, using the SAME Microsoft 365 sign-in that sends Teams messages. It
 * never reads "all of Teams"; only the scopes the user registered.
 *
 * Least-privilege delegated scopes: chats use `Chat.Read`; channels use
 * `Channel.ReadBasic.All` + `ChannelMessage.Read.All` (the latter may need admin
 * consent in some tenants). Reads never post, edit, or delete.
 *
 * Pure types + helpers here (unit-tested); the vscode persistence wrapper is in
 * teamsScopeStore.ts and the Graph calls are in commsClient.ts.
 */

export type TeamsScope =
  | { kind: "chat"; chatId: string }
  | { kind: "channel"; teamId: string; channelId: string };

export interface TeamsScopeEntry {
  id: string;
  /** The comms connection (cacheHandle) this scope belongs to. */
  connectionHandle: string;
  scope: TeamsScope;
  /** Human label shown in pickers/digests (chat topic / members, or team › channel). */
  label: string;
  createdAt: string;
}

export const TEAMS_READ_DEFAULT_TOP = 20;
export const TEAMS_READ_MAX_TOP = 50;
export const TEAMS_TEXT_MAX = 600;

/** Clamp a requested message count into Graph-friendly bounds. */
export function clampTeamsTop(n: number | undefined): number {
  if (!n || !Number.isFinite(n) || n < 1) return TEAMS_READ_DEFAULT_TOP;
  return Math.min(Math.floor(n), TEAMS_READ_MAX_TOP);
}

/** Stable dedup key for a scope (so the same chat/channel isn't registered twice). */
export function teamsScopeKey(scope: TeamsScope): string {
  return scope.kind === "chat" ? `chat:${scope.chatId}` : `channel:${scope.teamId}/${scope.channelId}`;
}

/** Graph path: the signed-in user's chats with members expanded (for labels). */
export function chatsListPath(top = 50): string {
  const n = Math.min(Math.max(Math.floor(top) || 50, 1), 50);
  return `/me/chats?$expand=members&$top=${n}`;
}

/** Graph path: messages in a chat (newest handled by the renderer's sort). */
export function chatMessagesPath(chatId: string, top: number): string {
  return `/chats/${encodeURIComponent(chatId)}/messages?$top=${clampTeamsTop(top)}`;
}

/** Graph path: channels of a joined team. */
export function channelsListPath(teamId: string): string {
  return `/teams/${encodeURIComponent(teamId)}/channels?$select=id,displayName`;
}

/** Graph path: messages in a team channel. */
export function channelMessagesPath(teamId: string, channelId: string, top: number): string {
  return `/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages?$top=${clampTeamsTop(top)}`;
}

interface ChatMemberRaw {
  displayName?: string;
  userId?: string;
}
export interface TeamsChatRaw {
  id?: string;
  topic?: string | null;
  chatType?: string;
  members?: ChatMemberRaw[];
  webUrl?: string;
}

/** Derive a friendly chat label: the topic if set; else the other members'
 *  names (excluding me); else the chat type. Pure. */
export function chatLabel(chat: TeamsChatRaw, myUserId: string): string {
  if (chat.topic && chat.topic.trim()) return chat.topic.trim();
  const others = (chat.members ?? [])
    .filter((m) => m.userId && m.userId !== myUserId)
    .map((m) => (m.displayName || "").trim())
    .filter(Boolean);
  if (others.length) return others.join(", ");
  return chat.chatType === "oneOnOne" ? "1:1 chat" : chat.chatType === "meeting" ? "Meeting chat" : "Group chat";
}

const HTML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Reduce a Teams message HTML body to plain text: drop tags, decode common
 *  entities, collapse whitespace. Bounded by the caller's render. Pure. */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos|nbsp);/g, (m, e: string) => {
      if (e[0] === "#") {
        const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return HTML_ENTITIES[e] ?? m;
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface TeamsMessageView {
  from?: { user?: { displayName?: string } | null; application?: { displayName?: string } | null };
  createdDateTime?: string;
  body?: { contentType?: string; content?: string };
  messageType?: string;
  deletedDateTime?: string | null;
  webUrl?: string;
}

/** Whether a message is real user content (not a system/join event or a deletion). */
function isRealMessage(m: TeamsMessageView): boolean {
  if (m.deletedDateTime) return false;
  if (m.messageType && m.messageType !== "message") return false; // systemEventMessage, etc.
  const raw = m.body?.content ?? "";
  return htmlToText(raw).length > 0;
}

/** The author display name for a message (user, app, or unknown). */
export function messageAuthor(m: TeamsMessageView): string {
  return m.from?.user?.displayName || m.from?.application?.displayName || "unknown";
}

/** Render a read-only Teams digest as Markdown, newest first. Filters out system
 *  and deleted messages and bounds each body. Pure. */
export function renderTeamsDigest(label: string, messages: TeamsMessageView[]): string {
  const real = messages
    .filter(isRealMessage)
    .slice()
    .sort((a, b) => (b.createdDateTime ?? "").localeCompare(a.createdDateTime ?? ""));
  if (real.length === 0) return `# Teams — ${label}\n\n_No messages._`;
  const rows = real.map((m) => {
    const who = messageAuthor(m);
    const when = m.createdDateTime ? m.createdDateTime.replace("T", " ").slice(0, 16) : "";
    const text = htmlToText(m.body?.content ?? "");
    const body = text.length > TEAMS_TEXT_MAX ? `${text.slice(0, TEAMS_TEXT_MAX)}…` : text;
    return `- **${who}** _(${when})_\n  > ${body.replace(/\n/g, "\n  > ")}`;
  });
  return [`# Teams — ${label}`, "", `_${real.length} message(s), newest first. Read-only._`, "", ...rows].join("\n");
}
