# ADR-0025: Communication Channels (Teams chat & Outlook email)

- **Status:** Accepted (2026-06-11)
- **Context:** Pilots want the assistant's research to reach people:
  "prepare communications to be sent to individuals via these
  communication channels that the user must approve prior to sending."
  Sending on a user's behalf is the highest-trust operation in the
  extension — above site write-back — because it is outward-facing and
  irreversible.

## Decision

1. **Outbox model with two human gates.** Drafts (Teams chat / Outlook
   email) are *prepared* into a local outbox — by the user (commands) or
   by the assistant (`draft_communication` tool, which itself sits behind
   VS Code's tool-confirmation UI). **Nothing sends from preparation.**
   Sending happens only in the review flow: full-fidelity preview opened
   in the editor, then a modal that names every recipient. The assistant
   has *no* send-capable code path.
2. **Individuals, not broadcasts:** max 10 recipients per draft,
   validated as emails/UPNs at entry and **resolved against the
   directory at send time** (a typo'd recipient aborts the send and
   names the failures).
3. **Graph, incremental consent** (mirrors ADR-0021): send-capable
   scopes are requested only by `CommsClient`, never by read paths —
   `User.ReadBasic.All` (recipient resolution), `Chat.ReadWrite` (create
   chat + post), `Mail.ReadWrite` (mailbox draft), `Mail.Send` (send the
   draft on approval). Authentication reuses the connected site's MSAL
   provider (keychain cache); with multiple tenants the user picks once.
4. **Outlook has a softer landing:** "Save to Outlook Drafts" creates
   the draft in the user's mailbox *without sending* — finish and send
   from Outlook itself. Teams (no draft concept) sends only on the modal
   approval; one recipient → oneOnOne chat, several → group chat.
5. **Transparency artifacts:** drafts carry origin (`user`/`agent`) and
   the agent's one-line `reason`; both appear in the outbox tooltip, the
   preview, and the approval dialog ("content was prepared by the
   assistant — review it"). Telemetry records channel/origin events
   only — never recipients or content.

## Consequences

- A compromised or confused model can at worst *queue* a clearly-labeled
  draft, which expires under the user's eyes — it cannot send.
- Messages send as the signed-in user (no app-only identity), so normal
  tenant DLP/compliance applies on the Graph side.
- Bodies are plain text in v1 (no HTML), bounded at 10k characters;
  attachments and channel posts (vs chats) are explicitly out of scope
  until asked for.
