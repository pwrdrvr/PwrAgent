import { describe, expect, it } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import {
  buildInstanceClusters,
  computeClusterCloud,
  orderParentAdjacent,
  ORBIT_MAX_CARDS_PER_CLOUD,
  ORBIT_MAX_CARDS_PER_GROUP,
} from "../star-map-clusters";

const NOW = 1_000_000;

function thread(
  id: string,
  options?: {
    path?: string;
    updatedAt?: number;
    parentId?: string;
  },
): NavigationThreadSummary {
  return {
    id,
    title: `Thread ${id}`,
    source: "codex",
    linkedDirectories: options?.path
      ? [
          {
            id: `dir-${options.path}`,
            label: options.path,
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

  it("orders clusters heaviest first, like the projects lens", () => {
    const clusters = buildInstanceClusters({
      threads: [
        thread("solo", { path: "/repo/sleepy", updatedAt: NOW - 10_000_000 }),
        ...Array.from({ length: 5 }, (unused, index) =>
          thread(`busy${index}`, { path: "/repo/busy", updatedAt: NOW }),
        ),
      ],
      now: NOW,
    });
    expect(clusters[0].label).toBe("busy");
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
      expandedKeys: new Set(["/repo/alpha"]),
      now: NOW,
    });
    expect(clusters[0].visibleCount).toBe(12);
    expect(clusters[0].overflow).toBe(0);
    expect(clusters[0].expanded).toBe(true);
  });

  it("clips at the cloud backstop and accrues the loss as overflow", () => {
    const threads = Array.from({ length: 8 }, (unused, project) =>
      Array.from({ length: 8 }, (unusedInner, index) =>
        thread(`p${project}-t${index}`, { path: `/repo/p${project}` }),
      ),
    ).flat();
    const clusters = buildInstanceClusters({ threads, now: NOW });
    const visibleTotal = clusters.reduce(
      (total, cluster) => total + cluster.visibleCount,
      0,
    );
    expect(visibleTotal).toBe(ORBIT_MAX_CARDS_PER_CLOUD);
    const overflowTotal = clusters.reduce(
      (total, cluster) => total + cluster.overflow,
      0,
    );
    expect(overflowTotal).toBe(threads.length - ORBIT_MAX_CARDS_PER_CLOUD);
  });
});

describe("orderParentAdjacent", () => {
  it("moves children to sit directly after their parent", () => {
    const ordered = orderParentAdjacent([
      thread("child2", { parentId: "parent" }),
      thread("other"),
      thread("parent"),
      thread("child1", { parentId: "parent" }),
    ]);
    // child2 sorted ahead of its parent (fresher activity) but still pulls
    // down under it; children keep their relative order.
    expect(ordered.map((entry) => entry.id)).toEqual([
      "other",
      "parent",
      "child2",
      "child1",
    ]);
  });

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

  it("leaves a thread alone when its parent is not in the cloud", () => {
    const ordered = orderParentAdjacent([
      thread("a"),
      thread("orphan", { parentId: "elsewhere" }),
      thread("b"),
    ]);
    expect(ordered.map((entry) => entry.id)).toEqual(["a", "orphan", "b"]);
  });

  it("never drops members of a parent cycle", () => {
    const ordered = orderParentAdjacent([
      thread("x", { parentId: "y" }),
      thread("y", { parentId: "x" }),
      thread("z"),
    ]);
    expect(ordered.map((entry) => entry.id).sort()).toEqual(["x", "y", "z"]);
  });

  it("nests grandchildren under their whole chain", () => {
    const ordered = orderParentAdjacent([
      thread("grandchild", { parentId: "child" }),
      thread("root"),
      thread("child", { parentId: "root" }),
    ]);
    expect(ordered.map((entry) => entry.id)).toEqual([
      "root",
      "child",
      "grandchild",
    ]);
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

  it("keeps every card inside its own cluster outline", () => {
    const cloud = cloudFor([6, 3, 2]);
    cloud.threads.forEach((entry, index) => {
      const cluster = cloud.clusters[cloud.clusterIndexByCard[index]];
      const slot = cloud.slots[index];
      expect(slot.dx - 100).toBeGreaterThanOrEqual(cluster.rect.x);
      expect(slot.dx + 100).toBeLessThanOrEqual(
        cluster.rect.x + cluster.rect.width,
      );
      expect(slot.dy).toBeGreaterThanOrEqual(cluster.rect.y);
      expect(slot.dy + height()).toBeLessThanOrEqual(
        cluster.rect.y + cluster.rect.height,
      );
    });
  });

  it("gives no two cards in a cluster overlapping boxes", () => {
    const cloud = cloudFor([8]);
    const boxes = cloud.slots.map((slot) => ({
      left: slot.dx - 100,
      right: slot.dx + 100,
      top: slot.dy,
      bottom: slot.dy + height(),
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

  it("separates cluster outlines from each other", () => {
    const cloud = cloudFor([8, 8, 4, 2]);
    const rects = cloud.clusters.map((cluster) => cluster.rect);
    for (let i = 0; i < rects.length; i += 1) {
      for (let j = i + 1; j < rects.length; j += 1) {
        const apart =
          rects[i].x + rects[i].width <= rects[j].x
          || rects[j].x + rects[j].width <= rects[i].x
          || rects[i].y + rects[i].height <= rects[j].y
          || rects[j].y + rects[j].height <= rects[i].y;
        expect(apart).toBe(true);
      }
    }
  });

  it("keeps clusters clear of the instance's own chrome", () => {
    // Mirrors STAR_MAP_INSTANCE_KEEPOUT in star-map-orbit.
    const keepout = { left: -92, right: 92, top: -58, bottom: 100 };
    const cloud = cloudFor([8, 8, 4]);
    for (const cluster of cloud.clusters) {
      const rect = cluster.rect;
      const apart =
        rect.x + rect.width <= keepout.left
        || rect.x >= keepout.right
        || rect.y + rect.height <= keepout.top
        || rect.y >= keepout.bottom;
      expect(apart).toBe(true);
    }
  });

  it("hangs a lone cloud below the body", () => {
    const cloud = cloudFor([4]);
    expect(cloud.clusters).toHaveLength(1);
    const rect = cloud.clusters[0].rect;
    expect(rect.y).toBeGreaterThan(0);
    expect(rect.x + rect.width / 2).toBeCloseTo(0, 5);
  });

  it("is chromeless only for a lone no-project cloud", () => {
    const bare = computeClusterCloud({
      clusters: buildInstanceClusters({
        threads: [thread("x"), thread("y")],
        now: NOW,
      }),
      cardWidth: 200,
      heightForThread: height,
    });
    expect(bare.clusters[0].chromeless).toBe(true);

    const project = cloudFor([2]);
    expect(project.clusters[0].chromeless).toBe(false);
  });

  it("places an overflow chip inside a capped cluster's outline", () => {
    const cloud = cloudFor([12]);
    const cluster = cloud.clusters[0];
    expect(cluster.overflow).toBeGreaterThan(0);
    expect(cluster.overflowSlot).toBeDefined();
    expect(cluster.overflowSlot!.dy).toBeLessThan(
      cluster.rect.y + cluster.rect.height,
    );
    expect(cluster.overflowSlot!.dy).toBeGreaterThan(
      cloud.slots[cloud.slots.length - 1].dy + height(),
    );
  });

  it("keeps the chip on an expanded cluster so it can collapse", () => {
    const cloud = cloudFor([12], ["/repo/p0"]);
    expect(cloud.clusters[0].overflow).toBe(0);
    expect(cloud.clusters[0].overflowSlot).toBeDefined();
  });

  it("reports an extent that covers every outline", () => {
    const cloud = cloudFor([8, 6, 3]);
    for (const cluster of cloud.clusters) {
      expect(Math.abs(cluster.rect.x)).toBeLessThanOrEqual(cloud.extent.rx);
      expect(Math.abs(cluster.rect.x + cluster.rect.width)).toBeLessThanOrEqual(
        cloud.extent.rx,
      );
      expect(Math.abs(cluster.rect.y)).toBeLessThanOrEqual(cloud.extent.ry);
      expect(
        Math.abs(cluster.rect.y + cluster.rect.height),
      ).toBeLessThanOrEqual(cloud.extent.ry);
    }
  });

  it("is deterministic", () => {
    expect(cloudFor([8, 5, 2])).toEqual(cloudFor([8, 5, 2]));
  });
});
