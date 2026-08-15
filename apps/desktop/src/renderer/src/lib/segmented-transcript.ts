import type {
  AppServerReadThreadResponse,
  AppServerThreadEntry,
  AppServerThreadMessage,
} from "@pwragent/shared";

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

export type TranscriptHistoryIndex = {
  entryIds: Set<string>;
  messageIds: Set<string>;
};

export function createTranscriptHistoryIndex(): TranscriptHistoryIndex {
  return {
    entryIds: new Set(),
    messageIds: new Set(),
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

  for (const entry of entries) {
    params.index.entryIds.add(entry.id);
  }
  for (const message of messages) {
    params.index.messageIds.add(message.id);
  }

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
        yield item;
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
      yield item;
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
): AppServerThreadEntry[] {
  if (!history?.oldestPage || !index) {
    return tailEntries;
  }
  const excludedHistoryIds = historyOverlapIds(tailEntries, index.entryIds);
  return createSegmentedArray({
    excludedHistoryIds,
    historyCount: history.entryCount,
    historyNewestPage: history.newestPage,
    historyPage: history.oldestPage,
    pageItems: (page) => page.entries,
    tail: tailEntries,
  });
}

export function combineTranscriptMessages(
  history: LoadedTranscriptHistory | undefined,
  index: TranscriptHistoryIndex | undefined,
  tailMessages: AppServerThreadMessage[],
): AppServerThreadMessage[] {
  if (!history?.oldestPage || !index) {
    return tailMessages;
  }
  const excludedHistoryIds = historyOverlapIds(tailMessages, index.messageIds);
  return createSegmentedArray({
    excludedHistoryIds,
    historyCount: history.messageCount,
    historyNewestPage: history.newestPage,
    historyPage: history.oldestPage,
    pageItems: (page) => page.messages,
    tail: tailMessages,
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
