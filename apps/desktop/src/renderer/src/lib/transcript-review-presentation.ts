import type {
  AppServerThreadEntry,
  AppServerThreadMessage,
  AppServerThreadMessageEntry,
  AppServerThreadReviewEntry,
} from "@pwragent/shared";

export type TranscriptReviewEvent =
  | AppServerThreadMessageEntry
  | AppServerThreadReviewEntry;

export type TranscriptReviewSegmentSummary = {
  assistantEntriesByTextHash: TranscriptTextIndex;
  assistantMessagesByTextHash: TranscriptTextIndex;
  events: TranscriptReviewEvent[];
};

export type TranscriptReviewHistoryIndex = {
  assistantEntriesByTextHash: TranscriptTextIndex;
  assistantMessagesByTextHash: TranscriptTextIndex;
  oldestEventSegment?: TranscriptReviewEventSegment;
};

type TranscriptTextCandidate = {
  id: string;
  text: string;
};

type TranscriptTextIndex = Map<number, TranscriptTextCandidate[]>;

type TranscriptReviewEventSegment = {
  events: TranscriptReviewEvent[];
  newerSegment?: TranscriptReviewEventSegment;
};

export type TranscriptReviewPresentation = {
  excludedHistoryEntryIds: ReadonlySet<string>;
  excludedHistoryMessageIds: ReadonlySet<string>;
  historyEntryOverrides: ReadonlyMap<string, AppServerThreadEntry>;
  tailEntries: AppServerThreadEntry[];
  tailMessages: AppServerThreadMessage[];
};

type ReviewCandidate = {
  entry: AppServerThreadReviewEntry;
  source: "history" | "tail";
};

export function normalizeTranscriptText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function isPlainReviewFindingText(text: string): boolean {
  return (
    /\b(?:full\s+)?review comments?:/i.test(text)
    && /(?:^|\n)\s*-\s*\[P[0-3]\]\s+.+(?:\s+—\s+|\s+-\s+).+:\d+/u.test(text)
  );
}

function shouldUseAssistantReviewText(params: {
  assistantText: string;
  reviewText: string;
}): boolean {
  if (!isPlainReviewFindingText(params.assistantText)) {
    return false;
  }

  const normalizedAssistant = normalizeTranscriptText(params.assistantText);
  const normalizedReview = normalizeTranscriptText(params.reviewText);
  return (
    !normalizedReview
    || normalizedAssistant === normalizedReview
    || normalizedAssistant.startsWith(normalizedReview)
    || normalizedAssistant.includes(normalizedReview)
  );
}

function normalizedTextHash(normalizedText: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < normalizedText.length; index += 1) {
    hash ^= normalizedText.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function appendTextCandidate(
  target: TranscriptTextIndex,
  text: string,
  id: string,
): void {
  const normalizedText = normalizeTranscriptText(text);
  if (!normalizedText) {
    return;
  }
  const hash = normalizedTextHash(normalizedText);
  const candidates = target.get(hash);
  const candidate = { id, text };
  if (candidates) {
    candidates.push(candidate);
  } else {
    target.set(hash, [candidate]);
  }
}

/**
 * Classifies one incoming page exactly once. The retained index keeps compact
 * text-hash candidates and review-only events rather than a second flattened
 * transcript, so adding later pages never revisits this page's entries.
 */
export function summarizeTranscriptReviewSegment(
  entries: AppServerThreadEntry[],
  messages: AppServerThreadMessage[],
): TranscriptReviewSegmentSummary {
  const assistantEntriesByTextHash: TranscriptTextIndex = new Map();
  const assistantMessagesByTextHash: TranscriptTextIndex = new Map();
  const events: TranscriptReviewEvent[] = [];

  for (const entry of entries) {
    const entryType = entry.type;
    if (entryType === "review") {
      events.push(entry);
      continue;
    }
    if (entryType !== "message" || entry.role !== "assistant") {
      continue;
    }

    appendTextCandidate(assistantEntriesByTextHash, entry.text, entry.id);
    if (isPlainReviewFindingText(entry.text)) {
      events.push(entry);
    }
  }

  for (const message of messages) {
    if (message.role === "assistant") {
      appendTextCandidate(assistantMessagesByTextHash, message.text, message.id);
    }
  }

  return {
    assistantEntriesByTextHash,
    assistantMessagesByTextHash,
    events,
  };
}

export function createTranscriptReviewHistoryIndex(): TranscriptReviewHistoryIndex {
  return {
    assistantEntriesByTextHash: new Map(),
    assistantMessagesByTextHash: new Map(),
  };
}

function addTextCandidates(
  target: TranscriptTextIndex,
  source: TranscriptTextIndex,
): void {
  for (const [hash, candidates] of source) {
    const targetCandidates = target.get(hash);
    if (targetCandidates) {
      targetCandidates.push(...candidates);
    } else {
      target.set(hash, [...candidates]);
    }
  }
}

export function addTranscriptReviewSegmentToIndex(
  index: TranscriptReviewHistoryIndex,
  summary: TranscriptReviewSegmentSummary,
): void {
  addTextCandidates(
    index.assistantEntriesByTextHash,
    summary.assistantEntriesByTextHash,
  );
  addTextCandidates(
    index.assistantMessagesByTextHash,
    summary.assistantMessagesByTextHash,
  );
  if (summary.events.length > 0) {
    index.oldestEventSegment = {
      events: summary.events,
      newerSegment: index.oldestEventSegment,
    };
  }
}

/**
 * Iterates only review-bearing retained segments. Ordinary transcript pages
 * do not add a node, so live-tail review derivation is independent of both
 * their entry count and their page count.
 */
export function* iterateTranscriptReviewHistoryEvents(
  index: TranscriptReviewHistoryIndex,
): Generator<TranscriptReviewEvent> {
  let segment = index.oldestEventSegment;
  while (segment) {
    yield* segment.events;
    segment = segment.newerSegment;
  }
}

function reviewEvent(entry: AppServerThreadEntry): TranscriptReviewEvent | undefined {
  if (entry.type === "review") {
    return entry;
  }
  if (
    entry.type === "message"
    && entry.role === "assistant"
    && isPlainReviewFindingText(entry.text)
  ) {
    return entry;
  }
  return undefined;
}

function matchingReviewCandidate(
  candidates: ReviewCandidate[],
  message: AppServerThreadMessageEntry,
): ReviewCandidate | undefined {
  return candidates.findLast((candidate) => {
    if (
      message.turn?.id
      && candidate.entry.turn?.id
      && message.turn.id !== candidate.entry.turn.id
    ) {
      return false;
    }
    return shouldUseAssistantReviewText({
      assistantText: message.text,
      reviewText: candidate.entry.review,
    });
  });
}

function addIndexedIds(
  target: Set<string>,
  index: TranscriptTextIndex,
  texts: ReadonlySet<string>,
): void {
  for (const text of texts) {
    const candidates = index.get(normalizedTextHash(text));
    if (!candidates) {
      continue;
    }
    for (const candidate of candidates) {
      // The hash only narrows candidates. Preserve exact normalized-text
      // semantics even in the event of a collision.
      if (normalizeTranscriptText(candidate.text) === text) {
        target.add(candidate.id);
      }
    }
  }
}

function isDuplicateReviewMessage(
  item: AppServerThreadEntry | AppServerThreadMessage,
  reviewTexts: ReadonlySet<string>,
): boolean {
  return (
    "role" in item
    && item.role === "assistant"
    && "text" in item
    && typeof item.text === "string"
    && reviewTexts.has(normalizeTranscriptText(item.text))
  );
}

/**
 * Replays only retained review/review-like events and exact-text hash
 * candidates. Unrelated retained entries are never visited, while hash
 * collisions are verified against normalized text before an ID is excluded.
 */
export function deriveTranscriptReviewPresentation(params: {
  historyEvents: Iterable<TranscriptReviewEvent>;
  historyIndex: TranscriptReviewHistoryIndex;
  tailEntries: AppServerThreadEntry[];
  tailMessages: AppServerThreadMessage[];
}): TranscriptReviewPresentation {
  const historyOverlapIds = new Set([
    ...params.tailEntries.map((entry) => entry.id),
    ...params.tailMessages.map((message) => message.id),
  ]);
  const candidates: ReviewCandidate[] = [];
  const excludedHistoryEntryIds = new Set<string>();
  const excludedHistoryMessageIds = new Set<string>();
  const excludedTailEntryIds = new Set<string>();
  const historyEntryOverrides = new Map<string, AppServerThreadEntry>();
  const tailEntryOverrides = new Map<string, AppServerThreadEntry>();

  const consumeEvent = (
    event: TranscriptReviewEvent,
    source: ReviewCandidate["source"],
  ): void => {
    if (event.type === "review") {
      candidates.push({ entry: event, source });
      return;
    }

    const candidate = matchingReviewCandidate(candidates, event);
    if (!candidate) {
      return;
    }

    candidate.entry = {
      ...candidate.entry,
      review: event.text,
    };
    if (candidate.source === "history") {
      historyEntryOverrides.set(candidate.entry.id, candidate.entry);
    } else {
      tailEntryOverrides.set(candidate.entry.id, candidate.entry);
    }
    if (source === "history") {
      excludedHistoryEntryIds.add(event.id);
    } else {
      excludedTailEntryIds.add(event.id);
    }
  };

  for (const event of params.historyEvents) {
    if (!historyOverlapIds.has(event.id)) {
      consumeEvent(event, "history");
    }
  }
  for (const entry of params.tailEntries) {
    const event = reviewEvent(entry);
    if (event) {
      consumeEvent(event, "tail");
    }
  }

  const reviewTexts = new Set<string>();
  for (const candidate of candidates) {
    const text = candidate.entry.output?.overall_explanation ?? candidate.entry.review;
    if (text.trim()) {
      reviewTexts.add(normalizeTranscriptText(text));
    }
  }

  addIndexedIds(
    excludedHistoryEntryIds,
    params.historyIndex.assistantEntriesByTextHash,
    reviewTexts,
  );
  addIndexedIds(
    excludedHistoryMessageIds,
    params.historyIndex.assistantMessagesByTextHash,
    reviewTexts,
  );

  return {
    excludedHistoryEntryIds,
    excludedHistoryMessageIds,
    historyEntryOverrides,
    tailEntries: params.tailEntries.flatMap((entry) => {
      if (
        excludedTailEntryIds.has(entry.id)
        || isDuplicateReviewMessage(entry, reviewTexts)
      ) {
        return [];
      }
      return [tailEntryOverrides.get(entry.id) ?? entry];
    }),
    tailMessages: params.tailMessages.filter(
      (message) => !isDuplicateReviewMessage(message, reviewTexts),
    ),
  };
}
