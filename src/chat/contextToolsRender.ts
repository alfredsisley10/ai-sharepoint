import { catalogByCategory, CapabilityReport, RenderedValidation } from "../context/adapters/confluenceMacros";
import { OwnerResolution } from "../context/adapters/confluenceOwnership";
import { ManageabilityReport } from "../context/adapters/confluenceEntitlements";
import { CurrencyReport } from "../context/adapters/confluenceCurrency";
import { PageRef, HierarchyResult, renderPageTree } from "../context/adapters/confluenceHierarchy";

/**
 * Model-facing renderers for the Confluence context tools (extracted from
 * contextTools.ts). Pure string formatting — no vscode, no IO — so this is
 * unit-tested directly while the tool wiring in contextTools.ts stays thin.
 */

/** The Confluence "Add more content" capabilities, formatted for the model:
 *  what's in use in this scope, then the full authorable vocabulary. */
export function renderCapabilities(r: CapabilityReport): string {
  const lines: string[] = ["# Confluence content capabilities", `Sampled ${r.pagesSampled} page(s) for what's actually in use here.`];
  if (r.apps.length) lines.push(`Apps detected (best-effort): ${r.apps.join(", ")}.`);
  if (r.used.length) {
    lines.push("", "## Elements already in use in this scope");
    for (const u of r.used) {
      lines.push(
        `- \`${u.name}\`${u.count > 1 ? ` ×${u.count}` : ""}${u.spec ? ` — ${u.spec.label}` : " — app/plugin macro (not in the built-in catalog)"}${u.app ? ` [needs ${u.app}]` : ""}`,
      );
    }
  }
  lines.push("", "## Authorable vocabulary — emit these as STORAGE-FORMAT elements");
  for (const g of catalogByCategory()) {
    lines.push("", `### ${g.category}`);
    for (const m of g.macros) {
      lines.push(`- **${m.label}** (\`${m.name}\`${m.app ? `, needs ${m.app}` : ""}): ${m.description}`);
    }
  }
  lines.push(
    "",
    'CRITICAL: author REAL storage-format elements — e.g. `<ac:structured-macro ac:name="toc"/>` — NEVER wiki/markdown shorthand like `[TOC]` or `{toc}`, which Confluence renders as the literal text "[TOC]". Pass the storage XHTML to write_confluence_page with format:"storage" (markdown bodies still auto-convert fenced code, "- [ ]" task lists, "---" rules, and a stray "[TOC]"). After writing, call validate_confluence_page with the returned pageId to confirm the elements rendered.',
  );
  return lines.join("\n");
}

/** The rendered-page validation, formatted for the model. */
export function renderValidation(v: RenderedValidation): string {
  const lines: string[] = [`# Rendered validation — “${v.title}”`, v.url];
  if (v.leaks.length) {
    lines.push("", "## ⚠️ Leaked markup — these are NOT real Confluence elements");
    for (const l of v.leaks) {
      lines.push(
        `- \`${l.markup}\` rendered as literal text. It was authored as shorthand; re-publish it as the real **${l.macro}** element, e.g. \`<ac:structured-macro ac:name="${l.macro}"/>\` (or the matching ac: element).`,
      );
    }
  } else {
    lines.push("", "✅ No leaked wiki/markdown shorthand — macro markup rendered as real elements.");
  }
  lines.push("", "## Elements that rendered");
  if (v.rendered.length) {
    for (const e of v.rendered) lines.push(`- ${e.name}${e.count > 1 ? ` ×${e.count}` : ""}`);
  } else {
    lines.push("- (none detected — a plain-text page)");
  }
  lines.push("", `Rendered text length: ${v.textLength} chars.`);
  return lines.join("\n");
}

export const UNVERIFIED_OWNER_NOTE =
  "Owner(s) determined WITHOUT active-employee verification: no LDAP/Active Directory reference source is configured, so ownership was resolved from the owner label / recency-weighted contribution history but NOT filtered by who is still an active employee. This is a valid result — just less reliable (a listed owner may have left). To turn on active-employee verification, add an LDAP/Active Directory source via 'Add Context Source' (if your org already has one defined, adding it here is enough — it's used automatically); otherwise ask an admin to define one. Do not report this as a failure.";

export function renderOwners(r: {
  resolution: OwnerResolution;
  labels: string[];
  directoryWired: boolean;
  directoryLabel?: string;
  ownerContacts?: Array<{ sam: string; displayName?: string; contact?: string; active?: boolean }>;
  cached?: boolean;
}): string {
  const { resolution } = r;
  const lines = [`# Page owner(s)${r.cached ? " (cached — pass refresh:true to recompute)" : ""}`];
  const contactBy = new Map((r.ownerContacts ?? []).map((c) => [c.sam.toLowerCase(), c]));
  const renderOwner = (sam: string): string => {
    const c = contactBy.get(sam.toLowerCase());
    if (!c) return sam;
    const who = c.displayName ? `${c.displayName} (${sam})` : sam;
    return `${who}${c.contact ? ` <${c.contact}>` : ""}${c.active === false ? " — ⚠️ inactive" : ""}`;
  };
  lines.push(`- Owner(s): ${resolution.owners.length ? resolution.owners.map(renderOwner).join(", ") : "(none determined)"}`);
  lines.push(`- Basis: ${resolution.basis}${resolution.note ? ` — ${resolution.note}` : ""}`);
  if (r.labels.length) lines.push(`- Labels: ${r.labels.join(", ")}`);
  if (resolution.considered?.length) {
    lines.push(
      `- Top recent contributors: ${resolution.considered
        .slice(0, 5)
        .map((c) => `${c.sam} (${c.count}×${c.score !== undefined ? `, score ${c.score.toFixed(2)}` : ""})`)
        .join(", ")}`,
    );
  }
  lines.push(
    "",
    r.directoryWired
      ? `Active-employee validation: ON via ${r.directoryLabel ?? "the configured directory"} (ranked by recency-weighted contribution; inactive contributors skipped).`
      : UNVERIFIED_OWNER_NOTE,
  );
  return lines.join("\n");
}

export function renderManageability(r: { report: ManageabilityReport; note: string }): string {
  const { report, note } = r;
  const lines = [`# Space manageability — ${report.spaceKey} (as ${report.user})`];
  lines.push(`Checked ${report.checkedPages} page(s); you can fully manage ${report.manageablePages}.`);
  if (report.gaps.length) {
    lines.push("", `## Pages you can't fully manage (${report.gaps.length})`);
    for (const g of report.gaps.slice(0, 50)) lines.push(`- ${g.title} — missing **${g.missing.join("+")}** — ${g.url}`);
    lines.push("", "## Access request (send to the space admins)", note);
  } else {
    lines.push("", `✅ ${note}`);
  }
  return lines.join("\n");
}

export function renderPageRefs(refs: PageRef[]): string {
  return refs.length ? refs.map((r) => `- ${r.title} (id ${r.id}) — ${r.url}`).join("\n") : "_(none)_";
}

export function renderHierarchy(r: HierarchyResult): string {
  switch (r.kind) {
    case "roots":
      return [`# Space ${r.spaceKey} — ${r.roots.length} root page(s)`, "", renderPageRefs(r.roots)].join("\n");
    case "ancestors": {
      const a = r.ancestors;
      return [
        `# Ancestors of “${a.page.title}” (id ${a.page.id})`,
        `Breadcrumb: ${[...a.ancestors, a.page].map((p) => p.title).join(" › ")}`,
        ...(a.spaceKey ? [`Space: ${a.spaceKey}`] : []),
        "",
        renderPageRefs(a.ancestors),
      ].join("\n");
    }
    case "children":
      return [`# Children of “${r.page.title}” (id ${r.page.id}) — ${r.children.length}`, "", renderPageRefs(r.children)].join("\n");
    case "subtree":
      return [
        `# Subtree of “${r.root.title}” (id ${r.root.id}) — ${r.count} descendant page(s)`,
        "```",
        renderPageTree(r.tree),
        "```",
      ].join("\n");
    case "context": {
      const h = r.hierarchy;
      return [
        `# “${h.page.title}” (id ${h.page.id})`,
        ...(h.spaceKey ? [`Space: ${h.spaceKey}`] : []),
        `Breadcrumb: ${[...h.ancestors, h.page].map((p) => p.title).join(" › ")}`,
        `Parent: ${h.parent ? `${h.parent.title} (id ${h.parent.id})` : "(none — this is a root page)"}`,
        "",
        `## Children (${h.childCount})`,
        renderPageRefs(h.children),
      ].join("\n");
    }
  }
}

export function renderCurrency(r: CurrencyReport): string {
  const lines = [`# Page currency — “${r.title}”`, r.url, "", "## Links"];
  if (r.brokenLinks.length) {
    for (const b of r.brokenLinks) lines.push(`- ❌ ${b.url}${b.status ? ` (${b.status})` : b.error ? ` (${b.error})` : ""}`);
  } else {
    lines.push(`- ✅ ${r.workingLinks} link(s) reachable`);
  }
  if (r.uncheckedRelativeLinks) lines.push(`- ${r.uncheckedRelativeLinks} relative link(s) not checked`);
  lines.push("", "## Ownership & age");
  lines.push(`- Owner tag: ${r.hasOwnerLabel ? r.owners.map((o) => o.sam).join(", ") : "none"}`);
  if (r.staleDays !== undefined) lines.push(`- Last updated ${r.staleDays} day(s) ago${r.staleDays > 365 ? " — **stale**" : ""}`);
  lines.push("", UNVERIFIED_OWNER_NOTE);
  return lines.join("\n");
}
