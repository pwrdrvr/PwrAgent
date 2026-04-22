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

  const commentaryMessages = params.entries.filter(isAssistantCommentaryMessage);
  if (commentaryMessages.length === 0) {
    return params.entries.map((entry) => ({ type: "entry", entry }));
  }

  const fallbackGroup = buildCommentaryOnlyGroup(commentaryMessages);
  return renderWithGroups(params.entries, [fallbackGroup]);
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
  const grouped = new Map<string, AppServerThreadEntry[]>();

  for (const entry of entries) {
    if (!entry.turn?.id || entry.turn.id === excludeTurnId || !isWorkPhaseEntry(entry)) {
      continue;
    }

    const current = grouped.get(entry.turn.id) ?? [];
    current.push(entry);
    grouped.set(entry.turn.id, current);
  }

  return [...grouped.entries()].flatMap(([turnId, turnEntries]) => {
    if (turnEntries.length === 0) {
      return [];
    }

    const turn = readCompletedTurn(turnEntries);
    if (!turn) {
      return [];
    }

    const hasWork = hasConcreteWork(turnEntries);
    return [
      {
        collapsible: true,
        entries: turnEntries,
        id: `${hasWork ? "work" : "commentary"}:${turnId}:complete`,
        label: hasWork
          ? workGroupLabel(turn)
          : previousMessagesLabel(turnEntries.filter(isAssistantCommentaryMessage).length),
      },
    ];
  });
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

function renderWithGroups(
  entries: AppServerThreadEntry[],
  groups: RenderGroup[]
): TranscriptRenderItem[] {
  const entryToGroup = new Map<string, RenderGroup>();
  const groupedEntryIds = new Set<string>();

  for (const group of groups) {
    for (const entry of group.entries) {
      groupedEntryIds.add(entry.id);
    }
    const firstEntry = group.entries[0];
    if (firstEntry) {
      entryToGroup.set(firstEntry.id, group);
    }
  }

  const items: TranscriptRenderItem[] = [];
  for (const entry of entries) {
    const group = entryToGroup.get(entry.id);
    if (group) {
      items.push({ type: "workPhaseGroup", ...group });
    }
    if (groupedEntryIds.has(entry.id)) {
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
