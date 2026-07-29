/**
 * The I/O half of "Align with Authoritative Source" (ADR-0049): concrete
 * `AlignmentEffects` over the real adapters.
 *
 * The engine (alignmentRun.ts) and the executor (alignmentDriver.ts) are pure
 * and effect-injected; everything that actually touches Confluence, SharePoint,
 * Copilot, the work inventory and the comms outbox lives here. That split is why
 * the durability guarantees are unit-testable and this layer stays thin.
 *
 * Two invariants carried from the ADR:
 *  - **Nothing is sent.** Conflicts become work items (ADR-0045) and owner
 *    notices become approval-gated outbox DRAFTS (ADR-0025).
 *  - **Interruptions are expected.** A Copilot entitlement refusal raises
 *    `AlignmentPaused` so the run pauses (resume later) instead of failing, and
 *    corporate-proxy stream resets are retried by the shared llmRetry policy.
 */

import {
  AlignmentRun,
  AlignmentTarget,
  AuthoritySnapshotPage,
  CandidateOwner,
  DiscoveredCandidate,
  contentHash,
  groupByOwner,
} from "./alignmentRun";
import { AlignmentEffects, AlignmentPaused } from "./alignmentDriver";
import { buildComparePrompt, parseVerdict, composeOwnerNotice } from "./alignmentCompare";
import { isTransientLlmError, retryDelayMs, errorText, MAX_TRANSIENT_RETRIES } from "./db/llmRetry";
import { ContextSource } from "./types";
import { AppError } from "../core/errors";

/** Everything this layer needs from the extension, injected so the module has
 *  no vscode import and stays testable. */
export interface AlignmentDeps {
  /** Resolve the Confluence source backing a run/target. */
  confluenceSource(sourceId: string): ContextSource | undefined;
  /** Gather a Confluence authority scope as bounded plain text. */
  gatherConfluence(
    source: ContextSource,
    scope: { kind: "space" | "page" | "subtree"; topic: string; spaceKey?: string; pageId?: string },
  ): Promise<Array<{ id: string; title: string; text: string; url: string }>>;
  /** Sweep the rest of a Confluence source for pages on the topic. */
  findConfluenceConflicts(
    source: ContextSource,
    topic: string,
    exclude: { spaceKey?: string; pageIds?: string[] },
  ): Promise<Array<{ id: string; title: string; url: string; excerpt?: string }>>;
  /** Fetch one Confluence page's text. */
  confluencePageText(source: ContextSource, pageId: string): Promise<{ title: string; text: string; url: string }>;
  /** Owner resolution for a Confluence page (label → contributors → space). */
  confluenceOwner(source: ContextSource, pageId: string): Promise<CandidateOwner>;
  /** Enumerate a SharePoint site's pages with their rendered text. The page
   *  `id` rides along because owner resolution needs the id, not the URL. */
  sharePointPages(siteUrl: string): Promise<Array<{ id: string; title: string; url: string; text: string }>>;
  /** Owner resolution for a SharePoint page (version-history editors), by id. */
  sharePointOwner(siteUrl: string, pageId: string): Promise<CandidateOwner>;
  /** One metered Copilot call. */
  ask(prompt: string, label: string): Promise<string>;
  /** Open a remediation work item; returns its id. */
  trackWorkItem(input: {
    title: string;
    finding: string;
    target: { source: string; kind: "confluence" | "sharepoint"; ref?: string; url?: string };
    authorityTopic: string;
    owner?: CandidateOwner;
  }): Promise<string>;
  /** Put an approval-gated draft in the outbox; returns its id. */
  draftNotice(input: { to: string[]; subject: string; body: string; reason: string }): Promise<string>;
  /** Persist the run (the checkpoint). */
  save(run: AlignmentRun): Promise<void>;
  now(): string;
  /** Cancellable sleep for the retry backoff. */
  sleep(ms: number): Promise<void>;
  log(message: string): void;
}

/** Cap the authority text sent per comparison; the prompt clips again. */
const AUTHORITY_TEXT_CAP = 40_000;

/**
 * A SharePoint "page id" is its URL — stable, and what the sweep already has —
 * so the two corpora share one candidate-locator convention.
 */
function locatorOf(corpus: "confluence" | "sharepoint", page: { id?: string; url: string }): string {
  return corpus === "confluence" ? (page.id ?? page.url) : page.url;
}

/**
 * Build the effects for one run.
 *
 * SharePoint page text is memoized per site for the run's lifetime: the sweep
 * already fetched every page's content to enumerate candidates, so re-reading it
 * per candidate would double the request count for no benefit (ADR-0049 §3 —
 * candidate content is cached).
 */
export function buildAlignmentEffects(deps: AlignmentDeps): AlignmentEffects {
  /** siteUrl → its scanned pages, so a site is read once per run. */
  const siteCache = new Map<string, Array<{ id: string; title: string; url: string; text: string }>>();
  /** candidate key → { siteUrl, pageId }, so SharePoint owner lookup (which
   *  needs the page id) can find it from the URL-based locator. */
  const spPageRefs = new Map<string, { siteUrl: string; pageId: string }>();
  /** candidate key → text, so compare/fetch don't re-read. */
  const textCache = new Map<string, string>();
  /** The authority text assembled at gather time, reused for every comparison. */
  let authorityText = "";
  let authorityTitle = "";
  let authorityUrl: string | undefined;

  const sitePages = async (siteUrl: string) => {
    const hit = siteCache.get(siteUrl);
    if (hit) return hit;
    const pages = await deps.sharePointPages(siteUrl);
    siteCache.set(siteUrl, pages);
    return pages;
  };

  const requireConfluence = (sourceId: string | undefined): ContextSource => {
    const source = sourceId ? deps.confluenceSource(sourceId) : undefined;
    if (!source) {
      throw new AppError(
        "The Confluence source for this run is no longer available — reconnect it, or start a new run.",
        "config",
      );
    }
    return source;
  };

  return {
    now: deps.now,

    async gatherAuthority(run) {
      const a = run.authority;
      if (a.corpus === "confluence") {
        const source = requireConfluence(a.sourceId);
        const pages = await deps.gatherConfluence(source, {
          kind: a.scopeKind === "site" ? "space" : a.scopeKind,
          topic: a.topic,
          ...(a.spaceKey ? { spaceKey: a.spaceKey } : {}),
          ...(a.pageId ? { pageId: a.pageId } : {}),
        });
        authorityTitle = pages[0]?.title ?? a.spaceKey ?? a.topic;
        authorityUrl = pages[0]?.url;
        authorityText = pages.map((p) => `## ${p.title}\n${p.text}`).join("\n\n").slice(0, AUTHORITY_TEXT_CAP);
        return pages.map(
          (p): AuthoritySnapshotPage => ({ id: p.id, title: p.title, url: p.url, hash: contentHash(p.text) }),
        );
      }
      // SharePoint authority: the whole site is the truth.
      if (!a.siteUrl) throw new AppError("This run's authority has no site URL.", "config");
      const pages = await sitePages(a.siteUrl);
      authorityTitle = a.topic;
      authorityUrl = a.siteUrl;
      authorityText = pages.map((p) => `## ${p.title}\n${p.text}`).join("\n\n").slice(0, AUTHORITY_TEXT_CAP);
      return pages.map(
        (p): AuthoritySnapshotPage => ({ id: p.url, title: p.title, url: p.url, hash: contentHash(p.text) }),
      );
    },

    async sweep(run, target: AlignmentTarget) {
      if (target.corpus === "confluence") {
        const source = requireConfluence(target.sourceId);
        const found = await deps.findConfluenceConflicts(source, run.authority.topic, {
          // Never sweep the authority's own space back at itself.
          ...(run.authority.corpus === "confluence" && run.authority.sourceId === target.sourceId && run.authority.spaceKey
            ? { spaceKey: run.authority.spaceKey }
            : {}),
          ...(run.snapshot ? { pageIds: run.snapshot.pages.map((p) => p.id) } : {}),
        });
        return {
          found: found.map(
            (c): DiscoveredCandidate => ({
              corpus: "confluence",
              locator: locatorOf("confluence", c),
              title: c.title,
              url: c.url,
            }),
          ),
        };
      }
      if (!target.siteUrl) throw new AppError("A SharePoint target has no site URL.", "config");
      const pages = await sitePages(target.siteUrl);
      const authorityPageUrls = new Set(
        run.authority.corpus === "sharepoint" ? (run.snapshot?.pages ?? []).map((p) => p.url) : [],
      );
      for (const p of pages) {
        const key = `sharepoint:${p.url.toLowerCase()}`;
        textCache.set(key, p.text);
        spPageRefs.set(key, { siteUrl: target.siteUrl, pageId: p.id });
      }
      return {
        found: pages
          .filter((p) => !authorityPageUrls.has(p.url))
          .map((p): DiscoveredCandidate => ({ corpus: "sharepoint", locator: p.url, title: p.title, url: p.url })),
      };
    },

    async fetchCandidate(run, candidate) {
      if (candidate.corpus === "sharepoint") {
        // Already read during the sweep — the site is scanned once per run.
        const cached = textCache.get(candidate.key);
        if (cached !== undefined) return { contentHash: contentHash(cached) };
        const pages = await sitePages(candidate.locator.replace(/\/SitePages\/.*$/i, ""));
        const hit = pages.find((p) => p.url.toLowerCase() === candidate.locator.toLowerCase());
        const text = hit?.text ?? "";
        textCache.set(candidate.key, text);
        return { contentHash: contentHash(text) };
      }
      const source = requireConfluence(
        run.targets.find((t) => t.corpus === "confluence")?.sourceId ?? run.authority.sourceId,
      );
      const page = await deps.confluencePageText(source, candidate.locator);
      textCache.set(candidate.key, page.text);
      return { contentHash: contentHash(page.text), title: page.title, url: page.url };
    },

    async compare(run, candidate) {
      const prompt = buildComparePrompt({
        topic: run.authority.topic,
        authorityText,
        authorityTitle,
        candidateTitle: candidate.title,
        candidateText: textCache.get(candidate.key) ?? "",
        candidateUrl: candidate.url,
      });
      // The metered step. A corporate proxy resetting the streaming reply is
      // retried unchanged (the same policy indexing uses); an entitlement
      // refusal PAUSES the run rather than failing it, because every remaining
      // comparison would hit the identical refusal.
      let attempt = 0;
      for (;;) {
        try {
          const reply = await deps.ask(prompt, "alignmentCompare");
          const verdict = parseVerdict(reply);
          if (verdict) return verdict;
          // Unparseable: treat as no conflict rather than inventing one — the
          // cost of a false positive is emailing someone about a fine page.
          deps.log(`Alignment: unparseable verdict for "${candidate.title}" — treated as no conflict.`);
          return { conflicts: false, severity: "low", summary: "The comparison could not be interpreted.", requestedEdits: [] };
        } catch (err) {
          if (err instanceof AppError && err.code === "copilot.entitlement") {
            throw new AlignmentPaused(`Copilot refused the request (${err.message})`);
          }
          if (isTransientLlmError(err) && attempt < MAX_TRANSIENT_RETRIES) {
            attempt += 1;
            deps.log(`Alignment: retrying comparison for "${candidate.title}" (attempt ${attempt}) — ${errorText(err)}`);
            await deps.sleep(retryDelayMs(attempt));
            continue;
          }
          throw err;
        }
      }
    },

    async resolveOwner(run, candidate) {
      if (candidate.corpus === "confluence") {
        const source = requireConfluence(
          run.targets.find((t) => t.corpus === "confluence")?.sourceId ?? run.authority.sourceId,
        );
        return deps.confluenceOwner(source, candidate.locator);
      }
      const ref = spPageRefs.get(candidate.key);
      if (!ref) {
        // The sweep that recorded the page id happened in an earlier session
        // (this run was resumed), so there is nothing to look up. Reported as
        // "no owner" rather than guessed at — a wrong owner emails the wrong
        // person. Re-running the sweep repopulates it.
        deps.log(`Alignment: no SharePoint page id cached for "${candidate.title}" — owner unresolved this pass.`);
        return {};
      }
      return deps.sharePointOwner(ref.siteUrl, ref.pageId);
    },

    async draft(run, candidate) {
      // One work item per conflicting page — the durable record of the finding.
      const workItemId = await deps.trackWorkItem({
        title: `Conflicts with the ${run.authority.topic} source of truth: ${candidate.title}`.slice(0, 160),
        finding: candidate.verdict?.summary ?? "Conflicts with the authoritative content.",
        target: {
          source: candidate.corpus === "confluence" ? "Confluence" : "SharePoint",
          kind: candidate.corpus,
          ref: candidate.locator,
          url: candidate.url,
        },
        authorityTopic: run.authority.topic,
        ...(candidate.owner ? { owner: candidate.owner } : {}),
      });

      // ONE notice per OWNER, not per page: the notice covers every page this
      // person owns that the run has resolved so far, so a single recipient is
      // never emailed once per page. Pages without a resolved owner get a work
      // item (above) but no draft — there is nobody to send it to.
      const email = candidate.owner?.email?.trim();
      if (!email) {
        deps.log(`Alignment: no owner resolved for "${candidate.title}" — work item opened, no notice drafted.`);
        return { workItemId };
      }
      const mine = (groupByOwner(run).get(email.toLowerCase()) ?? []).filter(
        (c) => c.key === candidate.key || c.draftId === undefined,
      );
      const covered = mine.length ? mine : [candidate];
      const notice = composeOwnerNotice(run, covered, authorityUrl, candidate.owner?.name);
      const draftId = await deps.draftNotice({
        to: [email],
        subject: notice.subject,
        body: notice.body,
        reason: `Aligning ${covered.length} page(s) with the ${run.authority.topic} source of truth`,
      });
      return { workItemId, draftId };
    },

    checkpoint: deps.save,
  };
}
