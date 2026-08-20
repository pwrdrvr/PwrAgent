import { describe, expect, it } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import {
  buildInstanceClusters,
  computeClusterCloud,
  refitCluster,
  orderParentAdjacent,
  resolveCloudDrop,
  ORBIT_MAX_CARDS_PER_GROUP,
} from "../star-map-clusters";

const NOW = 1_000_000;

function thread(
  id: string,
  options?: {
    path?: string;
    title?: string;
    updatedAt?: number;
    parentId?: string;
  },
): NavigationThreadSummary {
  return {
    id,
    title: options?.title ?? `Thread ${id}`,
    source: "codex",
    linkedDirectories: options?.path
      ? [
          {
            id: `dir-${options.path}`,
            label: options.path.split("/").filter(Boolean).pop(),
            path: options.path,
            kind: "local",
          },
        ]
      : [],
    inbox: { inInbox: false },
    updatedAt: options?.updatedAt ?? NOW,
    ...(options?.parentId ? { parentThreadId: options.parentId } : {}),
  } as unknown as NavigationThreadSummary;
}

const height = () => 112;

describe("buildInstanceClusters", () => {
  it("groups threads by project and keeps within-group order", () => {
    const clusters = buildInstanceClusters({
      threads: [
        thread("a1", { path: "/repo/alpha" }),
        thread("b1", { path: "/repo/beta" }),
        thread("a2", { path: "/repo/alpha" }),
        thread("b2", { path: "/repo/beta" }),
      ],
    });
    expect(clusters).toHaveLength(2);
    const alpha = clusters.find((cluster) => cluster.label === "alpha")!;
    expect(alpha.threads.map((entry) => entry.id)).toEqual(["a1", "a2"]);
    expect(alpha.isProject).toBe(true);
    expect(alpha.isParentGroup).toBe(false);
  });

  it("pools directory-less threads into a no-project cluster", () => {
    const clusters = buildInstanceClusters({
      threads: [thread("x"), thread("y")],
    });
    expect(clusters).toHaveLength(1);
    expect(clusters[0].isProject).toBe(false);
    expect(clusters[0].label).toBe("No project");
  });

  it("pools every scratch checkout into one Workspaces cluster", () => {
    // The classifier collapses anything under a .pwragent projects root;
    // twenty hash-named chats must not become twenty one-thread clouds.
    const clusters = buildInstanceClusters({
      threads: [
        thread("w1", { path: "/Users/op/.pwragent/projects/2026-08-02-04db3f" }),
        thread("w2", { path: "/Users/op/.pwragent/projects/2026-08-02-4e433f" }),
        thread("w3", { path: "/Users/op/.pwragent/projects/2026-05-23-885b8f" }),
      ],
    });
    expect(clusters).toHaveLength(1);
    expect(clusters[0].label).toBe("Workspaces");
    expect(clusters[0].threads).toHaveLength(3);
  });

  it("splits a parent and its children into their own cloud", () => {
    const clusters = buildInstanceClusters({
      threads: [
        thread("solo", { path: "/repo/alpha" }),
        thread("parent", { path: "/repo/alpha", title: "MCP foundation" }),
        thread("c1", { path: "/repo/alpha", parentId: "parent" }),
        thread("c2", { path: "/repo/alpha", parentId: "parent" }),
      ],
    });
    expect(clusters).toHaveLength(2);
    const parentCloud = clusters.find((cluster) => cluster.isParentGroup)!;
    expect(parentCloud.label).toBe("MCP foundation");
    expect(parentCloud.threads.map((entry) => entry.id)).toEqual([
      "parent",
      "c1",
      "c2",
    ]);
    const catchAll = clusters.find((cluster) => !cluster.isParentGroup)!;
    expect(catchAll.label).toBe("alpha");
    expect(catchAll.threads.map((entry) => entry.id)).toEqual(["solo"]);
  });

  it("keeps grandchildren inside their root parent's cloud", () => {
    const clusters = buildInstanceClusters({
      threads: [
        thread("root", { path: "/repo/alpha" }),
        thread("child", { path: "/repo/alpha", parentId: "root" }),
        thread("grandchild", { path: "/repo/alpha", parentId: "child" }),
      ],
    });
    expect(clusters).toHaveLength(1);
    expect(clusters[0].isParentGroup).toBe(true);
    expect(clusters[0].threads.map((entry) => entry.id)).toEqual([
      "root",
      "child",
      "grandchild",
    ]);
  });

  it("supports several parent clouds plus a catch-all for one project", () => {
    const clusters = buildInstanceClusters({
      threads: [
        thread("p1", { path: "/repo/alpha", title: "Effort one" }),
        thread("p1c", { path: "/repo/alpha", parentId: "p1" }),
        thread("p2", { path: "/repo/alpha", title: "Effort two" }),
        thread("p2c", { path: "/repo/alpha", parentId: "p2" }),
        thread("stray", { path: "/repo/alpha" }),
      ],
    });
    expect(clusters.filter((cluster) => cluster.isParentGroup)).toHaveLength(2);
    const catchAll = clusters.find((cluster) => !cluster.isParentGroup)!;
    expect(catchAll.threads.map((entry) => entry.id)).toEqual(["stray"]);
  });

  it("leaves an orphan whose parent is elsewhere in the catch-all", () => {
    const clusters = buildInstanceClusters({
      threads: [
        thread("orphan", { path: "/repo/alpha", parentId: "not-here" }),
        thread("plain", { path: "/repo/alpha" }),
      ],
    });
    expect(clusters).toHaveLength(1);
    expect(clusters[0].isParentGroup).toBe(false);
  });

  it("caps each cluster at the group limit and reports overflow", () => {
    const clusters = buildInstanceClusters({
      threads: Array.from({ length: 12 }, (unused, index) =>
        thread(`t${index}`, { path: "/repo/alpha" }),
      ),
    });
    expect(clusters[0].visibleCount).toBe(ORBIT_MAX_CARDS_PER_GROUP);
    expect(clusters[0].overflow).toBe(12 - ORBIT_MAX_CARDS_PER_GROUP);
    expect(clusters[0].expandable).toBe(true);
  });

  it("shows every card when the cluster is expanded", () => {
    const clusters = buildInstanceClusters({
      threads: Array.from({ length: 12 }, (unused, index) =>
        thread(`t${index}`, { path: "/repo/alpha" }),
      ),
      expandedKeys: new Set(["directory:/repo/alpha"]),
    });
    expect(clusters[0].visibleCount).toBe(12);
    expect(clusters[0].overflow).toBe(0);
    expect(clusters[0].expanded).toBe(true);
  });

  it("orders clouds by stable key, not by activity", () => {
    // Seat angles derive from cluster order, so activity-driven ordering
    // re-seated every cloud whenever recency shifted — placed cards
    // teleporting because some other project got busier.
    const keysWhen = (hot: "alpha" | "beta") =>
      buildInstanceClusters({
        threads: [
          thread("a1", {
            path: "/repo/alpha",
            updatedAt: hot === "alpha" ? NOW : NOW - 900_000,
          }),
          thread("a2", { path: "/repo/alpha", updatedAt: NOW - 500_000 }),
          thread("b1", {
            path: "/repo/beta",
            updatedAt: hot === "beta" ? NOW : NOW - 900_000,
          }),
          thread("b2", { path: "/repo/beta", updatedAt: NOW - 500_000 }),
        ],
      }).map((cluster) => cluster.key);
    expect(keysWhen("alpha")).toEqual(keysWhen("beta"));
  });

  it("never starves a cloud: every cloud shows cards regardless of fleet size", () => {
    // The old instance-wide budget allocated 40 cards in mass order, so a
    // big fleet's later clouds rendered zero cards and their expand chips
    // did nothing. Every cloud must always seat its own visible set.
    const threads = Array.from({ length: 10 }, (unused, project) =>
      Array.from({ length: 8 }, (unusedInner, index) =>
        thread(`p${project}-t${index}`, { path: `/repo/p${project}` }),
      ),
    ).flat();
    const clusters = buildInstanceClusters({ threads });
    expect(clusters).toHaveLength(10);
    for (const cluster of clusters) {
      expect(cluster.visibleCount).toBe(8);
      expect(cluster.overflow).toBe(0);
    }
  });

  it("expansion always works, even on the last cloud", () => {
    const threads = [
      ...Array.from({ length: 30 }, (unused, index) =>
        thread(`big-${index}`, { path: "/repo/big" }),
      ),
      ...Array.from({ length: 12 }, (unused, index) =>
        thread(`small-${index}`, {
          path: "/repo/small",
          updatedAt: NOW - 1_000_000,
        }),
      ),
    ];
    const collapsed = buildInstanceClusters({ threads });
    const small = collapsed.find((cluster) => cluster.label === "small")!;
    expect(small.visibleCount).toBe(ORBIT_MAX_CARDS_PER_GROUP);

    const expanded = buildInstanceClusters({
      threads,
      expandedKeys: new Set(["directory:/repo/small"]),
    });
    const expandedSmall = expanded.find((cluster) => cluster.label === "small")!;
    expect(expandedSmall.visibleCount).toBe(12);
    expect(expandedSmall.overflow).toBe(0);
  });
});

describe("orderParentAdjacent", () => {
  it("keeps children adjacent under a parent that sorts first", () => {
    const ordered = orderParentAdjacent([
      thread("parent"),
      thread("stranger"),
      thread("childA", { parentId: "parent" }),
      thread("childB", { parentId: "parent" }),
    ]);
    expect(ordered.map((entry) => entry.id)).toEqual([
      "parent",
      "childA",
      "childB",
      "stranger",
    ]);
  });

  it("never drops members of a parent cycle", () => {
    const ordered = orderParentAdjacent([
      thread("x", { parentId: "y" }),
      thread("y", { parentId: "x" }),
      thread("z"),
    ]);
    expect(ordered.map((entry) => entry.id).sort()).toEqual(["x", "y", "z"]);
  });
});

describe("computeClusterCloud", () => {
  function cloudFor(counts: number[], expanded?: string[]) {
    const threads = counts.flatMap((count, project) =>
      Array.from({ length: count }, (unused, index) =>
        thread(`p${project}-t${index}`, { path: `/repo/p${project}` }),
      ),
    );
    return computeClusterCloud({
      clusters: buildInstanceClusters({
        threads,
        expandedKeys: new Set(expanded ?? []),
      }),
      cardWidth: 200,
      heightForThread: height,
    });
  }

  it("aligns the flat threads, slots and heights", () => {
    const cloud = cloudFor([3, 2]);
    expect(cloud.threads).toHaveLength(5);
    expect(cloud.slots).toHaveLength(5);
    expect(cloud.heights).toHaveLength(5);
    expect(cloud.clusterIndexByCard).toHaveLength(5);
  });

  it("seats the first card at its cloud's centre", () => {
    const cloud = cloudFor([5, 3]);
    for (const cluster of cloud.clusters) {
      const first = cluster.slots[0];
      expect(first.dx).toBeCloseTo(cluster.center.x, 5);
      expect(first.dy + height() / 2).toBeCloseTo(cluster.center.y, 5);
    }
  });

  it("scatters the rest instead of gridding them", () => {
    // Rings with per-thread jitter: no three cards may share an x or y
    // coordinate, which is exactly what a column grid produced.
    const cloud = cloudFor([8]);
    const xs = new Map<number, number>();
    const ys = new Map<number, number>();
    for (const slot of cloud.slots) {
      const x = Math.round(slot.dx);
      const y = Math.round(slot.dy);
      xs.set(x, (xs.get(x) ?? 0) + 1);
      ys.set(y, (ys.get(y) ?? 0) + 1);
    }
    expect(Math.max(...xs.values())).toBeLessThan(3);
    expect(Math.max(...ys.values())).toBeLessThan(3);
  });

  it("gives every card a distinct slot", () => {
    const cloud = cloudFor([8, 8]);
    const unique = new Set(
      cloud.slots.map((slot) => `${Math.round(slot.dx)}:${Math.round(slot.dy)}`),
    );
    expect(unique.size).toBe(cloud.slots.length);
  });

  it("keeps every card inside its cloud's extent", () => {
    const cloud = cloudFor([8, 5, 2]);
    cloud.threads.forEach((entry, index) => {
      const cluster = cloud.clusters[cloud.clusterIndexByCard[index]];
      const slot = cloud.slots[index];
      expect(Math.abs(slot.dx - cluster.center.x) + 100).toBeLessThanOrEqual(
        cluster.extent.rx,
      );
      expect(slot.dy).toBeGreaterThanOrEqual(
        cluster.center.y - cluster.extent.ry,
      );
      expect(slot.dy + height()).toBeLessThanOrEqual(
        cluster.center.y + cluster.extent.ry,
      );
    });
  });

  it("separates cloud extents from each other", () => {
    const cloud = cloudFor([8, 8, 4, 2]);
    const boxes = cloud.clusters.map((cluster) => ({
      left: cluster.center.x - cluster.extent.rx,
      right: cluster.center.x + cluster.extent.rx,
      top: cluster.center.y - cluster.extent.ry,
      bottom: cluster.center.y + cluster.extent.ry,
    }));
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const apart =
          boxes[i].right <= boxes[j].left
          || boxes[j].right <= boxes[i].left
          || boxes[i].bottom <= boxes[j].top
          || boxes[j].bottom <= boxes[i].top;
        expect(apart).toBe(true);
      }
    }
  });

  it("keeps clouds clear of the instance's own chrome", () => {
    // Mirrors STAR_MAP_INSTANCE_KEEPOUT in star-map-orbit.
    const keepout = { left: -92, right: 92, top: -58, bottom: 100 };
    const cloud = cloudFor([8, 8, 4]);
    for (const cluster of cloud.clusters) {
      const box = {
        left: cluster.center.x - cluster.extent.rx,
        right: cluster.center.x + cluster.extent.rx,
        top: cluster.center.y - cluster.extent.ry,
        bottom: cluster.center.y + cluster.extent.ry,
      };
      const apart =
        box.right <= keepout.left
        || box.left >= keepout.right
        || box.bottom <= keepout.top
        || box.top >= keepout.bottom;
      expect(apart).toBe(true);
    }
  });

  it("hangs a lone cloud below the body", () => {
    const cloud = cloudFor([4]);
    expect(cloud.clusters).toHaveLength(1);
    const cluster = cloud.clusters[0];
    expect(cluster.center.x).toBeCloseTo(0, 5);
    expect(cluster.center.y - cluster.extent.ry).toBeGreaterThan(0);
  });

  it("floats a single-thread cloud chromeless", () => {
    const cloud = cloudFor([1, 5]);
    const lone = cloud.clusters.find(
      (cluster) => cluster.threads.length === 1,
    )!;
    expect(lone.chromeless).toBe(true);
    const full = cloud.clusters.find(
      (cluster) => cluster.threads.length === 5,
    )!;
    expect(full.chromeless).toBe(false);
  });

  it("is chromeless for a lone no-project cloud", () => {
    const bare = computeClusterCloud({
      clusters: buildInstanceClusters({
        threads: [thread("x"), thread("y")],
      }),
      cardWidth: 200,
      heightForThread: height,
    });
    expect(bare.clusters[0].chromeless).toBe(true);
  });

  it("places label above and chip below a capped cloud", () => {
    const cloud = cloudFor([12]);
    const cluster = cloud.clusters[0];
    expect(cluster.overflow).toBeGreaterThan(0);
    expect(cluster.labelSlot.dy).toBeLessThan(
      cluster.center.y - cluster.extent.ry,
    );
    expect(cluster.overflowSlot).toBeDefined();
    expect(cluster.overflowSlot!.dy).toBeGreaterThan(
      cluster.center.y + cluster.extent.ry,
    );
  });

  it("keeps the chip on an expanded cluster so it can collapse", () => {
    const cloud = cloudFor([12], ["directory:/repo/p0"]);
    expect(cloud.clusters[0].overflow).toBe(0);
    expect(cloud.clusters[0].overflowSlot).toBeDefined();
  });

  it("reports an extent that covers every cloud", () => {
    const cloud = cloudFor([8, 6, 3]);
    for (const cluster of cloud.clusters) {
      expect(
        Math.abs(cluster.center.x) + cluster.extent.rx,
      ).toBeLessThanOrEqual(cloud.extent.rx);
      expect(
        Math.abs(cluster.center.y) + cluster.extent.ry,
      ).toBeLessThanOrEqual(cloud.extent.ry);
    }
  });

  it("is deterministic", () => {
    expect(cloudFor([8, 5, 2])).toEqual(cloudFor([8, 5, 2]));
  });
});

/**
 * The layout is incremental on purpose: archiving one thread must take
 * one card off the map and disturb nothing else. Every assertion here is
 * a thing that used to move on its own.
 */
describe("layout stability", () => {
  const cardWidth = 200;

  function layout(
    threads: NavigationThreadSummary[],
    memory?: ReturnType<typeof computeClusterCloud>["memory"],
    expanded?: string[],
  ) {
    return computeClusterCloud({
      clusters: buildInstanceClusters({
        threads,
        expandedKeys: new Set(expanded ?? []),
      }),
      cardWidth,
      heightForThread: height,
      memory,
    });
  }

  function slotByThread(cloud: ReturnType<typeof computeClusterCloud>) {
    return new Map(
      cloud.threads.map((thread, index) => [thread.id, cloud.slots[index]]),
    );
  }

  const project = (name: string, count: number, from = 0) =>
    Array.from({ length: count }, (unused, index) =>
      thread(`${name}-${index + from}`, { path: `/repo/${name}` }),
    );

  it("moves nothing but the archived card", () => {
    const threads = [...project("alpha", 6), ...project("beta", 5)];
    const before = layout(threads);
    const after = layout(
      threads.filter((entry) => entry.id !== "alpha-2"),
      before.memory,
    );

    const was = slotByThread(before);
    const now = slotByThread(after);
    expect(now.has("alpha-2")).toBe(false);
    expect(now.size).toBe(was.size - 1);
    for (const [id, slot] of now) {
      expect(slot).toEqual(was.get(id));
    }
  });

  it("leaves every cloud centre where it was", () => {
    const threads = [
      ...project("alpha", 6),
      ...project("beta", 5),
      ...project("gamma", 3),
    ];
    const before = layout(threads);
    const after = layout(
      threads.filter((entry) => entry.id !== "beta-0"),
      before.memory,
    );
    for (const cluster of after.clusters) {
      const previous = before.clusters.find(
        (entry) => entry.key === cluster.key,
      )!;
      expect(cluster.center).toEqual(previous.center);
      expect(cluster.extent).toEqual(previous.extent);
    }
  });

  it("does not pull a cloud inward when its outermost card leaves", () => {
    // Extent drives cloud seating AND instance spacing, so a shrinking
    // cloud used to shove its neighbours (and its own body) around.
    const threads = project("alpha", 9);
    const before = layout(threads);
    const outermost = before.threads[before.threads.length - 1];
    const after = layout(
      threads.filter((entry) => entry.id !== outermost.id),
      before.memory,
    );
    expect(after.clusters[0].extent).toEqual(before.clusters[0].extent);
    expect(after.extent).toEqual(before.extent);
  });

  it("keeps the surviving clouds put when a whole cloud empties", () => {
    const threads = [...project("alpha", 4), ...project("beta", 1)];
    const before = layout(threads);
    const after = layout(
      threads.filter((entry) => !entry.id.startsWith("beta")),
      before.memory,
    );
    expect(after.clusters).toHaveLength(1);
    const alpha = after.clusters[0];
    const previousAlpha = before.clusters.find(
      (cluster) => cluster.key === alpha.key,
    )!;
    expect(alpha.center).toEqual(previousAlpha.center);
  });

  it("seats an arriving thread without moving the cards already there", () => {
    const threads = project("alpha", 5);
    const before = layout(threads);
    const after = layout([...threads, thread("newcomer", { path: "/repo/alpha" })], before.memory);

    const was = slotByThread(before);
    const now = slotByThread(after);
    for (const [id, slot] of was) {
      expect(now.get(id)).toEqual(slot);
    }
    expect(now.get("newcomer")).toBeDefined();
  });

  it("gives an arrival the seat an archived card freed", () => {
    const threads = project("alpha", 5);
    const before = layout(threads);
    const freed = slotByThread(before).get("alpha-2")!;
    const without = layout(
      threads.filter((entry) => entry.id !== "alpha-2"),
      before.memory,
    );
    const after = layout(
      [
        ...threads.filter((entry) => entry.id !== "alpha-2"),
        thread("newcomer", { path: "/repo/alpha" }),
      ],
      without.memory,
    );
    // Same seat, so the cloud does not sprout an outer ring for a card it
    // has room for. The jitter is per-thread, so the position is close
    // rather than identical.
    const taken = slotByThread(after).get("newcomer")!;
    expect(Math.hypot(taken.dx - freed.dx, taken.dy - freed.dy)).toBeLessThan(
      cardWidth,
    );
  });

  it("re-fits a cloud the operator expands, and only that cloud", () => {
    const threads = [...project("alpha", 14), ...project("beta", 4)];
    const before = layout(threads);
    const alphaKey = "directory:/repo/alpha";
    const after = layout(
      threads,
      refitCluster(before.memory, alphaKey),
      [alphaKey],
    );
    const beta = after.clusters.find((cluster) => cluster.key !== alphaKey)!;
    const previousBeta = before.clusters.find(
      (cluster) => cluster.key === beta.key,
    )!;
    expect(beta.center).toEqual(previousBeta.center);
    const alpha = after.clusters.find((cluster) => cluster.key === alphaKey)!;
    expect(alpha.slots).toHaveLength(14);
  });

  /**
   * Expanding a cloud used to drop its centre and its seats, which made it
   * an arrival again — seated from the base radius outward along its own
   * bearing, which is rarely where it was. The operator asked for two more
   * cards and the cloud they were reading vanished across the map.
   */
  it("expands a cloud where it stands when it has the room", () => {
    // One past the cap: the extra card takes a free seat in the rings the
    // cloud already has, so there is nothing to re-fit.
    const threads = [
      ...project("alpha", ORBIT_MAX_CARDS_PER_GROUP + 1),
      ...project("beta", 4),
    ];
    const alphaKey = "directory:/repo/alpha";
    const before = layout(threads);
    const after = layout(threads, refitCluster(before.memory, alphaKey), [
      alphaKey,
    ]);

    const previousAlpha = before.clusters.find(
      (cluster) => cluster.key === alphaKey,
    )!;
    const alpha = after.clusters.find((cluster) => cluster.key === alphaKey)!;
    expect(alpha.center).toEqual(previousAlpha.center);
    // Every card that was on screen is exactly where it was; the one the
    // operator asked for is the only new geometry.
    const was = slotByThread(before);
    const now = slotByThread(after);
    for (const [id, slot] of was) {
      expect(now.get(id)).toEqual(slot);
    }
    expect(now.size).toBe(was.size + 1);
  });

  it("moves a cloud that outgrows its spot no further than it has to", () => {
    const threads = [...project("alpha", 14), ...project("beta", 4)];
    const alphaKey = "directory:/repo/alpha";
    const before = layout(threads);
    const after = layout(threads, refitCluster(before.memory, alphaKey), [
      alphaKey,
    ]);
    const previousAlpha = before.clusters.find(
      (cluster) => cluster.key === alphaKey,
    )!;
    const alpha = after.clusters.find((cluster) => cluster.key === alphaKey)!;

    // Fourteen cards need a ring the eight did not, and that ring would
    // swallow the instance's own chrome, so this cloud does have to move.
    expect(alpha.extent.rx).toBeGreaterThan(previousAlpha.extent.rx);
    // It moves no further than it grew, so the old and new footprints
    // overlap — the difference between "made room" and "teleported".
    const moved = Math.hypot(
      alpha.center.x - previousAlpha.center.x,
      alpha.center.y - previousAlpha.center.y,
    );
    expect(moved).toBeGreaterThan(0);
    expect(moved).toBeLessThanOrEqual(
      Math.hypot(
        alpha.extent.rx - previousAlpha.extent.rx,
        alpha.extent.ry - previousAlpha.extent.ry,
      ),
    );
    // Away from the body, not through it.
    expect(Math.hypot(alpha.center.x, alpha.center.y)).toBeGreaterThan(
      Math.hypot(previousAlpha.center.x, previousAlpha.center.y),
    );
    // The cards it already had keep their places within the cloud.
    const was = slotByThread(before);
    const now = slotByThread(after);
    for (const thread of project("alpha", ORBIT_MAX_CARDS_PER_GROUP)) {
      const slot = was.get(thread.id)!;
      const taken = now.get(thread.id)!;
      expect(taken.dx - alpha.center.x).toBeCloseTo(
        slot.dx - previousAlpha.center.x,
        9,
      );
      expect(taken.dy - alpha.center.y).toBeCloseTo(
        slot.dy - previousAlpha.center.y,
        9,
      );
    }
  });

  /**
   * The map the operator actually has: several clouds around one body,
   * with the one they unfold hemmed in by a neighbour. It cannot grow
   * where it stands — something has to give — and what gives is this
   * cloud's position and nothing else. Its cloudmates hold, and it carries
   * its own cards with it rather than reshuffling them, so what the
   * operator follows is one cloud moving, not a new map.
   */
  it("moves only the unfolded cloud on a crowded map", () => {
    const threads = [
      ...project("alpha", 10),
      ...project("beta", 4),
      ...project("gamma", 5),
      ...project("delta", 3),
    ];
    const alphaKey = "directory:/repo/alpha";
    const before = layout(threads);
    const after = layout(threads, refitCluster(before.memory, alphaKey), [
      alphaKey,
    ]);

    const at = (cloud: ReturnType<typeof computeClusterCloud>) =>
      cloud.clusters.find((cluster) => cluster.key === alphaKey)!.center;
    const from = at(before);
    const moved = at(after);

    for (const cluster of before.clusters) {
      if (cluster.key === alphaKey) continue;
      expect(
        after.clusters.find((entry) => entry.key === cluster.key)!.center,
      ).toEqual(cluster.center);
    }
    const was = slotByThread(before);
    const now = slotByThread(after);
    for (const thread of project("alpha", ORBIT_MAX_CARDS_PER_GROUP)) {
      const slot = was.get(thread.id)!;
      const taken = now.get(thread.id)!;
      expect(taken.dx - moved.x).toBeCloseTo(slot.dx - from.x, 9);
      expect(taken.dy - moved.y).toBeCloseTo(slot.dy - from.y, 9);
    }
  });

  it("collapses a cloud back to the size it started at, in place", () => {
    const threads = [...project("alpha", 14), ...project("beta", 4)];
    const alphaKey = "directory:/repo/alpha";
    const before = layout(threads);
    const expanded = layout(threads, refitCluster(before.memory, alphaKey), [
      alphaKey,
    ]);
    const collapsed = layout(threads, refitCluster(expanded.memory, alphaKey));

    const previousAlpha = before.clusters.find(
      (cluster) => cluster.key === alphaKey,
    )!;
    const expandedAlpha = expanded.clusters.find(
      (cluster) => cluster.key === alphaKey,
    )!;
    const alpha = collapsed.clusters.find(
      (cluster) => cluster.key === alphaKey,
    )!;

    // Rings are grow-only, so without dropping that one entry the cloud
    // would keep the radius the expanded cards needed.
    expect(alpha.extent).toEqual(previousAlpha.extent);
    // Folding is not a reason to move: the cloud stays where the operator
    // last saw it, holding the cards that stay visible.
    expect(alpha.center).toEqual(expandedAlpha.center);
    const was = slotByThread(expanded);
    for (const [id, slot] of slotByThread(collapsed)) {
      expect(was.get(id)).toEqual(slot);
    }
  });

  it("lays out the same way twice from a cold start", () => {
    const threads = [...project("alpha", 6), ...project("beta", 5)];
    expect(layout(threads)).toEqual(layout(threads));
  });

  it("is idempotent when the same input is laid out over its own memory", () => {
    // The screen recomputes on every snapshot; feeding a layout its own
    // memory must be a no-op or the map would drift while idle.
    const threads = [...project("alpha", 6), ...project("beta", 5)];
    const first = layout(threads);
    const second = layout(threads, first.memory);
    expect(second.slots).toEqual(first.slots);
    expect(second.clusters.map((cluster) => cluster.center)).toEqual(
      first.clusters.map((cluster) => cluster.center),
    );
  });

  it("keeps a card's seat when a taller card joins its cloud", () => {
    // Ring radii come from a nominal height, so one tall card cannot
    // inflate the rings under everybody else.
    const threads = project("alpha", 5);
    const before = computeClusterCloud({
      clusters: buildInstanceClusters({ threads }),
      cardWidth,
      heightForThread: () => 112,
      memory: undefined,
    });
    const after = computeClusterCloud({
      clusters: buildInstanceClusters({
        threads: [...threads, thread("tall", { path: "/repo/alpha" })],
      }),
      cardWidth,
      heightForThread: (key) => (key === "codex:tall" ? 260 : 112),
      memory: before.memory,
    });
    const was = slotByThread(before);
    const now = slotByThread(after);
    for (const [id, slot] of was) {
      expect(now.get(id)).toEqual(slot);
    }
  });
});


/**
 * Cloud membership is derived, so a drop can only change it by changing
 * the data the grouping reads — and only one of the two kinds of cloud
 * reads data a drag is allowed to touch.
 */
describe("resolveCloudDrop", () => {
  function cloudOf(threads: NavigationThreadSummary[]) {
    return computeClusterCloud({
      clusters: buildInstanceClusters({ threads }),
      cardWidth: 200,
      heightForThread: height,
    });
  }

  const parented = [
    thread("parent", { path: "/repo/alpha", title: "MCP foundation" }),
    thread("child", { path: "/repo/alpha", parentId: "parent" }),
    thread("stray", { path: "/repo/alpha" }),
    thread("other", { path: "/repo/beta" }),
  ];

  function centerOf(
    cloud: ReturnType<typeof computeClusterCloud>,
    predicate: (key: string) => boolean,
  ) {
    return cloud.clusters.find((cluster) => predicate(cluster.key))!.center;
  }

  it("adopts a card dropped into a parent cloud", () => {
    const cloud = cloudOf(parented);
    const drop = resolveCloudDrop({
      clusters: cloud.clusters,
      point: centerOf(cloud, (key) => key.includes("::pc:")),
      thread: parented[2],
    });
    expect(drop.kind).toBe("adopt");
    expect(drop.kind === "adopt" && drop.parent.id).toBe("parent");
  });

  it("releases a child dropped back on its project's catch-all", () => {
    const cloud = cloudOf(parented);
    const drop = resolveCloudDrop({
      clusters: cloud.clusters,
      point: centerOf(
        cloud,
        (key) => key === "directory:/repo/alpha",
      ),
      thread: parented[1],
    });
    expect(drop.kind).toBe("release");
  });

  it("never relinks a thread's project", () => {
    // A project cloud groups on the thread's workspace — where its
    // commands run. Dropping a card there moves the card and nothing else.
    const cloud = cloudOf(parented);
    const drop = resolveCloudDrop({
      clusters: cloud.clusters,
      point: centerOf(cloud, (key) => key === "directory:/repo/beta"),
      thread: parented[2],
    });
    expect(drop.kind).toBe("none");
  });

  it("does nothing for a card dropped back in its own cloud", () => {
    const cloud = cloudOf(parented);
    const drop = resolveCloudDrop({
      clusters: cloud.clusters,
      point: centerOf(cloud, (key) => key.includes("::pc:")),
      thread: parented[1],
    });
    expect(drop.kind).toBe("none");
  });

  it("does nothing for a drop on bare sky", () => {
    const cloud = cloudOf(parented);
    const drop = resolveCloudDrop({
      clusters: cloud.clusters,
      point: { x: 100_000, y: 100_000 },
      thread: parented[2],
    });
    expect(drop.kind).toBe("none");
  });

  it("refuses to adopt a parent into its own descendant", () => {
    // Walking up from the candidate would come back around to the card
    // being dragged, and the grouping would fold in on itself.
    const chain = [
      thread("root", { path: "/repo/alpha", title: "Root" }),
      thread("mid", { path: "/repo/alpha", parentId: "root" }),
      thread("leaf", { path: "/repo/alpha", parentId: "mid" }),
      thread("second", { path: "/repo/alpha", title: "Second" }),
      thread("second-child", { path: "/repo/alpha", parentId: "second" }),
    ];
    const cloud = cloudOf(chain);
    const rootCloud = cloud.clusters.find((cluster) =>
      cluster.threads.some((entry) => entry.id === "leaf"),
    )!;
    // Drag the ROOT onto the cloud its own descendants are in.
    const drop = resolveCloudDrop({
      clusters: cloud.clusters,
      point: rootCloud.center,
      thread: chain[0],
    });
    expect(drop.kind).toBe("none");
  });
});
