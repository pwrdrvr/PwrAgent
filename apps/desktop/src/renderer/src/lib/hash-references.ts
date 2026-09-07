import {
  buildPullRequestStatusKey,
  buildThreadIdentityKey,
  federatedThreadIdentityKey,
  threadHasExactPrNumberMatch,
  threadMatchesQuery,
  type ThreadJumpCandidate,
  type PrSummary,
} from "@pwragent/shared";

export type HashReferenceTrigger = {
  end: number;
  query: string;
  start: number;
};

export type HashReferenceCandidates = {
  pullRequests: PrSummary[];
  threads: ThreadJumpCandidate[];
};

const THREAD_CANDIDATE_LIMIT = 8;
const PULL_REQUEST_CANDIDATE_LIMIT = 6;
const THREAD_LABEL_LENGTH_LIMIT = 72;
const THREAD_TOOLTIP_LENGTH_LIMIT = 300;

/**
 * How long a `#` query may get, with nothing to show for it, before the
 * `#` stops being an autocomplete anchor and goes back to being prose.
 *
 * Zero results is safe to treat as *terminal* rather than transient
 * because matching is monotonic: `threadMatchesQuery` is a set of
 * `includes(needle)` tests over fixed haystacks (title, id, branch,
 * agent metadata, PR numbers, directory labels), so extending a query
 * can only ever narrow the result set. A query matching nothing at
 * eight characters cannot start matching at nine. Without this, a `#`
 * anywhere in a sentence keeps the picker armed — and the federated
 * search re-firing — for the whole rest of the line.
 */
export const HASH_ANCHOR_COLD_QUERY_LENGTH = 8;

/**
 * Identity for a `#` anchor that has gone cold.
 *
 * This is the query's leading run, deliberately NOT the `#`'s offset in
 * the document. An offset shifts the moment the operator edits anything
 * earlier in the line, which would silently re-arm a retired anchor
 * mid-sentence — the exact symptom being fixed. The leading run is
 * stable both as the query grows to the right and as text before the
 * `#` changes.
 *
 * Two anchors sharing a leading run collapse to one entry. That is
 * harmless: by the monotonicity above, if the run matched nothing for
 * one of them it matches nothing for the other.
 */
export function hashReferenceAnchorKey(query: string): string {
  return query.slice(0, HASH_ANCHOR_COLD_QUERY_LENGTH).toLowerCase();
}

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
  thread: Pick<ThreadJumpCandidate, "id" | "title">,
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
  thread: Pick<ThreadJumpCandidate, "id" | "title">,
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
  threads: readonly ThreadJumpCandidate[],
  query: string,
  ownerMatched = false,
): HashReferenceCandidates {
  const trimmed = query.trim();
  const normalized = trimmed.toLowerCase();
  const threadCandidates = threads
    .filter((thread) => ownerMatched || !trimmed || threadMatchesQuery(thread, trimmed))
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

/**
 * The secondary line under a `#` thread row: the details that tell two
 * similarly-titled threads apart — a PR number (the one the query matched,
 * when it matched one), the branch, the first linked directory.
 */
export function describeHashReferenceThread(
  thread: ThreadJumpCandidate,
  query: string,
): string {
  const parts: string[] = [];
  const pullRequest = threadHasExactPrNumberMatch(thread, query)
    ? (thread.prs ?? []).find(
        (candidate) => candidate.number === Number(query.trim()),
      )
    : (thread.prs ?? [])[0];
  if (pullRequest) {
    parts.push(`#${pullRequest.number}`);
  }
  if (thread.gitBranch) {
    parts.push(thread.gitBranch);
  }
  const directory = (thread.linkedDirectories ?? [])[0];
  if (directory?.label) {
    parts.push(directory.label);
  }
  if (parts.length > 0) {
    return parts.join(" · ");
  }
  // The id is the last-resort disambiguator between same-named threads. A
  // thread with no title is already showing that same id as its label, so
  // repeating it here would just print the uuid twice.
  return collapseHashReferenceWhitespace(thread.title) ? thread.id : "";
}

/**
 * One row in the `#` popover: a thread or a pull request, and whether it
 * came from a peer rather than this instance's own navigation snapshot.
 */
export type HashReferenceOption =
  | {
      kind: "thread";
      remote: boolean;
      thread: ThreadJumpCandidate;
    }
  | {
      kind: "pull-request";
      pullRequest: PrSummary;
      remote: boolean;
    };

/**
 * Assemble the `#` popover's rows from the local thread population and
 * whatever a federated search turned up, local rows first.
 *
 * Shared by every composer surface so the two never disagree about what a
 * `#` offers. Three things are filtered out, in this order:
 *   - the thread being written in — referencing it tells the agent nothing
 *     it does not already have, and on a bare `#` it is the most recently
 *     updated thread, so it would otherwise take the first row;
 *   - remote threads the local snapshot already carries, which would
 *     otherwise appear twice once a peer answers;
 *   - remote pull requests already offered by a local thread.
 */
export function hashReferenceThreadIdentity(thread: ThreadJumpCandidate): string {
  return thread.federation?.ref ? federatedThreadIdentityKey(thread.federation.ref)
    : buildThreadIdentityKey(thread.source, thread.id);
}

export function buildHashReferenceOptions(params: {
  currentThreadKey?: string;
  localThreads: readonly ThreadJumpCandidate[];
  localOwnerMatched?: boolean;
  remoteOwnerMatched?: boolean;
  query: string;
  remoteThreads?: readonly ThreadJumpCandidate[];
}): HashReferenceOption[] {
  const { currentThreadKey, localThreads, query } = params;
  const isCurrentThread = (thread: ThreadJumpCandidate): boolean =>
    currentThreadKey !== undefined
    && hashReferenceThreadIdentity(thread) === currentThreadKey;
  const localCandidates = filterHashReferenceCandidates(
    localThreads.filter((thread) => !isCurrentThread(thread)),
    query,
    params.localOwnerMatched,
  );
  const localThreadKeys = new Set(
    localThreads.map((thread) =>
      hashReferenceThreadIdentity(thread),
    ),
  );
  const remoteCandidates = filterHashReferenceCandidates(
    (params.remoteThreads ?? []).filter(
      (thread) =>
        thread.federation?.ref.target.scope === "remote"
        && !isCurrentThread(thread)
        && !localThreadKeys.has(
          hashReferenceThreadIdentity(thread),
        ),
    ),
    query,
    params.remoteOwnerMatched,
  );
  const localPullRequestKeys = new Set(
    localCandidates.pullRequests.map(buildPullRequestStatusKey),
  );
  return [
    ...localCandidates.threads.map((thread) => ({
      kind: "thread" as const,
      remote: false,
      thread,
    })),
    ...localCandidates.pullRequests.map((pullRequest) => ({
      kind: "pull-request" as const,
      pullRequest,
      remote: false,
    })),
    ...remoteCandidates.threads.map((thread) => ({
      kind: "thread" as const,
      remote: true,
      thread,
    })),
    ...remoteCandidates.pullRequests
      .filter(
        (pullRequest) =>
          !localPullRequestKeys.has(buildPullRequestStatusKey(pullRequest)),
      )
      .map((pullRequest) => ({
        kind: "pull-request" as const,
        pullRequest,
        remote: true,
      })),
  ];
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
