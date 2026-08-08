import {
  buildPullRequestStatusKey,
  threadHasExactPrNumberMatch,
  threadMatchesQuery,
  type NavigationThreadSummary,
  type PrSummary,
} from "@pwragent/shared";

export type HashReferenceTrigger = {
  end: number;
  query: string;
  start: number;
};

export type HashReferenceCandidates = {
  pullRequests: PrSummary[];
  threads: NavigationThreadSummary[];
};

const THREAD_CANDIDATE_LIMIT = 8;
const PULL_REQUEST_CANDIDATE_LIMIT = 6;
const THREAD_LABEL_LENGTH_LIMIT = 72;
const THREAD_TOOLTIP_LENGTH_LIMIT = 300;

/** Collapse a free-text thread title onto one line. */
export function collapseHashReferenceWhitespace(
  value: string | undefined,
): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function truncateAtWordBoundary(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }

  const breakWindow = value.slice(0, limit + 1);
  const wordBreak = breakWindow.lastIndexOf(" ");
  const truncated =
    wordBreak >= Math.floor(limit / 2)
      ? value.slice(0, wordBreak)
      : value.slice(0, limit);
  return `${truncated.replace(/[\s,;:.-]+$/, "")}…`;
}

/**
 * A thread title is free text, and nothing guarantees it is short: a
 * provider that never derived a name leaves the operator's entire first
 * prompt — paragraphs, newlines and all — as the title. The `#` popover
 * renders one row per candidate inside a ~320px list, so an unbounded
 * title wraps until it is the only row the operator can see. Collapse to
 * a single line and cut at a word boundary.
 *
 * This is the label for every surface that names a referenced thread —
 * the popover row, the composer chip, and the `[title](pwragent://…)`
 * markdown the agent receives. Apply it wherever a token is minted, not
 * just at the picker: a draft restore rebuilds tokens from the live
 * thread summary rather than from the saved link text, so a formatter
 * that skips that path is undone by the next restore.
 */
export function formatHashReferenceThreadLabel(
  thread: Pick<NavigationThreadSummary, "id" | "title">,
): string {
  const collapsed = collapseHashReferenceWhitespace(thread.title);
  if (!collapsed) {
    return thread.id;
  }
  return truncateAtWordBoundary(collapsed, THREAD_LABEL_LENGTH_LIMIT);
}

/**
 * The hover text behind a clamped row. Longer than the label — the point
 * is to recover what the ellipsis hid — but still bounded, because a
 * native tooltip carrying a whole pasted prompt is its own unreadable
 * wall of text.
 */
export function formatHashReferenceThreadTooltip(
  thread: Pick<NavigationThreadSummary, "id" | "title">,
): string {
  const collapsed = collapseHashReferenceWhitespace(thread.title);
  if (!collapsed) {
    return thread.id;
  }
  return truncateAtWordBoundary(collapsed, THREAD_TOOLTIP_LENGTH_LIMIT);
}

/**
 * Match a composer `#` reference from the trigger through the caret. Thread
 * titles can contain spaces, so the query spans the rest of the current line.
 * A second `#` starts a new candidate instead of extending the first one.
 */
export function findHashReferenceTrigger(
  text: string,
  caret: number,
): HashReferenceTrigger | undefined {
  const prefix = text.slice(0, caret);
  const match = /(?:^|\s)#([^\n#]*)$/.exec(prefix);
  if (!match) {
    return undefined;
  }

  const query = match[1] ?? "";
  // A numeric hash is a pull-request query, so the first whitespace ends
  // autocomplete. Thread-title queries may still span spaces.
  if (/^\d{1,7}\s/.test(query)) {
    return undefined;
  }

  const start = prefix.length - match[0].length + match[0].lastIndexOf("#");
  return {
    start,
    end: caret,
    query,
  };
}

/**
 * The inline sibling of Cmd+K: filter the same thread population with the
 * shared matcher, then add repository-scoped PR choices when the query is
 * numeric. A PR attached to several threads appears once.
 */
export function filterHashReferenceCandidates(
  threads: readonly NavigationThreadSummary[],
  query: string,
): HashReferenceCandidates {
  const trimmed = query.trim();
  const normalized = trimmed.toLowerCase();
  const threadCandidates = threads
    .filter((thread) => !trimmed || threadMatchesQuery(thread, trimmed))
    .sort((left, right) => {
      const exactPrDifference =
        Number(threadHasExactPrNumberMatch(right, trimmed))
        - Number(threadHasExactPrNumberMatch(left, trimmed));
      if (exactPrDifference !== 0) {
        return exactPrDifference;
      }

      const titleDifference =
        threadTitleMatchRank(left.title, normalized)
        - threadTitleMatchRank(right.title, normalized);
      if (titleDifference !== 0) {
        return titleDifference;
      }

      return (right.updatedAt ?? right.createdAt ?? 0)
        - (left.updatedAt ?? left.createdAt ?? 0);
    })
    .slice(0, THREAD_CANDIDATE_LIMIT);

  if (!/^\d{1,7}$/.test(trimmed)) {
    return { pullRequests: [], threads: threadCandidates };
  }

  const pullRequests = new Map<string, PrSummary>();
  for (const thread of threads) {
    for (const pr of thread.prs ?? []) {
      if (!String(pr.number).includes(trimmed)) {
        continue;
      }
      const key = buildPullRequestStatusKey(pr);
      if (!pullRequests.has(key)) {
        pullRequests.set(key, pr);
      }
    }
  }

  return {
    threads: threadCandidates,
    pullRequests: [...pullRequests.values()]
      .sort((left, right) => {
        const leftNumber = String(left.number);
        const rightNumber = String(right.number);
        const exactDifference =
          Number(rightNumber === trimmed) - Number(leftNumber === trimmed);
        if (exactDifference !== 0) {
          return exactDifference;
        }
        const prefixDifference =
          Number(rightNumber.startsWith(trimmed))
          - Number(leftNumber.startsWith(trimmed));
        if (prefixDifference !== 0) {
          return prefixDifference;
        }
        return left.number - right.number;
      })
      .slice(0, PULL_REQUEST_CANDIDATE_LIMIT),
  };
}

function threadTitleMatchRank(title: string, query: string): number {
  if (!query) {
    return 0;
  }
  const normalizedTitle = title.toLowerCase();
  if (normalizedTitle === query) {
    return 0;
  }
  if (normalizedTitle.startsWith(query)) {
    return 1;
  }
  if (normalizedTitle.includes(query)) {
    return 2;
  }
  return 3;
}
