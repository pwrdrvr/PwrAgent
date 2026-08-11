import { describe, expect, it } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import {
  buildInstanceClusters,
  computeClusterCloud,
  orderParentAdjacent,
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
      now: NOW,
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
      now: NOW,
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
      now: NOW,
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
      now: NOW,
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
      now: NOW,
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
      now: NOW,
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
      now: NOW,
    });
    expect(clusters).toHaveLength(1);
    expect(clusters[0].isParentGroup).toBe(false);
  });

  it("caps each cluster at the group limit and reports overflow", () => {
    const clusters = buildInstanceClusters({
      threads: Array.from({ length: 12 }, (unused, index) =>
        thread(`t${index}`, { path: "/repo/alpha" }),
      ),
      now: NOW,
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
      now: NOW,
    });
    expect(clusters[0].visibleCount).toBe(12);
    expect(clusters[0].overflow).toBe(0);
    expect(clusters[0].expanded).toBe(true);
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
    const clusters = buildInstanceClusters({ threads, now: NOW });
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
    const collapsed = buildInstanceClusters({ threads, now: NOW });
    const small = collapsed.find((cluster) => cluster.label === "small")!;
    expect(small.visibleCount).toBe(ORBIT_MAX_CARDS_PER_GROUP);

    const expanded = buildInstanceClusters({
      threads,
      expandedKeys: new Set(["directory:/repo/small"]),
      now: NOW,
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
        now: NOW,
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
        now: NOW,
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
