/**
 * Release expiry — time-limited builds (white-label release control).
 *
 * A white-labeled VSIX can carry a `release` manifest in its package.json with an
 * `expiresAt` date. Past that date the extension's AI surfaces (the @chat
 * participant and the language-model tools) refuse with an upgrade prompt, so a
 * distributor can guarantee users move to newer releases on a cadence. The
 * standard build ships without an `expiresAt` and never expires.
 *
 * Everything here is pure and unit-tested except the tiny runtime holder, which
 * is set once at activation and read by the gated surfaces. Evaluation FAILS
 * OPEN on missing/malformed data — a bad date never bricks the extension.
 */

export interface ReleaseManifest {
  /** "standard" | "whitelabel" (informational). */
  channel?: string;
  /** ISO date the build stops working. Absent ⇒ never expires. */
  expiresAt?: string;
  /** ISO timestamp the build/rebrand happened (informational). */
  builtAt?: string;
  /** Validity window used to derive expiresAt (informational). */
  validityDays?: number;
  /** Where to obtain a newer build — shown in the upgrade prompt. */
  upgradeUrl?: string;
  /** Product (white-label display) name, for messaging. */
  productName?: string;
}

export type ExpiryState = "ok" | "warn" | "expired";

export interface ExpiryStatus {
  state: ExpiryState;
  expiresAt?: string;
  /** Whole days remaining; negative once expired. */
  daysLeft?: number;
  /** Human message for warn/expired states. */
  message?: string;
  upgradeUrl?: string;
  productName?: string;
}

export const DEFAULT_WARN_DAYS = 14;
export const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** ISO expiry = builtAt + validityDays (whole days). */
export function computeExpiry(builtAtMs: number, validityDays: number): string {
  return new Date(builtAtMs + Math.round(validityDays) * MS_PER_DAY).toISOString();
}

/** YYYY-MM-DD for user-facing messages. */
function dateOnly(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * Evaluate a release manifest against the current time. Pure. Returns "ok" when
 * there is no expiry, the date is malformed, or expiry is far off; "warn" inside
 * the warning window; "expired" once past the date.
 */
export function evaluateExpiry(
  manifest: ReleaseManifest | undefined,
  nowMs: number,
  warnDays = DEFAULT_WARN_DAYS,
): ExpiryStatus {
  const expiresAt = manifest?.expiresAt;
  if (!expiresAt) return { state: "ok" };
  const expMs = Date.parse(expiresAt);
  if (Number.isNaN(expMs)) return { state: "ok" }; // fail open on bad data — never brick
  const product = manifest?.productName || "This build";
  const upgradeUrl = manifest?.upgradeUrl;
  const productName = manifest?.productName;
  const daysLeft = Math.ceil((expMs - nowMs) / MS_PER_DAY);
  const getIt = upgradeUrl ? ` Get the latest from ${upgradeUrl}.` : "";
  if (nowMs >= expMs) {
    return {
      state: "expired",
      expiresAt,
      daysLeft,
      upgradeUrl,
      productName,
      message: `${product} expired on ${dateOnly(expiresAt)}. Update to the latest release to continue.${getIt}`,
    };
  }
  if (daysLeft <= warnDays) {
    return {
      state: "warn",
      expiresAt,
      daysLeft,
      upgradeUrl,
      productName,
      message: `${product} expires in ${daysLeft} day${daysLeft === 1 ? "" : "s"} (on ${dateOnly(expiresAt)}). Update to the latest release soon.${getIt}`,
    };
  }
  return { state: "ok", expiresAt, daysLeft, productName };
}

// --- runtime holder: set once at activation, read by gated surfaces ---------
let current: ExpiryStatus = { state: "ok" };

export function setReleaseStatus(status: ExpiryStatus): void {
  current = status;
}

export function releaseStatus(): ExpiryStatus {
  return current;
}

export function releaseExpired(): boolean {
  return current.state === "expired";
}

/** Message the AI surfaces return when the build has expired. */
export function expiredNotice(): string {
  return (
    current.message ?? "This build has expired — update to the latest release to continue."
  );
}
