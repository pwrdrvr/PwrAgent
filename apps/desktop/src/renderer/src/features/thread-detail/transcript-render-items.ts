import type {
  AppServerBackendKind,
  AppServerThreadActivityEntry,
  AppServerThreadEntry,
  AppServerThreadMessageEntry,
  AppServerThreadPlanEntry,
  AppServerThreadTurnMetadata,
} from "@pwragent/shared/contracts/normalized-app-server";
import { turnUsageEntryTurnId } from "@pwragent/shared/thread-usage-display";
import { formatElapsedMs } from "../../lib/format-duration";
import { projectCodexBrowserUseEntries } from "./codex-browser-completion";
import { isAutoReviewActivityEntry } from "./protocol-activity-entries";
import { isLaunchedTodoEntry } from "./launched-todo-entries";
import { isRewindMarkerEntry } from "./rewind-marker-entries";
import { formatFileEditActivitySummary, hasTranscriptFileDiff } from "./live-transcript-activity";

export type TranscriptRenderItem =
  | {
      type: "entry";
      entry: AppServerThreadEntry;
    }
  | {
      type: "workPhaseGroup";
      activeStartedAt?: number;
      /** Verb for the live elapsed label, e.g. "Reviewing for 1m 20s". */
      activeVerb?: string;
      id: string;
      collapsible: boolean;
      /** Starts open; a click still folds it. */
      defaultExpanded?: boolean;
      entries: AppServerThreadEntry[];
      label: string;
    };

export const ACTIVE_WORK_GROUP_THRESHOLD_MS = 60_000;

export function buildTranscriptRenderItems(params: {
  entries: AppServerThreadEntry[];
  backend?: AppServerBackendKind;
  activeTurnId?: string;
  activeTurnStartedAt?: number;
  activeMessageId?: string;
  alwaysVisibleEntryIds?: ReadonlySet<string>;
  now?: number;
}): TranscriptRenderItem[] {
  const entries = params.backend === "acp:antigravity"
    ? groupAntigravityEdits(params.entries, params.alwaysVisibleEntryIds)
    : params.backend === "codex"
      ? projectCodexBrowserUseEntries(
          params.entries,
          params.backend,
          params.alwaysVisibleEntryIds,
        )
      : params.entries;
  const activeTurnId =
    params.activeTurnId ??
    entries.find((entry) => entry.id === params.activeMessageId)?.turn?.id;

  if (params.activeMessageId && !activeTurnId) {
    return entries.map((entry) => ({ type: "entry", entry }));
  }

  const reviewTurnIds = collectReviewTurnIds(entries);

  if (activeTurnId) {
    // A running review folds its work between the cards as it goes, so the
    // transcript reads start card, one collapsed group, result card — rather
    // than streaming every commentary line the review writes along the way.
    const activeReview = reviewTurnIds.has(activeTurnId)
      ? {
          startedAt: activeTurnStartedAt(
            entries,
            activeTurnId,
            params.activeTurnStartedAt,
          ),
          turnId: activeTurnId,
        }
      : undefined;
    const groups = buildCompletedGroups(
      entries,
      activeReview ? undefined : activeTurnId,
      params.alwaysVisibleEntryIds,
      reviewTurnIds,
      activeReview,
      params.backend,
    );
    const activeGroups = activeReview
      ? []
      : buildActiveWorkGroups(
          entries,
          activeTurnId,
          params.now,
          params.activeTurnStartedAt,
          params.alwaysVisibleEntryIds,
        );
    groups.push(...activeGroups);
    if (groups.length > 0) {
      return renderWithGroups(entries, groups);
    }

    return entries.map((entry) => ({ type: "entry", entry }));
  }

  const completedGroups = buildCompletedGroups(
    entries,
    undefined,
    params.alwaysVisibleEntryIds,
    reviewTurnIds,
    undefined,
    params.backend,
  );
  if (completedGroups.length > 0) {
    return renderWithGroups(entries, completedGroups);
  }

  const fallbackGroups = buildCommentaryOnlyGroups(
    entries,
    params.alwaysVisibleEntryIds,
  );
  if (fallbackGroups.length === 0) {
    return entries.map((entry) => ({ type: "entry", entry }));
  }

  return renderWithGroups(entries, fallbackGroups);
}

const antigravityEditGroupCache = new WeakMap<
  AppServerThreadActivityEntry,
  {
    run: AppServerThreadActivityEntry[];
    grouped: AppServerThreadActivityEntry;
  }
>();

/**
 * Antigravity replays one tool row per edit. Fold neighboring successful or
 * active edits like a batched tool activity, keeping each call's exact patch.
 * The original replay entries still own ordering, ids, and diff references.
 *
 * Unchanged multi-edit runs reuse their cached folded entry by object identity
 * so streaming deltas on the active turn do not replace historical row
 * references or invalidate memoized workPhaseGroups.
 */
function groupAntigravityEdits(
  entries: AppServerThreadEntry[],
  alwaysVisibleEntryIds: ReadonlySet<string> | undefined,
): AppServerThreadEntry[] {
  let changed = false;
  const result: AppServerThreadEntry[] = [];
  let run: AppServerThreadActivityEntry[] = [];
  const flush = () => {
    const first = run[0];
    if (!first) return;
    if (run.length === 1) {
      result.push(first);
    } else {
      changed = true;
      const cached = antigravityEditGroupCache.get(first);
      if (
        cached
        && cached.run.length === run.length
        && cached.run.every((entry, index) => entry === run[index])
      ) {
        result.push(cached.grouped);
      } else {
        const details = run.flatMap((entry) => entry.details);
        const grouped: AppServerThreadActivityEntry = {
          ...first,
          summary: formatFileEditActivitySummary(details),
          status: run.some((entry) => entry.status === "in_progress")
            ? "in_progress"
            : run.at(-1)?.status,
          details,
        };
        antigravityEditGroupCache.set(first, { run, grouped });
        result.push(grouped);
      }
    }
    run = [];
  };
  for (const entry of entries) {
    if (entry.type !== "activity" || !entry.turn?.id || entry.tone || entry.detailsRef
      || entry.status === "failed" || entry.status === "cancelled"
      || entry.details.length === 0
      || entry.details.some((detail) => detail.kind !== "write" || !detail.path)
      || staysInView(entry, alwaysVisibleEntryIds)) {
      flush();
      result.push(entry);
      continue;
    }
    if (run[0]?.turn?.id !== entry.turn.id) flush();
    run.push(entry);
  }
  flush();
  return changed ? result : entries;
}

type RenderGroup = {
  activeStartedAt?: number;
  activeVerb?: string;
  collapsible: boolean;
  defaultExpanded?: boolean;
  entries: AppServerThreadEntry[];
  id: string;
  label: string;
};

function collectReviewTurnIds(entries: AppServerThreadEntry[]): Set<string> {
  const turnIds = new Set<string>();
  for (const entry of entries) {
    if (entry.type === "review" && entry.turn?.id) {
      turnIds.add(entry.turn.id);
    }
  }
  return turnIds;
}

function activeTurnStartedAt(
  entries: AppServerThreadEntry[],
  activeTurnId: string,
  fallbackStartedAt?: number,
): number | undefined {
  const turn = entries.find((entry) => entry.turn?.id === activeTurnId)?.turn;
  const startedAtCandidates = [fallbackStartedAt, turn?.startedAt].filter(
    (value): value is number => typeof value === "number"
  );
  return startedAtCandidates.length > 0
    ? Math.min(...startedAtCandidates)
    : undefined;
}

function buildActiveWorkGroups(
  entries: AppServerThreadEntry[],
  activeTurnId: string,
  now = Date.now(),
  fallbackStartedAt?: number,
  alwaysVisibleEntryIds?: ReadonlySet<string>,
): RenderGroup[] {
  const startedAt = activeTurnStartedAt(entries, activeTurnId, fallbackStartedAt);
  const elapsedMs =
    typeof startedAt === "number" ? Math.max(now - startedAt, 0) : undefined;
  if (
    typeof elapsedMs !== "number" ||
    elapsedMs <= ACTIVE_WORK_GROUP_THRESHOLD_MS
  ) {
    return [];
  }

  const activeEntries: AppServerThreadEntry[] = [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    // The turn's total sits after its last entry; the work above it is
    // still the turn's bottom work.
    if (
      activeEntries.length === 0
      && turnUsageEntryTurnId(entry) === activeTurnId
    ) {
      continue;
    }
    // Live auto-review notices and launched to-do cards carry no turn and stay
    // in view at top level without cutting off the work before them.
    if (isStandaloneOverlayActivity(entry)) {
      continue;
    }
    if (
      staysInView(entry, alwaysVisibleEntryIds)
      || entry.turn?.id !== activeTurnId
      || !isConcreteWorkEntry(entry)
    ) {
      break;
    }
    activeEntries.push(entry);
  }
  activeEntries.reverse();

  if (!hasConcreteWork(activeEntries)) {
    return [];
  }

  return [
    {
      activeStartedAt: startedAt,
      collapsible: false,
      entries: activeEntries,
      id: `work:${activeTurnId}:active`,
      label: `Working for ${formatElapsedMs(elapsedMs)}`,
    },
  ];
}

function buildCompletedGroups(
  entries: AppServerThreadEntry[],
  excludeTurnId?: string,
  alwaysVisibleEntryIds?: ReadonlySet<string>,
  reviewTurnIds?: ReadonlySet<string>,
  activeReview?: { startedAt?: number; turnId: string },
  backend?: AppServerBackendKind,
): RenderGroup[] {
  const groups: RenderGroup[] = [];
  const groupIds = new Set<string>();
  const completedWorkTurnIds = new Set<string>();
  // A review's replies fold only between its cards. One after the result card,
  // or in a review that ended without one, is what the reviewer said last and
  // stays in view.
  const lastReviewIndexByTurn = new Map<string, number>();
  entries.forEach((entry, index) => {
    if (entry.type === "review" && entry.turn?.id) {
      lastReviewIndexByTurn.set(entry.turn.id, index);
    }
  });
  const { interimReplies, trailingFileDiffs } = classifyCompletedTurnEntries(
    entries,
    backend,
  );
  let currentEntries: AppServerThreadEntry[] = [];
  let currentTurnId: string | undefined;

  const flushCurrent = (): void => {
    if (currentEntries.length === 0 || !currentTurnId) {
      currentEntries = [];
      currentTurnId = undefined;
      return;
    }

    const turn = readCompletedTurn(currentEntries);
    const liveReview =
      !turn && activeReview?.turnId === currentTurnId ? activeReview : undefined;
    if (!turn && !liveReview) {
      currentEntries = [];
      currentTurnId = undefined;
      return;
    }

    const hasWork = hasConcreteWork(currentEntries, trailingFileDiffs);
    const firstEntryId = currentEntries[0]?.id ?? groups.length.toString();
    const baseId = `${hasWork ? "work" : "commentary"}:${currentTurnId}:${firstEntryId}:complete`;
    const repeatedWorkTurn = hasWork && completedWorkTurnIds.has(currentTurnId);
    const id = groupIds.has(baseId) ? `${baseId}:${groups.length}` : baseId;
    groupIds.add(id);
    groups.push({
      // Same id the finished turn will produce, so a group opened mid-review
      // stays open when the review completes.
      ...(liveReview
        ? {
            activeStartedAt: liveReview.startedAt,
            activeVerb: "Reviewing",
          }
        : {}),
      collapsible: true,
      entries: currentEntries,
      id,
      // No completed metadata means this is the live review (checked above).
      label: !turn
        ? "Reviewing"
        : hasWork
          ? repeatedWorkTurn
            ? "More work"
            : workGroupLabel(
                turn,
                currentEntries,
                reviewTurnIds?.has(currentTurnId) ? "Reviewed" : "Worked",
              )
          : previousMessagesLabel(currentEntries.filter(isAssistantMessage).length),
    });
    if (hasWork) {
      completedWorkTurnIds.add(currentTurnId);
    }
    currentEntries = [];
    currentTurnId = undefined;
  };

  for (const [index, entry] of entries.entries()) {
    // Auto-review notices and launched to-do cards stay in view at top level:
    // they neither join a turn's work group nor split it, so each renders
    // after the group it arrived among.
    if (isStandaloneOverlayActivity(entry)) {
      continue;
    }
    const turnId = entry.turn?.id;
    const isReplyBetweenReviewCards =
      Boolean(turnId)
      && isAssistantMessage(entry)
      && (turnId === activeReview?.turnId
        || index < (lastReviewIndexByTurn.get(turnId ?? "") ?? -1));
    const canJoinGroup =
      !staysInView(entry, alwaysVisibleEntryIds)
      && Boolean(turnId)
      && turnId !== excludeTurnId
      && (
        isWorkPhaseEntry(entry, trailingFileDiffs)
        || isReplyBetweenReviewCards
        || interimReplies.has(entry)
      );

    if (!canJoinGroup) {
      flushCurrent();
      continue;
    }

    if (currentTurnId && currentTurnId !== turnId) {
      flushCurrent();
    }

    currentTurnId = turnId;
    currentEntries.push(entry);
  }

  flushCurrent();
  return openStoppedTurnTails(entries, groups);
}

/**
 * A turn the operator stopped before it answered keeps its last work group
 * open. That work was on screen while the turn ran, and with no reply below
 * it, folding it left one "Worked for" line where the turn's output had been.
 * A turn that replied after its last group folds as usual.
 */
function openStoppedTurnTails(
  entries: AppServerThreadEntry[],
  groups: RenderGroup[],
): RenderGroup[] {
  const stoppedTurnIds = new Set<string>();
  for (const entry of entries) {
    if (
      entry.turn
      && (entry.turn.status === "cancelled" || entry.turn.status === "interrupted")
    ) {
      stoppedTurnIds.add(entry.turn.id);
    }
  }
  if (stoppedTurnIds.size === 0) {
    return groups;
  }

  const groupOfEntry = new Map<AppServerThreadEntry, RenderGroup>();
  for (const group of groups) {
    for (const entry of group.entries) {
      groupOfEntry.set(entry, group);
    }
  }
  // Walking backward, the first entry met of a group is its last one.
  const tails = new Set<RenderGroup>();
  const settledTurnIds = new Set<string>();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    const turnId = entry.turn?.id;
    if (!turnId || !stoppedTurnIds.has(turnId) || settledTurnIds.has(turnId)) {
      continue;
    }
    const group = groupOfEntry.get(entry);
    if (group) {
      tails.add(group);
      settledTurnIds.add(turnId);
    } else if (isAssistantMessage(entry)) {
      settledTurnIds.add(turnId);
    }
  }

  return tails.size === 0
    ? groups
    : groups.map((group) =>
        tails.has(group) ? { ...group, defaultExpanded: true } : group
      );
}

/**
 * Classifies two turn-shape roles for completed work folding:
 *
 * 1. Trailing (post-answer) file-diff rows: a cumulative `live-diff-*` row or
 *    a file-diff activity that lands directly after the turn's answer with no
 *    subsequent work or reply stays at top level and never folds that answer.
 *    Mid-turn file edits (before the answer, or before more work, or in a turn
 *    with no answer) fold into the turn's work group instead of splitting it
 *    into repeated "Edited ..." / "More work" rows; their patches stay
 *    expandable inside the group and in the Edits rail/panel.
 *
 * 2. Interim assistant replies: Codex tags mid-turn prose `commentary`, while
 *    Claude tags no reply and ACP agents tag thoughts `commentary` but every
 *    visible `agent_message_chunk` (both mid-turn updates and the final
 *    answer) `final`. A reply followed by work in the same turn — or followed
 *    by a failed tool call or thought and a later reply — was not the answer.
 *    A user message or rewind marker resets the search so a steered reply
 *    stays in view. A non-ACP turn that tags commentary still protects its
 *    sole/last `final` answer from a late tool row, and an all-failed trailing
 *    tool call never folds the answer before it.
 */
function classifyCompletedTurnEntries(
  entries: AppServerThreadEntry[],
  backend?: AppServerBackendKind,
): {
  interimReplies: Set<AppServerThreadEntry>;
  trailingFileDiffs: Set<AppServerThreadEntry>;
} {
  const acpBackend = isAcpBackend(backend);
  const phaseTaggedTurnIds = new Set<string>();
  const fileDiffImmediatelyAfterAnswer = new Set<AppServerThreadEntry>();

  let forwardTurnId: string | undefined;
  let immediatelyAfterAnswer = false;
  for (const entry of entries) {
    if (isStandaloneOverlayActivity(entry)) {
      continue;
    }
    if ((entry.type === "message" && entry.role === "user") || isRewindMarkerEntry(entry)) {
      forwardTurnId = undefined;
      immediatelyAfterAnswer = false;
      continue;
    }
    const turnId = entry.turn?.id;
    if (!turnId) {
      forwardTurnId = undefined;
      immediatelyAfterAnswer = false;
      continue;
    }
    if (turnId !== forwardTurnId) {
      forwardTurnId = turnId;
      immediatelyAfterAnswer = false;
    }
    if (entry.type === "activity") {
      if (isTokenUsageActivity(entry) || isTerminalTurnFailureActivity(entry)) {
        continue;
      }
      if (isFileDiffActivity(entry) && !entry.id.startsWith("live-tools-")) {
        if (immediatelyAfterAnswer) {
          fileDiffImmediatelyAfterAnswer.add(entry);
        }
        continue;
      }
      if (!isAllFailedActivity(entry)) {
        immediatelyAfterAnswer = false;
      }
      continue;
    }
    if (entry.type === "plan") {
      immediatelyAfterAnswer = false;
      continue;
    }
    if (isAssistantMessage(entry)) {
      if (entry.phase === "commentary") {
        phaseTaggedTurnIds.add(turnId);
      }
      immediatelyAfterAnswer = entry.phase !== "commentary" && entry.phase !== "partial";
    }
  }

  const interimReplies = new Set<AppServerThreadEntry>();
  const trailingFileDiffs = new Set<AppServerThreadEntry>();
  let backwardTurnId: string | undefined;
  let sawReplyAfter = false;
  let sawFinalAfter = false;
  let sawNonFailedWorkAfter = false;
  let sawAnyWorkOrCommentaryAfter = false;
  let sawSteerAfterInTurn = false;

  const resetBackwardSegment = (nextTurnId?: string, keepSteerInTurn = false) => {
    backwardTurnId = nextTurnId;
    sawReplyAfter = false;
    sawFinalAfter = false;
    sawNonFailedWorkAfter = false;
    sawAnyWorkOrCommentaryAfter = false;
    sawSteerAfterInTurn = keepSteerInTurn;
  };

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    // A review notice or launched to-do card is not work: an answer it follows is still the answer.
    if (isStandaloneOverlayActivity(entry)) {
      continue;
    }
    if ((entry.type === "message" && entry.role === "user") || isRewindMarkerEntry(entry)) {
      const steerTurnId = entry.turn?.id;
      if (steerTurnId && steerTurnId === backwardTurnId) {
        resetBackwardSegment(steerTurnId, true);
      } else {
        resetBackwardSegment();
      }
      continue;
    }
    const turnId = entry.turn?.id;
    if (!turnId) {
      resetBackwardSegment();
      continue;
    }
    if (turnId !== backwardTurnId) {
      resetBackwardSegment(turnId);
    }
    if (
      entry.type === "activity"
      && (isTokenUsageActivity(entry) || isTerminalTurnFailureActivity(entry))
    ) {
      continue;
    }
    if (entry.type === "activity" && isFileDiffActivity(entry)) {
      const hasWorkOrReplyAfter = sawReplyAfter || sawNonFailedWorkAfter;
      const isTrailing =
        !hasWorkOrReplyAfter
        && (
          entry.id.startsWith("live-diff-")
          || (!acpBackend
            && !entry.id.startsWith("live-tools-")
            && !sawSteerAfterInTurn
            && fileDiffImmediatelyAfterAnswer.has(entry))
        );
      if (isTrailing) {
        trailingFileDiffs.add(entry);
      } else {
        sawAnyWorkOrCommentaryAfter = true;
        if (!isAllFailedActivity(entry)) {
          sawNonFailedWorkAfter = true;
        }
      }
      continue;
    }
    if (
      (entry.type === "activity" && isRichBrowserUseActivity(entry))
      || isConcreteWorkEntry(entry)
    ) {
      sawAnyWorkOrCommentaryAfter = true;
      if (!isAllFailedActivity(entry)) {
        sawNonFailedWorkAfter = true;
      }
      continue;
    }
    if (isAssistantMessage(entry)) {
      if (entry.phase === "commentary" || entry.phase === "partial") {
        sawAnyWorkOrCommentaryAfter = true;
        continue;
      }
      const isProtectedCodexFinal =
        !acpBackend
        && entry.phase === "final"
        && phaseTaggedTurnIds.has(turnId)
        && !sawFinalAfter;
      if (
        !isProtectedCodexFinal
        && (sawNonFailedWorkAfter || (sawAnyWorkOrCommentaryAfter && sawReplyAfter))
      ) {
        interimReplies.add(entry);
      }
      sawReplyAfter = true;
      if (entry.phase === "final") {
        sawFinalAfter = true;
      }
    }
  }

  return { interimReplies, trailingFileDiffs };
}

function isAcpBackend(backend: AppServerBackendKind | undefined): boolean {
  return typeof backend === "string" && backend.startsWith("acp:");
}

function buildCommentaryOnlyGroup(
  messages: AppServerThreadMessageEntry[]
): RenderGroup {
  return {
    collapsible: true,
    entries: messages,
    id: `commentary:${messages[0]?.id ?? "start"}:${messages[messages.length - 1]?.id ?? "end"}:complete`,
    label: previousMessagesLabel(messages.length),
  };
}

function buildCommentaryOnlyGroups(
  entries: AppServerThreadEntry[],
  alwaysVisibleEntryIds?: ReadonlySet<string>,
): RenderGroup[] {
  const groups: RenderGroup[] = [];
  let currentMessages: AppServerThreadMessageEntry[] = [];

  const flushCurrent = (): void => {
    if (currentMessages.length === 0) {
      return;
    }
    groups.push(buildCommentaryOnlyGroup(currentMessages));
    currentMessages = [];
  };

  const completedTurnIds = new Set<string>();
  for (const entry of entries) {
    if (entry.turn && isCompletedTurnMetadata(entry.turn)) {
      completedTurnIds.add(entry.turn.id);
    }
  }

  for (const entry of entries) {
    if (isStandaloneOverlayActivity(entry)) {
      continue;
    }
    if (
      !staysInView(entry, alwaysVisibleEntryIds)
      && isAssistantInterimMessage(entry)
      && !isLiveInProgressTurn(entry.turn, completedTurnIds)
    ) {
      currentMessages.push(entry);
      continue;
    }
    flushCurrent();
  }

  flushCurrent();
  return groups;
}

function isLiveInProgressTurn(
  turn: AppServerThreadTurnMetadata | undefined,
  completedTurnIds: ReadonlySet<string>
): boolean {
  return Boolean(
    turn &&
      turn.status === "in_progress" &&
      !isCompletedTurnMetadata(turn) &&
      !completedTurnIds.has(turn.id)
  );
}

function isCompletedTurnMetadata(turn: AppServerThreadTurnMetadata): boolean {
  return (
    turn.status === "completed" ||
    turn.status === "failed" ||
    turn.status === "cancelled" ||
    turn.status === "interrupted" ||
    typeof turn.durationMs === "number" ||
    typeof turn.completedAt === "number"
  );
}

function renderWithGroups(
  entries: AppServerThreadEntry[],
  groups: RenderGroup[]
): TranscriptRenderItem[] {
  const entryToGroup = new Map<AppServerThreadEntry, RenderGroup>();
  const groupedEntries = new Set<AppServerThreadEntry>();

  for (const group of groups) {
    for (const entry of group.entries) {
      groupedEntries.add(entry);
    }
    const firstEntry = group.entries[0];
    if (firstEntry) {
      entryToGroup.set(firstEntry, group);
    }
  }

  const items: TranscriptRenderItem[] = [];
  for (const entry of entries) {
    const group = entryToGroup.get(entry);
    if (group) {
      items.push({ type: "workPhaseGroup", ...group });
    }
    if (groupedEntries.has(entry)) {
      continue;
    }

    items.push({ type: "entry", entry });
  }

  return items;
}

/**
 * A question waits on the operator, so it never folds into work, whatever its
 * phase. Folded, it lost its answer controls and the To-dos row that links to
 * it had nothing to scroll to.
 */
function staysInView(
  entry: AppServerThreadEntry,
  alwaysVisibleEntryIds: ReadonlySet<string> | undefined,
): boolean {
  return Boolean(alwaysVisibleEntryIds?.has(entry.id)) || isAsyncQuestionMessage(entry);
}

function isAsyncQuestionMessage(entry: AppServerThreadEntry): boolean {
  return asyncQuestionsOfEntry(entry) !== undefined;
}

/** The questions Codex asked in an entry, when the entry draws a question card. */
export function asyncQuestionsOfEntry(
  entry: AppServerThreadEntry,
): AppServerThreadMessageEntry["questions"] {
  return isAssistantMessage(entry)
    && entry.delivery === "async"
    && entry.questions?.length
    ? entry.questions
    : undefined;
}

/**
 * In a review turn every assistant message is working output: the review's
 * answer is its result card. A streamed reply carries no `commentary` phase
 * until it completes, so matching on the phase alone would show each line of
 * a running review before folding it away.
 */
function isAssistantMessage(
  entry: AppServerThreadEntry,
): entry is AppServerThreadMessageEntry {
  return entry.type === "message" && entry.role === "assistant";
}

function isAssistantInterimMessage(
  entry: AppServerThreadEntry | undefined
): entry is AppServerThreadMessageEntry {
  return (
    entry?.type === "message" &&
    entry.role === "assistant" &&
    (entry.phase === "commentary" || entry.phase === "partial")
  );
}

function isStandaloneOverlayActivity(entry: AppServerThreadEntry): boolean {
  return isAutoReviewActivityEntry(entry) || isLaunchedTodoEntry(entry);
}

function isWorkPhaseEntry(
  entry: AppServerThreadEntry,
  trailingFileDiffs?: ReadonlySet<AppServerThreadEntry>,
): entry is
  | AppServerThreadMessageEntry
  | AppServerThreadActivityEntry
  | AppServerThreadPlanEntry {
  if (entry.type === "activity") {
    return (
      !isTerminalTurnFailureActivity(entry) &&
      !isRewindMarkerEntry(entry) &&
      !isLaunchedTodoEntry(entry) &&
      !(trailingFileDiffs ? trailingFileDiffs.has(entry) : isFileDiffActivity(entry)) &&
      !isRichBrowserUseActivity(entry) &&
      !isTokenUsageActivity(entry)
    );
  }

  if (entry.type === "plan") {
    return true;
  }

  return isAssistantInterimMessage(entry);
}

function hasConcreteWork(
  entries: AppServerThreadEntry[],
  trailingFileDiffs?: ReadonlySet<AppServerThreadEntry>,
): boolean {
  return entries.some((entry) =>
    trailingFileDiffs
      ? entry.type === "plan"
        || (entry.type === "activity"
          && !isTerminalTurnFailureActivity(entry)
          && !isRewindMarkerEntry(entry)
          && !isLaunchedTodoEntry(entry)
          && !trailingFileDiffs.has(entry)
          && !isRichBrowserUseActivity(entry)
          && !isTokenUsageActivity(entry))
      : isConcreteWorkEntry(entry),
  );
}

export function isConcreteWorkEntry(
  entry: AppServerThreadEntry
): entry is AppServerThreadActivityEntry | AppServerThreadPlanEntry {
  return (
    entry.type === "plan" ||
    (entry.type === "activity" &&
      !isTerminalTurnFailureActivity(entry) &&
      !isRewindMarkerEntry(entry) &&
      !isLaunchedTodoEntry(entry) &&
      (!isFileDiffActivity(entry) || entry.id.startsWith("live-tools-")) &&
      !isRichBrowserUseActivity(entry) &&
      !isTokenUsageActivity(entry))
  );
}

function isAllFailedActivity(
  entry: AppServerThreadActivityEntry | AppServerThreadPlanEntry,
): boolean {
  return entry.type === "activity"
    && entry.status === "failed"
    && entry.details.every((detail) => detail.status === "failed");
}

function isTerminalTurnFailureActivity(
  entry: AppServerThreadActivityEntry
): boolean {
  return (
    entry.id.startsWith("turn-failed:") &&
    entry.status === "failed" &&
    entry.turn?.status === "failed"
  );
}

function isFileDiffActivity(entry: AppServerThreadActivityEntry): boolean {
  return entry.details.some(hasTranscriptFileDiff);
}

function isRichBrowserUseActivity(entry: AppServerThreadActivityEntry): boolean {
  return Boolean(entry.browserUse && !entry.browserUse.standalone);
}

function isTokenUsageActivity(entry: AppServerThreadActivityEntry): boolean {
  return (
    entry.id.startsWith("live-token-usage-") ||
    entry.id.startsWith("live-turn-usage-") ||
    entry.summary.startsWith("Turn usage:") ||
    entry.summary.startsWith("Monitor usage:") ||
    entry.summary.startsWith("Usage:") ||
    entry.summary.startsWith("Latest request usage:")
  );
}

function readCompletedTurn(
  entries: AppServerThreadEntry[]
): AppServerThreadTurnMetadata | undefined {
  return entries
    .map((entry) => entry.turn)
    .find((turn): turn is AppServerThreadTurnMetadata =>
      Boolean(turn && isCompletedTurnMetadata(turn))
    );
}

// The heading is a count, never a digest of the work it hides. Tool labels
// carry whole command lines and file paths, so quoting even three of them
// wrapped the collapsed row across several lines of the detail it exists to
// fold away. Expanding the group shows every tool row.
function workGroupLabel(
  turn: AppServerThreadTurnMetadata,
  entries: AppServerThreadEntry[],
  verb: "Reviewed" | "Worked",
): string {
  const base = typeof turn.durationMs === "number" && turn.durationMs > 60_000
    ? `${verb} for ${formatElapsedMs(turn.durationMs)}`
    : typeof turn.startedAt === "number"
      && typeof turn.completedAt === "number"
      && turn.completedAt > turn.startedAt + 60_000
      ? `${verb} for ${formatElapsedMs(turn.completedAt - turn.startedAt)}`
      : "Previous work";
  const toolEntries = entries.filter(
    (entry): entry is AppServerThreadActivityEntry =>
      entry.type === "activity"
      // Keep the startup notice available when expanded without counting it
      // as tool work.
      && !(entry.tone === "warning"
        && entry.status !== "failed"
        && entry.summary.startsWith("Warning: Under-development features enabled:")),
  );
  if (toolEntries.length < 2) {
    return base;
  }

  return `${base} · ${toolEntries.length} tool updates`;
}

function previousMessagesLabel(count: number): string {
  return `${count} previous ${count === 1 ? "message" : "messages"}`;
}

export { formatElapsedMs };
