import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  describeColumn,
  summarizeCanvas,
  summarizePageContent,
  extractHtmlHeadings,
  extractHtmlLinks,
} from "../src/chat/siteInspect";

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
    type: "Text",
    text: "Welcome to the & team",
    headings: ["Welcome"],
  });
  assert.equal(out.sections[0].columns[1].webParts[0].type, "News");
  assert.equal(out.sections[0].columns[1].webParts[0].title, "News");
  assert.equal(out.sections[0].columns[1].webParts[0].text, "Latest team news");
  // Untitled standard parts fall back to a friendly label from the type id.
  assert.equal(out.verticalSection?.webParts[0].type, "Web part guid-x");
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

test("extractHtmlHeadings/Links pull headings and real targets from Text HTML", () => {
  assert.deepEqual(extractHtmlHeadings("<h1>A</h1><p>x</p><h3>B &amp; C</h3>"), ["A", "B & C"]);
  assert.deepEqual(
    extractHtmlLinks('<a href="https://x.com/a">x</a> <a href="#anchor">skip</a> <a href="/rel">z</a>'),
    ["https://x.com/a", "/rel"],
  );
});

test("text web part exposes its headings AND link targets", () => {
  const out = summarizeCanvas({
    horizontalSections: [
      {
        columns: [
          {
            webparts: [
              {
                innerHtml:
                  '<h3>Policies</h3><p>See the <a href="https://contoso.com/policy">policy</a>.</p>',
              },
            ],
          },
        ],
      },
    ],
  });
  const wp = out.sections[0].columns[0].webParts[0];
  assert.deepEqual(wp.headings, ["Policies"]);
  assert.deepEqual(wp.links, ["https://contoso.com/policy"]);
});

test("Quick Links web part surfaces tile titles and target urls generically", () => {
  const out = summarizeCanvas({
    horizontalSections: [
      {
        columns: [
          {
            webparts: [
              {
                "@odata.type": "#microsoft.graph.standardWebPart",
                webPartType: "c70391ea-0b10-4ee9-b2b4-006d3fcad0cd",
                data: {
                  title: "Quick links",
                  serverProcessedContent: {
                    searchablePlainTexts: { "items[0].title": "HR Portal", "items[1].title": "IT Help" },
                    links: {
                      "items[0].sourceItem.url": "https://hr.contoso.com",
                      "items[1].sourceItem.url": "https://it.contoso.com",
                    },
                  },
                },
              },
            ],
          },
        ],
      },
    ],
  });
  const wp = out.sections[0].columns[0].webParts[0];
  assert.equal(wp.type, "Quick links");
  assert.deepEqual(wp.headings, ["HR Portal", "IT Help"]);
  assert.deepEqual(wp.links, ["https://hr.contoso.com", "https://it.contoso.com"]);
});

test("Hero web part surfaces tile heading + link", () => {
  const out = summarizeCanvas({
    horizontalSections: [
      {
        columns: [
          {
            webparts: [
              {
                webPartType: "c4bd7b2f-7b6e-4599-8485-16504575f590",
                data: {
                  serverProcessedContent: {
                    searchablePlainTexts: { "heroItem[0].title": "Welcome aboard" },
                    links: { "heroItem[0].link": "https://contoso.sharepoint.com/onboarding" },
                  },
                },
              },
            ],
          },
        ],
      },
    ],
  });
  const wp = out.sections[0].columns[0].webParts[0];
  assert.equal(wp.type, "Hero");
  assert.deepEqual(wp.headings, ["Welcome aboard"]);
  assert.deepEqual(wp.links, ["https://contoso.sharepoint.com/onboarding"]);
});

test("List web part reports the embedded list view", () => {
  const out = summarizeCanvas({
    horizontalSections: [
      {
        columns: [
          {
            webparts: [
              {
                webPartType: "f92bf067-bc19-489e-a556-7fe95f508720",
                data: {
                  title: "Announcements",
                  properties: { selectedListId: "list-guid-123", listTitle: "Announcements" },
                },
              },
            ],
          },
        ],
      },
    ],
  });
  const wp = out.sections[0].columns[0].webParts[0];
  assert.equal(wp.type, "List");
  assert.deepEqual(wp.list, { id: "list-guid-123", title: "Announcements" });
});

test("summarizePageContent aggregates headings, links, web-part histogram and embedded lists", () => {
  const content = {
    canvasLayout: {
      horizontalSections: [
        {
          columns: [
            {
              webparts: [
                { innerHtml: '<h2>Overview</h2><p>Visit <a href="https://x/a">A</a></p>' },
                {
                  webPartType: "f92bf067-bc19-489e-a556-7fe95f508720",
                  data: { title: "Tasks", properties: { selectedListId: "L1", listTitle: "Tasks" } },
                },
              ],
            },
          ],
        },
      ],
    },
  };
  const page = summarizePageContent(
    { title: "Home", webUrl: "https://site/home.aspx", lastModified: "2024-01-02T00:00:00Z" },
    content,
  );
  assert.equal(page.title, "Home");
  assert.equal(page.url, "https://site/home.aspx");
  assert.equal(page.lastModified, "2024-01-02T00:00:00Z");
  assert.ok(page.headings.includes("Overview"));
  assert.ok(page.headings.includes("Tasks")); // the List web part's title
  assert.ok(page.links.includes("https://x/a"));
  assert.deepEqual(page.embeddedLists, ["Tasks"]);
  assert.equal(page.webPartCount, 2);
  assert.deepEqual(
    [...page.webParts].sort((a, b) => a.type.localeCompare(b.type)),
    [
      { type: "List", count: 1 },
      { type: "Text", count: 1 },
    ],
  );
});
