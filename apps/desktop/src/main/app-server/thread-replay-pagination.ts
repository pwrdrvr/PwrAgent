import type {
  AppServerReadThreadRequest,
  AppServerThreadEntry,
  AppServerThreadReplay,
} from "@pwragent/shared";

const FEDERATION_OMITTED_ENTRY_TEXT =
  "Content omitted because this entry exceeded the federation frame limit.";

export function pageNormalizedReplay(
  replay: AppServerThreadReplay,
  options: Pick<
    AppServerReadThreadRequest,
    "before" | "includeTurns" | "limit"
  >,
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

  if (options.limit === undefined && !options.before) {
    return replay;
  }

  const endIndex = options.before
    ? replay.entries.findIndex((entry) => entry.id === options.before)
    : replay.entries.length;
  const boundedEndIndex = endIndex >= 0 ? endIndex : replay.entries.length;
  const limit =
    options.limit === undefined ? undefined : Math.max(0, Math.floor(options.limit));
  const startIndex = limit === undefined
    ? 0
    : findTurnPageStartIndex(replay.entries, boundedEndIndex, limit);
  const entries = replay.entries.slice(startIndex, boundedEndIndex);
  return replayWithEntries(replay, entries, startIndex > 0);
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

export function fitNormalizedReplayWithinByteBudget(params: {
  replay: AppServerThreadReplay;
  maxBytes: number;
  measureBytes: (replay: AppServerThreadReplay) => number;
}): AppServerThreadReplay {
  if (params.measureBytes(params.replay) <= params.maxBytes) {
    return params.replay;
  }

  let entries = [...params.replay.entries];
  while (entries.length > 1) {
    entries = entries.slice(1);
    const candidate = replayWithEntries(params.replay, entries, true);
    if (params.measureBytes(candidate) <= params.maxBytes) {
      return candidate;
    }
  }

  if (entries[0]) {
    const candidate = replayWithEntries(
      params.replay,
      [compactOversizedEntry(entries[0])],
      params.replay.pagination.hasPreviousPage || params.replay.entries.length > 1,
    );
    if (params.measureBytes(candidate) <= params.maxBytes) {
      return candidate;
    }
  }

  return {
    entries: [],
    messages: [],
    pagination: {
      supportsPagination: true,
      hasPreviousPage: false,
    },
  };
}

function replayWithEntries(
  replay: AppServerThreadReplay,
  entries: AppServerThreadEntry[],
  hasPreviousPage: boolean,
): AppServerThreadReplay {
  const messages = entries.flatMap((entry) =>
    entry.type === "message"
      ? [
          {
            id: entry.id,
            role: entry.role,
            text: entry.text,
            ...(entry.parts ? { parts: entry.parts } : {}),
            ...(entry.origin ? { origin: entry.origin } : {}),
            ...(entry.createdAt ? { createdAt: entry.createdAt } : {}),
          },
        ]
      : [],
  );
  const firstEntry = entries[0];
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
    pagination: {
      supportsPagination: true,
      hasPreviousPage,
      ...(hasPreviousPage && firstEntry ? { previousCursor: firstEntry.id } : {}),
    },
  };
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
