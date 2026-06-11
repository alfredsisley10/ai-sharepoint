/**
 * Redaction layer (PLAN §6, ADR-0018).
 *
 * Every string that can reach a log line, an error notification, an error
 * report, or a diagnostics bundle passes through here first. Patterns are
 * deliberately aggressive: in an enterprise environment a false positive
 * (over-redacting) is cheap, a false negative (leaking a token or a tenant
 * identifier) is not.
 *
 * This module is pure (no vscode import) so it is unit-testable.
 */

const PATTERNS: Array<{ re: RegExp; replace: string }> = [
  // JSON Web Tokens (two- or three-segment base64url starting with eyJ).
  {
    re: /\beyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{4,}){1,2}\b/g,
    replace: "[redacted:jwt]",
  },
  // Authorization headers and bearer/basic credentials wherever they appear.
  {
    re: /\b(authorization\b["':\s]*)?(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    replace: "$2 [redacted]",
  },
  // PEM blocks (certificates / private keys).
  {
    re: /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g,
    replace: "[redacted:pem]",
  },
  // key=value style secrets in URLs / connection strings / error bodies.
  {
    re: /\b(client_secret|password|pwd|secret|api[_-]?key|sig|signature|access_token|refresh_token|id_token|code)=([^&\s"']{4,})/gi,
    replace: "$1=[redacted]",
  },
  // Email addresses / UPNs.
  {
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    replace: "[redacted:email]",
  },
  // GUIDs (tenant ids, site ids, request ids). Full redaction in logs;
  // diagnostics bundles use salted short-hashes instead (anonymize.ts).
  {
    re: /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g,
    replace: "[redacted:guid]",
  },
  // SharePoint tenant hostnames across commercial + sovereign clouds.
  {
    re: /\b[a-z0-9-]+\.sharepoint(?:-df)?\.(com|us|cn|de)\b/gi,
    replace: "[redacted:tenant].sharepoint.$1",
  },
  // Entra tenant default domains.
  {
    re: /\b[a-z0-9-]+\.onmicrosoft\.(com|us|cn|de)\b/gi,
    replace: "[redacted:tenant].onmicrosoft.$1",
  },
  // Non-loopback IPv4 addresses.
  {
    re: /\b(?!127\.)(?:\d{1,3}\.){3}\d{1,3}\b/g,
    replace: "[redacted:ip]",
  },
  // Local user-profile paths (Windows and POSIX) — usernames are PII.
  {
    re: /(?:[A-Za-z]:\\Users\\|\/home\/|\/Users\/)[^\\/\s"',)]+/g,
    replace: "[redacted:userpath]",
  },
];

/** Redact all known secret/PII shapes from arbitrary text. */
export function redactText(text: string): string {
  let out = text;
  for (const { re, replace } of PATTERNS) {
    out = out.replace(re, replace);
  }
  return out;
}

/** A safe-to-log/-export view of an error: name, redacted message, redacted stack. */
export interface SafeError {
  name: string;
  message: string;
  stack?: string;
}

/**
 * Convert an unknown thrown value into a redacted, path-stripped form.
 * Stack frames keep file basenames + line numbers only — enough to debug,
 * not enough to identify a user or machine.
 */
export function redactError(err: unknown): SafeError {
  if (!(err instanceof Error)) {
    return { name: "Error", message: redactText(String(err)) };
  }
  const stack = err.stack
    ? redactText(stripStackPaths(err.stack))
    : undefined;
  return {
    name: err.name || "Error",
    message: redactText(err.message),
    stack,
  };
}

/** Reduce absolute paths in stack traces to basenames (keeps line:col). */
export function stripStackPaths(stack: string): string {
  // Matches windows (C:\a\b\file.js) and posix (/a/b/file.js) path segments
  // inside stack frames and keeps only the final component.
  return stack.replace(
    /(?:[A-Za-z]:)?(?:[\\/][^\\/\s():]+)+[\\/]([^\\/\s():]+)/g,
    "…/$1",
  );
}
