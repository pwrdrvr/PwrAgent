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

/**
 * Reserved `threadKey` for an instance's load card. Thread keys are
 * `buildThreadIdentityKey(source, id)` and every real backend source is a
 * known kind, so a `system:` prefix cannot collide with one.
 *
 * Using the existing record instead of adding a field keeps this change
 * additive on the wire: arrangement entries cross the federation, and an
 * older peer validates only that `threadKey` is a non-empty string — it
 * stores and relays the offset for a card it does not know how to render,
 * rather than rejecting the merge.
 *
 * Presence is membership. An entry with live offsets means "this card is on
 * the map" (`0,0` = open at its default spot); the null-pair tombstone that
 * resets a thread card doubles as "closed" here. That is what makes the
 * load card appear on every instance in the fleet, since arrangement writes
 * already broadcast last-writer-wins.
 */
export const STAR_MAP_LOAD_CARD_KEY = "system:load";

/**
 * Where a load card sits, kept separate from whether it is shown.
 *
 * Membership and position cannot share one entry: closing a card has to
 * un-place it, and the only "absent" value an entry has is the null-pair
 * tombstone — which is also how a card forgets its offset. Sharing them made
 * closing a card destroy the spot the operator had dragged it to, so
 * reopening dumped it back on top of whatever sits at the default.
 */
export const STAR_MAP_LOAD_CARD_POSITION_KEY = "system:load:position";

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

/* ==== AI intake ==== */

export type StarMapIntakeCandidate = {
  directoryKey: string;
  label: string;
  path?: string;
};

/**
 * Intake dispatch, executed ON the owning instance so its directory
 * registry, launchpad defaults, and ~/.pwragent/AGENTS.md preferences are
 * the ones consulted. `directoryKey` is set on a disambiguation resubmit.
 *
 * Backend/thread ids are plain strings here (not the normalized app-server
 * types) so this contract stays leaf-importable without a type cycle.
 */
export type StarMapIntakeRequest = {
  requestId: string;
  request: string;
  directoryKey?: string;
};

export type StarMapIntakeResponse =
  | {
      status: "created";
      requestId: string;
      backend: string;
      threadId: string;
      title?: string;
    }
  | {
      status: "needs_disambiguation";
      requestId: string;
      /** Ranked candidate projects for the operator to pick from. */
      candidates: StarMapIntakeCandidate[];
    }
  | {
      status: "failed";
      requestId: string;
      error: string;
    };

export type StarMapIntakePhase =
  | "resolving"
  | "creating"
  | "needs_disambiguation"
  | "done"
  | "failed";
