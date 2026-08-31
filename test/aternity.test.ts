import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  deriveAternityEndpoints,
  aternityEndpointsOf,
  parseAternitySpec,
  aternityQueryPath,
  mapAternityRows,
} from "../src/context/adapters/aternity";

test("deriveAternityEndpoints pairs SaaS app/OData hosts and passes custom hosts through", () => {
  assert.deepEqual(deriveAternityEndpoints("https://us3.aternity.com/#/dashboard"), {
    apiBase: "https://us3-odata.aternity.com",
    appBase: "https://us3.aternity.com",
  });
  // The OData address derives the SAME pair — either paste works.
  assert.deepEqual(deriveAternityEndpoints("https://us3-odata.aternity.com/aternity.odata/latest/"), {
    apiBase: "https://us3-odata.aternity.com",
    appBase: "https://us3.aternity.com",
  });
  // A bare host is accepted (https assumed); on-prem hosts serve both roles.
  assert.deepEqual(deriveAternityEndpoints("aternity.corp.example"), {
    apiBase: "https://aternity.corp.example",
    appBase: "https://aternity.corp.example",
  });
  assert.equal(deriveAternityEndpoints("http://us3.aternity.com"), undefined); // HTTPS only
  assert.equal(deriveAternityEndpoints("not a url"), undefined);
  assert.equal(deriveAternityEndpoints(""), undefined);
});

test("aternityEndpointsOf reads the stored descriptor (web + default table params)", () => {
  const ep = aternityEndpointsOf({
    baseUrl: "https://us3-odata.aternity.com?web=https%3A%2F%2Fus3.aternity.com&table=HEALTH_EVENTS",
  });
  assert.equal(ep.apiBase, "https://us3-odata.aternity.com");
  assert.equal(ep.appBase, "https://us3.aternity.com");
  assert.equal(ep.defaultTable, "HEALTH_EVENTS");
  // Missing params degrade to the derived app base and no default table.
  const bare = aternityEndpointsOf({ baseUrl: "https://eu-odata.aternity.com" });
  assert.equal(bare.appBase, "https://eu.aternity.com");
  assert.equal(bare.defaultTable, undefined);
});

test("parseAternitySpec: JSON specs, bare table names, free text rejected with guidance", () => {
  assert.deepEqual(
    parseAternitySpec(
      '{"table": "HEALTH_EVENTS", "filter": "SEVERITY eq \'CRITICAL\'", "select": ["SEVERITY"], "top": 5, "timeframe": "last_24_hours"}',
    ),
    {
      table: "HEALTH_EVENTS",
      filter: "SEVERITY eq 'CRITICAL'",
      select: ["SEVERITY"],
      top: 5,
      timeframe: "last_24_hours",
    },
  );
  // A spec without a table falls back to the source's default table.
  assert.deepEqual(parseAternitySpec('{"timeframe": "last_7_days"}', "DEVICES_DAILY"), {
    table: "DEVICES_DAILY",
    timeframe: "last_7_days",
  });
  assert.deepEqual(parseAternitySpec("APPLICATIONS_DAILY"), { table: "APPLICATIONS_DAILY" });
  assert.throws(() => parseAternitySpec("   "), /Empty/);
  assert.throws(() => parseAternitySpec("{not json"), /JSON/);
  assert.throws(() => parseAternitySpec("{}"), /No table given/);
  assert.throws(() => parseAternitySpec('{"table": "bad name"}'), /not a valid Aternity table/);
  assert.throws(() => parseAternitySpec('{"table": "X", "timeframe": "yesterday"}'), /timeframe/);
  assert.throws(() => parseAternitySpec("why is Outlook slow?", "HEALTH_EVENTS"), /no free-text search/);
});

test("aternityQueryPath caps $top and composes relative_time into $filter", () => {
  assert.equal(
    aternityQueryPath({ table: "HEALTH_EVENTS" }, 25),
    "/aternity.odata/latest/HEALTH_EVENTS?$top=25",
  );
  assert.equal(
    aternityQueryPath(
      { table: "HEALTH_EVENTS", filter: "SEVERITY eq 'CRITICAL'", timeframe: "last_24_hours", top: 500 },
      25,
    ),
    // spec top capped by maxResults; timeframe leads the composed filter
    `/aternity.odata/latest/HEALTH_EVENTS?$top=25&$filter=${encodeURIComponent(
      "relative_time(last_24_hours) and SEVERITY eq 'CRITICAL'",
    )}`,
  );
  assert.equal(
    aternityQueryPath({ table: "DEVICES_DAILY", select: ["DEVICE_NAME", "HEALTH_SCORE"], top: 2 }, 25),
    "/aternity.odata/latest/DEVICES_DAILY?$top=2&$select=DEVICE_NAME%2CHEALTH_SCORE",
  );
});

test("mapAternityRows: name-ish columns title the hit; facts land in excerpt + meta", () => {
  const hits = mapAternityRows(
    { table: "HEALTH_EVENTS" },
    {
      "@odata.context": "…/$metadata#HEALTH_EVENTS",
      value: [
        {
          APPLICATION_NAME: "Outlook",
          SEVERITY: "CRITICAL",
          USERNAME: "jdoe",
          DEVICE_NAME: "LT-0042",
          "@odata.id": "ignored",
        },
        { DEVICE_NAME: "LT-0099", SEVERITY: "MINOR" },
      ],
    },
    "https://us3.aternity.com/",
    { maxResults: 25 },
  );
  assert.equal(hits.length, 2);
  assert.equal(hits[0].title, "Outlook");
  assert.equal(hits[0].url, "https://us3.aternity.com");
  assert.equal(hits[0].meta?.table, "HEALTH_EVENTS");
  assert.equal(hits[0].meta?.SEVERITY, "CRITICAL");
  assert.match(hits[0].excerpt ?? "", /USERNAME: jdoe/);
  assert.doesNotMatch(hits[0].excerpt ?? "", /@odata/);
  // No application column → the device names the second row.
  assert.equal(hits[1].title, "LT-0099");
});

test("mapAternityRows: result cap and rows without any name-ish column", () => {
  const hits = mapAternityRows(
    { table: "BOOTS" },
    { value: [{ BOOT_MS: 41000 }, { BOOT_MS: 39000 }, { BOOT_MS: 12000 }] },
    "https://us3.aternity.com",
    { maxResults: 2 },
  );
  assert.equal(hits.length, 2);
  assert.equal(hits[0].title, "BOOTS row 1");
  assert.match(hits[0].excerpt ?? "", /BOOT_MS: 41000/);
});
