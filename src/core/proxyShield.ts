/**
 * Proxy-block avoidance (#4). Corporate web proxies / DLP appliances routinely
 * block LLM requests or responses that merely CONTAIN a word they deem
 * sensitive — a false positive on ordinary business vocabulary — and the block
 * surfaces as a network-level failure (the request never completes), not a
 * helpful "content blocked" message. Pilot users lost interactions this way.
 *
 * This module is the pure core of the defence: maintain a list of words/phrases
 * to avoid, and either (a) DEFANG the outgoing prompt (insert an invisible
 * zero-width space inside each term so the proxy's literal/regex match fails
 * while the model still reads it), or (b) WARN the user, plus learn over time
 * that repeated network failures are most likely proxy content blocks. All pure
 * and unit-tested; the stateful store + chat wiring live elsewhere.
 */

export type ProxyMode = "off" | "warn" | "defang";

/** Zero-width space — invisible to humans, breaks a literal/regex match. */
export const ZERO_WIDTH = "​";

/** Trim, drop empties, de-duplicate (case-insensitive), preserve first casing. */
export function normalizeTerms(raw: Iterable<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of raw) {
    const t = typeof r === "string" ? r.trim() : "";
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/** Match a term as a whole word/phrase (word boundaries only where the term
 *  edge is itself a word char, so "ssn" doesn't fire inside "lesson"). */
function termRegex(term: string): RegExp {
  const esc = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const left = /^\w/.test(term) ? "\\b" : "";
  const right = /\w$/.test(term) ? "\\b" : "";
  return new RegExp(`${left}${esc}${right}`, "gi");
}

/** Distinct configured terms that appear in `text` (original casing). */
export function scanForTerms(text: string, terms: string[]): string[] {
  return normalizeTerms(terms).filter((term) => termRegex(term).test(text));
}

/**
 * Insert a zero-width space inside each occurrence of every term so a proxy's
 * literal/regex content match fails, while the text stays human- and
 * model-readable. Returns the rewritten text and which terms were hit.
 */
export function defang(text: string, terms: string[]): { text: string; hit: string[] } {
  let out = text;
  const hit: string[] = [];
  for (const term of normalizeTerms(terms)) {
    let matched = false;
    out = out.replace(termRegex(term), (m) => {
      matched = true;
      return m.length <= 1 ? `${m}${ZERO_WIDTH}` : `${m[0]}${ZERO_WIDTH}${m.slice(1)}`;
    });
    if (matched) hit.push(term);
  }
  return { text: out, hit };
}

/**
 * System-prompt note. In defang mode WITH terms it lists them so the model
 * avoids emitting them in its reply (the whole prompt is defanged before
 * sending, so the listing itself can't trigger the proxy). Otherwise a generic
 * note — never list raw terms into a prompt that travels through the proxy.
 */
export function buildProxyNudge(terms: string[], mode: ProxyMode): string {
  if (mode === "off") return "";
  const t = normalizeTerms(terms);
  if (mode === "defang" && t.length > 0) {
    return `Network-proxy safety: this organization's proxy blocks messages containing certain words. Do NOT use these exact words/phrases verbatim in your reply — rephrase around them or refer to them indirectly: ${t.join(", ")}.`;
  }
  return "Network-proxy note: if a reply ever fails to send with a network error, this organization's proxy may be blocking specific words in the content — prefer plain business language and avoid niche or sensitive-sounding jargon.";
}

/**
 * "Learn over time" advice: the more chat requests fail at the NETWORK layer,
 * the more confidently we attribute it to the corporate proxy blocking content
 * rather than connectivity. Pure — the caller supplies the running count.
 */
export function proxyBlockAdvice(networkFailures: number): string | undefined {
  if (networkFailures >= 3) {
    return `This is network failure #${networkFailures} for chat in this workspace. Repeated network-level failures are very often a **corporate proxy blocking the message content** (a false positive on a word it deems sensitive), not a connectivity problem. Add the likely trigger word(s) to the avoid-list ("AI SharePoint: Manage Proxy Avoid-List") and set \`aiSharePoint.proxy.mode\` to \`defang\` so future messages slip past automatically.`;
  }
  if (networkFailures >= 1) {
    return `If this recurs, a corporate proxy may be blocking specific words in the request or reply (not a connectivity issue). Maintain a words-to-avoid list via "AI SharePoint: Manage Proxy Avoid-List" and enable \`aiSharePoint.proxy.mode: defang\`.`;
  }
  return undefined;
}
