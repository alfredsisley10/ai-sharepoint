/** Pure path policy for agent-written site spec files (ADR-0021 amendment):
 *  only lists/<name>.json and pages/<name>.json, relative, forward-slash,
 *  no traversal, no hidden files. Kept vscode-free for unit testing. */
const SITE_FILE_RE = /^(lists|pages)\/[A-Za-z0-9][A-Za-z0-9._ -]*\.json$/;

export function validateSiteFilePath(p: string): string | undefined {
  if (p.includes("..") || p.startsWith("/") || p.includes("\\")) {
    return `"${p}" — paths must be relative, forward-slash, no traversal.`;
  }
  if (!SITE_FILE_RE.test(p)) {
    return `"${p}" — only lists/<name>.json and pages/<name>.json are writable.`;
  }
  return undefined;
}
