import { test } from "node:test";
import * as assert from "node:assert/strict";
import { recommendModel, betterModelFor, ModelChoice } from "../src/copilot/modelRecommend";

const m = (key: string, usable: number, multiplier: number, over: Partial<ModelChoice> = {}): ModelChoice => ({
  key,
  name: key,
  usable,
  multiplier,
  tested: true,
  ...over,
});

const MODELS = [
  m("economy", 60_000, 0), // cheap, small
  m("mid", 100_000, 1),
  m("premium", 400_000, 10), // expensive, huge
];

test("recommendModel picks the cheapest model that fits", () => {
  // 50k fits everything → cheapest (economy).
  assert.equal(recommendModel(MODELS, 50_000).best?.key, "economy");
  // 80k needs mid or premium → cheaper is mid.
  const r = recommendModel(MODELS, 80_000);
  assert.equal(r.best?.key, "mid");
  assert.equal(r.fits, true);
  assert.match(r.reason, /fits ~80,000 tokens/);
});

test("recommendModel falls back to the largest budget when nothing fits, with a warning", () => {
  const r = recommendModel(MODELS, 500_000);
  assert.equal(r.best?.key, "premium");
  assert.equal(r.fits, false);
  assert.match(r.reason, /No available model comfortably fits/);
  assert.match(r.reason, /largest usable budget/);
});

test("recommendModel handles no models", () => {
  assert.deepEqual(recommendModel([], 1000), { fits: false, reason: "No Copilot models are available." });
});

test("betterModelFor suggests a switch only when the active model can't fit and a better one can", () => {
  // Active = economy (60k), need 80k → mid fits and is cheapest better option.
  assert.equal(betterModelFor("economy", 60_000, MODELS, 80_000)?.key, "mid");
  // Active already fits → no suggestion.
  assert.equal(betterModelFor("mid", 100_000, MODELS, 90_000), undefined);
  // Need exceeds everything → no strictly-fitting better model.
  assert.equal(betterModelFor("economy", 60_000, MODELS, 500_000), undefined);
});
