import {
  ContextSource,
  ContextCredential,
  ContextSearchHit,
  ContextItem,
  ReadCaps,
} from "../types";
import { fetchJson, htmlToText } from "../http";

/**
 * Confluence adapter — Cloud (…atlassian.net/wiki, Basic email+API token)
 * and Data Center (any base URL, PAT Bearer or Basic). Read-only REST,
 * ADR-0012 caps applied to every call.
 */

const enc = encodeURIComponent;

interface SearchResponse {
  results: Array<{
    id?: string;
    title?: string;
    type?: string;
    _links?: { webui?: string };
    excerpt?: string;
    content?: { id?: string; title?: string; _links?: { webui?: string } };
    space?: { key?: string };
  }>;
}

function webUrl(source: ContextSource, webui?: string): string {
  if (!webui) return source.baseUrl;
  return `${source.baseUrl.replace(/\/$/, "")}${webui}`;
}

/** Single deliberate verification read (ADR-0009 verify-on-connect). */
export async function verifyConfluence(
  source: Pick<ContextSource, "baseUrl">,
  credential: ContextCredential,
  caps: ReadCaps,
): Promise<{ account: string }> {
  const me = await fetchJson<{ username?: string; displayName?: string; publicName?: string }>(
    `${source.baseUrl.replace(/\/$/, "")}/rest/api/user/current`,
    credential,
    caps.timeoutMs,
  );
  return { account: me.username ?? me.publicName ?? me.displayName ?? "verified" };
}

/** CQL search (raw CQL or free text wrapped in siteSearch). */
export async function searchConfluence(
  source: ContextSource,
  credential: ContextCredential,
  query: string,
  caps: ReadCaps,
): Promise<ContextSearchHit[]> {
  const looksLikeCql = /[=~]|\border by\b/i.test(query);
  const cql = looksLikeCql ? query : `siteSearch ~ "${query.replace(/"/g, '\\"')}"`;
  const res = await fetchJson<SearchResponse>(
    `${source.baseUrl.replace(/\/$/, "")}/rest/api/search?cql=${enc(cql)}&limit=${caps.maxResults}`,
    credential,
    caps.timeoutMs,
  );
  return res.results.slice(0, caps.maxResults).map((r) => ({
    title: r.content?.title ?? r.title ?? "(untitled)",
    url: webUrl(source, r.content?._links?.webui ?? r._links?.webui),
    excerpt: r.excerpt ? htmlToText(r.excerpt, 300) : undefined,
    meta: {
      type: r.type ?? "content",
      ...(r.space?.key ? { space: r.space.key } : {}),
      ...(r.content?.id ?? r.id ? { id: String(r.content?.id ?? r.id) } : {}),
    },
  }));
}

/** Fetch one page with plain-text body (storage format, HTML-stripped). */
export async function getConfluencePage(
  source: ContextSource,
  credential: ContextCredential,
  pageId: string,
  caps: ReadCaps,
): Promise<ContextItem> {
  const page = await fetchJson<{
    title?: string;
    body?: { storage?: { value?: string } };
    space?: { key?: string };
    _links?: { webui?: string };
    version?: { number?: number };
  }>(
    `${source.baseUrl.replace(/\/$/, "")}/rest/api/content/${enc(pageId)}?expand=body.storage,space,version`,
    credential,
    caps.timeoutMs,
  );
  return {
    title: page.title ?? "(untitled)",
    url: webUrl(source, page._links?.webui),
    body: htmlToText(page.body?.storage?.value ?? "", caps.maxBodyChars),
    meta: {
      ...(page.space?.key ? { space: page.space.key } : {}),
      ...(page.version?.number ? { version: String(page.version.number) } : {}),
    },
  };
}

export interface SpaceInfo {
  key: string;
  name: string;
  url: string;
}

/** Global spaces, capped — feeds the guided Browse & Bookmark picker. */
export async function listConfluenceSpaces(
  source: ContextSource,
  credential: ContextCredential,
  caps: ReadCaps,
): Promise<SpaceInfo[]> {
  const res = await fetchJson<{
    results?: Array<{ key?: string; name?: string; _links?: { webui?: string } }>;
  }>(
    `${source.baseUrl.replace(/\/$/, "")}/rest/api/space?type=global&limit=${caps.maxResults}`,
    credential,
    caps.timeoutMs,
  );
  return (res.results ?? [])
    .filter((sp) => sp.key)
    .map((sp) => ({
      key: sp.key!,
      name: sp.name ?? sp.key!,
      url: webUrl(source, sp._links?.webui),
    }));
}
