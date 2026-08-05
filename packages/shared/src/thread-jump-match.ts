import type { NavigationThreadSummary } from "./contracts/navigation";

const MIN_LONG_THREAD_ID_QUERY_LENGTH = 10;
const MIN_UUID_FRAGMENT_HEX_CHARS = 8;

/** PR numbers linked to a thread via its persisted overlay PR chips. */
export function threadPrNumbers(thread: NavigationThreadSummary): number[] {
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

/**
 * Relevance test for the thread-list quick jump (⌘K): matches title, Agent
 * metadata, thread id, linked PR number, git branch, and linked-directory
 * label. PR numbers match with or without the leading "#"; thread ids only
 * match sufficiently deliberate UUID-like fragments or longer pasted ids.
 *
 * Shared between the renderer (instant local filtering) and the main process
 * (federated jump search over remote navigation summaries) so local and
 * remote matching semantics can never drift.
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
