import {
  buildThreadIdentityKey,
  type NavigationThreadSummary,
  type ThreadSearchResponse,
  type ThreadSearchResult,
} from "@pwragent/shared";

const MIN_LONG_THREAD_ID_QUERY_LENGTH = 10;
const MIN_UUID_FRAGMENT_HEX_CHARS = 8;

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

function threadIdMatchesQuery(threadId: string, query: string): boolean {
  const id = threadId.toLowerCase();
  if (!id.includes(query)) {
    return false;
  }
  const hexChars = query.match(/[0-9a-f]/g)?.length ?? 0;
  const uuidFragment =
    /^[0-9a-f][0-9a-f-]{7,}$/i.test(query) &&
    hexChars >= MIN_UUID_FRAGMENT_HEX_CHARS;
  if (uuidFragment) {
    return true;
  }
  return query.length >= MIN_LONG_THREAD_ID_QUERY_LENGTH;
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

export function agentMetadataMatchesQuery(
  thread: NavigationThreadSummary,
  query: string,
): boolean {
  if (!thread.agent) {
    return false;
  }
  const tokens = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) {
    return false;
  }
  const haystack = [
    "agent",
    "agent thread",
    thread.agent.name,
    thread.agent.instructions,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

type AgentNavigationThread = NavigationThreadSummary & {
  agent: NonNullable<NavigationThreadSummary["agent"]>;
};

function agentMatchToSearchResult(thread: AgentNavigationThread): ThreadSearchResult {
  return {
    backend: thread.source,
    threadId: thread.id,
    identityKey: buildThreadIdentityKey(thread.source, thread.id),
    title: thread.title,
    ...(thread.titleSource ? { titleSource: thread.titleSource } : {}),
    ...(thread.summary ? { summary: thread.summary } : {}),
    ...(thread.projectKey ? { projectKey: thread.projectKey } : {}),
    ...(thread.createdAt !== undefined ? { createdAt: thread.createdAt } : {}),
    ...(thread.updatedAt !== undefined ? { updatedAt: thread.updatedAt } : {}),
    linkedDirectories: thread.linkedDirectories ?? [],
    source: thread.source,
    ...(thread.gitBranch ? { gitBranch: thread.gitBranch } : {}),
    ...(thread.model ? { model: thread.model } : {}),
    score: 1,
    confidence: "high",
    matchReasons: [
      { kind: "agent_match", field: "agent", value: thread.agent.name },
    ],
    snippets: [
      {
        scope: "metadata",
        field: "agent",
        text: `Agent: ${thread.agent.name}`,
      },
    ],
  };
}

export function mergeAgentMatches(
  response: ThreadSearchResponse,
  query: string,
  threads: readonly NavigationThreadSummary[] | undefined,
): ThreadSearchResponse {
  const matchingThreads = (threads ?? []).filter(
    (thread): thread is AgentNavigationThread =>
      Boolean(thread.agent) && agentMetadataMatchesQuery(thread, query),
  );
  if (matchingThreads.length === 0) {
    return response;
  }
  const existingByKey = new Map(
    response.results.map((result) => [result.identityKey, result]),
  );
  const matchedKeys = new Set<string>();
  const agentResults = matchingThreads.map((thread) => {
    const identityKey = buildThreadIdentityKey(thread.source, thread.id);
    matchedKeys.add(identityKey);
    const existing = existingByKey.get(identityKey);
    if (!existing) {
      return agentMatchToSearchResult(thread);
    }
    return {
      ...existing,
      confidence: "high" as const,
      matchReasons: [
        {
          kind: "agent_match" as const,
          field: "agent",
          value: thread.agent.name,
        },
        ...existing.matchReasons.filter((reason) => reason.kind !== "agent_match"),
      ],
    };
  });
  return {
    ...response,
    results: [
      ...agentResults,
      ...response.results.filter((result) => !matchedKeys.has(result.identityKey)),
    ],
  };
}

/**
 * Client-side relevance test for the thread-list quick search: matches title,
 * Agent metadata, thread id, linked PR number, git branch, and linked-directory
 * label. PR numbers match with or without the leading "#"; thread ids only
 * match sufficiently deliberate UUID-like fragments or longer pasted ids.
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
  if (agentMetadataMatchesQuery(thread, needle)) {
    return true;
  }
  if (threadIdMatchesQuery(thread.id, needle)) {
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
