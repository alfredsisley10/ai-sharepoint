import { test } from "node:test";
import * as assert from "node:assert/strict";
import { describeToolCall } from "../src/chat/toolStatus";

test("search status names the source and query, not a generic 'Running'", () => {
  assert.equal(
    describeToolCall("aisharepoint_search_context", { source: "CMDB", query: "owned by jdoe" }),
    "Searching CMDB for “owned by jdoe”…",
  );
  assert.equal(
    describeToolCall("aisharepoint_search_context", { query: "release notes" }),
    "Searching reference sources for “release notes”…",
  );
});

test("each tool gets a meaningful, input-aware line", () => {
  assert.equal(
    describeToolCall("aisharepoint_db_schema", { source: "CMDB", topic: "ownership" }),
    "Reading CMDB schema for “ownership”…",
  );
  assert.equal(
    describeToolCall("aisharepoint_vertex_answer", { source: "Corp Search", query: "policy" }),
    "Asking Corp Search “policy”…",
  );
  assert.equal(
    describeToolCall("aisharepoint_run_bookmark", { name: "Open incidents" }),
    "Running bookmark “Open incidents”…",
  );
  assert.equal(
    describeToolCall("aisharepoint_draft_communication", { channel: "teams", to: "jdoe@corp.example" }),
    "Preparing a Teams message to jdoe@corp.example…",
  );
  assert.equal(
    describeToolCall("aisharepoint_test_outlook_channel", {}),
    "Testing the Outlook channel (draft to yourself — nothing is sent)…",
  );
  assert.equal(
    describeToolCall("aisharepoint_export_context_results", { source: "CMDB" }),
    "Exporting CMDB results to a workspace file…",
  );
  assert.equal(
    describeToolCall("aisharepoint_apply_site", {}),
    "Launching apply-to-SharePoint (your approval required)…",
  );
  assert.equal(
    describeToolCall("aisharepoint_write_site_files", { files: [{ path: "lists/A.json", content: "{}" }, { path: "pages/B.json", content: "{}" }] }),
    "Writing 2 site file(s) into the repository…",
  );
});

test("malformed/empty input degrades gracefully; unknown tools get a readable fallback", () => {
  assert.equal(describeToolCall("aisharepoint_search_context", undefined), "Searching reference sources…");
  assert.equal(describeToolCall("aisharepoint_search_context", { source: 42 }), "Searching reference sources…");
  assert.equal(describeToolCall("aisharepoint_future_tool", {}), "Running future tool…");
});

test("long queries are truncated so the status line stays short", () => {
  const out = describeToolCall("aisharepoint_search_context", { query: "x".repeat(200) });
  assert.ok(out.length < 100, out);  // bounded, not the full 200-char query
  assert.ok(out.includes("…"));
});
