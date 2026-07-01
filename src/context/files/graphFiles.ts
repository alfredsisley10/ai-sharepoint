/**
 * Pure helpers for OneDrive / shared SharePoint file context via Microsoft Graph.
 * Resolving a sharing link and mapping driveItem JSON to a stable reference are
 * dependency-free and unit-tested; the authenticated Graph calls live on
 * CommsClient (the M365 Graph client), reusing the same sign-in as mail/sites.
 */

/** Encode a sharing URL as a Graph `shares` id: `u!` + base64url(url). */
export function encodeSharingUrl(url: string): string {
  const b64 = Buffer.from(url.trim(), "utf8").toString("base64");
  return "u!" + b64.replace(/=+$/, "").replace(/\//g, "_").replace(/\+/g, "-");
}

export interface DriveItemRef {
  driveId: string;
  itemId: string;
  name: string;
  webUrl?: string;
}

interface RawDriveItem {
  id?: string;
  name?: string;
  webUrl?: string;
  parentReference?: { driveId?: string };
  remoteItem?: { id?: string; name?: string; webUrl?: string; parentReference?: { driveId?: string } };
}

/** Map a Graph driveItem (from `/shares/{id}/driveItem` or `/me/drive/sharedWithMe`)
 *  to a stable {driveId,itemId,name}. `sharedWithMe` nests the real item under
 *  `remoteItem`, so prefer that when present. Returns undefined if incomplete. */
export function driveItemToRef(item: RawDriveItem | undefined): DriveItemRef | undefined {
  if (!item) return undefined;
  const remote = item.remoteItem;
  const driveId = remote?.parentReference?.driveId ?? item.parentReference?.driveId;
  const itemId = remote?.id ?? item.id;
  const name = item.name ?? remote?.name;
  const webUrl = item.webUrl ?? remote?.webUrl;
  if (!driveId || !itemId || !name) return undefined;
  return { driveId, itemId, name, ...(webUrl ? { webUrl } : {}) };
}
