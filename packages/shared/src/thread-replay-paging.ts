import type {
  AppServerReadThreadRequest,
  AppServerThreadEntry,
  AppServerThreadMessage,
  AppServerThreadReplay,
} from "./contracts/normalized-app-server";

/**
 * Pages a complete replay for an owner whose backend cannot paginate natively.
 *
 * Desktop owners and headless outposts both read a whole transcript and cut
 * the page here, so a viewer gets the same newest-page-first contract from
 * either. The cursor names a transcript entry; `before` resolves against the
 * same complete replay on the next read.
 */
export type ThreadReplayPageOptions =
  Pick<AppServerReadThreadRequest, "before" | "includeTurns" | "limit">;

export type ThreadReplayPageHooks = {
  /** Entries a later `before` can resolve. Defaults to every entry. */
  isCursorEntry?: (entry: AppServerThreadEntry) => boolean;
  /** Called when `before` names no entry in this replay. */
  onUnresolvedCursor?: () => void;
};

export function pageThreadReplay(
  replay: AppServerThreadReplay,
  options: ThreadReplayPageOptions,
  hooks: ThreadReplayPageHooks = {},
): AppServerThreadReplay {
  if (options.includeTurns === false) {
    return {
      ...replay,
      entries: [],
      messages: [],
      lastUserMessage: undefined,
      lastAssistantMessage: undefined,
      pagination: {
        supportsPagination: false,
        hasPreviousPage: false,
      },
    };
  }

  if (options.limit === undefined && options.before === undefined) {
    return replay;
  }

  // Presence, not truthiness: an empty-string cursor is a cursor that resolves
  // to nothing, and reading it as "no cursor" would hand the newest page to a
  // caller asking for older history — the failure the guard below exists to
  // prevent. Federation casts a peer's params straight to this request shape,
  // so the value is not ours to trust.
  const beforeIndex = options.before !== undefined
    ? replay.entries.findIndex((entry) => entry.id === options.before)
    : replay.entries.length;
  if (beforeIndex < 0) {
    // The cursor names an entry this replay does not contain, so no page can
    // be cut from it. Answering with the newest page would hand a reader who
    // asked for older history the history it already has: every id is a
    // duplicate, prependTranscriptHistoryPage drops all of them, and history
    // stops advancing with nothing on screen to say why. An unresolvable
    // cursor is indistinguishable from having reached the beginning, so say
    // that instead, and leave a record that it happened.
    hooks.onUnresolvedCursor?.();
    return {
      ...replay,
      entries: [],
      messages: [],
      lastUserMessage: undefined,
      lastAssistantMessage: undefined,
      pagination: {
        supportsPagination: true,
        hasPreviousPage: false,
      },
    };
  }

  const limit =
    options.limit === undefined ? undefined : Math.max(0, Math.floor(options.limit));
  const startIndex = limit === undefined
    ? 0
    : findTurnPageStartIndex(replay.entries, beforeIndex, limit);
  const entries = replay.entries.slice(startIndex, beforeIndex);
  return replayWithEntries(
    replay,
    entries,
    mintEntryCursorPagination(entries, startIndex > 0, hooks.isCursorEntry),
  );
}

function findTurnPageStartIndex(
  entries: AppServerThreadEntry[],
  endIndex: number,
  limit: number,
): number {
  if (limit === 0) {
    return endIndex;
  }

  // Turn metadata is optional in older replay formats and may be present on
  // only part of a logical turn. Mixing both paging strategies can then split
  // that turn or turn a bounded request into the entire replay, so preserve
  // entry-count paging unless every entry in scope has a turn ID.
  for (let index = 0; index < endIndex; index += 1) {
    if (!entries[index]?.turn?.id) {
      return Math.max(0, endIndex - limit);
    }
  }

  const turnIds = new Set<string>();
  let oldestRetainedTurnId: string | undefined;
  for (let index = endIndex - 1; index >= 0; index -= 1) {
    const turnId = entries[index]?.turn?.id;
    if (!turnId || turnIds.has(turnId)) {
      continue;
    }
    if (turnIds.size >= limit) {
      break;
    }
    turnIds.add(turnId);
    oldestRetainedTurnId = turnId;
  }

  // Empty replays still use the established entry-count paging result.
  if (!oldestRetainedTurnId) {
    return Math.max(0, endIndex - limit);
  }
  if (turnIds.size < limit) {
    return 0;
  }

  const firstTurnEntryIndex = entries.findIndex(
    (entry, index) => index < endIndex && entry.turn?.id === oldestRetainedTurnId,
  );
  return firstTurnEntryIndex >= 0 ? firstTurnEntryIndex : 0;
}

/**
 * Names the page's first entry that a later read can resolve.
 *
 * `hasPreviousPage` is reported only when a cursor was actually found. A page
 * with nothing to name must not announce history: the renderer gates its
 * "load older" affordance on `hasPreviousPage` alone but every loader bails
 * on the missing cursor, so each request would resolve having loaded nothing.
 */
export function mintEntryCursorPagination(
  entries: AppServerThreadEntry[],
  hasPreviousPage: boolean,
  isCursorEntry: (entry: AppServerThreadEntry) => boolean = () => true,
): AppServerThreadReplay["pagination"] {
  const cursorEntry = hasPreviousPage ? entries.find(isCursorEntry) : undefined;
  return {
    supportsPagination: true,
    hasPreviousPage: cursorEntry !== undefined,
    ...(cursorEntry ? { previousCursor: cursorEntry.id } : {}),
  };
}

export function replayWithEntries(
  replay: AppServerThreadReplay,
  entries: AppServerThreadEntry[],
  pagination: AppServerThreadReplay["pagination"],
): AppServerThreadReplay {
  const messages = entries.flatMap((entry) => {
    const message = replayMessage(entry);
    return message ? [message] : [];
  });
  const lastUserMessage = messages.findLast((message) => message.role === "user")?.text;
  const lastAssistantMessage = messages.findLast(
    (message) => message.role === "assistant",
  )?.text;

  return {
    ...replay,
    entries,
    messages,
    lastUserMessage,
    lastAssistantMessage,
    pagination,
  };
}

function replayMessage(entry: AppServerThreadEntry): AppServerThreadMessage | undefined {
  if (entry.type !== "message") {
    return undefined;
  }
  return {
    id: entry.id,
    role: entry.role,
    text: entry.text,
    ...(entry.parts ? { parts: entry.parts } : {}),
    ...(entry.origin ? { origin: entry.origin } : {}),
    ...(entry.createdAt ? { createdAt: entry.createdAt } : {}),
  };
}

// "page", not "entry": a page kept whole for a backend-owned cursor sheds
// bytes by compacting entries that were not themselves oversized.
const FEDERATION_OMITTED_ENTRY_TEXT =
  "Content omitted because this page exceeded the federation frame limit.";

/**
 * Which id space a replay's pagination cursor lives in.
 *
 * A cursor is only ever handed back to whoever can resolve it, so the two
 * spaces never mix:
 *
 * - `provider-cursor` — the backend paginates natively and minted the cursor
 *   itself. For Codex that is an opaque `thread/turns/list` cursor, not a
 *   transcript entry id, so nothing downstream may substitute an entry id for
 *   it.
 * - `entry-id` — the backend does not paginate, so this module synthesizes
 *   pages and names the cursor after a transcript entry. Only entries the
 *   provider owns qualify; a read resolves `before` against the provider's own
 *   replay, where an overlay-minted id does not exist.
 */
export type ThreadReplayCursorIdSpace = "entry-id" | "provider-cursor";

type MeasureJsonBytes = (value: unknown) => number;

type ReplayByteBudget = {
  replay: AppServerThreadReplay;
  maxBytes: number;
  /** UTF-8 byte length of compact JSON for a replay or one of its fragments. */
  measureJsonBytes: MeasureJsonBytes;
};

export function fitThreadReplayWithinByteBudget(params: ReplayByteBudget & {
  cursorIdSpace: ThreadReplayCursorIdSpace;
  /** Entries a later `before` can resolve. Defaults to every entry. */
  isCursorEntry?: (entry: AppServerThreadEntry) => boolean;
}): AppServerThreadReplay {
  if (params.measureJsonBytes(params.replay) <= params.maxBytes) {
    return params.replay;
  }

  // A natively paginated replay carries the backend's own cursor, which is not
  // a transcript entry id at all — Codex hands back an opaque
  // `thread/turns/list` cursor. Nothing here can improve on it and nothing may
  // substitute an entry id for it, so the page's boundaries are the backend's
  // to keep: shrink it by compacting entries in place rather than by dropping
  // them, which would leave the preserved cursor naming a boundary the page no
  // longer has and silently strand everything between the two.
  if (params.cursorIdSpace === "provider-cursor") {
    return compactReplayWithinByteBudget(params);
  }

  return trimReplayWithinByteBudget(params, params.isCursorEntry);
}

function trimReplayWithinByteBudget(
  { replay, maxBytes, measureJsonBytes }: ReplayByteBudget,
  isCursorEntry: (entry: AppServerThreadEntry) => boolean = () => true,
): AppServerThreadReplay {
  const { entries } = replay;
  const empty = replayWithEntries(replay, [], mintEntryCursorPagination([], false));
  if (entries.length === 0) {
    return empty;
  }

  // Grow a suffix from the newest entry so each row and cursor is measured
  // once. Keep the longest fitting suffix, since changing the first eligible
  // cursor can make a longer suffix smaller. The original page (start 0) was
  // already measured, with its own pagination and message projections.
  const emptyRowsBytes = measureJsonBytes({ entries: [], messages: [] });
  let pagination = empty.pagination;
  let paginationBytes = measureJsonBytes(pagination);
  let replayBytesWithoutPagination = measureJsonBytes(empty) - paginationBytes;
  const messageRoles = new Set<AppServerThreadMessage["role"]>();
  let start = entries.length;
  let fittedPagination = pagination;
  for (let index = entries.length - 1; index > 0; index -= 1) {
    const entry = entries[index]!;
    const isLastMessage = entry.type === "message" && !messageRoles.has(entry.role);
    replayBytesWithoutPagination += measureEntryFragment(entry, isLastMessage, measureJsonBytes) - emptyRowsBytes;
    if (index < entries.length - 1) {
      replayBytesWithoutPagination += 1; // Entries array comma.
    }
    if (entry.type === "message") {
      if (messageRoles.size > 0) {
        replayBytesWithoutPagination += 1; // Messages array comma.
      }
      messageRoles.add(entry.role);
    }
    // The entries and last-message fields can only add bytes as the suffix
    // grows. Once those alone exceed the budget, no cursor can make it fit.
    if (replayBytesWithoutPagination > maxBytes) {
      break;
    }
    if (isCursorEntry(entry)) {
      pagination = mintEntryCursorPagination([entry], true);
      paginationBytes = measureJsonBytes(pagination);
    }
    if (replayBytesWithoutPagination + paginationBytes <= maxBytes) {
      start = index;
      fittedPagination = pagination;
    }
  }
  if (start < entries.length) {
    return replayWithEntries(replay, entries.slice(start), fittedPagination);
  }

  const oversizedEntry = entries[entries.length - 1]!;
  const candidate = replayWithEntries(
    replay,
    [compactOversizedEntry(oversizedEntry)],
    // Compaction rewrites activity summaries that can identify overlay rows.
    mintEntryCursorPagination(
      [oversizedEntry],
      replay.pagination.hasPreviousPage || entries.length > 1,
      isCursorEntry,
    ),
  );
  return measureJsonBytes(candidate) <= maxBytes ? candidate : empty;
}

/**
 * Fits a page whose boundaries belong to the backend.
 *
 * Replace content oldest first, keeping every entry at its original boundary.
 * Each replacement preserves the row's type and role, so array separators and
 * the entries supplying the last-message fields stay fixed.
 */
function compactReplayWithinByteBudget(
  { replay, maxBytes, measureJsonBytes }: ReplayByteBudget,
): AppServerThreadReplay {
  const { pagination } = replay;
  if (replay.entries.length > 0) {
    const entries = [...replay.entries];
    entries[0] = compactOversizedEntry(entries[0]!);
    // Rebuild the message projections once for the first candidate. The input
    // can come from a read that left those projections empty.
    const firstCandidate = replayWithEntries(replay, entries, pagination);
    let bytes = measureJsonBytes(firstCandidate);
    if (bytes <= maxBytes) {
      return firstCandidate;
    }

    const lastUserIndex = entries.findLastIndex((entry) => entry.type === "message" && entry.role === "user");
    const lastAssistantIndex = entries.findLastIndex((entry) => entry.type === "message" && entry.role === "assistant");
    for (let index = 1; index < entries.length; index += 1) {
      const entry = entries[index]!;
      const compacted = compactOversizedEntry(entry);
      const isLastMessage = index === lastUserIndex || index === lastAssistantIndex;
      bytes += measureEntryFragment(compacted, isLastMessage, measureJsonBytes)
        - measureEntryFragment(entry, isLastMessage, measureJsonBytes);
      entries[index] = compacted;
      if (bytes <= maxBytes) {
        return replayWithEntries(replay, entries, pagination);
      }
    }
  }
  return replayWithEntries(replay, [], pagination);
}

// Include precisely the copies of an entry that appear in the rebuilt replay.
// The entry and message brackets are fixed, and callers account for commas.
function measureEntryFragment(
  entry: AppServerThreadEntry,
  isLastMessage: boolean,
  measureJsonBytes: MeasureJsonBytes,
): number {
  const message = replayMessage(entry);
  return measureJsonBytes({
    entries: [entry],
    messages: message ? [message] : [],
    lastUserMessage: isLastMessage && message?.role === "user" ? message.text : undefined,
    lastAssistantMessage: isLastMessage && message?.role === "assistant" ? message.text : undefined,
  });
}

function compactOversizedEntry(entry: AppServerThreadEntry): AppServerThreadEntry {
  switch (entry.type) {
    case "message":
      return {
        type: "message",
        id: entry.id,
        role: entry.role,
        text: FEDERATION_OMITTED_ENTRY_TEXT,
        ...(entry.createdAt ? { createdAt: entry.createdAt } : {}),
        ...(entry.phase ? { phase: entry.phase } : {}),
        ...(entry.turn ? { turn: entry.turn } : {}),
      };
    case "activity":
      return {
        type: "activity",
        id: entry.id,
        summary: FEDERATION_OMITTED_ENTRY_TEXT,
        details: [],
        ...(entry.createdAt ? { createdAt: entry.createdAt } : {}),
        ...(entry.tone ? { tone: entry.tone } : {}),
        ...(entry.status ? { status: entry.status } : {}),
        ...(entry.turn ? { turn: entry.turn } : {}),
      };
    case "plan":
      return {
        type: "plan",
        id: entry.id,
        markdown: FEDERATION_OMITTED_ENTRY_TEXT,
        steps: [],
        ...(entry.createdAt ? { createdAt: entry.createdAt } : {}),
        ...(entry.turn ? { turn: entry.turn } : {}),
      };
    case "review":
      return {
        type: "review",
        id: entry.id,
        review: FEDERATION_OMITTED_ENTRY_TEXT,
        ...(entry.createdAt ? { createdAt: entry.createdAt } : {}),
        ...(entry.status ? { status: entry.status } : {}),
        ...(entry.turn ? { turn: entry.turn } : {}),
      };
  }
}
