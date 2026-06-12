import { AppError } from "../core/errors";
import { wireEnabled, emitWire, safeUrl } from "../core/wireLog";

/**
 * Teams delivery via an **Incoming Webhook** (ADR-0025 amendment) — the
 * no-admin-consent alternative to the Graph `Chat.ReadWrite` path. A channel
 * owner creates the webhook (Teams channel → … → Connectors → Incoming
 * Webhook, or a Power Automate "Workflows" webhook); the extension POSTs a
 * card to that URL. No app registration, no tenant approval, no Graph token.
 *
 * Trade-offs vs. Graph: a webhook targets a CHANNEL, not a 1:1/group chat,
 * and cannot @-mention or message individuals — recipients become a "For:"
 * line in the card. The URL embeds a secret token, so it lives in the OS
 * keychain (never settings/logs).
 *
 * Pure payload construction + a single POST helper; both classic O365
 * MessageCard connectors and Workflows webhooks accept the MessageCard body.
 */

export interface TeamsWebhook {
  /** Channel-friendly label the user assigns (e.g. "IT Ops · Alerts"). */
  name: string;
  /** Full webhook URL incl. token — keychain only. */
  url: string;
}

const WEBHOOK_HOST_RE =
  /(^|\.)(webhook\.office\.com|outlook\.office\.com|office\.com|logic\.azure\.com|powerplatform\.com|azure-api\.net)$/i;

/** Validate a pasted webhook URL: https, a known Teams/Power-Automate host,
 *  and a non-trivial path (the token lives there). Permissive on host so
 *  sovereign/!commercial clouds still pass with a warning, strict on https. */
export function teamsWebhookUrlIssue(url: string): string | undefined {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return "Enter the full https:// webhook URL copied from the Teams channel connector.";
  }
  if (u.protocol !== "https:") return "Webhook URLs must be https://.";
  if (!u.pathname || u.pathname === "/") {
    return "That URL has no path — copy the COMPLETE webhook URL (it includes a long token).";
  }
  return undefined;
}

/** True for hosts we recognize as Teams/Power-Automate webhooks; callers may
 *  warn (not block) on false so unusual tenants still work. */
export function isKnownWebhookHost(url: string): boolean {
  try {
    return WEBHOOK_HOST_RE.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

export interface WebhookCardInput {
  body: string;
  /** Optional heading (Outlook-style subject / a short title). */
  title?: string;
  /** Informational recipients — a webhook can't address individuals. */
  to?: string[];
  /** "agent" adds an "assistant-prepared" note in the card. */
  origin?: "user" | "agent";
}

/** Build a MessageCard accepted by classic Incoming Webhook connectors AND
 *  Workflows webhooks. Plain text body; recipients/origin as card facts. */
export function buildTeamsWebhookPayload(input: WebhookCardInput): Record<string, unknown> {
  const facts: Array<{ name: string; value: string }> = [];
  if (input.to && input.to.length > 0) facts.push({ name: "For", value: input.to.join(", ") });
  if (input.origin === "agent") facts.push({ name: "Prepared by", value: "@sharepoint assistant (review before relying on it)" });
  const section: Record<string, unknown> = {
    text: input.body,
    ...(facts.length > 0 ? { facts } : {}),
  };
  return {
    "@type": "MessageCard",
    "@context": "https://schema.org/extensions",
    summary: input.title?.trim() || "Message from AI SharePoint",
    ...(input.title?.trim() ? { title: input.title.trim() } : {}),
    // Plain text fallback for clients that ignore sections.
    text: facts.length === 0 ? input.body : undefined,
    sections: [section],
  };
}

/** POST the card to the webhook. Classic connectors answer "1" (text);
 *  Workflows answer 200/202 — both are success. Failures carry the body so
 *  a revoked/wrong URL is diagnosable. Wire-logged (URL safe-masked). */
export async function postTeamsWebhook(
  url: string,
  payload: Record<string, unknown>,
  timeoutMs = 20_000,
): Promise<void> {
  const started = Date.now();
  if (wireEnabled()) emitWire("teams-webhook", "→", `POST ${safeUrl(url)}`);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    emitWire("teams-webhook", "✗", `POST ${safeUrl(url)} — ${err instanceof Error ? err.message : String(err)}`);
    throw new AppError(
      `Teams webhook unreachable: ${err instanceof Error ? err.message : String(err)}`,
      "network",
      "Check the webhook URL and your network. The channel owner can re-copy the URL from the channel connector if it was rotated.",
    );
  }
  const text = await res.text().catch(() => "");
  emitWire("teams-webhook", res.ok ? "←" : "✗", `POST ${safeUrl(url)} ${res.status} (${Date.now() - started}ms)`);
  if (!res.ok) {
    throw new AppError(
      `Teams webhook rejected the message (${res.status}): ${text.slice(0, 200)}`,
      res.status === 404 || res.status === 410 ? "config" : "unknown",
      res.status === 404 || res.status === 410
        ? "The webhook no longer exists — it was removed or rotated in the channel. Ask the channel owner for a fresh URL and reconfigure it."
        : "The channel connector rejected the post. Confirm the webhook is still enabled in the Teams channel.",
    );
  }
}
