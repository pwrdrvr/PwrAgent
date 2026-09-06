import { describe, expect, it } from "vitest";
import type { NavigationDirectoryRow, NavigationThreadSummary } from "@pwragent/shared";
import {
  STAR_MAP_NO_PROJECT_KEY,
  groupThreadsByProject,
  instanceIdByThreadKey,
  projectMass,
  threadProjectKey,
} from "../star-map-projects";
import { computeProjectLayout } from "../star-map-project-layout";
import { cardRingSlots } from "../star-map-orbit";

function thread(params: {
  id: string;
  repoPath?: string;
  label?: string;
  worktreePath?: string;
  updatedAt?: number;
}): NavigationThreadSummary {
  return {
    id: params.id,
    title: `Thread ${params.id}`,
    source: "codex",
    inbox: { inInbox: false },
    updatedAt: params.updatedAt ?? 0,
    linkedDirectories: params.repoPath
      ? [
          {
            id: `${params.id}-dir`,
            kind: params.worktreePath ? "worktree" : "local",
            label: params.label ?? "label",
            path: params.repoPath,
            ...(params.worktreePath
              ? { worktreePath: params.worktreePath }
              : {}),
          },
        ]
      : [],
  } as unknown as NavigationThreadSummary;
}

describe("threadProjectKey", () => {
  it("keys on the repo root, not the worktree", () => {
    const a = thread({
      id: "a",
      repoPath: "/repos/PwrAgnt",
      label: "2026-07-31-b3ba9c",
      worktreePath: "/worktrees/2026-07-31-b3ba9c",
    });
    const b = thread({
      id: "b",
      repoPath: "/repos/PwrAgnt",
      label: "2026-08-02-a99cba",
      worktreePath: "/worktrees/2026-08-02-a99cba",
    });
    // Two worktrees of one repo are one project, not two.
    expect(threadProjectKey(a)).toBe(threadProjectKey(b));
  });

  it("falls back to a sentinel when a thread has no directory", () => {
    expect(threadProjectKey(thread({ id: "x" }))).toBe(STAR_MAP_NO_PROJECT_KEY);
  });
});

describe("groupThreadsByProject", () => {
  const local = thread({ id: "l1", repoPath: "/repos/PwrAgnt", updatedAt: 10 });
  const remote = thread({ id: "r1", repoPath: "/repos/PwrAgnt", updatedAt: 30 });
  const other = thread({ id: "o1", repoPath: "/repos/PwrSnap", updatedAt: 20 });
  const orphan = thread({ id: "n1", updatedAt: 5 });
  const byInstance = new Map([
    ["local", [local, other]],
    ["peer", [remote, orphan]],
  ]);

  // Project keys carry the shared directory classifier's prefix, so the
  // Star Map and the Directories lens file threads under the same rows.
  it("pools threads for one project across instances", () => {
    const projects = groupThreadsByProject(byInstance);
    const pwragent = projects.find(
      (p) => p.key === "directory:/repos/PwrAgnt",
    );
    expect(pwragent?.threads.map((t) => t.id)).toEqual(["r1", "l1"]);
  });

  it("names a project after its repo folder", () => {
    const projects = groupThreadsByProject(byInstance);
    expect(
      projects.find((p) => p.key === "directory:/repos/PwrSnap")?.label,
    ).toBe("PwrSnap");
  });

  it("orders threads within a project by recent activity", () => {
    const projects = groupThreadsByProject(byInstance);
    const ids = projects.find(
      (p) => p.key === "directory:/repos/PwrAgnt",
    )!.threads;
    expect(ids[0].updatedAt).toBeGreaterThan(ids[1].updatedAt!);
  });

  it("puts the busiest project first", () => {
    expect(groupThreadsByProject(byInstance)[0].key).toBe(
      "directory:/repos/PwrAgnt",
    );
  });

  it("pools scratch checkouts into one Workspaces project", () => {
    const w1 = thread({
      id: "w1",
      repoPath: "/Users/op/.pwragent/projects/2026-08-02-04db3f",
      label: "2026-08-02-04db3f",
    });
    const w2 = thread({
      id: "w2",
      repoPath: "/Users/op/.pwragent/projects/2026-05-23-885b8f",
      label: "2026-05-23-885b8f",
    });
    const projects = groupThreadsByProject(new Map([["local", [w1, w2]]]));
    expect(projects).toHaveLength(1);
    expect(projects[0].label).toBe("Workspaces");
    expect(projects[0].threads).toHaveLength(2);
  });

  it("gives directory-less threads a home", () => {
    const projects = groupThreadsByProject(byInstance);
    const none = projects.find((p) => p.key === STAR_MAP_NO_PROJECT_KEY);
    expect(none?.label).toBe("No project");
    expect(none?.threads).toHaveLength(1);
  });

  it("is stable across calls", () => {
    expect(groupThreadsByProject(byInstance).map((p) => p.key)).toEqual(
      groupThreadsByProject(byInstance).map((p) => p.key),
    );
  });
});

describe("instanceIdByThreadKey", () => {
  const local = thread({ id: "l1", repoPath: "/repos/A" });
  const remote = thread({ id: "r1", repoPath: "/repos/A" });
  const byInstance = new Map([
    ["local", [local]],
    ["peer", [remote]],
  ]);

  it("maps each thread to its owning instance", () => {
    const owners = instanceIdByThreadKey(byInstance);
    expect(owners.get("codex:r1")).toBe("peer");
    expect(owners.get("codex:l1")).toBe("local");
  });

  it("has no entry for a thread from nowhere", () => {
    expect(instanceIdByThreadKey(byInstance).get("codex:gone")).toBeUndefined();
  });

  it("keys on thread identity, not object identity", () => {
    // A clone must resolve the same way — the previous implementation
    // scanned with `===` and would have missed this entirely.
    const owners = instanceIdByThreadKey(byInstance);
    const clone = { ...remote } as typeof remote;
    expect(
      owners.get(`${clone.source}:${clone.id}`),
    ).toBe("peer");
  });
});

describe("computeProjectLayout", () => {
  it("returns an empty canvas when there is nothing to place", () => {
    const layout = computeProjectLayout({ cardWidth: 200, projects: [] });
    expect(layout.projects).toHaveLength(0);
    expect(layout.canvasWidth).toBe(0);
  });

  it("places every project exactly once", () => {
    const layout = computeProjectLayout({
      cardWidth: 200,
      projects: [
        { key: "a", cardCount: 9 },
        { key: "b", cardCount: 3 },
        { key: "c", cardCount: 1 },
      ],
    });
    expect(layout.projects.map((p) => p.key).sort()).toEqual(["a", "b", "c"]);
  });

  it("never lets two projects' cards overlap", () => {
    const defs = [
      { key: "a", cardCount: 12 },
      { key: "b", cardCount: 2 },
      { key: "c", cardCount: 7 },
      { key: "d", cardCount: 1 },
      { key: "e", cardCount: 20 },
    ];
    const layout = computeProjectLayout({ cardWidth: 200, projects: defs });

    // The reported extent must already cover the cards themselves — they
    // sit centred on the outermost ring and overhang it by half a card.
    // Sizing on the bare ring radius let neighbouring clouds interleave.
    for (const project of layout.projects) {
      const count = defs.find((def) => def.key === project.key)!.cardCount;
      for (const slot of cardRingSlots(count, 200)) {
        expect(Math.abs(slot.dx) + 100).toBeLessThanOrEqual(project.rx + 1);
        expect(Math.abs(slot.dy) + 56).toBeLessThanOrEqual(project.ry + 1);
      }
    }

    for (const left of layout.projects) {
      for (const right of layout.projects) {
        if (left.key === right.key) continue;
        const overlapX = Math.abs(left.x - right.x) < left.rx + right.rx;
        const overlapY = Math.abs(left.y - right.y) < left.ry + right.ry;
        expect(overlapX && overlapY).toBe(false);
      }
    }
  });

  it("gives a busy project a bigger footprint than a quiet one", () => {
    const layout = computeProjectLayout({
      cardWidth: 200,
      projects: [
        { key: "busy", cardCount: 20 },
        { key: "quiet", cardCount: 1 },
      ],
    });
    const busy = layout.projects.find((p) => p.key === "busy")!;
    const quiet = layout.projects.find((p) => p.key === "quiet")!;
    expect(busy.rx).toBeGreaterThan(quiet.rx);
  });

  it("keeps every project inside the reported canvas", () => {
    const layout = computeProjectLayout({
      cardWidth: 200,
      projects: Array.from({ length: 9 }, (_, index) => ({
        key: `p${index}`,
        cardCount: index + 1,
      })),
    });
    for (const project of layout.projects) {
      expect(project.x - project.rx).toBeGreaterThan(0);
      expect(project.x + project.rx).toBeLessThan(layout.canvasWidth);
      expect(project.y - project.ry).toBeGreaterThan(0);
      expect(project.y + project.ry).toBeLessThan(layout.canvasHeight);
    }
  });
});

describe("computeProjectLayout galaxy shape", () => {
  const defs = Array.from({ length: 12 }, (_, index) => ({
    key: `p${index}`,
    cardCount: 12 - index,
  }));

  it("emits one path per arm", () => {
    const layout = computeProjectLayout({ cardWidth: 200, projects: defs });
    expect(layout.arms).toHaveLength(3);
    for (const arm of layout.arms) {
      expect(arm.startsWith("M ")).toBe(true);
      expect(arm).toContain("L ");
    }
  });

  it("seats the busiest project nearest the core", () => {
    const layout = computeProjectLayout({ cardWidth: 200, projects: defs });
    const distance = (key: string) => {
      const project = layout.projects.find((entry) => entry.key === key)!;
      return Math.hypot(
        project.x - layout.core.x,
        project.y - layout.core.y,
      );
    };
    // p0 is the busiest and seats first; the last-placed project has been
    // pushed well outward by everything before it.
    expect(distance("p0")).toBeLessThan(distance("p11"));
  });

  it("spreads projects around the core rather than along a lattice", () => {
    const layout = computeProjectLayout({ cardWidth: 200, projects: defs });
    const angles = layout.projects.map((project) =>
      Math.atan2(project.y - layout.core.y, project.x - layout.core.x),
    );
    // A grid would repeat a handful of angles; a spiral fans them out.
    expect(new Set(angles.map((angle) => angle.toFixed(2))).size).toBeGreaterThan(
      6,
    );
  });

  it("is deterministic", () => {
    const first = computeProjectLayout({ cardWidth: 200, projects: defs });
    const second = computeProjectLayout({ cardWidth: 200, projects: defs });
    expect(first.projects).toEqual(second.projects);
    expect(first.arms).toEqual(second.arms);
  });

  it("still seats a single project", () => {
    const layout = computeProjectLayout({
      cardWidth: 200,
      projects: [{ key: "solo", cardCount: 3 }],
    });
    expect(layout.projects).toHaveLength(1);
    expect(layout.canvasWidth).toBeGreaterThan(0);
  });
});

describe("projectMass", () => {
  const HOUR = 60 * 60 * 1000;
  const now = 1_000 * HOUR;

  it("grows with card count", () => {
    expect(
      projectMass({ cardCount: 9, lastActivityAt: now, now }),
    ).toBeGreaterThan(projectMass({ cardCount: 3, lastActivityAt: now, now }));
  });

  it("grows with recency at equal size", () => {
    const fresh = projectMass({ cardCount: 4, lastActivityAt: now, now });
    const stale = projectMass({
      cardCount: 4,
      lastActivityAt: now - 400 * HOUR,
      now,
    });
    expect(fresh).toBeGreaterThan(stale);
  });

  it("lets a live small project outrank a dormant slightly-bigger one", () => {
    // The whole point of the recency term: a project you touched an hour
    // ago is worth reviewing before a marginally larger one nobody has
    // opened in a fortnight.
    const live = projectMass({ cardCount: 3, lastActivityAt: now, now });
    const dormant = projectMass({
      cardCount: 6,
      lastActivityAt: now - 800 * HOUR,
      now,
    });
    expect(live).toBeGreaterThan(dormant);
  });

  it("does not let recency beat a genuinely large project", () => {
    const live = projectMass({ cardCount: 2, lastActivityAt: now, now });
    const big = projectMass({
      cardCount: 20,
      lastActivityAt: now - 800 * HOUR,
      now,
    });
    expect(big).toBeGreaterThan(live);
  });

  it("never goes below the card count", () => {
    expect(
      projectMass({ cardCount: 5, lastActivityAt: 0, now }),
    ).toBeGreaterThanOrEqual(5);
  });
});

describe("gravity seating", () => {
  const distances = (
    defs: { key: string; cardCount: number; mass: number }[],
  ) => {
    const layout = computeProjectLayout({ cardWidth: 200, projects: defs });
    return new Map(
      layout.projects.map((project) => [
        project.key,
        Math.hypot(project.x - layout.core.x, project.y - layout.core.y),
      ]),
    );
  };

  it("drags heavier projects toward the core", () => {
    const d = distances([
      { key: "heavy", cardCount: 12, mass: 20 },
      { key: "middle", cardCount: 6, mass: 10 },
      { key: "light", cardCount: 1, mass: 2 },
    ]);
    expect(d.get("heavy")!).toBeLessThan(d.get("middle")!);
    expect(d.get("middle")!).toBeLessThan(d.get("light")!);
  });

  it("separates by mass, not just by rank", () => {
    // Two projects a hair apart in mass should sit at nearly the same
    // radius; ordering alone would have spaced them a whole ring apart.
    const d = distances([
      { key: "a", cardCount: 4, mass: 10 },
      { key: "b", cardCount: 4, mass: 9.8 },
      { key: "far", cardCount: 1, mass: 1 },
    ]);
    const gapBetweenPeers = Math.abs(d.get("a")! - d.get("b")!);
    const gapToFar = Math.abs(d.get("a")! - d.get("far")!);
    expect(gapBetweenPeers).toBeLessThan(gapToFar);
  });

  it("falls back to card count when mass is absent", () => {
    const d = distances([
      { key: "big", cardCount: 12 },
      { key: "small", cardCount: 1 },
    ] as { key: string; cardCount: number; mass: number }[]);
    expect(d.get("big")!).toBeLessThan(d.get("small")!);
  });

  it("seats an unranked fleet at the core, not the rim", () => {
    // Every project one thread of similar age — the shape of a new or
    // small fleet. There is no ranking to express, so they belong at the
    // centre; a zero mass span used to give them all the LIGHTEST
    // treatment and leave a hollow galaxy.
    const d = distances(
      Array.from({ length: 6 }, (_, index) => ({
        key: `p${index}`,
        cardCount: 1,
        mass: 1,
      })),
    );
    const closest = Math.min(...d.values());
    expect(closest).toBeLessThan(400);
  });

  it("puts a lone project at its own core", () => {
    const d = distances([{ key: "solo", cardCount: 3, mass: 8 }]);
    expect(d.get("solo")!).toBeLessThan(400);
  });
});

describe("groupThreadsByProject summons", () => {
  it("seats a summoned thread first, ahead of recency", () => {
    // A project body seats only its first PROJECT_MAX_CARDS_PER_BODY
    // threads, and this lens re-sorts its pools by activity — so a card
    // the operator asked for by name has to be told to come forward here
    // as well as in `selectFilteredThreads`.
    const stale = thread({
      id: "stale",
      repoPath: "/repo/pwragent",
      updatedAt: 1,
    });
    const busy = thread({
      id: "busy",
      repoPath: "/repo/pwragent",
      updatedAt: 500,
    });
    const [project] = groupThreadsByProject(
      new Map([["pwr_local", [busy, stale]]]),
      { now: 1_000, summonedKeys: new Set(["codex:stale"]) },
    );
    expect(project.threads.map((entry) => entry.id)).toEqual([
      "stale",
      "busy",
    ]);
  });

  it("leaves the order alone when nothing was summoned", () => {
    const stale = thread({
      id: "stale",
      repoPath: "/repo/pwragent",
      updatedAt: 1,
    });
    const busy = thread({
      id: "busy",
      repoPath: "/repo/pwragent",
      updatedAt: 500,
    });
    const [project] = groupThreadsByProject(
      new Map([["pwr_local", [stale, busy]]]),
      { now: 1_000 },
    );
    expect(project.threads.map((entry) => entry.id)).toEqual([
      "busy",
      "stale",
    ]);
  });
});


it("keeps project mass and off-page bodies stable while another row page arrives", () => {
  const visible = thread({ id: "visible", repoPath: "/repos/large", updatedAt: 1 });
  const descriptor = (key: string, total: number): NavigationDirectoryRow => ({
    key, label: key, kind: "directory", counts: { total, active: 0, unread: 0, review: 0 },
    pinnedRootCount: 0, unpinnedRootCount: total, launchpadPresent: false, latestUpdatedAt: 100,
  });
  const descriptors = new Map([["owner", [descriptor(threadProjectKey(visible), 1000), descriptor("off-page", 500)]]]);
  const first = groupThreadsByProject(new Map([["owner", [visible]]]), { descriptorsByInstance: descriptors, now: 100 });
  const next = groupThreadsByProject(new Map([["owner", [visible, thread({ id: "next", repoPath: "/repos/large" })]]]),
    { descriptorsByInstance: descriptors, now: 100 });
  expect(first.map((project) => [project.key, project.mass, project.totalThreadCount]))
    .toEqual(next.map((project) => [project.key, project.mass, project.totalThreadCount]));
  expect(first.find((project) => project.key === "off-page")?.threads).toEqual([]);
});
