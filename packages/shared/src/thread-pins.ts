export const PIN_RANK_STEP = 1024;

type PinSortableThread = {
  id: string;
  pinnedRank?: string;
  updatedAt?: number;
};

type CreationSortableThread = {
  id: string;
  createdAt?: number;
  updatedAt?: number;
};

export function isPinnedThread(thread: PinSortableThread): boolean {
  return Boolean(thread.pinnedRank?.trim());
}

export function comparePinnedThreads<T extends PinSortableThread>(
  left: T,
  right: T,
): number {
  const rankComparison = comparePinRanks(left.pinnedRank, right.pinnedRank);
  if (rankComparison !== 0) return rankComparison;

  const updatedComparison = (right.updatedAt ?? 0) - (left.updatedAt ?? 0);
  if (updatedComparison !== 0) return updatedComparison;

  return left.id.localeCompare(right.id);
}

export function comparePinRanks(left?: string, right?: string): number {
  const leftNumber = parsePinRank(left);
  const rightNumber = parsePinRank(right);
  if (leftNumber !== rightNumber) return leftNumber - rightNumber;
  return (left ?? "").localeCompare(right ?? "");
}

export function compareThreadsByCreatedAtDesc<T extends CreationSortableThread>(
  left: T,
  right: T,
): number {
  const createdComparison = (right.createdAt ?? 0) - (left.createdAt ?? 0);
  if (createdComparison !== 0) return createdComparison;

  return right.id.localeCompare(left.id);
}

export function buildAppendPinRank(existingRanks: Array<string | undefined>): string {
  const maxRank = existingRanks.reduce((max, rank) => {
    const parsed = parsePinRank(rank);
    return Number.isFinite(parsed) ? Math.max(max, parsed) : max;
  }, 0);
  return String(maxRank + PIN_RANK_STEP);
}

export function buildPinnedRanks(threadIds: string[]): Record<string, string> {
  return Object.fromEntries(
    threadIds.map((threadId, index) => [
      threadId,
      String((index + 1) * PIN_RANK_STEP),
    ]),
  );
}

export function moveThreadKey(
  threadKeys: string[],
  draggedKey: string,
  targetKey: string,
  position: "before" | "after",
): string[] {
  if (draggedKey === targetKey) return threadKeys;

  const withoutDragged = threadKeys.filter((threadKey) => threadKey !== draggedKey);
  const targetIndex = withoutDragged.indexOf(targetKey);
  if (targetIndex === -1) {
    return [...withoutDragged, draggedKey];
  }

  const insertIndex = position === "after" ? targetIndex + 1 : targetIndex;
  return [
    ...withoutDragged.slice(0, insertIndex),
    draggedKey,
    ...withoutDragged.slice(insertIndex),
  ];
}

function parsePinRank(rank?: string): number {
  if (!rank?.trim()) return Number.POSITIVE_INFINITY;
  const parsed = Number(rank);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}
