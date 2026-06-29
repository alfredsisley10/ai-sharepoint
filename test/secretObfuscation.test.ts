import { test } from "node:test";
import * as assert from "node:assert/strict";
import { obfuscateSecret, deobfuscateSecret, isObfuscatedSecret } from "../src/diagnostics/secretObfuscation";

test("obfuscate/deobfuscate round-trips and hides the plaintext", () => {
  const secret = "hec-token-abc123-SECRET";
  const blob = obfuscateSecret(secret);
  assert.equal(deobfuscateSecret(blob), secret);
  // the blob must not contain the plaintext anywhere
  assert.equal(blob.includes(secret), false);
  assert.ok(isObfuscatedSecret(blob));
});

test("each obfuscation is salted (non-deterministic) yet both decode", () => {
  const a = obfuscateSecret("same-value");
  const b = obfuscateSecret("same-value");
  assert.notEqual(a, b);
  assert.equal(deobfuscateSecret(a), "same-value");
  assert.equal(deobfuscateSecret(b), "same-value");
});

test("tampering is detected (AES-GCM auth tag) and bad formats throw", () => {
  const blob = obfuscateSecret("x");
  const parts = blob.split(".");
  // corrupt the ciphertext segment
  parts[4] = Buffer.from("tampered-ciphertext").toString("base64");
  assert.throws(() => deobfuscateSecret(parts.join(".")));
  assert.throws(() => deobfuscateSecret("not-a-blob"), /Unrecognized/);
  assert.equal(isObfuscatedSecret("plain text"), false);
  assert.equal(isObfuscatedSecret(undefined), false);
});
