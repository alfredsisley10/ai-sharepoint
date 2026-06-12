import { test } from "node:test";
import * as assert from "node:assert/strict";
import { describeColumn, summarizeCanvas } from "../src/chat/siteInspect";

test("describeColumn reads the Graph type facet and required flag", () => {
  assert.deepEqual(
    describeColumn({ name: "Title", displayName: "Title", text: {}, required: true }),
    { name: "Title", type: "text", required: true },
  );
  assert.deepEqual(
    describeColumn({ name: "Owner", personOrGroup: { allowMultipleSelection: false } }),
    { name: "Owner", type: "personOrGroup" },
  );
  assert.deepEqual(describeColumn({ displayName: "Mystery" }), {
    name: "Mystery",
    type: "unknown",
  });
});

test("summarizeCanvas walks sections/columns and classifies web parts", () => {
  const canvas = {
    horizontalSections: [
      {
        layout: "twoColumns",
        emphasis: "none",
        columns: [
          {
            width: 6,
            webparts: [
              {
                "@odata.type": "#microsoft.graph.textWebPart",
                innerHtml: "<h2>Welcome</h2><p>to the &amp; team</p>",
              },
            ],
          },
          {
            width: 6,
            webparts: [
              {
                "@odata.type": "#microsoft.graph.standardWebPart",
                webPartType: "8c88f208-6c77-4bdb-86a0-0c47b4316588",
                data: { title: "News", description: "Latest team news" },
              },
            ],
          },
        ],
      },
    ],
    verticalSection: {
      webparts: [{ "@odata.type": "#microsoft.graph.standardWebPart", webPartType: "guid-x", data: {} }],
    },
  };
  const out = summarizeCanvas(canvas);
  assert.equal(out.webPartCount, 3);
  assert.equal(out.sections[0].layout, "twoColumns");
  assert.deepEqual(out.sections[0].columns[0].webParts[0], {
    kind: "text",
    text: "Welcome to the & team",
  });
  assert.equal(out.sections[0].columns[1].webParts[0].title, "News");
  assert.equal(out.sections[0].columns[1].webParts[0].text, "Latest team news");
  // Untitled standard parts fall back to the webPartType id.
  assert.equal(out.verticalSection?.webParts[0].type, "guid-x");
});

test("summarizeCanvas degrades gracefully on missing/blocked layouts", () => {
  assert.deepEqual(summarizeCanvas(undefined), { sections: [], webPartCount: 0 });
  assert.deepEqual(summarizeCanvas({ horizontalSections: "nope" }), {
    sections: [],
    webPartCount: 0,
  });
});

test("text web parts cap long content", () => {
  const html = `<p>${"x".repeat(2000)}</p>`;
  const out = summarizeCanvas({
    horizontalSections: [{ columns: [{ webparts: [{ innerHtml: html }] }] }],
  });
  assert.ok((out.sections[0].columns[0].webParts[0].text?.length ?? 0) <= 401);
});
