import { AppError } from "../core/errors";
import { detectProxyFromError } from "../core/networkDiagnostics";

/**
 * Turn an MSAL sign-in failure into actionable guidance when a corporate
 * proxy / SSL-inspection appliance / web content filter is the cause.
 *
 * MSAL token + metadata endpoints (login.microsoftonline.com, the authority's
 * OIDC discovery) are ordinary HTTPS, so the full HTTP-oriented remediation
 * from the shared detector applies — unlike raw-socket DB/LDAP, where only the
 * TLS-interception case fits. The opaque errors MSAL surfaces ("fetch failed",
 * a bare network throw) hide the real reason (the TLS errno lives in
 * `err.cause`), which is exactly what makes sign-in failures so hard to triage
 * on locked-down networks.
 *
 * Returns the original error unchanged when no filtering fingerprint is present
 * (so genuine auth errors, timeouts, and state mismatches keep their meaning),
 * and passes AppErrors through untouched — the caller already classified those.
 */
export function describeSignInFailure(err: unknown, authority: string): unknown {
  if (err instanceof AppError) return err;
  const diag = detectProxyFromError(err, authority);
  if (diag) {
    return new AppError(
      `Sign-in couldn't reach Microsoft: ${diag.message}\n\n${diag.summary}`,
      diag.kind === "tls-inspection" ? "config" : "network",
      diag.summary,
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}
