import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  createWorkItem,
  applyEvent,
  workItemEvent,
  workItemIssue,
  rebuildWorkItem,
  isFollowUpDue,
  dueFollowUps,
  statusCounts,
  buildWorkItemsExport,
  isWorkItemsExport,
  importWorkItems,
  coerceWorkItem,
  WorkItem,
} from "../src/context/workItems";

const T = (n: number) => new Date(Date.UTC(2026, 6, 1, 0, n)).toISOString(); // minute-spaced ISO stamps

function base(): WorkItem {
  return createWorkItem(
    { title: "Stale VPN page", finding: "Says the old gateway", target: { source: "Wiki", kind: "confluence", ref: "123" } },
    "wi1",
    "e0",
    T(0),
  );
}

test("workItemIssue: requires title, finding, and a target source", () => {
  assert.ok(workItemIssue({}));
  assert.ok(workItemIssue({ title: "x", finding: "y" })); // no target
  assert.equal(
    workItemIssue({ title: "x", finding: "y", target: { source: "Wiki", kind: "confluence" } }),
    undefined,
  );
});

test("createWorkItem: opens as open with a created event; owner adds an owner_resolved event", () => {
  const item = base();
  assert.equal(item.status, "open");
  assert.equal(item.events.length, 1);
  assert.equal(item.events[0].kind, "created");

  const withOwner = createWorkItem(
    { title: "t", finding: "f", target: { source: "Wiki", kind: "confluence" }, owner: { sam: "jdoe", basis: "page-contributor" } },
    "wi2",
    "e0",
    T(0),
  );
  assert.equal(withOwner.owner?.sam, "jdoe");
  assert.deepEqual(withOwner.events.map((e) => e.kind), ["created", "owner_resolved"]);
});

test("applyEvent: status/owner/followUpDueAt are derived from the event log", () => {
  let item = base();
  item = applyEvent(item, workItemEvent("e1", T(1), "communication", "ai", { channel: "outlook", recipient: "a@b.com", toStatus: "notified" }));
  assert.equal(item.status, "notified");
  item = applyEvent(item, workItemEvent("e2", T(2), "followup_scheduled", "user", { dueAt: T(100) }));
  assert.equal(item.followUpDueAt, T(100));
  item = applyEvent(item, workItemEvent("e3", T(3), "followup_sent", "ai", {}));
  assert.equal(item.followUpDueAt, undefined); // sending clears the pending follow-up
  item = applyEvent(item, workItemEvent("e4", T(4), "resolved", "user", { toStatus: "resolved" }));
  assert.equal(item.status, "resolved");
  assert.equal(item.updatedAt, T(4));
  assert.equal(item.events.length, 5);
});

test("isFollowUpDue / dueFollowUps: due only when scheduled, past due, and unresolved", () => {
  let item = applyEvent(base(), workItemEvent("e1", T(1), "followup_scheduled", "user", { dueAt: T(10) }));
  assert.equal(isFollowUpDue(item, Date.parse(T(5))), false); // not yet
  assert.equal(isFollowUpDue(item, Date.parse(T(20))), true); // past due
  const resolved = applyEvent(item, workItemEvent("e2", T(2), "resolved", "user", { toStatus: "resolved" }));
  assert.equal(isFollowUpDue(resolved, Date.parse(T(20))), false); // resolved clears due
  assert.equal(dueFollowUps([item, resolved], Date.parse(T(20))).length, 1);
});

test("rebuildWorkItem: re-derives state purely from a shuffled event log", () => {
  const item = base();
  const shuffled: WorkItem = {
    ...item,
    status: "open",
    events: [
      workItemEvent("e2", T(2), "resolved", "user", { toStatus: "resolved" }),
      item.events[0], // created (T0)
      workItemEvent("e1", T(1), "communication", "ai", { channel: "teams", toStatus: "notified" }),
    ],
  };
  const rebuilt = rebuildWorkItem(shuffled);
  assert.equal(rebuilt.status, "resolved");
  assert.deepEqual(rebuilt.events.map((e) => e.at), [T(0), T(1), T(2)]); // re-sorted
  assert.equal(rebuilt.updatedAt, T(2));
});

test("export round-trips; replace restores wholesale", () => {
  const item = base();
  const exp = buildWorkItemsExport([item], T(9));
  assert.ok(isWorkItemsExport(exp));
  assert.equal(isWorkItemsExport({ schema: "other", items: [] }), false);
  const restored = importWorkItems(exp, [], "replace");
  assert.equal(restored.items.length, 1);
  assert.equal(restored.items[0].id, "wi1");
});

test("merge import unions event logs by id and rebuilds (no clobber)", () => {
  // Person A: created + notified. Person B: same item created + resolved.
  const a = applyEvent(base(), workItemEvent("eA", T(1), "communication", "ai", { channel: "outlook", toStatus: "notified" }));
  const b = applyEvent(base(), workItemEvent("eB", T(2), "resolved", "user", { toStatus: "resolved" }));
  const merged = importWorkItems(buildWorkItemsExport([b], T(9)), [a], "merge");
  assert.equal(merged.items.length, 1);
  assert.equal(merged.updated, 1);
  const item = merged.items[0];
  // both distinct events survive (created is shared by id, so deduped)
  assert.ok(item.events.some((e) => e.id === "eA"));
  assert.ok(item.events.some((e) => e.id === "eB"));
  assert.equal(item.status, "resolved"); // latest event wins after rebuild
});

test("coerceWorkItem: rejects junk, repairs a raw item's derived fields", () => {
  assert.equal(coerceWorkItem({}), undefined);
  assert.equal(coerceWorkItem({ id: "x", title: "t" }), undefined); // no target/events
  const raw = { ...base(), status: "open" }; // stale status vs a resolved event
  raw.events = [...raw.events, workItemEvent("r1", T(5), "resolved", "user", { toStatus: "resolved" })];
  const coerced = coerceWorkItem(raw);
  assert.equal(coerced?.status, "resolved");
});

test("statusCounts tallies by derived status", () => {
  const open = base();
  const done = applyEvent(base(), workItemEvent("e", T(1), "resolved", "user", { toStatus: "resolved" }));
  assert.deepEqual(statusCounts([open, done]), { open: 1, notified: 0, in_progress: 0, resolved: 1, wont_fix: 0 });
});
