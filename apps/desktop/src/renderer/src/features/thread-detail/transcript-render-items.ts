import type {
  AppServerThreadActivityEntry,
  AppServerThreadEntry,
  AppServerThreadMessageEntry,
  AppServerThreadPlanEntry,
  AppServerThreadTurnMetadata,
} from "@pwragent/shared";

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
      entries: AppServerThreadEntry[];
      label: string;
    };

export const ACTIVE_WORK_GROUP_THRESHOLD_MS = 60_000;

export function buildTranscriptRenderItems(params: {
  entries: AppServerThreadEntry[];
  activeTurnId?: string;
  activeTurnStartedAt?: number;
  activeMessageId?: string;
  alwaysVisibleEntryIds?: ReadonlySet<string>;
  now?: number;
}): TranscriptRenderItem[] {
  const activeTurnId =
    params.activeTurnId ??
    params.entries.find((entry) => entry.id === params.activeMessageId)?.turn?.id;

  if (params.activeMessageId && !activeTurnId) {
    return params.entries.map((entry) => ({ type: "entry", entry }));
  }

  const reviewTurnIds = collectReviewTurnIds(params.entries);

  if (activeTurnId) {
    // A running review folds its work between the cards as it goes, so the
    // transcript reads start card, one collapsed group, result card — rather
    // than streaming every commentary line the review writes along the way.
    const activeReview = reviewTurnIds.has(activeTurnId)
      ? {
          startedAt: activeTurnStartedAt(
            params.entries,
            activeTurnId,
            params.activeTurnStartedAt,
          ),
          turnId: activeTurnId,
        }
      : undefined;
    const groups = buildCompletedGroups(
      params.entries,
      activeReview ? undefined : activeTurnId,
      params.alwaysVisibleEntryIds,
      reviewTurnIds,
      activeReview,
    );
    const activeGroups = activeReview
      ? []
      : buildActiveWorkGroups(
          params.entries,
          activeTurnId,
          params.now,
          params.activeTurnStartedAt,
          params.alwaysVisibleEntryIds,
        );
    groups.push(...activeGroups);
    if (groups.length > 0) {
      return renderWithGroups(params.entries, groups);
    }

    return params.entries.map((entry) => ({ type: "entry", entry }));
  }

  const completedGroups = buildCompletedGroups(
    params.entries,
    undefined,
    params.alwaysVisibleEntryIds,
    reviewTurnIds,
  );
  if (completedGroups.length > 0) {
    return renderWithGroups(params.entries, completedGroups);
  }

  const fallbackGroups = buildCommentaryOnlyGroups(
    params.entries,
    params.alwaysVisibleEntryIds,
  );
  if (fallbackGroups.length === 0) {
    return params.entries.map((entry) => ({ type: "entry", entry }));
  }

  return renderWithGroups(params.entries, fallbackGroups);
}

type RenderGroup = {
  activeStartedAt?: number;
  activeVerb?: string;
  collapsible: boolean;
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
    if (
      alwaysVisibleEntryIds?.has(entry.id)
      || entry.turn?.id !== activeTurnId
      || !isConcreteWorkEntry(entry)
    ) {
      break;
    }
    activeEntries.unshift(entry);
  }

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

    const hasWork = hasConcreteWork(currentEntries);
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
    const turnId = entry.turn?.id;
    const isReplyBetweenReviewCards =
      Boolean(turnId)
      && isAssistantMessage(entry)
      && (turnId === activeReview?.turnId
        || index < (lastReviewIndexByTurn.get(turnId ?? "") ?? -1));
    const canJoinGroup =
      !alwaysVisibleEntryIds?.has(entry.id)
      && Boolean(turnId)
      && turnId !== excludeTurnId
      && (isWorkPhaseEntry(entry) || isReplyBetweenReviewCards);

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
  return groups;
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
    if (
      !alwaysVisibleEntryIds?.has(entry.id)
      && isAssistantCommentaryMessage(entry)
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

function isAssistantCommentaryMessage(
  entry: AppServerThreadEntry | undefined
): entry is AppServerThreadMessageEntry {
  return (
    entry?.type === "message" &&
    entry.role === "assistant" &&
    entry.phase === "commentary"
  );
}

function isWorkPhaseEntry(
  entry: AppServerThreadEntry
): entry is
  | AppServerThreadMessageEntry
  | AppServerThreadActivityEntry
  | AppServerThreadPlanEntry {
  if (entry.type === "activity") {
    return (
      !isTerminalTurnFailureActivity(entry) &&
      !isFileDiffActivity(entry) &&
      !isTokenUsageActivity(entry)
    );
  }

  if (entry.type === "plan") {
    return true;
  }

  return isAssistantCommentaryMessage(entry);
}

function hasConcreteWork(entries: AppServerThreadEntry[]): boolean {
  return entries.some(isConcreteWorkEntry);
}

function isConcreteWorkEntry(
  entry: AppServerThreadEntry
): entry is AppServerThreadActivityEntry | AppServerThreadPlanEntry {
  return (
    entry.type === "plan" ||
    (entry.type === "activity" &&
      !isTerminalTurnFailureActivity(entry) &&
      !isFileDiffActivity(entry) &&
      !isTokenUsageActivity(entry))
  );
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
  return entry.details.some((detail) =>
    Boolean(detail.fileDiff?.diff || detail.fileDiff?.omittedReason)
  );
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

export function formatElapsedMs(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (totalMinutes > 0) {
    return `${totalMinutes}m ${seconds.toString().padStart(2, "0")}s`;
  }
  return `${seconds}s`;
}
