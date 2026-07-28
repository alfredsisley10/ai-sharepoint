import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  buildComparePrompt,
  parseVerdict,
  composeOwnerNotice,
  AUTHORITY_PROMPT_CHARS,
  CANDIDATE_PROMPT_CHARS,
} from "../src/context/alignmentCompare";
import { AlignmentRun, AlignmentCandidate, createAlignmentRun } from "../src/context/alignmentRun";

const T = "2026-07-27T10:00:00.000Z";

function run(): AlignmentRun {
  return createAlignmentRun(
    {
      title: "VPN",
      authority: { corpus: "confluence", sourceId: "s", scopeKind: "space", spaceKey: "OPS", topic: "VPN access" },
      targets: [{ corpus: "sharepoint", siteUrl: "https://c/sites/IT" }],
    },
    "r1",
    T,
  );
}

function candidate(over: Partial<AlignmentCandidate> = {}): AlignmentCandidate {
  return {
    key: "confluence:p1",
    corpus: "confluence",
    locator: "p1",
    title: "Old VPN notes",
    url: "https://wiki/p1",
    stage: "owner-resolved",
    attempts: 0,
    verdict: { conflicts: true, severity: "high", summary: "names the retired vpn-old host", requestedEdits: ["Replace vpn-old with vpn.corp"] },
    ...over,
  };
}

test("the prompt pins judgement to the supplied authority and demands JSON", () => {
  const p = buildComparePrompt({
    topic: "VPN access",
    authorityText: "Use vpn.corp.",
    authorityTitle: "VPN policy",
    candidateTitle: "Old notes",
    candidateText: "Use vpn-old.corp.",
    candidateUrl: "https://wiki/p1",
  });
  assert.match(p, /ONLY truth/i);
  assert.match(p, /Do NOT use outside knowledge/i);
  // The two "not a conflict" carve-outs that stop false positives.
  assert.match(p, /does not mention the topic is NOT a conflict/i);
  assert.match(p, /less detailed is NOT a conflict/i);
  assert.match(p, /ONE JSON object/i);
  assert.ok(p.includes("VPN access") && p.includes("vpn.corp") && p.includes("vpn-old.corp"));
});

test("prompt clips each side so one huge page can't blow the turn budget", () => {
  const p = buildComparePrompt({
    topic: "t",
    authorityText: "A".repeat(AUTHORITY_PROMPT_CHARS * 2),
    authorityTitle: "auth",
    candidateTitle: "cand",
    candidateText: "B".repeat(CANDIDATE_PROMPT_CHARS * 2),
    candidateUrl: "u",
  });
  assert.ok(!p.includes("A".repeat(AUTHORITY_PROMPT_CHARS + 1)));
  assert.ok(!p.includes("B".repeat(CANDIDATE_PROMPT_CHARS + 1)));
  assert.match(p, /…/);
});

test("parseVerdict reads a clean reply", () => {
  const v = parseVerdict('{"conflicts":true,"severity":"high","summary":"names the old host","requestedEdits":["use vpn.corp"]}');
  assert.deepEqual(v, { conflicts: true, severity: "high", summary: "names the old host", requestedEdits: ["use vpn.corp"] });
});

test("parseVerdict survives fences and surrounding prose", () => {
  const reply = 'Sure! Here is my analysis:\n```json\n{"conflicts": true, "severity": "medium", "summary": "outdated port", "requestedEdits": ["update the port"]}\n```\nHope that helps.';
  const v = parseVerdict(reply)!;
  assert.equal(v.conflicts, true);
  assert.equal(v.severity, "medium");
  assert.equal(v.requestedEdits[0], "update the port");
  // Braces inside strings must not end the object early.
  const tricky = parseVerdict('{"conflicts":true,"severity":"low","summary":"uses {placeholder} syntax","requestedEdits":["fix {x}"]}')!;
  assert.equal(tricky.summary, "uses {placeholder} syntax");
  assert.equal(tricky.requestedEdits[0], "fix {x}");
});

test("parseVerdict FAILS CLOSED — a false positive would email someone about a fine page", () => {
  // Unparseable / missing / non-object replies yield no verdict at all.
  assert.equal(parseVerdict("I could not determine this."), undefined);
  assert.equal(parseVerdict(""), undefined);
  assert.equal(parseVerdict("[1,2,3]"), undefined);
  assert.equal(parseVerdict('{"conflicts": true'), undefined); // truncated
  // Anything that isn't an explicit `true` is NOT a conflict.
  assert.equal(parseVerdict('{"conflicts":"yes","summary":"x"}')!.conflicts, false);
  assert.equal(parseVerdict('{"conflicts":1,"summary":"x"}')!.conflicts, false);
  assert.equal(parseVerdict('{"summary":"x"}')!.conflicts, false);
  // A conflict with nothing actionable to say is downgraded, not sent.
  const empty = parseVerdict('{"conflicts":true,"severity":"high","summary":"","requestedEdits":[]}')!;
  assert.equal(empty.conflicts, false);
  // A non-conflict never carries edits or an alarming severity.
  const clean = parseVerdict('{"conflicts":false,"severity":"high","summary":"agrees","requestedEdits":["do a thing"]}')!;
  assert.deepEqual([clean.severity, clean.requestedEdits], ["low", []]);
  // Junk severity falls back rather than throwing.
  assert.equal(parseVerdict('{"conflicts":true,"severity":"catastrophic","summary":"s"}')!.severity, "medium");
});

test("composeOwnerNotice sends ONE message covering all of a person's pages", () => {
  const n = composeOwnerNotice(
    run(),
    [candidate(), candidate({ key: "sharepoint:x", title: "IT VPN page", url: "https://sp/x" })],
    "https://wiki/authority",
    "Dana",
  );
  assert.match(n.subject, /2 pages/);
  assert.match(n.body, /^Hi Dana,/);
  // Both pages, their URLs, and the specific corrections appear.
  assert.ok(n.body.includes("Old VPN notes") && n.body.includes("IT VPN page"));
  assert.ok(n.body.includes("https://wiki/p1") && n.body.includes("https://sp/x"));
  assert.match(n.body, /Replace vpn-old with vpn\.corp/);
  // The authority is linked so the recipient can verify rather than trust us.
  assert.ok(n.body.includes("https://wiki/authority"));
  // It asks, and offers the "you might be right" escape hatch.
  assert.match(n.body, /Could you review/);
  assert.match(n.body, /authoritative page is the one that's wrong/);
  assert.deepEqual(n.candidateKeys, ["confluence:p1", "sharepoint:x"]);
});

test("composeOwnerNotice degrades gracefully with one page, no name, no authority URL", () => {
  const n = composeOwnerNotice(run(), [candidate()], undefined);
  assert.match(n.subject, /"Old VPN notes"/);
  assert.ok(!/\d+ pages/.test(n.subject));
  assert.match(n.body, /^Hi,/);
  assert.match(n.body, /this page/);
  // No dangling "source of truth: undefined".
  assert.ok(!n.body.includes("undefined"));
});
