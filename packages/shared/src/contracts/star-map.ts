/**
 * Star Map card arrangement: operator-dragged offsets for attention-thread
 * cards, keyed by owning instance + thread identity, synced across the
 * federation last-writer-wins so every instance renders the same map.
 *
 * Offsets are relative to the card's default slot (not absolute pixels), so
 * layouts survive viewport differences between machines. A null offset pair
 * is a tombstone: "back to the default slot", propagated like any write so
 * resets converge too.
 */

export type StarMapArrangementEntry = {
  /** Federation instance that owns the thread this card represents. */
  instanceId: string;
  /** buildThreadIdentityKey(source, id) of the thread. */
  threadKey: string;
  /** Pixel offset from the default slot; null with null dy = tombstone. */
  dx: number | null;
  dy: number | null;
  updatedAt: number;
  /** Instance that made the write — the deterministic LWW tiebreak. */
  by: string;
};

export function starMapArrangementEntryKey(
  entry: Pick<StarMapArrangementEntry, "instanceId" | "threadKey">,
): string {
  return `${entry.instanceId} ${entry.threadKey}`;
}

export function isStarMapArrangementEntry(
  value: unknown,
): value is StarMapArrangementEntry {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<StarMapArrangementEntry>;
  const offsetValid = (offset: unknown): offset is number | null =>
    offset === null || (typeof offset === "number" && Number.isFinite(offset));
  return (
    typeof candidate.instanceId === "string"
    && candidate.instanceId.length > 0
    && typeof candidate.threadKey === "string"
    && candidate.threadKey.length > 0
    && offsetValid(candidate.dx)
    && offsetValid(candidate.dy)
    // A half-tombstone is malformed; both offsets live or both die.
    && (candidate.dx === null) === (candidate.dy === null)
    && typeof candidate.updatedAt === "number"
    && Number.isFinite(candidate.updatedAt)
    && typeof candidate.by === "string"
    && candidate.by.length > 0
  );
}

/**
 * Merge incoming entries into the current arrangement, last-writer-wins per
 * card. Ties break on the writing instance id so replicas converge no
 * matter the merge order. Returns the accepted incoming entries so callers
 * can persist and re-broadcast deltas only.
 */
export function mergeStarMapArrangementEntries(
  current: readonly StarMapArrangementEntry[],
  incoming: readonly StarMapArrangementEntry[],
): {
  entries: StarMapArrangementEntry[];
  accepted: StarMapArrangementEntry[];
  changed: boolean;
} {
  const merged = new Map<string, StarMapArrangementEntry>();
  for (const entry of current) {
    merged.set(starMapArrangementEntryKey(entry), entry);
  }
  const accepted: StarMapArrangementEntry[] = [];
  for (const entry of incoming) {
    if (!isStarMapArrangementEntry(entry)) continue;
    const key = starMapArrangementEntryKey(entry);
    const existing = merged.get(key);
    if (existing && !arrangementEntryBeats(entry, existing)) {
      continue;
    }
    if (
      !existing
      || existing.dx !== entry.dx
      || existing.dy !== entry.dy
      || existing.updatedAt !== entry.updatedAt
      || existing.by !== entry.by
    ) {
      accepted.push(entry);
    }
    merged.set(key, entry);
  }
  return {
    entries: [...merged.values()],
    accepted,
    changed: accepted.length > 0,
  };
}

function arrangementEntryBeats(
  candidate: StarMapArrangementEntry,
  incumbent: StarMapArrangementEntry,
): boolean {
  if (candidate.updatedAt !== incumbent.updatedAt) {
    return candidate.updatedAt > incumbent.updatedAt;
  }
  return candidate.by > incumbent.by;
}

export type ReadStarMapArrangementResponse = {
  entries: StarMapArrangementEntry[];
};

export type SetStarMapCardPositionRequest = {
  instanceId: string;
  threadKey: string;
  /** null resets the card to its default slot (tombstone write). */
  dx: number | null;
  dy: number | null;
};
