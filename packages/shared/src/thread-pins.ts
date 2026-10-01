export const PIN_RANK_STEP = 1024;

/**
 * Pins the operator keeps at top live in a rank band far below every ordinary
 * pin. The tier travels inside the rank itself, so every store, projection,
 * federation hop, and older build that sorts ranks ascending already puts
 * these pins first. New ordinary ranks (`buildPrependPinRank`) ignore the
 * band, which is what keeps a freshly pinned thread below them.
 *
 * Ordinary prepends step down 1024 from the lowest ordinary rank, so they need
 * about 5e8 prepends to reach the boundary. Ranks this size stay exact well
 * past the midpoint splits `relativePinRanks` makes.
 */
export const KEEP_AT_TOP_RANK_BOUNDARY = -(2 ** 39);
const KEEP_AT_TOP_RANK_BASE = -(2 ** 40);

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

export function isKeptAtTopRank(rank?: string): boolean {
  const parsed = parsePinRank(rank);
  return Number.isFinite(parsed) && parsed < KEEP_AT_TOP_RANK_BOUNDARY;
}

export function isKeptAtTopThread(thread: PinSortableThread): boolean {
  return isKeptAtTopRank(thread.pinnedRank);
}

export function buildAppendPinRank(existingRanks: Array<string | undefined>): string {
  const maxRank = existingRanks.reduce((max, rank) => {
    const parsed = parsePinRank(rank);
    return Number.isFinite(parsed) && !isKeptAtTopRank(rank)
      ? Math.max(max, parsed)
      : max;
  }, 0);
  return String(maxRank + PIN_RANK_STEP);
}

/**
 * The next rank at the TOP of the ordinary pins: one step before the lowest
 * ordinary rank in use, and therefore below every pin kept at top. Ranks may
 * go to zero or below — `parsePinRank` accepts any finite number, and
 * `relativePinRanks` already produces them for a drag to the top.
 */
export function buildPrependPinRank(existingRanks: Array<string | undefined>): string {
  const minRank = existingRanks.reduce((min, rank) => {
    const parsed = parsePinRank(rank);
    return Number.isFinite(parsed) && !isKeptAtTopRank(rank)
      ? Math.min(min, parsed)
      : min;
  }, Number.POSITIVE_INFINITY);
  return String(
    Number.isFinite(minRank) ? minRank - PIN_RANK_STEP : PIN_RANK_STEP,
  );
}

/**
 * Compacted ranks for one tier, in order. Ordinary pins restart at 1024;
 * pins kept at top restart at the band's base, so compaction never moves a
 * pin across the boundary.
 */
export function buildTierPinRanks(
  keys: readonly string[],
  keptAtTop: boolean,
): Record<string, string> {
  const base = keptAtTop ? KEEP_AT_TOP_RANK_BASE : PIN_RANK_STEP;
  return Object.fromEntries(
    keys.map((key, index) => [key, String(base + index * PIN_RANK_STEP)]),
  );
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
