import { ErrorReport } from "./errorReports";
import { TelemetryEvent } from "./telemetry";

/**
 * Diagnostics-bundle assembly (ADR-0018). Pure module: the extension gathers
 * inputs (already anonymized/redacted at capture time), this builds the
 * portable JSON + human-readable Markdown, and `scanForLeaks` is the final
 * defense-in-depth gate — if anything secret-shaped survived the earlier
 * layers, the export refuses to write.
 */

export type BundleScope = "full" | "usage" | "errors";

export interface BundleEnvironment {
  extensionVersion: string;
  vscodeVersion: string;
  platform: string; // e.g. "linux-x64"
  uiKind: string; // "desktop" | "web"
  remoteName?: string;
  appHost?: string;
}

export interface BundleUsage {
  monthRequests: number;
  monthFailures: number;
  todayRequests: number;
  byModel: Array<{ key: string; requests: number; inputTokens: number; outputTokens: number }>;
  byLabel: Array<{ key: string; requests: number }>;
  daily: Array<{ day: string; requests: number; failures: number }>;
}

export interface BundleSiteSummary {
  /** Salted-hash tenant, e.g. anon-1a2b3c4d5e.sharepoint.com */
  tenant: string;
  role: string;
  authProviderId: string;
  verified: boolean;
}

export interface DiagnosticsBundle {
  $schema: "ai-sharepoint/diagnostics-bundle/v1";
  generatedAt: string;
  scope: BundleScope;
  anonymousInstallId: string;
  notice: string;
  environment: BundleEnvironment;
  settings: Record<string, string | number | boolean | string[]>;
  sites?: BundleSiteSummary[];
  usage?: BundleUsage;
  telemetry?: {
    totalsByEvent: Record<string, number>;
    daysCovered: number;
    recentEvents: TelemetryEvent[];
  };
  errors?: ErrorReport[];
}

export const BUNDLE_NOTICE =
  "Generated locally by the AI SharePoint extension at the user's explicit request. " +
  "Contents are anonymized: identifiers are salted hashes, messages and stacks are redacted. " +
  "No prompts, responses, site content, credentials, or personal identifiers are included.";

export interface BundleInputs {
  generatedAt: string;
  scope: BundleScope;
  anonymousInstallId: string;
  environment: BundleEnvironment;
  settings: Record<string, string | number | boolean | string[]>;
  sites: BundleSiteSummary[];
  usage: BundleUsage;
  telemetry: {
    totalsByEvent: Record<string, number>;
    daysCovered: number;
    recentEvents: TelemetryEvent[];
  };
  errors: ErrorReport[];
}

export function buildBundle(input: BundleInputs): DiagnosticsBundle {
  const bundle: DiagnosticsBundle = {
    $schema: "ai-sharepoint/diagnostics-bundle/v1",
    generatedAt: input.generatedAt,
    scope: input.scope,
    anonymousInstallId: input.anonymousInstallId,
    notice: BUNDLE_NOTICE,
    environment: input.environment,
    settings: input.settings,
  };
  if (input.scope !== "errors") {
    bundle.usage = input.usage;
    bundle.telemetry = input.telemetry;
    bundle.sites = input.sites;
  }
  if (input.scope !== "usage") {
    bundle.errors = input.errors;
    bundle.sites ??= input.sites;
  }
  return bundle;
}

/** Human-readable companion document for the same bundle. */
export function bundleToMarkdown(b: DiagnosticsBundle): string {
  const lines: string[] = [];
  lines.push(`# AI SharePoint — diagnostics bundle`);
  lines.push("");
  lines.push(`> ${b.notice}`);
  lines.push("");
  lines.push(`| | |`);
  lines.push(`|---|---|`);
  lines.push(`| Generated | ${b.generatedAt} |`);
  lines.push(`| Scope | ${b.scope} |`);
  lines.push(`| Anonymous install ID | \`${b.anonymousInstallId}\` |`);
  lines.push(`| Extension | ${b.environment.extensionVersion} |`);
  lines.push(
    `| VS Code | ${b.environment.vscodeVersion} (${b.environment.uiKind}${b.environment.remoteName ? `, remote: ${b.environment.remoteName}` : ""}) |`,
  );
  lines.push(`| Platform | ${b.environment.platform} |`);
  lines.push("");

  lines.push(`## Settings (non-default, anonymized)`);
  const settingKeys = Object.keys(b.settings);
  if (settingKeys.length === 0) {
    lines.push("_All settings at defaults._");
  } else {
    lines.push(`| Setting | Value |`);
    lines.push(`|---|---|`);
    for (const k of settingKeys) {
      lines.push(`| ${k} | \`${JSON.stringify(b.settings[k])}\` |`);
    }
  }
  lines.push("");

  if (b.sites) {
    lines.push(`## Connections (${b.sites.length})`);
    if (b.sites.length > 0) {
      lines.push(`| Tenant (anonymized) | Role | Auth method | Verified |`);
      lines.push(`|---|---|---|---|`);
      for (const s of b.sites) {
        lines.push(
          `| ${s.tenant} | ${s.role} | ${s.authProviderId} | ${s.verified ? "yes" : "no"} |`,
        );
      }
    } else {
      lines.push("_No connections configured._");
    }
    lines.push("");
  }

  if (b.usage) {
    const u = b.usage;
    lines.push(`## Copilot activity (this extension's local request counts)`);
    lines.push("");
    lines.push(
      `**This month:** ${u.monthRequests} requests, ${u.monthFailures} failed. **Today:** ${u.todayRequests} requests.`,
    );
    lines.push("");
    if (u.byModel.length > 0) {
      lines.push(`| Model | Requests | Tokens in/out |`);
      lines.push(`|---|---|---|`);
      for (const m of u.byModel) {
        lines.push(
          `| ${m.key} | ${m.requests} | ${m.inputTokens}/${m.outputTokens} |`,
        );
      }
      lines.push("");
    }
    if (u.byLabel.length > 0) {
      lines.push(`| Task | Requests |`);
      lines.push(`|---|---|`);
      for (const l of u.byLabel) {
        lines.push(`| ${l.key} | ${l.requests} |`);
      }
      lines.push("");
    }
  }

  if (b.telemetry) {
    lines.push(`## Feature usage (local counters, ${b.telemetry.daysCovered} day(s))`);
    const totals = Object.entries(b.telemetry.totalsByEvent).sort(
      (a, c) => c[1] - a[1],
    );
    if (totals.length === 0) {
      lines.push("_No usage recorded (capture may be disabled)._");
    } else {
      lines.push(`| Event | Count |`);
      lines.push(`|---|---|`);
      for (const [name, n] of totals) {
        lines.push(`| ${name} | ${n} |`);
      }
    }
    lines.push("");
  }

  if (b.errors) {
    lines.push(`## Error reports (${b.errors.length})`);
    if (b.errors.length === 0) {
      lines.push("_No errors recorded._");
    }
    for (const e of b.errors) {
      lines.push("");
      lines.push(
        `### \`${e.code}\` in ${e.context} — ×${e.count} (last ${e.lastAt})`,
      );
      lines.push("");
      lines.push(`> ${e.name}: ${e.message}`);
      if (e.stack) {
        lines.push("");
        lines.push("```");
        lines.push(e.stack);
        lines.push("```");
      }
    }
    lines.push("");
  }

  lines.push("---");
  lines.push(
    "_Review this file before sharing. The matching `.json` file carries the same data for machine processing._",
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Leak scan — the last gate before anything is written to disk.
// ---------------------------------------------------------------------------

export interface LeakFinding {
  pattern: string;
  severity: "block" | "warn";
  count: number;
  sample: string;
}

interface LeakPattern {
  name: string;
  severity: "block" | "warn";
  re: RegExp;
  /** Code-level exemption for matches that are actually safe. */
  exempt?: (match: string, text: string, index: number) => boolean;
}

const LEAK_PATTERNS: LeakPattern[] = [
  { name: "jwt", severity: "block", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g },
  { name: "pem-block", severity: "block", re: /-----BEGIN [A-Z ]+-----/g },
  { name: "bearer-credential", severity: "block", re: /\b[Bb]earer\s+[A-Za-z0-9._~+/=-]{8,}/g },
  {
    name: "secret-assignment",
    severity: "block",
    // Key list kept a superset of redaction.ts's key=value pattern so this
    // last gate is never weaker than the first one. "code" is deliberately
    // absent here — bundles legitimately contain `"code":"graph.forbidden"`
    // fields — and is covered in querystring form by authcode-in-url below.
    // Tolerates JSON string escaping (\" around values) between key and value.
    re: /\b(client_secret|password|pwd|secret|api[_-]?key|sig|signature|access_token|refresh_token|id_token)\\?["']?\s*[:=]\s*[\\"']*(?!\[redacted)[^\s\\"',}{]{6,}/gi,
  },
  {
    name: "authcode-in-url",
    severity: "block",
    re: /[?&](code|access_token|id_token|sig)=(?!\[redacted)[^\s\\&"',]{6,}/gi,
  },
  { name: "email-address", severity: "block", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  {
    name: "raw-tenant-host",
    severity: "block",
    re: /\b[a-z0-9-]+\.sharepoint(?:-df)?\.(com|us|cn|de)\b/gi,
    // Salted pseudonyms ("anon-1a2b3c4d5e.sharepoint.com") are the *output* of
    // anonymization. A regex \b can start matching inside the token, so the
    // exemption checks the preceding text instead.
    exempt: (match, text, index) =>
      match.toLowerCase().startsWith("anon-") ||
      text.slice(Math.max(0, index - 5), index).toLowerCase() === "anon-",
  },
  { name: "guid", severity: "warn", re: /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g },
  { name: "ipv4-address", severity: "warn", re: /\b(?!127\.)(?:\d{1,3}\.){3}\d{1,3}\b/g },
];

/**
 * Scan serialized bundle text for anything secret-shaped that survived the
 * capture-time anonymization. "block" findings must abort the export; "warn"
 * findings are surfaced for the user to judge (e.g. a GUID inside an error
 * string that classification kept).
 *
 * The anonymous install id (a GUID by construction) is exempted by callers
 * passing it via `allowlist`.
 */
export function scanForLeaks(text: string, allowlist: string[] = []): LeakFinding[] {
  const findings: LeakFinding[] = [];
  for (const { name, severity, re, exempt } of LEAK_PATTERNS) {
    const matches = [...text.matchAll(re)]
      .filter((m) => !(exempt?.(m[0], text, m.index ?? 0) ?? false))
      .map((m) => m[0])
      .filter((m) => !allowlist.some((a) => a && m.includes(a)));
    if (matches.length > 0) {
      findings.push({
        pattern: name,
        severity,
        count: matches.length,
        sample: matches[0].slice(0, 24) + (matches[0].length > 24 ? "…" : ""),
      });
    }
  }
  return findings;
}
