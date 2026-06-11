// PLAN §6 quality gate: scan tracked files for secret-shaped content before
// it can reach the public repo. Zero-dependency by design (runs in air-gapped
// CI). Exits non-zero on findings.
"use strict";
const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");

const PATTERNS = [
  { name: "private key block", re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "JWT", re: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/ },
  { name: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { name: "Azure client secret-ish", re: /\bclient_secret\s*[:=]\s*["'][^"']{12,}["']/i },
  { name: "password assignment", re: /\bpassword\s*[:=]\s*["'][^"'{$%][^"']{7,}["']/i },
  { name: "connection string with creds", re: /:\/\/[^\s/:@"']+:[^\s/:@"']+@[\w.-]+/ },
  { name: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/ },
];

// Files where pattern *definitions* legitimately live.
const ALLOW = new Set([
  "scripts/scan-secrets.js",
  "src/core/redaction.ts",
  "src/diagnostics/bundle.ts",
  "test/redaction.test.ts",
  "test/bundle.test.ts",
]);

const files = execSync("git ls-files", { cwd: root, encoding: "utf8" })
  .split("\n")
  .filter(Boolean)
  .filter((f) => !f.endsWith(".png"));

let findings = 0;
for (const file of files) {
  if (ALLOW.has(file)) continue;
  const text = fs.readFileSync(path.join(root, file), "utf8");
  for (const { name, re } of PATTERNS) {
    const m = text.match(re);
    if (m) {
      findings++;
      console.error(`✗ ${file}: ${name} → ${m[0].slice(0, 32)}…`);
    }
  }
}

if (findings > 0) {
  console.error(`Secret scan FAILED with ${findings} finding(s).`);
  process.exit(1);
}
console.log(`✓ Secret scan passed (${files.length} tracked files).`);
