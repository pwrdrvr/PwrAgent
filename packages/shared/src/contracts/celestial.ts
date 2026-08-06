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

export interface CelestialIconAssignment {
  instanceId: string;
  icon: CelestialIconId;
  source: CelestialIconAssignmentSource;
  updatedAt: number;
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
  return CELESTIAL_ICON_IDS[hashInstanceId(instanceId) % CELESTIAL_ICON_IDS.length];
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
  return candidate.icon > incumbent.icon;
}

export type SetCelestialIconRequest = {
  instanceId: string;
  icon: CelestialIconId;
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
