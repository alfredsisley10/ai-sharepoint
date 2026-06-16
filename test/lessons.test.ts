import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  scrubLessonText,
  normalizeLesson,
  lessonKey,
  mergeLesson,
  buildLessonsExport,
  lessonsToMarkdown,
  Lesson,
} from "../src/diagnostics/lessons";

// --- scrubLessonText: generic redaction + domain shapes --------------------

test("scrubs emails and GUIDs via the generic redaction layer", () => {
  const out = scrubLessonText("contact jane.doe@corp.com about 11111111-2222-3333-4444-555555555555");
  assert.ok(!out.includes("jane.doe@corp.com"));
  assert.ok(!/11111111-2222/.test(out));
  assert.match(out, /\[redacted:email\]/);
});

test("personal space key / username (~userid) → ~<user>", () => {
  assert.equal(
    scrubLessonText("scope to the user's personal space ~jdoe instead of global"),
    "scope to the user's personal space ~<user> instead of global",
  );
  // Cloud personal key with a colon is also collapsed.
  assert.match(scrubLessonText("use ~712020:abc-def"), /~<user>/);
});

test("space path segments (/spaces, /display) are generalized", () => {
  assert.match(scrubLessonText("search confluence/spaces/ENG first"), /spaces\/<space>/);
  assert.match(scrubLessonText("open /display/HR/Onboarding"), /display\/<space>/);
  assert.ok(!scrubLessonText("/spaces/ENG").includes("ENG"));
});

test("SharePoint site/team path segments are generalized", () => {
  assert.match(scrubLessonText("the /sites/Marketing landing page"), /sites\/<site>/);
  assert.match(scrubLessonText("/teams/Engineering channel"), /teams\/<site>/);
});

test("quoted UPPERCASE space key after the word 'space' is masked", () => {
  assert.equal(scrubLessonText('prefer space "WXPS" as authoritative'), 'prefer space "<KEY>" as authoritative');
});

test("does not mangle ordinary prose", () => {
  const s = "when the user mentions their own space, narrow the search before going global";
  assert.equal(scrubLessonText(s), s);
});

// --- normalizeLesson -------------------------------------------------------

test("normalizeLesson builds a clean lesson", () => {
  const l = normalizeLesson({
    category: "scoping",
    trigger: "  user says 'my Confluence space'  ",
    lesson: "scope to ~jdoe personal space, not global",
    tags: ["Confluence", "search_context", "confluence"],
  });
  assert.equal(l?.category, "scoping");
  assert.equal(l?.trigger, "user says 'my Confluence space'");
  assert.match(l!.lesson, /~<user>/);
  // tags lowercased, de-duped, symbol-stripped
  assert.deepEqual(l?.tags, ["confluence", "search_context"]);
});

test("normalizeLesson requires both trigger and lesson", () => {
  assert.equal(normalizeLesson({ category: "scoping", trigger: "", lesson: "x" }), undefined);
  assert.equal(normalizeLesson({ category: "scoping", trigger: "x", lesson: "   " }), undefined);
});

test("unknown category falls back to 'other'", () => {
  const l = normalizeLesson({ category: "bogus" as never, trigger: "t", lesson: "l" });
  assert.equal(l?.category, "other");
});

// --- lessonKey / mergeLesson ----------------------------------------------

test("lessonKey folds whitespace, case and punctuation", () => {
  const a = lessonKey({ category: "scoping", trigger: "My space?", lesson: "Use personal!" });
  const b = lessonKey({ category: "scoping", trigger: "my   space", lesson: "use  personal" });
  assert.equal(a, b);
});

test("different category → different key", () => {
  const a = lessonKey({ category: "scoping", trigger: "t", lesson: "l" });
  const b = lessonKey({ category: "workflow", trigger: "t", lesson: "l" });
  assert.notEqual(a, b);
});

test("mergeLesson bumps count, updates lastAt, unions tags", () => {
  const base: Lesson = {
    id: "1",
    category: "scoping",
    trigger: "t",
    lesson: "l",
    tags: ["confluence"],
    count: 1,
    firstAt: "2026-06-16T00:00:00Z",
    lastAt: "2026-06-16T00:00:00Z",
    version: "0.49.0",
  };
  const merged = mergeLesson(base, { category: "scoping", trigger: "t", lesson: "l", tags: ["search_context"] }, "2026-06-16T01:00:00Z");
  assert.equal(merged.count, 2);
  assert.equal(merged.lastAt, "2026-06-16T01:00:00Z");
  assert.deepEqual(merged.tags, ["confluence", "search_context"]);
  assert.equal(base.count, 1, "input not mutated");
});

// --- buildLessonsExport / markdown ----------------------------------------

const L = (over: Partial<Lesson>): Lesson => ({
  id: Math.random().toString(36).slice(2),
  category: "scoping",
  trigger: "t",
  lesson: "l",
  count: 1,
  firstAt: "2026-06-16T00:00:00Z",
  lastAt: "2026-06-16T00:00:00Z",
  version: "0.49.0",
  ...over,
});

test("buildLessonsExport sorts most-observed first and re-scrubs", () => {
  const ex = buildLessonsExport(
    [L({ count: 1, lesson: "leak ~jdoe here" }), L({ count: 5, lesson: "common" })],
    { generatedAt: "2026-06-16T02:00:00Z", anonymousInstallId: "anon-x", extensionVersion: "0.49.0" },
  );
  assert.equal(ex.schema, "ai-sharepoint-lessons/1");
  assert.equal(ex.count, 2);
  assert.equal(ex.lessons[0].count, 5);
  // re-scrub catches a literal that predates a scrubber rule
  assert.ok(!JSON.stringify(ex).includes("~jdoe"));
  assert.match(JSON.stringify(ex), /~<user>/);
});

test("lessonsToMarkdown renders a row per lesson, and an empty state", () => {
  const empty = buildLessonsExport([], { generatedAt: "t", anonymousInstallId: "a", extensionVersion: "v" });
  assert.match(lessonsToMarkdown(empty), /No lessons captured yet/);
  const ex = buildLessonsExport([L({ lesson: "scope to personal" })], {
    generatedAt: "t",
    anonymousInstallId: "a",
    extensionVersion: "v",
  });
  assert.match(lessonsToMarkdown(ex), /scope to personal/);
  assert.match(lessonsToMarkdown(ex), /\| # \| Category \|/);
});
