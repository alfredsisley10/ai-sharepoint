import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  clampTop,
  messagesPath,
  calendarWindow,
  calendarViewPath,
  normalizeSubject,
  buildSubjectMoveRule,
  withTrackedSubject,
  renderMailDigest,
  renderCalendarDigest,
  MAIL_READ_DEFAULT_TOP,
  MAIL_READ_MAX_TOP,
  RULE_NAME_MAX,
} from "../src/comms/outlookWorkspace";

test("clampTop applies sane bounds", () => {
  assert.equal(clampTop(undefined), MAIL_READ_DEFAULT_TOP);
  assert.equal(clampTop(0), MAIL_READ_DEFAULT_TOP);
  assert.equal(clampTop(5), 5);
  assert.equal(clampTop(9999), MAIL_READ_MAX_TOP);
});

test("messagesPath: workspace reads the folder, mailbox reads all; newest first", () => {
  const ws = messagesPath("workspace", "FOLDER 1", 10);
  assert.match(ws, /\/me\/mailFolders\/FOLDER%201\/messages/);
  assert.match(ws, /\$orderby=receivedDateTime desc/);
  assert.match(ws, /\$top=10/);
  const mb = messagesPath("mailbox", "ignored", 10);
  assert.match(mb, /^\/me\/messages\?/);
});

test("calendarWindow spans now..now+days; calendarViewPath orders by start", () => {
  const { startIso, endIso } = calendarWindow("2026-06-30T00:00:00.000Z", 7);
  assert.equal(startIso, "2026-06-30T00:00:00.000Z");
  assert.equal(endIso, "2026-07-07T00:00:00.000Z");
  const p = calendarViewPath(startIso, endIso, 50);
  assert.match(p, /\/me\/calendarView\?startDateTime=/);
  assert.match(p, /\$orderby=start\/dateTime/);
});

test("normalizeSubject strips Re:/Fwd: and collapses whitespace", () => {
  assert.equal(normalizeSubject("  Re:  Quarterly   plan "), "Quarterly plan");
  assert.equal(normalizeSubject("FWD: hi"), "hi");
  assert.equal(normalizeSubject("Plain subject"), "Plain subject");
});

test("buildSubjectMoveRule moves matching subjects to the folder; clamps name + sequence", () => {
  const rule = buildSubjectMoveRule("Re: Budget review", "FID", "Workspace", 3);
  assert.equal(rule.conditions.subjectContains[0], "Budget review");
  assert.equal(rule.actions.moveToFolder, "FID");
  assert.equal(rule.isEnabled, true);
  assert.equal(rule.sequence, 3);
  assert.ok(rule.displayName.includes("Workspace"));
  // Long subject → name clamped.
  const long = buildSubjectMoveRule("x".repeat(500), "FID", "WS", 0);
  assert.ok(long.displayName.length <= RULE_NAME_MAX);
  assert.equal(long.sequence, 1, "non-positive sequence floored to 1");
});

test("withTrackedSubject dedupes case-insensitively on the normalized form", () => {
  let subs = withTrackedSubject([], "Re: Plan");
  assert.deepEqual(subs, ["Plan"]);
  subs = withTrackedSubject(subs, "plan"); // dup
  assert.deepEqual(subs, ["Plan"]);
  subs = withTrackedSubject(subs, "Budget");
  assert.deepEqual(subs, ["Plan", "Budget"]);
});

test("renderMailDigest: empty + populated (unread dot, sender, preview)", () => {
  assert.match(renderMailDigest("workspace", []), /_No messages\._/);
  const md = renderMailDigest("workspace", [
    { subject: "Hello", from: { emailAddress: { name: "Ann" } }, receivedDateTime: "2026-06-30T09:30:00Z", isRead: false, bodyPreview: "first line" },
  ]);
  assert.match(md, /● \*\*Hello\*\* — Ann/);
  assert.match(md, /first line/);
  assert.match(md, /Read-only/);
});

test("renderCalendarDigest: empty + populated (time, organizer, location)", () => {
  assert.match(renderCalendarDigest("next 7 days", []), /_No events/);
  const md = renderCalendarDigest("next 7 days", [
    { subject: "Standup", organizer: { emailAddress: { name: "Bob" } }, start: { dateTime: "2026-07-01T15:00:00" }, location: { displayName: "Room 2" } },
  ]);
  assert.match(md, /\*\*Standup\*\*/);
  assert.match(md, /Bob/);
  assert.match(md, /Room 2/);
});
