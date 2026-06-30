import * as crypto from "node:crypto";

/**
 * Secret OBFUSCATION for values baked into a white-labeled VSIX (e.g. a Splunk
 * Attribution Identifier — the Splunk HEC token — pre-packaged by the distributor).
 *
 * IMPORTANT — this is obfuscation, NOT secrecy. The key is derived from a
 * constant compiled into the extension, so the value is recoverable at runtime
 * (it must be, to be usable) and therefore by a determined party who has the
 * build and reverse-engineers it. What it DOES guarantee: the token never
 * appears as plaintext in package.json or anywhere a casual user would look, it
 * is not stored in settings, and on install it is moved into the OS keychain.
 * AES-256-GCM also makes the blob tamper-evident. Treat baked tokens as
 * low-privilege, rotatable, HEC-ingest-only credentials.
 */

const VERSION = "v1";
// Obfuscation passphrase (NOT a security boundary — see the file header). Kept
// out of the brand-token set so a rebrand doesn't change it (bake-time and
// run-time must agree).
const PASSPHRASE = "ai-sharepoint::telemetry-secret-obfuscation::do-not-treat-as-secret";

function deriveKey(salt: Buffer): Buffer {
  return crypto.scryptSync(PASSPHRASE, salt, 32);
}

/** Obfuscate a plaintext secret into an opaque, tamper-evident blob. */
export function obfuscateSecret(plaintext: string): string {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveKey(salt), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, salt.toString("base64"), iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(".");
}

/** Recover a plaintext secret from an obfuscated blob. Throws on tamper / bad format. */
export function deobfuscateSecret(blob: string): string {
  const parts = (blob ?? "").split(".");
  if (parts.length !== 5 || parts[0] !== VERSION) {
    throw new Error("Unrecognized obfuscated-secret format.");
  }
  const [, saltB, ivB, tagB, ctB] = parts;
  const decipher = crypto.createDecipheriv("aes-256-gcm", deriveKey(Buffer.from(saltB, "base64")), Buffer.from(ivB, "base64"));
  decipher.setAuthTag(Buffer.from(tagB, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB, "base64")), decipher.final()]).toString("utf8");
}

/** Whether a string looks like one of our obfuscated blobs. */
export function isObfuscatedSecret(s: unknown): boolean {
  return typeof s === "string" && s.startsWith(`${VERSION}.`) && s.split(".").length === 5;
}
