import { describe, expect, it } from "vitest";
import {
  CELESTIAL_ICON_IDS,
  isCelestialIconAssignment,
  isCelestialIconId,
  mergeCelestialIconAssignments,
  pickCelestialIcon,
  type CelestialIconAssignment,
  type CelestialIconId,
} from "../celestial";

const assignment = (
  instanceId: string,
  icon: CelestialIconId,
  updatedAt: number,
  source: "auto" | "override" = "auto",
): CelestialIconAssignment => ({ instanceId, icon, source, updatedAt });

describe("isCelestialIconId", () => {
  it("accepts every declared id and rejects everything else", () => {
    for (const icon of CELESTIAL_ICON_IDS) {
      expect(isCelestialIconId(icon)).toBe(true);
    }
    expect(isCelestialIconId("comet")).toBe(false);
    expect(isCelestialIconId(undefined)).toBe(false);
    expect(isCelestialIconId(3)).toBe(false);
  });
});

describe("isCelestialIconAssignment", () => {
  it("validates the full record shape", () => {
    expect(isCelestialIconAssignment(assignment("pwr_a", "moon", 1))).toBe(true);
    expect(isCelestialIconAssignment({ instanceId: "", icon: "moon", source: "auto", updatedAt: 1 })).toBe(false);
    expect(isCelestialIconAssignment({ instanceId: "pwr_a", icon: "comet", source: "auto", updatedAt: 1 })).toBe(false);
    expect(isCelestialIconAssignment({ instanceId: "pwr_a", icon: "moon", source: "manual", updatedAt: 1 })).toBe(false);
    expect(isCelestialIconAssignment({ instanceId: "pwr_a", icon: "moon", source: "auto", updatedAt: Number.NaN })).toBe(false);
    expect(isCelestialIconAssignment(null)).toBe(false);
  });

  it("accepts tombstones and rejects non-boolean removed flags", () => {
    expect(
      isCelestialIconAssignment({ ...assignment("pwr_a", "moon", 1), removed: true }),
    ).toBe(true);
    expect(
      isCelestialIconAssignment({ ...assignment("pwr_a", "moon", 1), removed: false }),
    ).toBe(true);
    expect(
      isCelestialIconAssignment({ ...assignment("pwr_a", "moon", 1), removed: "yes" }),
    ).toBe(false);
  });
});

describe("pickCelestialIcon", () => {
  it("gives the gateway the sun first", () => {
    expect(pickCelestialIcon(new Map(), "pwr_gw", { isGateway: true })).toBe("sun");
  });

  it("keeps the sun for the hub: non-gateway picks start at the moon", () => {
    expect(pickCelestialIcon(new Map(), "pwr_a")).toBe("moon");
  });

  it("returns an existing assignment unchanged", () => {
    const assigned = new Map<string, CelestialIconId>([["pwr_a", "black-hole"]]);
    expect(pickCelestialIcon(assigned, "pwr_a")).toBe("black-hole");
  });

  it("assigns each id once before reusing", () => {
    const assigned = new Map<string, CelestialIconId>();
    const seen = new Set<CelestialIconId>();
    for (const id of ["pwr_gw", "pwr_a", "pwr_b", "pwr_c", "pwr_d"]) {
      const icon = pickCelestialIcon(assigned, id, {
        isGateway: id === "pwr_gw",
      });
      expect(seen.has(icon)).toBe(false);
      seen.add(icon);
      assigned.set(id, icon);
    }
    expect(seen.size).toBe(CELESTIAL_ICON_IDS.length);
  });

  it("degrades to a stable hash pick when every icon is taken", () => {
    const assigned = new Map<string, CelestialIconId>(
      CELESTIAL_ICON_IDS.map((icon, index) => [`pwr_${index}`, icon]),
    );
    const first = pickCelestialIcon(assigned, "pwr_overflow");
    const second = pickCelestialIcon(assigned, "pwr_overflow");
    expect(first).toBe(second);
    expect(isCelestialIconId(first)).toBe(true);
  });

  it("never hands a non-gateway the sun, even in the hash fallback", () => {
    const assigned = new Map<string, CelestialIconId>(
      CELESTIAL_ICON_IDS.map((icon, index) => [`pwr_${index}`, icon]),
    );
    for (let index = 0; index < 32; index += 1) {
      expect(pickCelestialIcon(assigned, `pwr_overflow_${index}`)).not.toBe("sun");
    }
  });
});

describe("mergeCelestialIconAssignments", () => {
  it("keeps the newer entry per instance", () => {
    const merged = mergeCelestialIconAssignments(
      [assignment("pwr_a", "moon", 10)],
      [assignment("pwr_a", "sun", 20)],
    );
    expect(merged.changed).toBe(true);
    expect(merged.assignments).toEqual([assignment("pwr_a", "sun", 20)]);
  });

  it("ignores older entries and reports no change", () => {
    const merged = mergeCelestialIconAssignments(
      [assignment("pwr_a", "moon", 20)],
      [assignment("pwr_a", "sun", 10)],
    );
    expect(merged.changed).toBe(false);
    expect(merged.assignments).toEqual([assignment("pwr_a", "moon", 20)]);
  });

  it("breaks updatedAt ties toward overrides", () => {
    const merged = mergeCelestialIconAssignments(
      [assignment("pwr_a", "moon", 10)],
      [assignment("pwr_a", "sun", 10, "override")],
    );
    expect(merged.assignments[0].icon).toBe("sun");
    expect(merged.assignments[0].source).toBe("override");
  });

  it("is idempotent: replaying a snapshot reports no change", () => {
    const snapshot = [
      assignment("pwr_a", "moon", 10),
      assignment("pwr_b", "sun", 12, "override"),
    ];
    const once = mergeCelestialIconAssignments([], snapshot);
    expect(once.changed).toBe(true);
    const twice = mergeCelestialIconAssignments(once.assignments, snapshot);
    expect(twice.changed).toBe(false);
    expect(twice.assignments).toEqual(once.assignments);
  });

  it("converges regardless of merge order", () => {
    const a = [assignment("pwr_a", "moon", 10), assignment("pwr_b", "sun", 30)];
    const b = [assignment("pwr_a", "black-hole", 20), assignment("pwr_c", "ringed-planet", 5)];
    const ab = mergeCelestialIconAssignments(a, b).assignments;
    const ba = mergeCelestialIconAssignments(b, a).assignments;
    const sortById = (entries: CelestialIconAssignment[]) =>
      [...entries].sort((left, right) =>
        left.instanceId.localeCompare(right.instanceId),
      );
    expect(sortById(ab)).toEqual(sortById(ba));
  });

  it("propagates a newer tombstone and lets a newer assignment revive it", () => {
    const tombstone: CelestialIconAssignment = {
      ...assignment("pwr_a", "moon", 20),
      removed: true,
    };
    const removedMerge = mergeCelestialIconAssignments(
      [assignment("pwr_a", "moon", 10)],
      [tombstone],
    );
    expect(removedMerge.changed).toBe(true);
    expect(removedMerge.assignments).toEqual([tombstone]);

    // Replaying the tombstone is a no-op.
    const replay = mergeCelestialIconAssignments(removedMerge.assignments, [tombstone]);
    expect(replay.changed).toBe(false);

    // An older tombstone loses to the live assignment.
    const staleTombstone = mergeCelestialIconAssignments(
      [assignment("pwr_a", "moon", 30)],
      [tombstone],
    );
    expect(staleTombstone.changed).toBe(false);
    expect(staleTombstone.assignments).toEqual([assignment("pwr_a", "moon", 30)]);

    // A newer assignment (re-enrollment) revives the instance.
    const revived = mergeCelestialIconAssignments(
      removedMerge.assignments,
      [assignment("pwr_a", "ringed-planet", 40)],
    );
    expect(revived.changed).toBe(true);
    expect(revived.assignments).toEqual([assignment("pwr_a", "ringed-planet", 40)]);
  });

  it("breaks full ties toward removal so merge order cannot resurrect", () => {
    const live = assignment("pwr_a", "moon", 10);
    const tombstone: CelestialIconAssignment = { ...live, removed: true };
    const forward = mergeCelestialIconAssignments([live], [tombstone]);
    const backward = mergeCelestialIconAssignments([tombstone], [live]);
    expect(forward.assignments).toEqual([tombstone]);
    expect(backward.assignments).toEqual([tombstone]);
  });

  it("ranks removal above source so a tied override cannot resurrect", () => {
    // The tombstone revokePeer writes is source:"auto"; an operator
    // override landing in the same millisecond must not outrank it.
    const tombstone: CelestialIconAssignment = {
      ...assignment("pwr_a", "moon", 10),
      removed: true,
    };
    const override = assignment("pwr_a", "sun", 10, "override");
    expect(
      mergeCelestialIconAssignments([tombstone], [override]).assignments,
    ).toEqual([tombstone]);
    expect(
      mergeCelestialIconAssignments([override], [tombstone]).assignments,
    ).toEqual([tombstone]);
  });

  it("drops malformed incoming entries", () => {
    const merged = mergeCelestialIconAssignments(
      [],
      [
        assignment("pwr_a", "moon", 10),
        { instanceId: "pwr_bad", icon: "comet", source: "auto", updatedAt: 1 } as unknown as CelestialIconAssignment,
      ],
    );
    expect(merged.assignments).toEqual([assignment("pwr_a", "moon", 10)]);
  });
});
