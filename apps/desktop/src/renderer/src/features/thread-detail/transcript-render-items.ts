import type {
  AppServerThreadActivityEntry,
  AppServerThreadEntry,
  AppServerThreadMessageEntry,
  AppServerThreadPlanEntry,
  AppServerThreadTurnMetadata,
} from "@pwragnt/shared";

export type TranscriptRenderItem =
  | {
      type: "entry";
      entry: AppServerThreadEntry;
    }
  | {
      type: "workPhaseGroup";
      id: string;
      collapsible: boolean;
      entries: AppServerThreadEntry[];
      label: string;
    };

export function buildTranscriptRenderItems(params: {
  entries: AppServerThreadEntry[];
  activeTurnId?: string;
  activeTurnStartedAt?: number;
  activeMessageId?: string;
  now?: number;
}): TranscriptRenderItem[] {
  const activeTurnId =
    params.activeTurnId ??
    params.entries.find((entry) => entry.id === params.activeMessageId)?.turn?.id;

  if (params.activeMessageId && !activeTurnId) {
    return params.entries.map((entry) => ({ type: "entry", entry }));
  }

  if (activeTurnId) {
    const groups = buildCompletedGroups(params.entries, activeTurnId);
    const activeGroup = buildActiveWorkGroup(
      params.entries,
      activeTurnId,
      params.now,
      params.activeTurnStartedAt
    );
    if (activeGroup) {
      groups.push(activeGroup);
    }
    if (groups.length > 0) {
      return renderWithGroups(params.entries, groups);
    }

    return params.entries.map((entry) => ({ type: "entry", entry }));
  }

  const completedGroups = buildCompletedGroups(params.entries);
  if (completedGroups.length > 0) {
    return renderWithGroups(params.entries, completedGroups);
  }

  const fallbackGroups = buildCommentaryOnlyGroups(params.entries);
  if (fallbackGroups.length === 0) {
    return params.entries.map((entry) => ({ type: "entry", entry }));
  }

  return renderWithGroups(params.entries, fallbackGroups);
}

type RenderGroup = {
  collapsible: boolean;
  entries: AppServerThreadEntry[];
  id: string;
  label: string;
};

function buildActiveWorkGroup(
  entries: AppServerThreadEntry[],
  activeTurnId: string,
  now = Date.now(),
  activeTurnStartedAt?: number
): RenderGroup | undefined {
  const turnEntries = entries.filter(
    (entry) => entry.turn?.id === activeTurnId && isWorkPhaseEntry(entry)
  );
  if (!hasConcreteWork(turnEntries)) {
    return undefined;
  }

  const turn = turnEntries.find((entry) => entry.turn)?.turn;
  const startedAtCandidates = [activeTurnStartedAt, turn?.startedAt].filter(
    (value): value is number => typeof value === "number"
  );
  const startedAt =
    startedAtCandidates.length > 0 ? Math.min(...startedAtCandidates) : undefined;
  const elapsedMs =
    typeof startedAt === "number" ? Math.max(now - startedAt, 0) : undefined;
  if (typeof elapsedMs !== "number" || elapsedMs <= 60_000) {
    return undefined;
  }

  return {
    collapsible: false,
    entries: turnEntries,
    id: `work:${activeTurnId}:active`,
    label: `Working for ${formatElapsedMs(elapsedMs)}`,
  };
}

function buildCompletedGroups(
  entries: AppServerThreadEntry[],
  excludeTurnId?: string
): RenderGroup[] {
  const groups: RenderGroup[] = [];
  const groupIds = new Set<string>();
  const completedWorkTurnIds = new Set<string>();
  let currentEntries: AppServerThreadEntry[] = [];
  let currentTurnId: string | undefined;

  const flushCurrent = (): void => {
    if (currentEntries.length === 0 || !currentTurnId) {
      currentEntries = [];
      currentTurnId = undefined;
      return;
    }

    const turn = readCompletedTurn(currentEntries);
    if (!turn) {
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
      collapsible: true,
      entries: currentEntries,
      id,
      label: hasWork
        ? repeatedWorkTurn
          ? "More work"
          : workGroupLabel(turn)
        : previousMessagesLabel(currentEntries.filter(isAssistantCommentaryMessage).length),
    });
    if (hasWork) {
      completedWorkTurnIds.add(currentTurnId);
    }
    currentEntries = [];
    currentTurnId = undefined;
  };

  for (const entry of entries) {
    const turnId = entry.turn?.id;
    const canJoinGroup =
      Boolean(turnId) &&
      turnId !== excludeTurnId &&
      isWorkPhaseEntry(entry);

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

function buildCommentaryOnlyGroups(entries: AppServerThreadEntry[]): RenderGroup[] {
  const groups: RenderGroup[] = [];
  let currentMessages: AppServerThreadMessageEntry[] = [];

  const flushCurrent = (): void => {
    if (currentMessages.length === 0) {
      return;
    }
    groups.push(buildCommentaryOnlyGroup(currentMessages));
    currentMessages = [];
  };

  for (const entry of entries) {
    if (isAssistantCommentaryMessage(entry)) {
      currentMessages.push(entry);
      continue;
    }
    flushCurrent();
  }

  flushCurrent();
  return groups;
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
  if (entry.type === "activity" || entry.type === "plan") {
    return true;
  }

  return isAssistantCommentaryMessage(entry);
}

function hasConcreteWork(entries: AppServerThreadEntry[]): boolean {
  return entries.some((entry) => entry.type === "activity" || entry.type === "plan");
}

function readCompletedTurn(
  entries: AppServerThreadEntry[]
): AppServerThreadTurnMetadata | undefined {
  return entries
    .map((entry) => entry.turn)
    .find((turn): turn is AppServerThreadTurnMetadata =>
      Boolean(
        turn &&
          (turn.status === "completed" ||
            turn.status === "failed" ||
            turn.status === "cancelled" ||
            turn.status === "interrupted" ||
            typeof turn.durationMs === "number" ||
            typeof turn.completedAt === "number")
      )
    );
}

function workGroupLabel(turn: AppServerThreadTurnMetadata): string {
  if (typeof turn.durationMs === "number" && turn.durationMs > 60_000) {
    return `Worked for ${formatElapsedMs(turn.durationMs)}`;
  }

  if (
    typeof turn.startedAt === "number" &&
    typeof turn.completedAt === "number" &&
    turn.completedAt > turn.startedAt + 60_000
  ) {
    return `Worked for ${formatElapsedMs(turn.completedAt - turn.startedAt)}`;
  }

  return "Previous work";
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
