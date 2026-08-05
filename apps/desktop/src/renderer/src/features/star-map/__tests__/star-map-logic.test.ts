import { describe, expect, it } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import {
  selectAttentionThreads,
  threadAttentionCategories,
} from "../attention";
import {
  clampToCloudRadius,
  computeStarMapLayout,
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
    const layout = computeStarMapLayout([
      { instanceId: "pwr_solo", isHub: true },
    ]);
    expect(layout.positions).toHaveLength(1);
    expect(layout.links).toHaveLength(0);
    expect(layout.positions[0].x).toBe(50);
  });

  it("spreads spokes deterministically around the hub", () => {
    const layout = computeStarMapLayout([
      { instanceId: "pwr_b", isHub: false },
      { instanceId: "pwr_hub", isHub: true },
      { instanceId: "pwr_a", isHub: false },
    ]);
    expect(layout.links).toEqual([
      { fromInstanceId: "pwr_hub", toInstanceId: "pwr_a" },
      { fromInstanceId: "pwr_hub", toInstanceId: "pwr_b" },
    ]);
    // Same input, same shape — every federation member renders identically.
    expect(computeStarMapLayout([
      { instanceId: "pwr_a", isHub: false },
      { instanceId: "pwr_b", isHub: false },
      { instanceId: "pwr_hub", isHub: true },
    ])).toEqual(layout);
    for (const position of layout.positions) {
      expect(position.x).toBeGreaterThanOrEqual(0);
      expect(position.x).toBeLessThanOrEqual(100);
      expect(position.y).toBeGreaterThanOrEqual(0);
      expect(position.y).toBeLessThanOrEqual(100);
    }
  });
});

describe("starMapCardSlot", () => {
  it("lays cards in centered rows of three", () => {
    expect(starMapCardSlot(0).dx).toBeLessThan(0);
    expect(starMapCardSlot(1).dx).toBe(0);
    expect(starMapCardSlot(2).dx).toBeGreaterThan(0);
    expect(starMapCardSlot(3).dy).toBeGreaterThan(starMapCardSlot(0).dy);
  });
});

describe("clampToCloudRadius", () => {
  it("keeps offsets inside the radius and scales outliers back", () => {
    expect(clampToCloudRadius(30, 40, 100)).toEqual({ dx: 30, dy: 40 });
    const clamped = clampToCloudRadius(300, 400, 100);
    expect(Math.hypot(clamped.dx, clamped.dy)).toBeCloseTo(100);
  });
});
