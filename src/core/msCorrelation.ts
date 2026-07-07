/**
 * Microsoft request-correlation identifiers (supportability).
 *
 * Every Graph / SharePoint REST response carries `request-id` and
 * `client-request-id` headers — opaque server-side trace tokens that Microsoft
 * support uses to locate a specific failed call in their logs. They are NOT
 * secret and NOT user-identifying, but they were being dropped, so a failure
 * reported to support ("Graph returned 403") couldn't be traced. This captures
 * them in a labeled, redaction-exempt form (see redaction.ts) so they survive
 * into error reports and the diagnostics bundle. Pure + unit-tested.
 */

interface HeaderBag {
  get(name: string): string | null;
}

/** A GUID-shaped value, so we never echo an arbitrary attacker-controlled
 *  header back into an error message. */
const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** The ` [request-id=… client-request-id=…]` suffix for a failed MS response,
 *  or "" when neither header is present/valid. Keys use the exact `request-id=`
 *  prefix the redactor exempts. */
export function msCorrelationSuffix(headers: HeaderBag): string {
  const parts: string[] = [];
  const reqId = headers.get("request-id");
  const clientReqId = headers.get("client-request-id");
  if (reqId && GUID.test(reqId)) parts.push(`request-id=${reqId}`);
  // Only add the client id when it differs (Graph often echoes the same value).
  if (clientReqId && GUID.test(clientReqId) && clientReqId !== reqId) {
    parts.push(`client-request-id=${clientReqId}`);
  }
  return parts.length ? ` [${parts.join(" ")}]` : "";
}
