/**
 * Celestial instance icons.
 *
 * Every federation instance gets a unique celestial icon as a recognition
 * device ("oh, this is the moon — that's that machine"). The gateway
 * coordinates auto-assignment; operators may override per instance. The five
 * ids below are the full v1 set — renderers must treat unknown ids as
 * unassigned rather than crashing so older builds tolerate future additions.
 */

export const CELESTIAL_ICON_IDS = [
  "sun",
  "moon",
  "ringed-planet",
  "tilted-ringed-planet",
  "black-hole",
] as const;

export type CelestialIconId = (typeof CELESTIAL_ICON_IDS)[number];

export function isCelestialIconId(value: unknown): value is CelestialIconId {
  return (
    typeof value === "string"
    && (CELESTIAL_ICON_IDS as readonly string[]).includes(value)
  );
}

export type CelestialIconAssignmentSource = "auto" | "override";

/**
 * Upper bound on how many assignment entries an instance will accept and
 * persist. The LWW merge otherwise grows without limit, so a buggy or
 * hostile peer could permanently bloat every instance's persisted map by
 * streaming fabricated instance ids.
 */
export const MAX_CELESTIAL_ASSIGNMENTS = 64;

export interface CelestialIconAssignment {
  instanceId: string;
  icon: CelestialIconId;
  source: CelestialIconAssignmentSource;
  updatedAt: number;
  /**
   * Tombstone: the instance left the federation (revoked or pruned), so its
   * icon is free again. Tombstones ride the same LWW merge that assignments
   * do — that is what lets a removal propagate, since a plain merge can only
   * ever add. The `icon` field keeps the last assigned value so older builds
   * that predate tombstones still validate the entry; they simply keep
   * showing the icon, which matches their pre-tombstone behavior.
   */
  removed?: boolean;
}

export function isCelestialIconAssignment(
  value: unknown,
): value is CelestialIconAssignment {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<CelestialIconAssignment>;
  return (
    typeof candidate.instanceId === "string"
    && candidate.instanceId.length > 0
    && isCelestialIconId(candidate.icon)
    && (candidate.source === "auto" || candidate.source === "override")
    && typeof candidate.updatedAt === "number"
    && Number.isFinite(candidate.updatedAt)
    && (candidate.removed === undefined || typeof candidate.removed === "boolean")
  );
}

/**
 * Deterministically pick an icon for an instance.
 *
 * The gateway reads as the hub of the map, so it prefers the sun. Everyone
 * else takes the first unassigned id in declaration order. When all five ids
 * are taken the pick degrades to a stable hash of the instance id so repeated
 * recomputation never flaps an existing assignment.
 */
export function pickCelestialIcon(
  assigned: ReadonlyMap<string, CelestialIconId>,
  instanceId: string,
  options?: { isGateway?: boolean },
): CelestialIconId {
  const existing = assigned.get(instanceId);
  if (existing) {
    return existing;
  }
  const taken = new Set(assigned.values());
  if (options?.isGateway && !taken.has("sun")) {
    return "sun";
  }
  // Non-hub instances leave the sun for the hub: it reads as the center of
  // the map, so it is only ever picked last by everyone else.
  const order = options?.isGateway
    ? CELESTIAL_ICON_IDS
    : [...CELESTIAL_ICON_IDS.filter((icon) => icon !== "sun"), "sun" as const];
  for (const icon of order) {
    if (!taken.has(icon)) {
      return icon;
    }
  }
  // All ids taken: degrade to a stable hash so recomputation never flaps.
  // Non-hub instances hash over the sun-less pool — the order array ends
  // with the sun for them, so slicing it off keeps the sun-last rule intact
  // even here: a duplicated planet is recoverable noise, a duplicated sun
  // reads as two hubs.
  const fallback = options?.isGateway ? order : order.slice(0, -1);
  return fallback[hashInstanceId(instanceId) % fallback.length];
}

/**
 * Merge incoming assignments into the current map, last-writer-wins.
 *
 * Ties resolve override-before-auto, then by lexicographic instance id of
 * the writer being irrelevant here — the entry itself carries everything —
 * so the deterministic tiebreak is source rank alone. Returns the merged
 * array plus whether anything changed, so callers can skip persistence and
 * re-broadcast on no-op merges (offline peers replaying old snapshots).
 */
export function mergeCelestialIconAssignments(
  current: readonly CelestialIconAssignment[],
  incoming: readonly CelestialIconAssignment[],
): { assignments: CelestialIconAssignment[]; changed: boolean } {
  const merged = new Map<string, CelestialIconAssignment>();
  for (const assignment of current) {
    merged.set(assignment.instanceId, assignment);
  }
  let changed = false;
  for (const assignment of incoming) {
    if (!isCelestialIconAssignment(assignment)) continue;
    const existing = merged.get(assignment.instanceId);
    if (existing && !celestialAssignmentBeats(assignment, existing)) {
      continue;
    }
    if (
      !existing
      || existing.icon !== assignment.icon
      || existing.source !== assignment.source
      || existing.updatedAt !== assignment.updatedAt
      || (existing.removed ?? false) !== (assignment.removed ?? false)
    ) {
      changed = true;
    }
    merged.set(assignment.instanceId, assignment);
  }
  return { assignments: [...merged.values()], changed };
}

function celestialAssignmentBeats(
  candidate: CelestialIconAssignment,
  incumbent: CelestialIconAssignment,
): boolean {
  if (candidate.updatedAt !== incumbent.updatedAt) {
    return candidate.updatedAt > incumbent.updatedAt;
  }
  if (candidate.source !== incumbent.source) {
    return candidate.source === "override";
  }
  if ((candidate.removed ?? false) !== (incumbent.removed ?? false)) {
    // Deterministic either way; removal wins so a same-instant revoke does
    // not resurrect on merge order.
    return candidate.removed === true;
  }
  return candidate.icon > incumbent.icon;
}

export type SetCelestialIconRequest = {
  instanceId: string;
  /**
   * A concrete id applies an operator override; null clears the override
   * back to auto-assignment.
   */
  icon: CelestialIconId | null;
};

export type SetCelestialIconResponse = {
  assignments: CelestialIconAssignment[];
};

function hashInstanceId(instanceId: string): number {
  let hash = 5381;
  for (let index = 0; index < instanceId.length; index += 1) {
    hash = ((hash << 5) + hash + instanceId.charCodeAt(index)) >>> 0;
  }
  return hash;
}
