import type { NavigationThreadSummary } from "./contracts/navigation";
import { textMatchesJumpQuery } from "./jump-search-text";
import {
  matchesThreadSearchProjects,
  parseThreadSearchQuery,
  threadSearchTextTerms,
} from "./thread-search-query";

/** Metadata needed to match or reference a row; never action/config authority. */
export type ThreadJumpCandidate = Pick<NavigationThreadSummary,
  "id" | "source" | "title" | "titleSource" | "createdAt" | "updatedAt"
  | "projectKey" | "gitBranch" | "linkedDirectories" | "prs"
> & {
  agent?: { name: string; instructions?: string };
  federation?: Pick<NonNullable<NavigationThreadSummary["federation"]>,
    "ref" | "instanceLabel" | "celestialIcon"
  >;
};

const MIN_LONG_THREAD_ID_QUERY_LENGTH = 10;
const MIN_UUID_FRAGMENT_HEX_CHARS = 8;

/** PR numbers linked to a thread via its persisted overlay PR chips. */
export function threadPrNumbers(thread: ThreadJumpCandidate): number[] {
  return (thread.prs ?? []).map((pr) => pr.number);
}

/** True when a bare numeric query exactly identifies any attached PR. */
export function threadHasExactPrNumberMatch(
  thread: ThreadJumpCandidate,
  query: string,
): boolean {
  const match = query.trim().match(/^#?(\d{1,7})$/);
  if (!match) {
    return false;
  }
  const number = Number(match[1]);
  return (
    Number.isInteger(number)
    && number > 0
    && threadPrNumbers(thread).includes(number)
  );
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

export function agentMetadataMatchesQuery(
  thread: ThreadJumpCandidate,
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

/**
 * Split a quick-jump query into its free text and its `@project` /
 * `in:@project` mentions, with the same grammar as thread search (⌘⇧F).
 * Quoting is the escape for a literal `"@word"`, so a query with a mention or
 * a quoted would-be mention has its quoted phrases unwrapped in `text`. Any
 * other query's `text` is as typed. `terms` are the whitespace-separated
 * words, with a quoted phrase kept whole.
 */
export function parseThreadJumpQuery(query: string): { text: string; projects: string[]; terms: string[] } {
  const parsed = parseThreadSearchQuery(query);
  const terms = threadSearchTextTerms(parsed.query).map((term) => term.text);
  if (!parsed.projects.length && !/"(?:in:)?@[^"]*"/i.test(parsed.query)) {
    return { text: parsed.query, projects: [], terms };
  }
  return { text: terms.join(" "), projects: parsed.projects, terms };
}

/**
 * Relevance test for the thread-list quick jump (⌘K): matches title, Agent
 * metadata, thread id, linked PR number, git branch, and linked-directory
 * label/path, including word-prefix abbreviations. PR numbers match with or
 * without the leading "#"; thread ids only
 * match sufficiently deliberate UUID-like fragments or longer pasted ids.
 * The text matches as one phrase first; failing that, every word must match
 * some field, so `pnpm mcp` finds "pnpm install foo-mcp warning".
 * An `@project` mention scopes the match to threads in that project; a query
 * that is only mentions matches every thread in them.
 *
 * Shared between the renderer (instant local filtering) and the main process
 * (federated jump search over remote navigation summaries) so local and
 * remote matching semantics can never drift.
 */
export function threadMatchesQuery(
  thread: ThreadJumpCandidate,
  query: string,
): boolean {
  const { text, projects, terms } = parseThreadJumpQuery(query);
  if (projects.length && !matchesThreadSearchProjects(thread, projects)) {
    return false;
  }
  const needle = text.trim().toLowerCase();
  if (!needle) {
    return projects.length > 0;
  }
  if (threadMatchesNeedle(thread, needle)) {
    return true;
  }
  return terms.length > 1
    && terms.every((term) => threadMatchesNeedle(thread, term.toLowerCase()));
}

function threadMatchesNeedle(
  thread: ThreadJumpCandidate,
  needle: string,
): boolean {
  if (textMatchesJumpQuery(thread.title, needle)) {
    return true;
  }
  if (agentMetadataMatchesQuery(thread, needle)) {
    return true;
  }
  if (threadIdMatchesQuery(thread.id, needle)) {
    return true;
  }
  if (textMatchesJumpQuery(thread.gitBranch, needle)) {
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
    [directory.label, directory.path, directory.worktreePath]
      .some((value) => textMatchesJumpQuery(value, needle)),
  );
}

/**
 * Apply the shared Cmd+K match and ordering rules to a navigation collection.
 * Owners use this before returning bounded Federation search results, while
 * viewers use it to merge results from multiple peers without semantic drift.
 */
export function rankThreadJumpMatches<T extends ThreadJumpCandidate>(
  threads: readonly T[],
  query: string,
): T[] {
  return sortThreadJumpMatches(threads.filter((thread) => threadMatchesQuery(thread, query)), query);
}

/** Merge owner-matched results without re-filtering their compact display data. */
export function sortThreadJumpMatches<T extends ThreadJumpCandidate>(
  threads: readonly T[],
  query: string,
): T[] {
  const { text } = parseThreadJumpQuery(query);
  return [...threads].sort((left, right) => {
    const exactPrPriority =
      Number(threadHasExactPrNumberMatch(right, text))
      - Number(threadHasExactPrNumberMatch(left, text));
    if (exactPrPriority !== 0) {
      return exactPrPriority;
    }
    return (
      (right.updatedAt ?? right.createdAt ?? 0)
      - (left.updatedAt ?? left.createdAt ?? 0)
    );
  });
}
