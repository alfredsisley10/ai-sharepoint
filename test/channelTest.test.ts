import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  channelTestCode,
  channelTestEmail,
  channelTestCodeMatches,
  CHANNEL_TEST_CODE_LENGTH,
} from "../src/comms/channelTest";

test("channelTestCode maps bytes to digits deterministically and demands enough entropy", () => {
  assert.equal(channelTestCode(new Uint8Array([0, 11, 22, 33, 44, 55])), "012345");
  // Extra bytes are ignored; only the first N drive the code.
  assert.equal(channelTestCode(new Uint8Array([250, 251, 252, 253, 254, 255, 9])), "012345");
  assert.equal(
    channelTestCode(new Uint8Array(CHANNEL_TEST_CODE_LENGTH)).length,
    CHANNEL_TEST_CODE_LENGTH,
  );
  assert.throws(() => channelTestCode(new Uint8Array(CHANNEL_TEST_CODE_LENGTH - 1)));
});

test("channelTestEmail carries the code and reads as a never-sent test draft", () => {
  const mail = channelTestEmail("424242");
  assert.ok(mail.body.includes("424242"));
  assert.match(mail.subject, /channel test/i);
  assert.match(mail.subject, /never sent/i);
  assert.match(mail.body, /nothing was or will be sent/i);
  assert.match(mail.body, /addressed to you alone/i);
});

test("channelTestCodeMatches tolerates spaces/hyphens, rejects wrong or empty input", () => {
  assert.ok(channelTestCodeMatches("123456", "123456"));
  assert.ok(channelTestCodeMatches("123456", " 123 456 "));
  assert.ok(channelTestCodeMatches("123456", "123-456"));
  assert.ok(!channelTestCodeMatches("123456", "654321"));
  assert.ok(!channelTestCodeMatches("123456", ""));
  assert.ok(!channelTestCodeMatches("123456", "   "));
});
