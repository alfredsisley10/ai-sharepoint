import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  normalizeMailFormat,
  looksLikeHtml,
  htmlEscape,
  plainToHtml,
  buildMessageBody,
  contentTypeForName,
  attachmentsTotalBytes,
  attachmentIssue,
  buildFileAttachment,
  ATTACHMENT_TOTAL_MAX,
  ComposedAttachment,
} from "../src/comms/mailCompose";

test("normalizeMailFormat: text/plain → text; html/rich text → html", () => {
  assert.equal(normalizeMailFormat("Plain text"), "text");
  assert.equal(normalizeMailFormat("text"), "text");
  assert.equal(normalizeMailFormat("HTML"), "html");
  assert.equal(normalizeMailFormat("Rich Text"), "html");
});

test("looksLikeHtml / htmlEscape / plainToHtml", () => {
  assert.ok(looksLikeHtml("<p>hi</p>"));
  assert.ok(!looksLikeHtml("just text with < and >"));
  assert.equal(htmlEscape('a<b>&"c'), "a&lt;b&gt;&amp;&quot;c");
  assert.equal(plainToHtml("line1\nline2"), "line1<br>\nline2");
});

test("buildMessageBody: text stays Text; html passthrough vs plain conversion", () => {
  assert.deepEqual(buildMessageBody("text", "a\nb"), { contentType: "Text", content: "a\nb" });
  assert.deepEqual(buildMessageBody("html", "<b>hi</b>"), { contentType: "HTML", content: "<b>hi</b>" });
  // Plain text under HTML format is escaped + <br>'d so it doesn't show as raw.
  assert.deepEqual(buildMessageBody("html", "x\ny & z"), { contentType: "HTML", content: "x<br>\ny &amp; z" });
});

test("contentTypeForName maps extensions; unknown → octet-stream", () => {
  assert.equal(contentTypeForName("Book.XLSX"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.equal(contentTypeForName("data.csv"), "text/csv");
  assert.equal(contentTypeForName("pic.png"), "image/png");
  assert.equal(contentTypeForName("thing.bin"), "application/octet-stream");
});

test("attachment size guard + Graph fileAttachment payload", () => {
  const small: ComposedAttachment = { name: "a.csv", contentType: "text/csv", base64: "eA==", bytes: 1 };
  assert.equal(attachmentsTotalBytes([small, small]), 2);
  assert.equal(attachmentIssue([small]), undefined);
  const big: ComposedAttachment = { name: "big.bin", contentType: "application/octet-stream", base64: "", bytes: ATTACHMENT_TOTAL_MAX + 1 };
  assert.match(attachmentIssue([big])!, /inline limit/);
  assert.deepEqual(buildFileAttachment(small), {
    "@odata.type": "#microsoft.graph.fileAttachment",
    name: "a.csv",
    contentType: "text/csv",
    contentBytes: "eA==",
  });
});
