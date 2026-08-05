import type {
  AppServerReadThreadRequest,
  AppServerThreadReplay,
} from "@pwragent/shared";

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
  const hasPreviousPage = startIndex > 0;

  return {
    ...replay,
    entries,
    messages,
    pagination: {
      supportsPagination: true,
      hasPreviousPage,
      ...(hasPreviousPage && firstEntry ? { previousCursor: firstEntry.id } : {}),
    },
  };
}
