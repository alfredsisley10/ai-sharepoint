import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  clampTeamsTop,
  teamsScopeKey,
  chatsListPath,
  chatMessagesPath,
  channelsListPath,
  channelMessagesPath,
  chatLabel,
  htmlToText,
  messageAuthor,
  renderTeamsDigest,
  TeamsMessageView,
  TEAMS_READ_DEFAULT_TOP,
  TEAMS_READ_MAX_TOP,
  TEAMS_TEXT_MAX,
} from "../src/comms/teamsScope";

test("clampTeamsTop bounds the message count", () => {
  assert.equal(clampTeamsTop(undefined), TEAMS_READ_DEFAULT_TOP);
  assert.equal(clampTeamsTop(0), TEAMS_READ_DEFAULT_TOP);
  assert.equal(clampTeamsTop(5), 5);
  assert.equal(clampTeamsTop(9999), TEAMS_READ_MAX_TOP);
});

test("teamsScopeKey distinguishes chats and channels", () => {
  assert.equal(teamsScopeKey({ kind: "chat", chatId: "C1" }), "chat:C1");
  assert.equal(teamsScopeKey({ kind: "channel", teamId: "T", channelId: "CH" }), "channel:T/CH");
  assert.notEqual(teamsScopeKey({ kind: "chat", chatId: "x" }), teamsScopeKey({ kind: "channel", teamId: "x", channelId: "y" }));
});

test("Graph paths encode ids and carry $top / $expand", () => {
  assert.match(chatsListPath(50), /\/me\/chats\?\$expand=members&\$top=50/);
  assert.match(chatMessagesPath("a/b", 10), /\/chats\/a%2Fb\/messages\?\$top=10/);
  assert.match(channelsListPath("T1"), /\/teams\/T1\/channels\?\$select=id,displayName/);
  assert.match(channelMessagesPath("T1", "C1", 5), /\/teams\/T1\/channels\/C1\/messages\?\$top=5/);
  // count is clamped inside the path too
  assert.match(chatMessagesPath("c", 9999), new RegExp(`\\$top=${TEAMS_READ_MAX_TOP}`));
});

test("chatLabel: topic wins; else other members; else chat-type fallback", () => {
  assert.equal(chatLabel({ topic: "Project X", chatType: "group" }, "me"), "Project X");
  assert.equal(
    chatLabel({ chatType: "group", members: [{ displayName: "Me", userId: "me" }, { displayName: "Ann", userId: "a" }, { displayName: "Bob", userId: "b" }] }, "me"),
    "Ann, Bob",
  );
  assert.equal(chatLabel({ chatType: "oneOnOne", members: [{ displayName: "Me", userId: "me" }] }, "me"), "1:1 chat");
  assert.equal(chatLabel({ chatType: "group" }, "me"), "Group chat");
});

test("htmlToText strips tags, decodes entities, and turns block tags into newlines", () => {
  assert.equal(htmlToText("<p>Hello <b>world</b></p>"), "Hello world");
  assert.equal(htmlToText("a<br>b"), "a\nb");
  assert.equal(htmlToText("x &amp; y &lt;z&gt; &#65;"), "x & y <z> A");
  assert.equal(htmlToText("<div>one</div><div>two</div>").replace(/\n+/g, "|"), "one|two");
});

test("messageAuthor prefers user, then application, then unknown", () => {
  assert.equal(messageAuthor({ from: { user: { displayName: "Ann" } } }), "Ann");
  assert.equal(messageAuthor({ from: { application: { displayName: "Bot" } } }), "Bot");
  assert.equal(messageAuthor({ from: {} }), "unknown");
  assert.equal(messageAuthor({}), "unknown");
});

test("renderTeamsDigest filters system/deleted/empty, sorts newest-first, bounds body", () => {
  const msgs: TeamsMessageView[] = [
    { messageType: "message", from: { user: { displayName: "Ann" } }, createdDateTime: "2026-06-01T09:00:00Z", body: { contentType: "html", content: "<p>first</p>" } },
    { messageType: "systemEventMessage", body: { content: "<systemEventMessage/>" }, createdDateTime: "2026-06-02T09:00:00Z" },
    { messageType: "message", deletedDateTime: "2026-06-03T09:00:00Z", body: { content: "gone" }, createdDateTime: "2026-06-03T09:00:00Z" },
    { messageType: "message", from: { user: { displayName: "Bob" } }, createdDateTime: "2026-06-04T09:00:00Z", body: { contentType: "html", content: "<p>latest</p>" } },
    { messageType: "message", from: { user: { displayName: "Empty" } }, createdDateTime: "2026-06-05T09:00:00Z", body: { content: "   " } },
  ];
  const md = renderTeamsDigest("Project X", msgs);
  // Only Ann + Bob survive; Bob (newer) is listed before Ann.
  assert.match(md, /2 message\(s\), newest first/);
  assert.ok(md.indexOf("Bob") < md.indexOf("Ann"), "newest first");
  assert.ok(!md.includes("systemEventMessage") && !md.includes("gone") && !md.includes("Empty"));
  // Empty input → explicit no-messages note.
  assert.match(renderTeamsDigest("Empty", []), /_No messages\._/);
  // Long body is truncated with an ellipsis.
  const long = renderTeamsDigest("L", [{ messageType: "message", from: { user: { displayName: "X" } }, createdDateTime: "2026-06-01T00:00:00Z", body: { content: "y".repeat(TEAMS_TEXT_MAX + 50) } }]);
  assert.ok(long.includes("…"));
});
