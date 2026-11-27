import type {
  AppServerReadThreadResponse,
  AppServerThreadEntry,
  AppServerThreadMessage,
  AppServerThreadMessageEntry,
} from "@pwragent/shared/contracts/normalized-app-server";
import { turnUsageEntryTurnId } from "@pwragent/shared/thread-usage-display";
import { applyCorrespondenceRevision, isCorrespondenceEntry } from "./transcript-correspondence";
import { isTurnAnswer, lateWorkBelongsAboveAnswer } from "../features/thread-detail/turn-answer-placement";
import {
  addTranscriptReviewSegmentToIndex,
  createTranscriptReviewHistoryIndex,
  deriveTranscriptReviewPresentation,
  presentIndexedTranscriptReviews,
  reviseArchivedAssistantReviewEvidence,
  summarizeTranscriptReviewSegment,
  type TranscriptReviewHistoryIndex,
  type TranscriptReviewPresentation,
} from "./transcript-review-presentation";

export type TranscriptHistoryPage = {
  entries: AppServerThreadEntry[];
  entryCount: number;
  messageCount: number;
  messages: AppServerThreadMessage[];
  prompts: AppServerThreadMessageEntry[];
  newerPage?: TranscriptHistoryPage;
  olderPage?: TranscriptHistoryPage;
  olderPromptPage?: TranscriptHistoryPage;
};

export type LoadedTranscriptHistory = {
  entryCount: number;
  messageCount: number;
  newestPage?: TranscriptHistoryPage;
  oldestPage?: TranscriptHistoryPage;
  newestPromptPage?: TranscriptHistoryPage;
  oldestPromptPage?: TranscriptHistoryPage;
  previous?: LoadedTranscriptHistory;
  appendedPage?: TranscriptHistoryPage;
  pagination: AppServerReadThreadResponse["replay"]["pagination"];
};

type TranscriptHistoryTurnPage = {
  entryIndexes: number[];
  page: TranscriptHistoryPage;
};

type TranscriptHistoryInsertionPoint = {
  entryIndex: number;
  page: TranscriptHistoryPage;
  placement: "before" | "after";
};

type CachedRetainedEntryPlacement = {
  entryTime: number | undefined;
  insertionPoint: TranscriptHistoryInsertionPoint;
  turnId: string;
  turnPageCount: number;
};

type TranscriptRevision<T> = { value: T; version: number; previous?: TranscriptRevision<T> };

export type TranscriptHistoryIndex = {
  entryIds: Set<string>;
  messageIds: Set<string>;
  warmEntryIds: Set<string>;
  warmMessageIds: Set<string>;
  warmEntryOverrides: Map<string, TranscriptRevision<AppServerThreadEntry>>;
  warmMessageOverrides: Map<string, TranscriptRevision<AppServerThreadMessage>>;
  correspondenceById: Map<string, AppServerThreadMessageEntry>;
  warmRevisionVersion: number;
  activityRevision: number;
  promptsById: Map<string, AppServerThreadMessageEntry>;
  promptsByTurn: Map<string, AppServerThreadMessageEntry[]>;
  retainedEntryPlacements: Map<string, CachedRetainedEntryPlacement>;
  review: TranscriptReviewHistoryIndex;
  turnPages: Map<string, TranscriptHistoryTurnPage[]>;
};

export function createTranscriptHistoryIndex(): TranscriptHistoryIndex {
  return {
    entryIds: new Set(),
    messageIds: new Set(),
    warmEntryIds: new Set(),
    warmMessageIds: new Set(),
    warmEntryOverrides: new Map(),
    warmMessageOverrides: new Map(),
    correspondenceById: new Map(),
    warmRevisionVersion: 0,
    activityRevision: 0,
    promptsById: new Map(),
    promptsByTurn: new Map(),
    retainedEntryPlacements: new Map(),
    review: createTranscriptReviewHistoryIndex(),
    turnPages: new Map(),
  };
}

function transcriptRevisionAt<T>(revisions: ReadonlyMap<string, TranscriptRevision<T>>, id: string, version: number): T | undefined {
  let revision = revisions.get(id);
  while (revision && revision.version > version) revision = revision.previous;
  return revision?.value;
}

function messagesForEntries(
  entries: AppServerThreadEntry[],
  messages: AppServerThreadMessage[],
  prompts?: AppServerThreadMessageEntry[],
): AppServerThreadMessage[] {
  const messagesById = new Map(messages.map((message) => [message.id, message]));

  return entries.flatMap((entry) => {
    if (entry.type !== "message") {
      return [];
    }
    if (entry.role === "user") prompts?.push(entry);

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

function isTranscriptPrompt(entry: AppServerThreadEntry): entry is AppServerThreadMessageEntry {
  return entry.type === "message" && entry.role === "user";
}

/**
 * Adds one server page without traversing or copying previously loaded pages.
 *
 * The index is an append-only, non-rendered companion owned by one thread
 * session. Keeping it outside React state is deliberate: cloning a growing
 * Set here would merely move the cumulative history copy from the entry array
 * to the ID index.
 */
type TranscriptHistoryPageInput = {
  history: LoadedTranscriptHistory | undefined;
  index: TranscriptHistoryIndex;
  page: AppServerReadThreadResponse;
  tailEntries: AppServerThreadEntry[];
};

export function prependTranscriptHistoryPage(params: TranscriptHistoryPageInput): LoadedTranscriptHistory {
  return retainTranscriptPage(params, "older");
}

export function appendTranscriptHistoryPage(params: TranscriptHistoryPageInput): LoadedTranscriptHistory {
  return retainTranscriptPage(params, "newer");
}

function retainTranscriptPage(params: TranscriptHistoryPageInput, position: "older" | "newer"): LoadedTranscriptHistory {
  const tailEntryIds = new Set(params.tailEntries.map((entry) => entry.id));
  const correspondence = params.index.correspondenceById;
  if (position === "newer") {
    const revisions = params.page.replay.entries.filter((entry) => params.index.entryIds.has(entry.id) && !tailEntryIds.has(entry.id));
    if (revisions.length > 0) {
      // Record only the touched IDs. An existing view captures its revision
      // version, so later updates need no copies of its historical overrides.
      const version = ++params.index.warmRevisionVersion;
      const updated = revisions.map((entry) => {
        const original = correspondence.get(entry.id);
        if (entry.type !== "message" || !original) return entry;
        const latest = params.index.warmEntryOverrides.get(entry.id)?.value;
        return applyCorrespondenceRevision(latest?.type === "message" ? latest : original, entry, true);
      });
      for (const entry of updated) {
        if (entry.type === "activity") params.index.activityRevision++;
        params.index.warmEntryIds.add(entry.id);
        const entries = params.index.warmEntryOverrides;
        entries.set(entry.id, { value: entry, version, previous: entries.get(entry.id) });
      }
      const revisedMessages = messagesForEntries(updated,
        params.page.replay.messages.filter((message) => !correspondence.has(message.id)));
      for (const message of revisedMessages) {
        if (!params.index.messageIds.has(message.id)) continue;
        params.index.warmMessageIds.add(message.id);
        const messages = params.index.warmMessageOverrides;
        messages.set(message.id, { value: message, version, previous: messages.get(message.id) });
      }
      reviseArchivedAssistantReviewEvidence(params.index.review, updated, revisedMessages);
    }
  }
  const entries = params.page.replay.entries.filter(
    (entry) =>
      (!tailEntryIds.has(entry.id) || isCorrespondenceEntry(entry))
      && !params.index.entryIds.has(entry.id),
  );
  const prompts: AppServerThreadMessageEntry[] = [];
  const messages = messagesForEntries(entries, params.page.replay.messages, prompts);
  const reviewSummary = summarizeTranscriptReviewSegment(entries, messages);

  for (const entry of entries) {
    params.index.entryIds.add(entry.id);
    if (isCorrespondenceEntry(entry)) correspondence.set(entry.id, entry);
    if (position === "newer" || correspondence.has(entry.id)) params.index.warmEntryIds.add(entry.id);
  }
  for (const message of messages) {
    params.index.messageIds.add(message.id);
    if (position === "newer" || correspondence.has(message.id)) params.index.warmMessageIds.add(message.id);
  }
  addTranscriptReviewSegmentToIndex(
    params.index.review, reviewSummary, position,
    position === "newer" && !entries.some((entry) => !entry.turn?.id || params.index.turnPages.has(entry.turn.id)),
  );

  const previousEntryCount = params.history?.entryCount ?? 0;
  const previousMessageCount = params.history?.messageCount ?? 0;
  let oldestPage = params.history?.oldestPage;
  let newestPage = params.history?.newestPage;
  let newestPromptPage = params.history?.newestPromptPage;
  let oldestPromptPage = params.history?.oldestPromptPage;
  let appendedPage: TranscriptHistoryPage | undefined;
  if (entries.length > 0) {
    const page: TranscriptHistoryPage = {
      entries,
      entryCount: entries.length,
      messageCount: messages.length,
      messages,
      prompts,
    };
    // Both links are append-only. Array views capture their own first and
    // last page so linking new pages does not grow a previously returned view.
    if (position === "newer") {
      page.olderPage = newestPage;
      if (newestPage) newestPage.newerPage = page;
      newestPage = page;
      oldestPage ??= page;
      appendedPage = page;
    } else {
      page.newerPage = oldestPage;
      if (oldestPage) oldestPage.olderPage = page;
      oldestPage = page;
      newestPage ??= page;
    }
    if (prompts.length > 0) {
      if (position === "newer") {
        page.olderPromptPage = newestPromptPage;
        newestPromptPage = page;
        oldestPromptPage ??= page;
      } else {
        if (oldestPromptPage) oldestPromptPage.olderPromptPage = page;
        oldestPromptPage = page;
        newestPromptPage ??= page;
      }
      const promptsByTurn = new Map<string, AppServerThreadMessageEntry[]>();
      for (const prompt of prompts) {
        params.index.promptsById.set(prompt.id, prompt);
        if (!prompt.turn?.id) continue;
        const byTurn = promptsByTurn.get(prompt.turn.id) ?? [];
        byTurn.push(prompt);
        promptsByTurn.set(prompt.turn.id, byTurn);
      }
      for (const [turnId, prompts] of promptsByTurn) {
        const previous = params.index.promptsByTurn.get(turnId);
        if (!previous) params.index.promptsByTurn.set(turnId, prompts);
        else if (position === "newer") previous.push(...prompts);
        else previous.unshift(...prompts);
      }
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
      // The insertion helper visits the oldest page first.
      if (position === "newer") turnPages.unshift({ entryIndexes, page });
      else turnPages.push({ entryIndexes, page });
      params.index.turnPages.set(turnId, turnPages);
    }
  }

  return {
    entryCount: previousEntryCount + entries.length,
    messageCount: previousMessageCount + messages.length,
    newestPage,
    oldestPage,
    newestPromptPage,
    oldestPromptPage,
    ...(appendedPage ? { previous: params.history, appendedPage } : {}),
    pagination: position === "newer" && params.history ? params.history.pagination : params.page.replay.pagination,
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

type TranscriptIdLookup = Pick<ReadonlySet<string>, "has" | "size">;
const projectedHistoryExclusions = new WeakMap<ReadonlySet<string>, {
  index: ReadonlySet<string>; indexSize: number; ids: Set<string>;
}>();

function excludedIndexedHistoryIds<T extends { id: string }>(
  tail: T[],
  historyIds: ReadonlySet<string>,
  presentationIds: ReadonlySet<string> | undefined,
  exclusionsAreIndexed?: boolean,
  revisionVisibility?: ReadonlyMap<string, boolean>,
): TranscriptIdLookup {
  const overlap = historyOverlapIds(tail, historyIds);
  if (!presentationIds?.size && !revisionVisibility?.size) return overlap;
  let excluded = presentationIds;
  if (presentationIds?.size && !exclusionsAreIndexed) {
    let projection = projectedHistoryExclusions.get(presentationIds);
    if (projection?.index !== historyIds || projection.indexSize !== historyIds.size) {
      const ids = new Set<string>();
      for (const id of presentationIds) if (historyIds.has(id)) ids.add(id);
      projection = { index: historyIds, indexSize: historyIds.size, ids };
      projectedHistoryExclusions.set(presentationIds, projection);
    }
    excluded = projection.ids;
  }
  let size = overlap.size + (excluded?.size ?? 0);
  for (const id of overlap) if (excluded?.has(id)) size--;
  const wasExcluded = (id: string) => overlap.has(id) || excluded?.has(id) === true;
  for (const [id, visible] of revisionVisibility ?? []) {
    if (wasExcluded(id) === visible) size += visible ? -1 : 1;
  }
  return {
    size,
    has: (id) => revisionVisibility?.has(id) ? !revisionVisibility.get(id) : wasExcluded(id),
  };
}

type SegmentedArraySource<T> = {
  excludedHistoryIds: TranscriptIdLookup;
  excludedTailIds?: ReadonlySet<string>;
  historyCount: number;
  historyNewestPage: TranscriptHistoryPage | undefined;
  historyPage: TranscriptHistoryPage | undefined;
  itemOverrides?: Pick<ReadonlyMap<string, T>, "get">;
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
    if (page === source.historyNewestPage) break;
    page = page.newerPage;
  }
  for (const item of source.tail) {
    if (!source.excludedTailIds?.has(item.id)) {
      yield item;
    }
  }
}

function* iterateSegmentedArrayReverse<T extends { id: string }>(
  source: SegmentedArraySource<T>,
): Generator<T> {
  for (let index = source.tail.length - 1; index >= 0; index -= 1) {
    const item = source.tail[index]!;
    if (!source.excludedTailIds?.has(item.id)) {
      yield item;
    }
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
  const length =
    source.historyCount
    - source.excludedHistoryIds.size
    + source.tail.length
    - (source.excludedTailIds?.size ?? 0);
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

function separateWarmRevisions<T extends { id: string }>(items: T[], warmIds: ReadonlySet<string>) {
  const revisions = new Map<string, T>();
  if (!warmIds.size) return { tail: items, revisions };
  const tail = items.filter((item) => {
    if (!warmIds.has(item.id)) return true;
    revisions.set(item.id, item);
    return false;
  });
  return { tail, revisions };
}

export type SegmentedTranscriptDisplay = {
  history: LoadedTranscriptHistory;
  tail: readonly AppServerThreadEntry[];
  activityRevision: number;
  historicalActivityOverlays: readonly AppServerThreadEntry[];
  entriesForPage: (page: TranscriptHistoryPage) => Iterable<AppServerThreadEntry>;
  entriesForTurn: (turnId: string | undefined) => Iterable<AppServerThreadEntry>;
  latestPrompt: (predicate?: (entry: AppServerThreadMessageEntry) => boolean) => AppServerThreadMessageEntry | undefined;
  hasRewindablePrompt: (allowUnbound: boolean) => boolean;
  isFirstPrompt: (id: string, allowUnbound: boolean) => boolean;
};

const displaySegments = new WeakMap<readonly unknown[], SegmentedTranscriptDisplay>();

export function segmentedTranscriptDisplay(entries: readonly unknown[]): SegmentedTranscriptDisplay | undefined {
  return displaySegments.get(entries);
}

export function combineTranscriptEntries(
  history: LoadedTranscriptHistory | undefined,
  index: TranscriptHistoryIndex | undefined,
  tailEntries: AppServerThreadEntry[],
  presentation?: Pick<
    TranscriptReviewPresentation,
    "excludedHistoryEntryIds" | "historyEntryOverrides" | "indexedHistoryExclusions" | "revisedHistoryEntryVisibility"
  >,
  retainedEntries: readonly AppServerThreadEntry[] = [],
): AppServerThreadEntry[] {
  if (!history?.oldestPage || !index) {
    return tailEntries;
  }
  // A later item revision or a fresh owner page can carry a copy of a row
  // already promoted from this live tail. Use its payload in the old slot.
  const { tail, revisions } = separateWarmRevisions(tailEntries, index.warmEntryIds);
  const excludedHistoryIds = excludedIndexedHistoryIds(
    tail, index.entryIds, presentation?.excludedHistoryEntryIds, presentation?.indexedHistoryExclusions,
    presentation?.revisedHistoryEntryVisibility,
  );
  const warmOverrides = index.warmEntryOverrides;
  const warmRevisionVersion = index.warmRevisionVersion;
  for (const [id, tailRevision] of revisions) {
    const historical = index.correspondenceById.get(id);
    if (historical && tailRevision.type === "message") {
      const warmRevision = transcriptRevisionAt(warmOverrides, id, warmRevisionVersion);
      revisions.set(id, applyCorrespondenceRevision(warmRevision?.type === "message" ? warmRevision : historical, tailRevision, true));
    }
  }
  const historyInsertions = placeRetainedArtifactsInHistory(
    retainedEntries,
    index,
  );
  const insertedEntryIds = new Set(
    [...historyInsertions.values()].flatMap((pageInsertions) => [
      ...[...pageInsertions.before.values()].flat().map((entry) => entry.id),
      ...[...pageInsertions.after.values()].flat().map((entry) => entry.id),
    ])
  );
  const source: SegmentedArraySource<AppServerThreadEntry> = {
    excludedHistoryIds,
    excludedTailIds: insertedEntryIds,
    historyCount: history.entryCount + insertedEntryIds.size,
    historyNewestPage: history.newestPage,
    historyPage: history.oldestPage,
    itemOverrides: revisions.size || warmOverrides.size || presentation?.historyEntryOverrides.size
      ? { get: (id) => revisions.get(id)
        ?? transcriptRevisionAt(warmOverrides, id, warmRevisionVersion)
        ?? presentation?.historyEntryOverrides.get(id) }
      : undefined,
    pageItems: (page) => entriesWithHistoryInsertions(
      page,
      historyInsertions.get(page),
    ),
    tail,
  };
  const entries = createSegmentedArray(source);
  const visibleTail = insertedEntryIds.size ? tail.filter((entry) => !insertedEntryIds.has(entry.id)) : tail;
  const visiblePrompt = (prompt: AppServerThreadMessageEntry) => {
    if (excludedHistoryIds.has(prompt.id)) return undefined;
    const resolved = source.itemOverrides?.get(prompt.id) ?? prompt;
    return isTranscriptPrompt(resolved) ? resolved : undefined;
  };
  const latestPrompt: SegmentedTranscriptDisplay["latestPrompt"] = (predicate) => {
    const live = visibleTail.findLast((entry): entry is AppServerThreadMessageEntry =>
      isTranscriptPrompt(entry) && (!predicate || predicate(entry)));
    if (live) return live;
    let page = history.newestPromptPage;
    while (page) {
      for (let position = page.prompts.length - 1; position >= 0; position--) {
        const prompt = visiblePrompt(page.prompts[position]!);
        if (prompt && (!predicate || predicate(prompt))) return prompt;
      }
      if (page === history.oldestPromptPage) break;
      page = page.olderPromptPage;
    }
    return undefined;
  };
  displaySegments.set(entries, {
    history,
    tail: visibleTail,
    activityRevision: index.activityRevision,
    historicalActivityOverlays: tailEntries.filter((entry) => entry.type === "activity"
      && (index.entryIds.has(entry.id) || insertedEntryIds.has(entry.id))),
    *entriesForPage(page) {
      for (const entry of source.pageItems(page)) {
        if (!excludedHistoryIds.has(entry.id)) yield source.itemOverrides?.get(entry.id) ?? entry;
      }
    },
    *entriesForTurn(turnId) {
      for (const entry of visibleTail) if (!turnId || entry.turn?.id === turnId) yield entry;
      if (!turnId) return;
      const pages = index.turnPages.get(turnId) ?? [];
      for (const { page, entryIndexes } of pages) {
        for (const position of entryIndexes) {
          const entry = page.entries[position]!;
          if (!excludedHistoryIds.has(entry.id)) yield source.itemOverrides?.get(entry.id) ?? entry;
        }
      }
    },
    latestPrompt,
    hasRewindablePrompt: (allowUnbound) => allowUnbound
      ? Boolean(latestPrompt())
      : visibleTail.some((entry) => isTranscriptPrompt(entry) && Boolean(entry.turn?.id))
        || (index.promptsByTurn.size > 0 && Boolean(latestPrompt((entry) => Boolean(entry.turn?.id)))),
    isFirstPrompt(id, allowUnbound) {
      const live = visibleTail.find((entry): entry is AppServerThreadMessageEntry => entry.id === id && isTranscriptPrompt(entry));
      const historical = index.promptsById.get(id);
      const candidate = live ?? (historical && visiblePrompt(historical));
      if (!candidate) return false;
      const turnId = candidate.turn?.id;
      if (!turnId) return allowUnbound;
      const firstHistorical = index.promptsByTurn.get(turnId)?.find((entry) => visiblePrompt(entry)?.turn?.id === turnId);
      if (firstHistorical) return firstHistorical.id === id;
      return visibleTail.find((entry) => isTranscriptPrompt(entry) && entry.turn?.id === turnId)?.id === id;
    },
  });
  return entries;
}

type HistoryPageInsertions = {
  before: Map<number, AppServerThreadEntry[]>;
  after: Map<number, AppServerThreadEntry[]>;
};

type HistoryEntryInsertions = Map<
  TranscriptHistoryPage,
  HistoryPageInsertions
>;

function isTerminalRetainedArtifactEntry(
  entry: AppServerThreadEntry,
): boolean {
  const status = entry.turn?.status;
  return (
    (entry.type === "activity" || entry.type === "plan")
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
  const createdAt = entry.createdAt;
  if (typeof createdAt === "number") {
    return createdAt;
  }
  if (entry.type === "message" && entry.role === "user") {
    return entry.turn?.startedAt;
  }
  return entry.turn?.completedAt ?? entry.turn?.startedAt;
}

/**
 * The time a retained row is placed by. A turn total has none: its place is
 * after the last entry of its turn, wherever its own clock landed.
 */
function retainedPlacementTime(entry: AppServerThreadEntry): number | undefined {
  return turnUsageEntryTurnId(entry) === undefined
    ? transcriptEntryTime(entry)
    : undefined;
}

function findHistoryInsertionPoint(
  entry: AppServerThreadEntry,
  turnId: string,
  turnPages: TranscriptHistoryTurnPage[],
): TranscriptHistoryInsertionPoint | undefined {
  const entryTime = retainedPlacementTime(entry);
  let lastTurnEntry:
    | { entryIndex: number; page: TranscriptHistoryPage }
    | undefined;
  let firstTurnTotal: TranscriptHistoryInsertionPoint | undefined;
  // The first entry stamped later than the row, and the turn's last reply.
  // `position` orders them across pages.
  let laterEntry:
    | (TranscriptHistoryInsertionPoint & { position: number })
    | undefined;
  let lastAnswer:
    | (TranscriptHistoryInsertionPoint & {
        answer: AppServerThreadEntry;
        position: number;
      })
    | undefined;
  let position = 0;

  for (let pageIndex = turnPages.length - 1; pageIndex >= 0; pageIndex -= 1) {
    const turnPage = turnPages[pageIndex]!;
    for (const entryIndex of turnPage.entryIndexes) {
      const historyEntry = turnPage.page.entries[entryIndex];
      if (!historyEntry) {
        continue;
      }
      // The page's own turn total is no anchor: retained work belongs above
      // it, and a retained total beside it.
      if (turnUsageEntryTurnId(historyEntry) !== undefined) {
        firstTurnTotal ??= { entryIndex, page: turnPage.page, placement: "before" };
        continue;
      }
      position += 1;
      const historyEntryTime = transcriptEntryTime(historyEntry);
      const isOpeningPrompt =
        position === 1 && historyEntry.type === "message" && historyEntry.role === "user";
      if (
        !laterEntry
        && !isOpeningPrompt
        && typeof entryTime === "number"
        && typeof historyEntryTime === "number"
        && historyEntryTime > entryTime
      ) {
        // With no reply above it, this entry is the row's place.
        if (!lastAnswer) {
          return { entryIndex, page: turnPage.page, placement: "before" };
        }
        laterEntry = { entryIndex, page: turnPage.page, placement: "before", position };
      }
      if (isTurnAnswer(historyEntry, turnId)) {
        lastAnswer = {
          answer: historyEntry,
          entryIndex,
          page: turnPage.page,
          placement: "before",
          position,
        };
      }
      lastTurnEntry = { entryIndex, page: turnPage.page };
    }
  }

  // A finished turn's work goes above its answer, however late its stamp,
  // unless an entry stamped later than the row comes first.
  if (
    lastAnswer
    && (!laterEntry || laterEntry.position > lastAnswer.position)
    && lateWorkBelongsAboveAnswer(entry, lastAnswer.answer)
  ) {
    return { entryIndex: lastAnswer.entryIndex, page: lastAnswer.page, placement: "before" };
  }
  if (laterEntry) {
    return { entryIndex: laterEntry.entryIndex, page: laterEntry.page, placement: "before" };
  }

  // A page split inside the turn can carry only the turn's total; the row
  // still belongs with its turn, just above that total.
  return lastTurnEntry
    ? {
        entryIndex: lastTurnEntry.entryIndex,
        page: lastTurnEntry.page,
        placement: "after",
      }
    : firstTurnTotal;
}

function retainedEntryInsertionPoint(
  entry: AppServerThreadEntry,
  index: TranscriptHistoryIndex,
  turnId: string,
  turnPages: TranscriptHistoryTurnPage[],
): TranscriptHistoryInsertionPoint | undefined {
  const entryTime = retainedPlacementTime(entry);
  const cached = index.retainedEntryPlacements.get(entry.id);
  if (
    cached
    && cached.entryTime === entryTime
    && cached.turnId === turnId
    && cached.turnPageCount === turnPages.length
  ) {
    return cached.insertionPoint;
  }

  const insertionPoint = findHistoryInsertionPoint(entry, turnId, turnPages);
  if (insertionPoint) {
    index.retainedEntryPlacements.set(entry.id, {
      entryTime,
      insertionPoint,
      turnId,
      turnPageCount: turnPages.length,
    });
  }
  return insertionPoint;
}

function placeRetainedArtifactsInHistory(
  retainedEntries: readonly AppServerThreadEntry[],
  index: TranscriptHistoryIndex,
): HistoryEntryInsertions {
  const insertions: HistoryEntryInsertions = new Map();

  for (const entry of retainedEntries) {
    const turnId = entry.turn?.id;
    const turnPages = turnId ? index.turnPages.get(turnId) : undefined;
    // ThreadView supplies only the small set of live artifacts retained at a
    // terminal turn boundary. The owning-turn index avoids any transcript
    // history scan, and the cached insertion point avoids rescanning even
    // that turn while a newer message streams character updates.
    const belongsInHistory =
      isTerminalRetainedArtifactEntry(entry)
      && Boolean(turnPages?.length)
      && !index.entryIds.has(entry.id);
    if (belongsInHistory && turnId && turnPages) {
      const insertionPoint = retainedEntryInsertionPoint(
        entry,
        index,
        turnId,
        turnPages,
      );
      if (insertionPoint) {
        const pageInsertions = insertions.get(insertionPoint.page) ?? {
          before: new Map(),
          after: new Map(),
        };
        const bucket =
          insertionPoint.placement === "before"
            ? pageInsertions.before
            : pageInsertions.after;
        const entries = bucket.get(insertionPoint.entryIndex) ?? [];
        entries.push(entry);
        bucket.set(insertionPoint.entryIndex, entries);
        insertions.set(insertionPoint.page, pageInsertions);
        continue;
      }
    }
  }

  return insertions;
}

function entriesWithHistoryInsertions(
  page: TranscriptHistoryPage,
  pageInsertions: HistoryPageInsertions | undefined,
): AppServerThreadEntry[] {
  if (
    !pageInsertions
    || (pageInsertions.before.size === 0 && pageInsertions.after.size === 0)
  ) {
    return page.entries;
  }

  const entries: AppServerThreadEntry[] = [];
  for (let entryIndex = 0; entryIndex < page.entries.length; entryIndex += 1) {
    entries.push(...(pageInsertions.before.get(entryIndex) ?? []));
    entries.push(page.entries[entryIndex]!);
    entries.push(...(pageInsertions.after.get(entryIndex) ?? []));
  }
  return entries;
}

export function combineTranscriptMessages(
  history: LoadedTranscriptHistory | undefined,
  index: TranscriptHistoryIndex | undefined,
  tailMessages: AppServerThreadMessage[],
  presentation?: Pick<
    TranscriptReviewPresentation,
    "excludedHistoryMessageIds" | "indexedHistoryExclusions" | "revisedHistoryMessageVisibility"
  >,
): AppServerThreadMessage[] {
  if (!history?.oldestPage || !index) {
    return tailMessages;
  }
  const { tail, revisions } = separateWarmRevisions(tailMessages, index.warmMessageIds);
  const excludedHistoryIds = excludedIndexedHistoryIds(
    tail, index.messageIds, presentation?.excludedHistoryMessageIds, presentation?.indexedHistoryExclusions,
    presentation?.revisedHistoryMessageVisibility,
  );
  const warmOverrides = index.warmMessageOverrides;
  const warmRevisionVersion = index.warmRevisionVersion;
  for (const [id, live] of revisions) {
    const historical = index.correspondenceById.get(id);
    if (historical) {
      const stored = transcriptRevisionAt(warmOverrides, id, warmRevisionVersion);
      revisions.set(id, applyCorrespondenceRevision(stored ?? historical, live, true));
    }
  }
  return createSegmentedArray({
    excludedHistoryIds,
    historyCount: history.messageCount,
    historyNewestPage: history.newestPage,
    historyPage: history.oldestPage,
    itemOverrides: revisions.size || warmOverrides.size
      ? { get: (id) => revisions.get(id) ?? transcriptRevisionAt(warmOverrides, id, warmRevisionVersion) }
      : undefined,
    pageItems: (page) => page.messages,
    tail,
  });
}

function revisedHistoryVisibility<T extends { id: string }>(
  before: readonly T[], after: readonly T[], warmIds: ReadonlySet<string>,
): ReadonlyMap<string, boolean> | undefined {
  if (!warmIds.size) return undefined;
  const revisions = before.filter(({ id }) => warmIds.has(id));
  if (!revisions.length) return undefined;
  const visible = new Set(after.map(({ id }) => id));
  return new Map(revisions.map(({ id }) => [id, visible.has(id)]));
}

export function createTranscriptReviewPresentation(params: {
  history: LoadedTranscriptHistory | undefined;
  index: TranscriptHistoryIndex | undefined;
  tailEntries: AppServerThreadEntry[];
  tailMessages: AppServerThreadMessage[];
}): TranscriptReviewPresentation {
  if (params.history && params.index) {
    const presentation = presentIndexedTranscriptReviews({
      ...params,
      index: params.index.review,
      historyEntryIds: params.index.entryIds,
      historyMessageIds: params.index.messageIds,
      historyTurns: params.index.turnPages,
    });
    // The revision has already been classified as current evidence. Its old
    // slot must have the same visibility after it is removed from the tail.
    return {
      ...presentation,
      revisedHistoryEntryVisibility: revisedHistoryVisibility(
        params.tailEntries, presentation.tailEntries, params.index.warmEntryIds,
      ),
      revisedHistoryMessageVisibility: revisedHistoryVisibility(
        params.tailMessages, presentation.tailMessages, params.index.warmMessageIds,
      ),
    };
  }
  return deriveTranscriptReviewPresentation({
    historyEvents: [],
    historyIndex: createTranscriptReviewHistoryIndex(),
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
