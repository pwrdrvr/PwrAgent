import { describe, expect, it } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import {
  countFilterImpact,
  selectAttentionThreads,
  threadAttentionCategories,
} from "../attention";
import {
  clampToCloudRadius,
  computeStarMapLayout,
  generateStarField,
  starMapCardSlot,
} from "../star-map-layout";

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
});

describe("selectAttentionThreads", () => {
  const threads = [
    thread({
      id: "unread",
      updatedAt: 10,
      inbox: { inInbox: true, reason: "updated-since-seen" },
    }),
    thread({ id: "working", updatedAt: 30, threadStatus: "active" }),
    thread({ id: "quiet", updatedAt: 20 }),
    thread({
      id: "archived",
      updatedAt: 40,
      archivedAt: 41,
      threadStatus: "active",
    }),
  ];

  it("keeps only enabled categories, newest first, never archived", () => {
    const selected = selectAttentionThreads({
      threads,
      enabled: new Set(["unread", "active"]),
    });
    expect(selected.map((entry) => entry.id)).toEqual(["working", "unread"]);
  });

  it("returns nothing when every filter is off", () => {
    expect(
      selectAttentionThreads({ threads, enabled: new Set() }),
    ).toEqual([]);
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

describe("starMapCardSlot", () => {
  it("flows cards down a single lane column", () => {
    expect(starMapCardSlot(0).dx).toBe(0);
    expect(starMapCardSlot(1).dx).toBe(0);
    expect(starMapCardSlot(1).dy).toBeGreaterThan(starMapCardSlot(0).dy);
    expect(starMapCardSlot(2).dy - starMapCardSlot(1).dy).toBe(
      starMapCardSlot(1).dy - starMapCardSlot(0).dy,
    );
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

describe("clampToCloudRadius", () => {
  it("keeps offsets inside the radius and scales outliers back", () => {
    expect(clampToCloudRadius(30, 40, 100)).toEqual({ dx: 30, dy: 40 });
    const clamped = clampToCloudRadius(300, 400, 100);
    expect(Math.hypot(clamped.dx, clamped.dy)).toBeCloseTo(100);
  });
});

describe("countFilterImpact", () => {
  const threads = [
    // Unread only: turning Unread off drops it.
    thread({
      id: "only-unread",
      inbox: { inInbox: true, reason: "updated-since-seen" },
    }),
    // Unread AND working: neither chip alone drops it.
    thread({
      id: "unread-and-working",
      inbox: { inInbox: true, reason: "updated-since-seen" },
      threadStatus: "active",
    }),
    // Matches only a disabled category, so it would appear if flipped on.
    thread({
      id: "only-unpushed",
      gitWorkingState: {
        dirtyFiles: 0,
        dirtyAdditions: 0,
        dirtyDeletions: 0,
        untrackedFiles: 0,
        unpushedCommits: 3,
      },
    }),
    thread({ id: "quiet" }),
  ];

  it("counts cards that a chip alone is keeping on the map", () => {
    const counts = countFilterImpact({
      threads,
      enabled: new Set(["unread", "active"]),
    });
    expect(counts.unread).toBe(1);
    expect(counts.active).toBe(0);
  });

  it("counts cards a disabled chip would bring back", () => {
    const counts = countFilterImpact({
      threads,
      enabled: new Set(["unread", "active"]),
    });
    expect(counts.unpushed).toBe(1);
  });

  it("ignores archived threads", () => {
    const counts = countFilterImpact({
      threads: [
        thread({
          id: "archived",
          archivedAt: 1,
          inbox: { inInbox: true, reason: "updated-since-seen" },
        }),
      ],
      enabled: new Set(["unread"]),
    });
    expect(counts.unread).toBe(0);
  });
});
