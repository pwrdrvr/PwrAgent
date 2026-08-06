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
  const startIndex = limit === undefined ? 0 : Math.max(0, boundedEndIndex - limit);
  const entries = replay.entries.slice(startIndex, boundedEndIndex);
  return replayWithEntries(replay, entries, startIndex > 0);
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
