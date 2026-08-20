import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  federatedThreadIdentityKey,
  type NavigationThreadSummary,
} from "@pwragent/shared";
import { threadAttentionCategories } from "../attention";
import {
  cardRiseDelays,
  cloudDetentRadius,
  computeStarMapLayout,
  computeCardSlots,
  generateStarField,
  resolveCardDragOffset,
  STAR_MAP_RISE_DURATION_MS,
  STAR_MAP_RISE_GROUP_STEP_MS,
  STAR_MAP_RISE_MAX_GROUPS,
  STAR_MAP_RISE_TOTAL_MS,
  visibleCardCount,
  type StarMapCardSlot,
} from "../star-map-layout";
import { cardRingSlots } from "../star-map-orbit";

function thread(
  overrides: Partial<NavigationThreadSummary> & { id: string },
): NavigationThreadSummary {
  return {
    title: overrides.id,
    titleSource: "generated",
    linkedDirectories: [],
    source: "codex",
    inbox: { inInbox: false },
    ...overrides,
  } as NavigationThreadSummary;
}

describe("threadAttentionCategories", () => {
  it("flags unread, active, pr, and unpushed from snapshot state", () => {
    const categories = threadAttentionCategories(
      thread({
        id: "t1",
        threadStatus: "active",
        inbox: { inInbox: true, reason: "updated-since-seen" },
        prs: [
          {
            provider: "github",
            number: 12,
            org: "pwrdrvr",
            repo: "PwrAgnt",
            state: "passing",
            url: "https://github.com/pwrdrvr/PwrAgnt/pull/12",
          },
        ],
        gitWorkingState: {
          dirtyFiles: 0,
          dirtyAdditions: 0,
          dirtyDeletions: 0,
          untrackedFiles: 0,
          unpushedCommits: 2,
        },
      }),
    );
    expect(categories).toEqual(["unread", "active", "pr", "unpushed"]);
  });

  it("does not flag merged or closed PRs", () => {
    const categories = threadAttentionCategories(
      thread({
        id: "t2",
        prs: [
          {
            provider: "github",
            number: 13,
            org: "pwrdrvr",
            repo: "PwrAgnt",
            state: "merged",
            url: "https://github.com/pwrdrvr/PwrAgnt/pull/13",
          },
          {
            provider: "github",
            number: 14,
            org: "pwrdrvr",
            repo: "PwrAgnt",
            state: "passing",
            lifecycleState: "closed",
            url: "https://github.com/pwrdrvr/PwrAgnt/pull/14",
          },
        ],
      }),
    );
    expect(categories).toEqual([]);
  });

  it("flags approval and thinking from session key maps", () => {
    const subject = thread({ id: "t3" });
    const key = "codex:t3";
    const categories = threadAttentionCategories(subject, {
      approvalRequestThreadKeys: { [key]: true },
      thinkingThreadKeys: { [key]: true },
    });
    expect(categories).toContain("approval");
    expect(categories).toContain("active");
  });

  it("does not let an unscoped stale session mark a remote thread active", () => {
    const subject = thread({
      id: "shared-thread-id",
      federation: {
        ref: {
          backend: "codex",
          target: {
            scope: "remote",
            instanceId: "peer-harold",
          },
          threadId: "shared-thread-id",
        },
        instanceLabel: "Harold-MBP-M2-Max",
      },
    });

    expect(threadAttentionCategories(subject, {
      thinkingThreadKeys: { "codex:shared-thread-id": true },
    })).not.toContain("active");
  });

  it("reads thinking from the remote thread identity", () => {
    const subject = thread({
      id: "shared-thread-id",
      federation: {
        ref: {
          backend: "codex",
          target: {
            scope: "remote",
            instanceId: "peer-harold",
          },
          threadId: "shared-thread-id",
        },
        instanceLabel: "Harold-MBP-M2-Max",
      },
    });

    expect(threadAttentionCategories(subject, {
      thinkingThreadKeys: {
        [federatedThreadIdentityKey(subject.federation!.ref)]: true,
      },
    })).toContain("active");
  });
});

describe("computeStarMapLayout", () => {
  it("centers a lone instance with no links", () => {
    const layout = computeStarMapLayout(
      [{ instanceId: "pwr_solo", isHub: true }],
      1200,
    );
    expect(layout.positions).toHaveLength(1);
    expect(layout.links).toHaveLength(0);
    expect(layout.positions[0].x).toBe(600);
  });

  it("gives every instance an exclusive lane with the hub in the middle", () => {
    const layout = computeStarMapLayout(
      [
        { instanceId: "pwr_b", isHub: false },
        { instanceId: "pwr_hub", isHub: true },
        { instanceId: "pwr_a", isHub: false },
      ],
      1200,
    );
    // Lane order: sorted spokes with the hub spliced into the middle.
    expect(layout.positions.map((position) => position.instanceId)).toEqual([
      "pwr_a",
      "pwr_hub",
      "pwr_b",
    ]);
    expect(layout.links.map((link) => link.toInstanceId)).toEqual([
      "pwr_a",
      "pwr_b",
    ]);
    // Deterministic: same input, same shape, regardless of node order.
    expect(
      computeStarMapLayout(
        [
          { instanceId: "pwr_a", isHub: false },
          { instanceId: "pwr_b", isHub: false },
          { instanceId: "pwr_hub", isHub: true },
        ],
        1200,
      ),
    ).toEqual(layout);
    // Lanes tile the row without overlap: neighbors are one lane apart.
    const xs = layout.positions.map((position) => position.x);
    expect(xs[1] - xs[0]).toBeCloseTo(layout.positions[0].laneWidth);
    expect(xs[2] - xs[1]).toBeCloseTo(layout.positions[0].laneWidth);
  });

  it("arcs links through the sky above the body row", () => {
    const layout = computeStarMapLayout(
      [
        { instanceId: "pwr_hub", isHub: true },
        { instanceId: "pwr_a", isHub: false },
      ],
      1000,
    );
    const arc = layout.links[0].path;
    expect(arc.cy).toBeLessThan(arc.y1);
    expect(arc.cy).toBeLessThan(arc.y2);
  });

  it("narrows cards to fit dense federations", () => {
    const nodes = Array.from({ length: 6 }, (_, index) => ({
      instanceId: `pwr_${index}`,
      isHub: index === 0,
    }));
    const layout = computeStarMapLayout(nodes, 900);
    expect(layout.cardWidth).toBeLessThan(240);
    expect(layout.cardWidth).toBeGreaterThan(120);
  });
});

describe("computeCardSlots", () => {
  it("stacks cards from their measured heights so none overlap", () => {
    const heights = [124, 64, 96];
    const slots = computeCardSlots(heights);
    expect(slots.map((slot) => slot.dx)).toEqual([0, 0, 0]);
    for (let index = 1; index < slots.length; index += 1) {
      const previousBottom = slots[index - 1].dy + heights[index - 1];
      expect(slots[index].dy).toBeGreaterThan(previousBottom);
    }
  });

  it("keeps a uniform gap regardless of card height", () => {
    const slots = computeCardSlots([100, 40], { top: 0, gap: 10 });
    expect(slots[0].dy).toBe(0);
    expect(slots[1].dy).toBe(110);
  });
});

describe("visibleCardCount", () => {
  it("stops before cards would run off the bottom", () => {
    const count = visibleCardCount({
      heights: [120, 120, 120, 120, 120],
      availableHeight: 460,
      max: 8,
    });
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(5);
  });

  it("never hides the only card a lane has", () => {
    expect(
      visibleCardCount({ heights: [400], availableHeight: 120, max: 8 }),
    ).toBe(1);
  });

  it("respects the hard cap even with room to spare", () => {
    expect(
      visibleCardCount({
        heights: Array.from({ length: 20 }, () => 40),
        availableHeight: 5000,
        max: 8,
      }),
    ).toBe(8);
  });
});

describe("generateStarField", () => {
  it("is deterministic and stays in percent bounds", () => {
    const first = generateStarField(40);
    expect(generateStarField(40)).toEqual(first);
    expect(first).toHaveLength(40);
    for (const star of first) {
      expect(star.x).toBeGreaterThanOrEqual(0);
      expect(star.x).toBeLessThanOrEqual(100);
      expect(star.y).toBeGreaterThanOrEqual(0);
      expect(star.y).toBeLessThanOrEqual(100);
      expect(star.opacity).toBeGreaterThan(0);
      expect(star.opacity).toBeLessThanOrEqual(1);
    }
  });
});

describe("cloudDetentRadius", () => {
  it("never starts resisting inside the cloud the lens drew", () => {
    // A lane stacks downward, so its last slot is the far one; an orbit
    // ring puts slots all around the body. No slot may sit on the detent.
    for (const slots of [
      computeCardSlots([112, 112, 112, 112, 112]),
      cardRingSlots(16, 200),
    ]) {
      const radius = cloudDetentRadius(slots);
      for (const slot of slots) {
        expect(Math.hypot(slot.dx, slot.dy)).toBeLessThan(radius);
      }
    }
  });

  it("grows with the cloud rather than fixing one lens's bound", () => {
    expect(
      cloudDetentRadius(computeCardSlots([112, 112, 112])),
    ).toBeGreaterThan(cloudDetentRadius(computeCardSlots([112])));
  });
});

describe("resolveCardDragOffset", () => {
  // Ring slots, because the reported symptom was horizontal: a card to the
  // LEFT of a body could not reach where the cards on the right sit.
  const slots = cardRingSlots(8, 200);
  const detentRadius = cloudDetentRadius(slots);
  const leftmost = slots.reduce((far, slot) => (slot.dx < far.dx ? slot : far));
  const rightmost = slots.reduce((far, slot) => (slot.dx > far.dx ? slot : far));
  const distance = (point: StarMapCardSlot) => Math.hypot(point.dx, point.dy);
  /** Where a card based at `baseSlot` ends up when dragged onto `target`. */
  const dragTo = (baseSlot: StarMapCardSlot, target: StarMapCardSlot) => {
    const committed = resolveCardDragOffset({
      baseSlot,
      offset: {
        dx: target.dx - baseSlot.dx,
        dy: target.dy - baseSlot.dy,
      },
      detentRadius,
    });
    return {
      dx: baseSlot.dx + committed.dx,
      dy: baseSlot.dy + committed.dy,
    };
  };

  it("commits an offset from the card's own slot, not a position", () => {
    // The persisted shape syncs across the federation, so it stays an
    // offset even though the detent applies to the body-relative position.
    expect(
      resolveCardDragOffset({
        baseSlot: leftmost,
        offset: { dx: 12, dy: -8 },
        detentRadius,
      }),
    ).toEqual({ dx: 12, dy: -8 });
  });

  it("carries a left-side card onto the position a right-side card holds", () => {
    // The symptom this geometry exists to fix. Resisting the offset
    // instead of the position would stop this drag well short.
    expect(leftmost.dx).toBeLessThan(0);
    expect(rightmost.dx).toBeGreaterThan(0);
    const landed = dragTo(leftmost, rightmost);
    expect(landed.dx).toBeCloseTo(rightmost.dx);
    expect(landed.dy).toBeCloseTo(rightmost.dy);
  });

  it("gives every card in the cloud the same region and the same resistance", () => {
    const targets: StarMapCardSlot[] = [
      // Each other's slots, either way round.
      leftmost,
      rightmost,
      // Just inside the detent, into it, and far beyond it.
      { dx: detentRadius - 20, dy: 0 },
      { dx: 0, dy: detentRadius + 60 },
      { dx: -2000, dy: 900 },
    ];
    for (const target of targets) {
      const fromLeft = dragTo(leftmost, target);
      const fromRight = dragTo(rightmost, target);
      expect(fromLeft.dx).toBeCloseTo(fromRight.dx);
      expect(fromLeft.dy).toBeCloseTo(fromRight.dy);
    }
  });

  it("follows the pointer exactly up to the detent", () => {
    const target = { dx: detentRadius - 1, dy: 0 };
    expect(dragTo(leftmost, target).dx).toBeCloseTo(target.dx);
  });

  it("resists inside the detent instead of stopping the drag", () => {
    const pushedTo = detentRadius + 60;
    const landed = distance(dragTo(leftmost, { dx: 0, dy: pushedTo }));
    // Past the detent, so it moved — but it gave up most of the overshoot.
    expect(landed).toBeGreaterThan(detentRadius);
    expect(landed).toBeLessThan(detentRadius + 60);
  });

  it("breaks through so a card can be parked in an island of its own", () => {
    const near = distance(dragTo(leftmost, { dx: 0, dy: detentRadius + 400 }));
    const far = distance(dragTo(leftmost, { dx: 0, dy: detentRadius + 900 }));
    // Through the detent the pointer is tracked one-for-one again: another
    // 500px of drag buys another 500px of travel.
    expect(far - near).toBeCloseTo(500);
    // The resistance already absorbed stays behind as a constant lag.
    expect(near).toBeLessThan(detentRadius + 400);
    expect(near).toBeGreaterThan(detentRadius + 200);
  });
});

describe("cardRiseDelays", () => {
  const allInView = (count: number) =>
    cardRiseDelays(new Array<boolean>(count).fill(true));

  it("gives an off-screen card no delay at all", () => {
    // Budget spent on a card the operator cannot see is budget spent on
    // nothing, and counting them made an in-view group depend on how many
    // cards happened to be parked off to the side.
    const delays = cardRiseDelays([false, true, false, true, false]);
    expect(delays[0]).toBe(0);
    expect(delays[2]).toBe(0);
    expect(delays[4]).toBe(0);
  });

  it("lands the last card on budget however large the cloud is", () => {
    // The regression this exists for: an orbit cloud is capped per
    // cluster, not per cloud, so a per-card step grew without bound.
    for (const count of [1, 2, 8, 40, 160, 1_000]) {
      const last = Math.max(...allInView(count));
      expect(last + STAR_MAP_RISE_DURATION_MS).toBeLessThanOrEqual(
        STAR_MAP_RISE_TOTAL_MS,
      );
    }
  });

  it("uses whole group steps, never a per-card slide", () => {
    for (const delay of allInView(50)) {
      expect(delay % STAR_MAP_RISE_GROUP_STEP_MS).toBe(0);
    }
  });

  it("keeps the groups within one card of each other", () => {
    const delays = allInView(50);
    const sizes = new Map<number, number>();
    for (const delay of delays) {
      sizes.set(delay, (sizes.get(delay) ?? 0) + 1);
    }
    expect(sizes.size).toBe(STAR_MAP_RISE_MAX_GROUPS);
    const counts = [...sizes.values()];
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  });

  it("scatters each group instead of sweeping the card order", () => {
    // The complaint this answers: stepping by index reads as one wipe,
    // because clusters are seated contiguously so index order is roughly
    // spatial. Neighbours therefore must NOT share a beat wholesale.
    const delays = allInView(50);
    // The property that separates a scatter from a wipe is that the delay
    // does not rise with the index. Both the old per-card step and an
    // ordered deal are monotonic; only a scramble is not.
    const monotonic = delays.every(
      (delay, index) => index === 0 || delay >= delays[index - 1],
    );
    expect(monotonic).toBe(false);
    // Each group must also reach across the cloud rather than owning a
    // contiguous run of it.
    for (let group = 0; group < STAR_MAP_RISE_MAX_GROUPS; group += 1) {
      const members = delays.flatMap((delay, index) =>
        delay === group * STAR_MAP_RISE_GROUP_STEP_MS ? [index] : [],
      );
      expect(members.length).toBeGreaterThan(0);
      const span = members[members.length - 1] - members[0];
      expect(span).toBeGreaterThan(delays.length / 2);
    }
    // Nor may it be the plain round-robin over the card order. That also
    // spans the cloud, but it is periodic: in a ring, lighting every Nth
    // seat is a rotating pattern rather than a scatter.
    const roundRobin = delays.map(
      (_, index) =>
        (index % STAR_MAP_RISE_MAX_GROUPS) * STAR_MAP_RISE_GROUP_STEP_MS,
    );
    expect(delays).not.toEqual(roundRobin);
  });

  it("gives a cloud smaller than one group per card its own beats", () => {
    // Small clouds keep the settle they always had rather than flattening
    // to a single switch-on.
    const delays = cardRiseDelays([true, true, true]);
    expect(new Set(delays).size).toBe(3);
  });

  it("is deterministic, so a re-render cannot re-deal a card", () => {
    expect(allInView(50)).toEqual(allInView(50));
  });

  it("matches the duration app.css actually animates", () => {
    // The budget is delay + duration, so a duration edited in the
    // stylesheet alone silently pushes the last card past the total.
    const css = readFileSync(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../../styles/app.css",
      ),
      "utf8",
    );
    const rule = /\.star-map-card-shell \{[^}]*animation:\s*star-map-rise\s+(\d+)ms/.exec(
      css,
    );
    expect(rule).not.toBeNull();
    expect(Number(rule![1])).toBe(STAR_MAP_RISE_DURATION_MS);
  });
});
