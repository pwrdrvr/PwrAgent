import type {
  AppServerReadThreadResponse,
  AppServerThreadEntry,
  AppServerThreadMessage,
} from "@pwragent/shared";
import {
  addTranscriptReviewSegmentToIndex,
  createTranscriptReviewHistoryIndex,
  deriveTranscriptReviewPresentation,
  iterateTranscriptReviewHistoryEvents,
  summarizeTranscriptReviewSegment,
  type TranscriptReviewHistoryIndex,
  type TranscriptReviewPresentation,
} from "./transcript-review-presentation";

export type TranscriptHistoryPage = {
  entries: AppServerThreadEntry[];
  entryCount: number;
  messageCount: number;
  messages: AppServerThreadMessage[];
  newerPage?: TranscriptHistoryPage;
  olderPage?: TranscriptHistoryPage;
};

export type LoadedTranscriptHistory = {
  entryCount: number;
  messageCount: number;
  newestPage?: TranscriptHistoryPage;
  oldestPage?: TranscriptHistoryPage;
  pagination: AppServerReadThreadResponse["replay"]["pagination"];
};

type TranscriptHistoryTurnPage = {
  entryIndexes: number[];
  page: TranscriptHistoryPage;
};

export type TranscriptHistoryIndex = {
  entryIds: Set<string>;
  messageIds: Set<string>;
  review: TranscriptReviewHistoryIndex;
  turnPages: Map<string, TranscriptHistoryTurnPage[]>;
};

export function createTranscriptHistoryIndex(): TranscriptHistoryIndex {
  return {
    entryIds: new Set(),
    messageIds: new Set(),
    review: createTranscriptReviewHistoryIndex(),
    turnPages: new Map(),
  };
}

function messagesForEntries(
  entries: AppServerThreadEntry[],
  messages: AppServerThreadMessage[],
): AppServerThreadMessage[] {
  const messagesById = new Map(messages.map((message) => [message.id, message]));

  return entries.flatMap((entry) => {
    if (entry.type !== "message") {
      return [];
    }

    const message = messagesById.get(entry.id);
    return message
      ? [message]
      : [{
          id: entry.id,
          role: entry.role,
          text: entry.text,
          ...(entry.parts ? { parts: entry.parts } : {}),
          ...(entry.origin ? { origin: entry.origin } : {}),
          ...(entry.createdAt !== undefined
            ? { createdAt: entry.createdAt }
            : {}),
        }];
  });
}

/**
 * Adds one server page without traversing or copying previously loaded pages.
 *
 * The index is an append-only, non-rendered companion owned by one thread
 * session. Keeping it outside React state is deliberate: cloning a growing
 * Set here would merely move the cumulative history copy from the entry array
 * to the ID index.
 */
export function prependTranscriptHistoryPage(params: {
  history: LoadedTranscriptHistory | undefined;
  index: TranscriptHistoryIndex;
  page: AppServerReadThreadResponse;
  tailEntries: AppServerThreadEntry[];
}): LoadedTranscriptHistory {
  const tailEntryIds = new Set(params.tailEntries.map((entry) => entry.id));
  const entries = params.page.replay.entries.filter(
    (entry) =>
      !tailEntryIds.has(entry.id)
      && !params.index.entryIds.has(entry.id),
  );
  const messages = messagesForEntries(entries, params.page.replay.messages);
  const reviewSummary = summarizeTranscriptReviewSegment(entries, messages);

  for (const entry of entries) {
    params.index.entryIds.add(entry.id);
  }
  for (const message of messages) {
    params.index.messageIds.add(message.id);
  }
  addTranscriptReviewSegmentToIndex(params.index.review, reviewSummary);

  const previousEntryCount = params.history?.entryCount ?? 0;
  const previousMessageCount = params.history?.messageCount ?? 0;
  let oldestPage = params.history?.oldestPage;
  let newestPage = params.history?.newestPage;
  if (entries.length > 0) {
    const page: TranscriptHistoryPage = {
      entries,
      entryCount: entries.length,
      messageCount: messages.length,
      messages,
      newerPage: params.history?.oldestPage,
    };
    if (oldestPage) {
      // This reverse link is an append-only navigation index. Older array
      // views remain bounded by their captured entry count, so attaching the
      // next page cannot make a previously returned view grow.
      oldestPage.olderPage = page;
    }
    const entryIndexesByTurn = new Map<string, number[]>();
    entries.forEach((entry, entryIndex) => {
      const turnId = entry.turn?.id;
      if (!turnId) {
        return;
      }
      const entryIndexes = entryIndexesByTurn.get(turnId) ?? [];
      entryIndexes.push(entryIndex);
      entryIndexesByTurn.set(turnId, entryIndexes);
    });
    for (const [turnId, entryIndexes] of entryIndexesByTurn) {
      const turnPages = params.index.turnPages.get(turnId) ?? [];
      turnPages.push({ entryIndexes, page });
      params.index.turnPages.set(turnId, turnPages);
    }
    oldestPage = page;
    newestPage ??= page;
  }

  return {
    entryCount: previousEntryCount + entries.length,
    messageCount: previousMessageCount + messages.length,
    newestPage,
    oldestPage,
    pagination: params.page.replay.pagination,
  };
}

function historyOverlapIds<T extends { id: string }>(
  tail: readonly T[],
  historyIds: ReadonlySet<string>,
): Set<string> {
  const overlap = new Set<string>();
  for (const item of tail) {
    if (historyIds.has(item.id)) {
      overlap.add(item.id);
    }
  }
  return overlap;
}

type SegmentedArraySource<T> = {
  excludedHistoryIds: ReadonlySet<string>;
  historyCount: number;
  historyNewestPage: TranscriptHistoryPage | undefined;
  historyPage: TranscriptHistoryPage | undefined;
  itemOverrides?: ReadonlyMap<string, T>;
  pageItems: (page: TranscriptHistoryPage) => readonly T[];
  tail: readonly T[];
};

function* iterateSegmentedArray<T extends { id: string }>(
  source: SegmentedArraySource<T>,
): Generator<T> {
  let page = source.historyPage;
  while (page) {
    for (const item of source.pageItems(page)) {
      if (!source.excludedHistoryIds.has(item.id)) {
        yield source.itemOverrides?.get(item.id) ?? item;
      }
    }
    page = page.newerPage;
  }
  yield* source.tail;
}

function* iterateSegmentedArrayReverse<T extends { id: string }>(
  source: SegmentedArraySource<T>,
): Generator<T> {
  for (let index = source.tail.length - 1; index >= 0; index -= 1) {
    yield source.tail[index]!;
  }

  let remainingHistoryItems =
    source.historyCount - source.excludedHistoryIds.size;
  let page = source.historyNewestPage;
  while (page && remainingHistoryItems > 0) {
    const items = source.pageItems(page);
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index]!;
      if (source.excludedHistoryIds.has(item.id)) {
        continue;
      }
      yield source.itemOverrides?.get(item.id) ?? item;
      remainingHistoryItems -= 1;
      if (remainingHistoryItems === 0) {
        return;
      }
    }
    page = page.olderPage;
  }
}

function normalizeSliceIndex(
  index: number | undefined,
  length: number,
  fallback: number,
): number {
  if (index === undefined) {
    return fallback;
  }
  const integer = Math.trunc(index);
  if (integer < 0) {
    return Math.max(length + integer, 0);
  }
  return Math.min(integer, length);
}

function segmentedSlice<T extends { id: string }>(
  source: SegmentedArraySource<T>,
  length: number,
  start?: number,
  end?: number,
): T[] {
  const normalizedStart = normalizeSliceIndex(start, length, 0);
  const normalizedEnd = normalizeSliceIndex(end, length, length);
  if (normalizedStart >= normalizedEnd) {
    return [];
  }

  if (normalizedEnd === length) {
    const output: T[] = [];
    const requestedCount = normalizedEnd - normalizedStart;
    for (const item of iterateSegmentedArrayReverse(source)) {
      output.push(item);
      if (output.length === requestedCount) {
        break;
      }
    }
    output.reverse();
    return output;
  }

  const output: T[] = [];
  let index = 0;
  for (const item of iterateSegmentedArray(source)) {
    if (index >= normalizedEnd) {
      break;
    }
    if (index >= normalizedStart) {
      output.push(item);
    }
    index += 1;
  }
  return output;
}

function readSegmentedIndex<T extends { id: string }>(
  source: SegmentedArraySource<T>,
  index: number,
  length: number,
): T | undefined {
  if (index < 0) {
    return undefined;
  }
  if (index >= length) {
    return undefined;
  }
  if (index > length / 2) {
    let currentIndex = length - 1;
    for (const item of iterateSegmentedArrayReverse(source)) {
      if (currentIndex === index) {
        return item;
      }
      currentIndex -= 1;
    }
    return undefined;
  }

  let currentIndex = 0;
  for (const item of iterateSegmentedArray(source)) {
    if (currentIndex === index) {
      return item;
    }
    currentIndex += 1;
  }
  return undefined;
}

function isArrayIndex(property: PropertyKey): property is string {
  return (
    typeof property === "string"
    && /^(?:0|[1-9]\d*)$/u.test(property)
  );
}

/**
 * Presents linked pages as the array shape the rest of the renderer already
 * consumes. Length reads and newest-window slices stay lazy; an operation
 * that genuinely needs the whole transcript materializes it once for this
 * view and then reuses that array.
 */
function createSegmentedArray<T extends { id: string }>(
  source: SegmentedArraySource<T>,
): T[] {
  const length = source.historyCount - source.excludedHistoryIds.size + source.tail.length;
  const target = new Array<T>(length);
  let materialized: T[] | undefined;
  const materialize = (): T[] => {
    materialized ??= [...iterateSegmentedArray(source)];
    return materialized;
  };

  const proxy = new Proxy(target, {
    deleteProperty: () => false,
    get: (_target, property) => {
      if (property === Symbol.iterator || property === "values") {
        return () => materialized?.values() ?? iterateSegmentedArray(source);
      }
      if (property === "entries") {
        return function* entries(): Generator<[number, T]> {
          let index = 0;
          for (const item of iterateSegmentedArray(source)) {
            yield [index, item];
            index += 1;
          }
        };
      }
      if (property === "keys") {
        return function* keys(): Generator<number> {
          for (let index = 0; index < length; index += 1) {
            yield index;
          }
        };
      }
      if (property === "slice") {
        return (start?: number, end?: number) =>
          materialized?.slice(start, end)
          ?? segmentedSlice(source, length, start, end);
      }
      if (property === "at") {
        return (index: number) => {
          const normalizedIndex = index < 0
            ? length + Math.trunc(index)
            : Math.trunc(index);
          return materialized?.at(normalizedIndex)
            ?? readSegmentedIndex(source, normalizedIndex, length);
        };
      }
      if (
        property === "concat"
        || property === "every"
        || property === "filter"
        || property === "find"
        || property === "findIndex"
        || property === "findLast"
        || property === "findLastIndex"
        || property === "flat"
        || property === "flatMap"
        || property === "forEach"
        || property === "includes"
        || property === "indexOf"
        || property === "join"
        || property === "lastIndexOf"
        || property === "map"
        || property === "reduce"
        || property === "reduceRight"
        || property === "some"
        || property === "toLocaleString"
        || property === "toString"
      ) {
        return (...args: unknown[]) => {
          const method = Reflect.get(materialize(), property) as (
            ...methodArgs: unknown[]
          ) => unknown;
          return method.apply(materialize(), args);
        };
      }
      if (property === "toJSON") {
        return () => materialize();
      }
      if (
        property === "copyWithin"
        || property === "fill"
        || property === "pop"
        || property === "push"
        || property === "reverse"
        || property === "shift"
        || property === "sort"
        || property === "splice"
        || property === "unshift"
      ) {
        return () => {
          throw new TypeError("Transcript entry views are read-only");
        };
      }
      if (isArrayIndex(property)) {
        // Existing renderer searches walk this array backwards with numeric
        // indexing. Materialize on the first indexed read so that one scan is
        // O(n) rather than traversing the page chain once per entry (O(n²)).
        return materialize()[Number(property)];
      }
      return Reflect.get(target, property, proxy);
    },
    getOwnPropertyDescriptor: (_target, property) => {
      if (isArrayIndex(property) && Number(property) < length) {
        return {
          configurable: true,
          enumerable: true,
          value: materialize()[Number(property)],
          writable: false,
        };
      }
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
    has: (_target, property) =>
      isArrayIndex(property)
        ? Number(property) < length
        : Reflect.has(target, property),
    ownKeys: () => {
      materialize();
      return [
        ...Array.from({ length }, (_value, index) => String(index)),
        "length",
      ];
    },
    set: () => false,
  });

  return proxy;
}

export function combineTranscriptEntries(
  history: LoadedTranscriptHistory | undefined,
  index: TranscriptHistoryIndex | undefined,
  tailEntries: AppServerThreadEntry[],
  presentation?: Pick<
    TranscriptReviewPresentation,
    "excludedHistoryEntryIds" | "historyEntryOverrides"
  >,
): AppServerThreadEntry[] {
  if (!history?.oldestPage || !index) {
    return tailEntries;
  }
  const excludedHistoryIds = historyOverlapIds(tailEntries, index.entryIds);
  for (const id of presentation?.excludedHistoryEntryIds ?? []) {
    excludedHistoryIds.add(id);
  }
  const historyInsertions = placeMisorderedCompletedActivityInHistory(
    tailEntries,
    index,
  );
  const insertedEntries = new Set(
    [...historyInsertions.values()].flatMap((insertionsByIndex) =>
      [...insertionsByIndex.values()].flat()
    )
  );
  const projectedTailEntries = insertedEntries.size > 0
    ? tailEntries.filter((entry) => !insertedEntries.has(entry))
    : tailEntries;
  return createSegmentedArray({
    excludedHistoryIds,
    historyCount: history.entryCount + insertedEntries.size,
    historyNewestPage: history.newestPage,
    historyPage: history.oldestPage,
    itemOverrides: presentation?.historyEntryOverrides,
    pageItems: (page) => entriesWithHistoryInsertions(
      page,
      historyInsertions.get(page),
    ),
    tail: projectedTailEntries,
  });
}

type HistoryEntryInsertions = Map<
  TranscriptHistoryPage,
  Map<number, AppServerThreadEntry[]>
>;

function isCompletedActivityEntry(
  entry: AppServerThreadEntry,
): boolean {
  const status = entry.turn?.status;
  return (
    entry.type === "activity"
    && Boolean(entry.turn)
    && (
      status === "completed"
      || status === "failed"
      || status === "cancelled"
      || status === "interrupted"
      || typeof entry.turn?.completedAt === "number"
      || typeof entry.turn?.durationMs === "number"
    )
  );
}

function transcriptEntryTime(entry: AppServerThreadEntry): number | undefined {
  return entry.createdAt ?? entry.turn?.completedAt ?? entry.turn?.startedAt;
}

function findHistoryInsertionPoint(
  entry: AppServerThreadEntry,
  turnPages: TranscriptHistoryTurnPage[],
): { entryIndex: number; page: TranscriptHistoryPage } | undefined {
  const entryTime = transcriptEntryTime(entry);
  let lastTurnEntry:
    | { entryIndex: number; page: TranscriptHistoryPage }
    | undefined;

  for (let pageIndex = turnPages.length - 1; pageIndex >= 0; pageIndex -= 1) {
    const turnPage = turnPages[pageIndex]!;
    for (const entryIndex of turnPage.entryIndexes) {
      const historyEntry = turnPage.page.entries[entryIndex];
      if (!historyEntry) {
        continue;
      }
      const historyEntryTime = transcriptEntryTime(historyEntry);
      if (
        typeof entryTime === "number"
        && typeof historyEntryTime === "number"
        && historyEntryTime > entryTime
      ) {
        return { entryIndex, page: turnPage.page };
      }
      lastTurnEntry = { entryIndex, page: turnPage.page };
    }
  }

  return lastTurnEntry
    ? {
        entryIndex: lastTurnEntry.entryIndex + 1,
        page: lastTurnEntry.page,
      }
    : undefined;
}

function placeMisorderedCompletedActivityInHistory(
  tailEntries: AppServerThreadEntry[],
  index: TranscriptHistoryIndex,
): HistoryEntryInsertions {
  const insertions: HistoryEntryInsertions = new Map();
  let greatestSeenTime: number | undefined;

  for (const entry of tailEntries) {
    const entryTime = transcriptEntryTime(entry);
    const turnId = entry.turn?.id;
    const turnPages = turnId ? index.turnPages.get(turnId) : undefined;
    // A turn can legitimately span the history/tail boundary. Move only a
    // completed activity that has already fallen behind a newer tail item.
    // The owning-turn index then restores its position without walking pages
    // from unrelated turns on each streamed update.
    const belongsBeforeTail =
      isCompletedActivityEntry(entry)
      && typeof entryTime === "number"
      && typeof greatestSeenTime === "number"
      && entryTime < greatestSeenTime
      && Boolean(turnPages?.length)
      && !index.entryIds.has(entry.id);
    if (belongsBeforeTail && turnPages) {
      const insertionPoint = findHistoryInsertionPoint(entry, turnPages);
      if (insertionPoint) {
        const insertionsByIndex = insertions.get(insertionPoint.page) ?? new Map();
        const entries = insertionsByIndex.get(insertionPoint.entryIndex) ?? [];
        entries.push(entry);
        insertionsByIndex.set(insertionPoint.entryIndex, entries);
        insertions.set(insertionPoint.page, insertionsByIndex);
        continue;
      }
    }

    if (typeof entryTime === "number") {
      greatestSeenTime = Math.max(greatestSeenTime ?? entryTime, entryTime);
    }
  }

  return insertions;
}

function entriesWithHistoryInsertions(
  page: TranscriptHistoryPage,
  insertionsByIndex: Map<number, AppServerThreadEntry[]> | undefined,
): AppServerThreadEntry[] {
  if (!insertionsByIndex || insertionsByIndex.size === 0) {
    return page.entries;
  }

  const entries: AppServerThreadEntry[] = [];
  for (let entryIndex = 0; entryIndex <= page.entries.length; entryIndex += 1) {
    entries.push(...(insertionsByIndex.get(entryIndex) ?? []));
    if (entryIndex < page.entries.length) {
      entries.push(page.entries[entryIndex]!);
    }
  }
  return entries;
}

export function combineTranscriptMessages(
  history: LoadedTranscriptHistory | undefined,
  index: TranscriptHistoryIndex | undefined,
  tailMessages: AppServerThreadMessage[],
  presentation?: Pick<
    TranscriptReviewPresentation,
    "excludedHistoryMessageIds"
  >,
): AppServerThreadMessage[] {
  if (!history?.oldestPage || !index) {
    return tailMessages;
  }
  const excludedHistoryIds = historyOverlapIds(tailMessages, index.messageIds);
  for (const id of presentation?.excludedHistoryMessageIds ?? []) {
    excludedHistoryIds.add(id);
  }
  return createSegmentedArray({
    excludedHistoryIds,
    historyCount: history.messageCount,
    historyNewestPage: history.newestPage,
    historyPage: history.oldestPage,
    pageItems: (page) => page.messages,
    tail: tailMessages,
  });
}

export function createTranscriptReviewPresentation(params: {
  history: LoadedTranscriptHistory | undefined;
  index: TranscriptHistoryIndex | undefined;
  tailEntries: AppServerThreadEntry[];
  tailMessages: AppServerThreadMessage[];
}): TranscriptReviewPresentation {
  return deriveTranscriptReviewPresentation({
    historyEvents: params.history && params.index
      ? iterateTranscriptReviewHistoryEvents(params.index.review)
      : [],
    historyIndex:
      params.index?.review
      ?? createTranscriptReviewHistoryIndex(),
    tailEntries: params.tailEntries,
    tailMessages: params.tailMessages,
  });
}

export function combineTranscriptResponse(params: {
  history: LoadedTranscriptHistory | undefined;
  index: TranscriptHistoryIndex | undefined;
  response: AppServerReadThreadResponse | undefined;
}): AppServerReadThreadResponse | undefined {
  if (!params.response || !params.history) {
    return params.response;
  }
  return {
    ...params.response,
    replay: {
      ...params.response.replay,
      entries: combineTranscriptEntries(
        params.history,
        params.index,
        params.response.replay.entries,
      ),
      messages: combineTranscriptMessages(
        params.history,
        params.index,
        params.response.replay.messages,
      ),
      pagination: params.history.pagination,
    },
  };
}
