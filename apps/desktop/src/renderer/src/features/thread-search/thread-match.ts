import {
  buildThreadIdentityKey,
  type NavigationThreadSummary,
  type ThreadSearchResponse,
  type ThreadSearchResult,
} from "@pwragent/shared";

/**
 * Parse a "bare PR number" query — "779" or "#779" — into its number, or
 * `null` when the query is anything else. Bounded to 7 digits so a long digit
 * run isn't mistaken for a PR.
 */
export function parsePrNumberQuery(query: string): number | null {
  const match = query.trim().match(/^#?(\d{1,7})$/);
  if (!match) {
    return null;
  }
  const value = Number(match[1]);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function threadPrNumbers(thread: NavigationThreadSummary): number[] {
  return (thread.prs ?? []).map((pr) => pr.number);
}

/** Threads linked to the given PR number (via persisted overlay PRs). */
export function threadsByPrNumber(
  threads: readonly NavigationThreadSummary[],
  prNumber: number,
): NavigationThreadSummary[] {
  return threads.filter((thread) => threadPrNumbers(thread).includes(prNumber));
}

/** Synthesize a search result for a PR-number hit on a navigation thread. */
export function prMatchToSearchResult(
  thread: NavigationThreadSummary,
  prNumber: number,
): ThreadSearchResult {
  const pr = (thread.prs ?? []).find((entry) => entry.number === prNumber);
  return {
    backend: thread.source,
    threadId: thread.id,
    identityKey: buildThreadIdentityKey(thread.source, thread.id),
    title: thread.title,
    ...(thread.projectKey ? { projectKey: thread.projectKey } : {}),
    linkedDirectories: thread.linkedDirectories ?? [],
    source: thread.source,
    ...(thread.gitBranch ? { gitBranch: thread.gitBranch } : {}),
    ...(thread.model ? { model: thread.model } : {}),
    score: 1,
    confidence: "high",
    matchReasons: [{ kind: "pr_number_match", value: `#${prNumber}` }],
    snippets: pr?.title
      ? [
          {
            scope: "metadata",
            field: "pr",
            text: `${pr.org}/${pr.repo} #${pr.number} — ${pr.title}`,
          },
        ]
      : [],
  };
}

/**
 * When `query` is a bare PR number, prepend its linked threads (deduped
 * against the backend hits) to a search response — so "#779" / "779" finds
 * the right thread even though PR numbers aren't in the FTS index.
 */
export function mergePrNumberMatches(
  response: ThreadSearchResponse,
  query: string,
  threads: readonly NavigationThreadSummary[] | undefined,
): ThreadSearchResponse {
  const prNumber = parsePrNumberQuery(query);
  if (prNumber === null || !threads) {
    return response;
  }
  const seen = new Set(response.results.map((result) => result.identityKey));
  const prResults = threadsByPrNumber(threads, prNumber)
    .map((thread) => prMatchToSearchResult(thread, prNumber))
    .filter((result) => !seen.has(result.identityKey));
  if (prResults.length === 0) {
    return response;
  }
  return { ...response, results: [...prResults, ...response.results] };
}

/**
 * Client-side relevance test for the thread-list quick search: matches title,
 * linked PR number, git branch, and linked-directory label. PR numbers match
 * with or without the leading "#".
 */
export function threadMatchesQuery(
  thread: NavigationThreadSummary,
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return false;
  }
  if (thread.title.toLowerCase().includes(needle)) {
    return true;
  }
  if ((thread.gitBranch ?? "").toLowerCase().includes(needle)) {
    return true;
  }
  const bareNeedle = needle.replace(/^#/, "");
  if (
    bareNeedle.length > 0 &&
    threadPrNumbers(thread).some((number) => String(number).includes(bareNeedle))
  ) {
    return true;
  }
  return (thread.linkedDirectories ?? []).some((directory) =>
    (directory.label ?? "").toLowerCase().includes(needle),
  );
}
