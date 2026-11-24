import type {
  AppServerThreadEntry,
  AppServerThreadMessage,
  AppServerThreadMessageEntry,
  AppServerThreadReviewEntry,
} from "@pwragent/shared/contracts/normalized-app-server";
import {
  isCodexReviewPromptText,
  isPwrAgentInlineReviewPrompt,
} from "../../../shared/review-command";
import { isPendingEntryId } from "./pending-entry-id";

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
  newestEventSegment?: TranscriptReviewEventSegment;
  eventIds: Set<string>;
  hasUnboundReview: boolean;
  unboundAssistantHashes: Set<number>;
  revision: number;
};

type TranscriptTextCandidate = {
  id: string;
  text: string;
  turnId?: string;
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
  indexedHistoryExclusions?: boolean;
};

type ReviewCandidate = {
  entry: AppServerThreadReviewEntry;
  source: "history" | "tail";
  position: number;
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
  turnId?: string,
): void {
  const normalizedText = normalizeTranscriptText(text);
  if (!normalizedText) {
    return;
  }
  const hash = normalizedTextHash(normalizedText);
  const candidates = target.get(hash);
  const candidate = { id, text, turnId };
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
  const assistantTurnsById = new Map<string, string>();

  for (const entry of entries) {
    const entryType = entry.type;
    if (entryType === "review") {
      events.push(entry);
      continue;
    }
    if (
      entryType === "message"
      && entry.role === "user"
      && (isCodexReviewPromptText(entry.text) || isPwrAgentInlineReviewPrompt(entry.text))
    ) {
      events.push(entry);
    }
    if (entryType !== "message" || entry.role !== "assistant") {
      continue;
    }

    if (entry.turn?.id) assistantTurnsById.set(entry.id, entry.turn.id);
    appendTextCandidate(assistantEntriesByTextHash, entry.text, entry.id, entry.turn?.id);
    if (isPlainReviewFindingText(entry.text)) {
      events.push(entry);
    }
  }

  for (const message of messages) {
    if (message.role === "assistant") {
      appendTextCandidate(assistantMessagesByTextHash, message.text, message.id, assistantTurnsById.get(message.id));
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
    eventIds: new Set(),
    hasUnboundReview: false,
    unboundAssistantHashes: new Set(),
    revision: 0,
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

function sharesLegacyReviewEvidence(index: TranscriptReviewHistoryIndex, event: TranscriptReviewEvent): boolean {
  if (event.type === "review") {
    return index.unboundAssistantHashes.has(normalizedTextHash(normalizeTranscriptText(
      event.output?.overall_explanation ?? event.review,
    )));
  }
  return event.role === "assistant" && (index.hasUnboundReview
    || index.unboundAssistantHashes.has(normalizedTextHash(normalizeTranscriptText(event.text))));
}

export function addTranscriptReviewSegmentToIndex(
  index: TranscriptReviewHistoryIndex,
  summary: TranscriptReviewSegmentSummary,
  position: "older" | "newer" = "older",
  independent = false,
): void {
  // A page of ordinary messages in new, known turns cannot change existing
  // review rules. Older pages and review-bearing segments can.
  const unboundAssistantHashes = new Set<number>();
  for (const textIndex of [summary.assistantEntriesByTextHash, summary.assistantMessagesByTextHash]) {
    for (const [hash, rows] of textIndex) {
      if (rows.some((candidate) => !candidate.turnId)) unboundAssistantHashes.add(hash);
    }
  }
  const canExtend = position === "newer" && independent && unboundAssistantHashes.size === 0
    && !summary.events.some((event) => !event.turn?.id || sharesLegacyReviewEvidence(index, event));
  const cached = cachedReviewRules.get(index);
  const previousRevision = index.revision;
  if (!canExtend || summary.events.length || index.hasUnboundReview) index.revision++;
  addTextCandidates(
    index.assistantEntriesByTextHash,
    summary.assistantEntriesByTextHash,
  );
  addTextCandidates(
    index.assistantMessagesByTextHash,
    summary.assistantMessagesByTextHash,
  );
  if (summary.events.length > 0) {
    const segment = { events: summary.events };
    if (position === "newer" && index.newestEventSegment) {
      index.newestEventSegment.newerSegment = segment;
      index.newestEventSegment = segment;
    } else {
      index.oldestEventSegment = { ...segment, newerSegment: index.oldestEventSegment };
      index.newestEventSegment ??= index.oldestEventSegment;
    }
  }
  for (const event of summary.events) {
    index.eventIds.add(event.id);
    if (event.type === "review" && !event.turn?.id) index.hasUnboundReview = true;
  }
  for (const hash of unboundAssistantHashes) index.unboundAssistantHashes.add(hash);
  if (canExtend && index.revision !== previousRevision && cached?.revision === previousRevision && cached.history) {
    const history = cached.history;
    if (index.hasUnboundReview) {
      // A new page can repeat a legacy review. Look up its own texts in the
      // cached rules rather than applying every historical rule to the page.
      for (const [textIndex, exclusions] of [
        [summary.assistantEntriesByTextHash, history.excludedHistoryEntryIds],
        [summary.assistantMessagesByTextHash, history.excludedHistoryMessageIds],
      ] as const) {
        for (const rows of textIndex.values()) {
          for (const row of rows) {
            const turns = history.reviewTexts.get(normalizeTranscriptText(row.text));
            if (turns?.has(undefined)) exclusions.add(row.id);
          }
        }
      }
    }
    if (summary.events.length > 0) {
      const additions = analyzeTranscriptReviews({
        historyEvents: summary.events, historyIndex: { ...emptyReviewHistory, ...summary },
        tailEvents: [], historyOverlapIds: emptyReviewOverlaps,
      });
      extendIndependentHistoryRules(history, additions);
    }
    cached.revision = index.revision;
    cached.combined = undefined;
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
    // A local submission header has neither a provider turn nor findings.
    // It cannot claim messages in earlier turns even with identical text.
    return !entry.turn?.id && isPendingEntryId(entry.id) ? undefined : entry;
  }
  if (
    entry.type === "message"
    && ((entry.role === "assistant" && isPlainReviewFindingText(entry.text))
      || (entry.role === "user"
        && (isCodexReviewPromptText(entry.text) || isPwrAgentInlineReviewPrompt(entry.text))))
  ) {
    return entry;
  }
  return undefined;
}

type ReviewTextsByTurn = ReadonlyMap<string, ReadonlySet<string | undefined>>;

function reviewTextMatchesTurn(turnIds: ReadonlySet<string | undefined>, turnId: string | undefined): boolean {
  // Legacy timelines can omit turn IDs. When both sides name a turn, text
  // can only identify a duplicate in the same turn.
  return !turnId || turnIds.has(turnId) || turnIds.has(undefined);
}

function addIndexedIds(
  target: Set<string>,
  index: TranscriptTextIndex,
  texts: ReviewTextsByTurn,
): void {
  for (const [text, turnIds] of texts) {
    const candidates = index.get(normalizedTextHash(text));
    if (!candidates) {
      continue;
    }
    for (const candidate of candidates) {
      // The hash only narrows candidates. Preserve exact normalized-text
      // semantics even in the event of a collision.
      if (reviewTextMatchesTurn(turnIds, candidate.turnId) && normalizeTranscriptText(candidate.text) === text) {
        target.add(candidate.id);
      }
    }
  }
}

function isDuplicateReviewMessage(
  item: AppServerThreadEntry | AppServerThreadMessage,
  reviewTexts: ReviewTextsByTurn,
  turnId: string | undefined,
): boolean {
  if (!("role" in item) || item.role !== "assistant") return false;
  const turns = reviewTexts.get(normalizeTranscriptText(item.text));
  return turns !== undefined && reviewTextMatchesTurn(turns, turnId);
}

/**
 * Replays only retained review/review-like events and exact-text hash
 * candidates. Unrelated retained entries are never visited, while hash
 * collisions are verified against normalized text before an ID is excluded.
 */
function analyzeTranscriptReviews(params: {
  historyEvents: Iterable<TranscriptReviewEvent>;
  historyIndex: TranscriptReviewHistoryIndex;
  tailEvents: TranscriptReviewEvent[];
  historyOverlapIds: ReadonlySet<string>;
}) {
  const candidates: ReviewCandidate[] = [];
  const candidatesByTurn = new Map<string | undefined, ReviewCandidate[]>();
  const userPrompts: {
    entry: AppServerThreadMessageEntry;
    source: ReviewCandidate["source"];
  }[] = [];
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
      const candidate = { entry: event, source, position: candidates.length };
      candidates.push(candidate);
      const turnId = event.turn?.id;
      const sameTurn = candidatesByTurn.get(turnId);
      if (sameTurn) sameTurn.push(candidate);
      else candidatesByTurn.set(turnId, [candidate]);
      return;
    }

    if (event.role === "user") {
      userPrompts.push({ entry: event, source });
      return;
    }
    const matches = ({ entry }: ReviewCandidate) => shouldUseAssistantReviewText({
      assistantText: event.text,
      reviewText: entry.review,
    });
    const turnId = event.turn?.id;
    const sameTurn = turnId ? candidatesByTurn.get(turnId)?.findLast(matches) : candidates.findLast(matches);
    const legacy = turnId ? candidatesByTurn.get(undefined)?.findLast(matches) : undefined;
    const candidate = legacy && legacy.position > (sameTurn?.position ?? -1) ? legacy : sameTurn;
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
    if (!params.historyOverlapIds.has(event.id)) {
      consumeEvent(event, "history");
    }
  }
  for (const event of params.tailEvents) {
    consumeEvent(event, "tail");
  }

  // Correlate by turn, after collecting all markers: replay pages and live
  // items may deliver the generated prompt before the review start marker.
  const reviewTurnIds = new Set(
    candidates.flatMap(({ entry }) => entry.turn?.id ? [entry.turn.id] : []),
  );
  const excludedPromptIds = new Set<string>();
  for (const { entry, source } of userPrompts) {
    if (
      !isPwrAgentInlineReviewPrompt(entry.text)
      && (!entry.turn?.id || !reviewTurnIds.has(entry.turn.id) || entry.origin)
    ) {
      continue;
    }
    excludedPromptIds.add(entry.id);
    // Filtering the tail removes its overlap IDs from the combined view.
    // Exclude retained copies too, even when we collected only the tail copy.
    excludedHistoryEntryIds.add(entry.id);
    excludedHistoryMessageIds.add(entry.id);
    if (source === "tail") {
      excludedTailEntryIds.add(entry.id);
    }
  }

  const reviewTexts = new Map<string, Set<string | undefined>>();
  for (const candidate of candidates) {
    const text = candidate.entry.output?.overall_explanation ?? candidate.entry.review;
    if (text.trim()) {
      const normalized = normalizeTranscriptText(text);
      const turnId = candidate.entry.turn?.id;
      const turns = reviewTexts.get(normalized);
      if (turns) turns.add(turnId);
      else reviewTexts.set(normalized, new Set([turnId]));
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
    excludedHistoryEntryIds, excludedHistoryMessageIds, historyEntryOverrides,
    excludedPromptIds, excludedTailEntryIds, tailEntryOverrides, reviewTexts,
  };
}

type ReviewRules = ReturnType<typeof analyzeTranscriptReviews>;
type ReviewTail = { tailEntries: AppServerThreadEntry[]; tailMessages: AppServerThreadMessage[] };

function applyReviewRules(tail: ReviewTail, rules: ReviewRules, history?: ReviewRules): TranscriptReviewPresentation {
  const assistantTurnsById = new Map<string, string>();
  const tailEntries = tail.tailEntries.flatMap((entry) => {
    if (entry.type === "message" && entry.role === "assistant" && entry.turn?.id) {
      assistantTurnsById.set(entry.id, entry.turn.id);
    }
    if (rules.excludedTailEntryIds.has(entry.id)
      || isDuplicateReviewMessage(entry, rules.reviewTexts, entry.turn?.id)
      || (history && isDuplicateReviewMessage(entry, history.reviewTexts, entry.turn?.id))) {
      return [];
    }
    return [rules.tailEntryOverrides.get(entry.id) ?? entry];
  });
  const historicalRules = history ?? rules;
  return {
    excludedHistoryEntryIds: historicalRules.excludedHistoryEntryIds,
    excludedHistoryMessageIds: historicalRules.excludedHistoryMessageIds,
    historyEntryOverrides: historicalRules.historyEntryOverrides,
    indexedHistoryExclusions: history !== undefined,
    tailEntries,
    tailMessages: tail.tailMessages.filter((message) => {
      const turnId = assistantTurnsById.get(message.id);
      return !rules.excludedPromptIds.has(message.id)
        && !isDuplicateReviewMessage(message, rules.reviewTexts, turnId)
        && (!history || !isDuplicateReviewMessage(message, history.reviewTexts, turnId));
    }),
  };
}

function extendIndependentHistoryRules(previous: ReviewRules, additions: ReviewRules): void {
  for (const id of additions.excludedHistoryEntryIds) previous.excludedHistoryEntryIds.add(id);
  for (const id of additions.excludedHistoryMessageIds) previous.excludedHistoryMessageIds.add(id);
  for (const [id, entry] of additions.historyEntryOverrides) previous.historyEntryOverrides.set(id, entry);
  for (const [text, turnIds] of additions.reviewTexts) {
    const previousTurns = previous.reviewTexts.get(text);
    if (previousTurns) for (const turnId of turnIds) previousTurns.add(turnId);
    else previous.reviewTexts.set(text, turnIds);
  }
}

export function deriveTranscriptReviewPresentation(params: ReviewTail & {
  historyEvents: Iterable<TranscriptReviewEvent>;
  historyIndex: TranscriptReviewHistoryIndex;
}): TranscriptReviewPresentation {
  return applyReviewRules(params, analyzeTranscriptReviews({
    ...params,
    tailEvents: params.tailEntries.flatMap((entry) => reviewEvent(entry) ?? []),
    historyOverlapIds: new Set([
      ...params.tailEntries.map((entry) => entry.id), ...params.tailMessages.map((message) => message.id),
    ]),
  }));
}

const emptyReviewHistory = createTranscriptReviewHistoryIndex();
const emptyReviewOverlaps = new Set<string>();
const cachedReviewRules = new WeakMap<TranscriptReviewHistoryIndex, {
  revision: number;
  history?: ReviewRules;
  combined?: { events: TranscriptReviewEvent[]; overlaps: Set<string>; rules: ReviewRules };
}>();

export function presentIndexedTranscriptReviews(params: ReviewTail & {
  index: TranscriptReviewHistoryIndex;
  historyEntryIds: ReadonlySet<string>;
  historyMessageIds: ReadonlySet<string>;
  historyTurns: Pick<ReadonlyMap<string, unknown>, "has">;
}): TranscriptReviewPresentation {
  const { index } = params;
  const tailEvents = params.tailEntries.flatMap((entry) => reviewEvent(entry) ?? []);
  const historyOverlaps = new Set<string>();
  for (const item of [...params.tailEntries, ...params.tailMessages]) {
    if (index.eventIds.has(item.id)) historyOverlaps.add(item.id);
  }
  let cache = cachedReviewRules.get(index);
  if (cache?.revision !== index.revision) {
    cache = { revision: index.revision };
    cachedReviewRules.set(index, cache);
  }

  // With provider turn IDs, a new turn can classify its own review rows
  // without revisiting settled reviews from every earlier page. Fall back
  // when the page boundary splits a turn or a legacy row can interact with
  // the current evidence.
  const crossesPageBoundary = historyOverlaps.size > 0
    || tailEvents.some((event) => !event.turn?.id || sharesLegacyReviewEvidence(index, event)
      || params.historyTurns.has(event.turn.id) || params.historyEntryIds.has(event.id)
      || params.historyMessageIds.has(event.id));
  if (!crossesPageBoundary) {
    cache.history ??= analyzeTranscriptReviews({
      historyEvents: iterateTranscriptReviewHistoryEvents(index), historyIndex: index,
      tailEvents: [], historyOverlapIds: emptyReviewOverlaps,
    });
    const tailRules = analyzeTranscriptReviews({
      historyEvents: [], historyIndex: emptyReviewHistory, tailEvents, historyOverlapIds: emptyReviewOverlaps,
    });
    return applyReviewRules(params, tailRules, cache.history);
  }

  const last = cache.combined;
  if (last && last.events.length === tailEvents.length
    && last.events.every((event, offset) => event === tailEvents[offset])
    && last.overlaps.size === historyOverlaps.size
    && [...historyOverlaps].every((id) => last.overlaps.has(id))) {
    return applyReviewRules(params, last.rules);
  }
  const rules = analyzeTranscriptReviews({
    historyEvents: iterateTranscriptReviewHistoryEvents(index), historyIndex: index,
    tailEvents, historyOverlapIds: historyOverlaps,
  });
  cache.combined = { events: tailEvents, overlaps: historyOverlaps, rules };
  return applyReviewRules(params, rules);
}
