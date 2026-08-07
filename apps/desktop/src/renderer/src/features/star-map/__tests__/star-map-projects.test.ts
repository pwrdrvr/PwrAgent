import { describe, expect, it } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import {
  STAR_MAP_NO_PROJECT_KEY,
  groupThreadsByProject,
  instanceIdByThreadKey,
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

  it("pools threads for one project across instances", () => {
    const projects = groupThreadsByProject(byInstance);
    const pwragent = projects.find((p) => p.key === "/repos/PwrAgnt");
    expect(pwragent?.threads.map((t) => t.id)).toEqual(["r1", "l1"]);
  });

  it("names a project after its repo folder", () => {
    const projects = groupThreadsByProject(byInstance);
    expect(projects.find((p) => p.key === "/repos/PwrSnap")?.label).toBe(
      "PwrSnap",
    );
  });

  it("orders threads within a project by recent activity", () => {
    const projects = groupThreadsByProject(byInstance);
    const ids = projects.find((p) => p.key === "/repos/PwrAgnt")!.threads;
    expect(ids[0].updatedAt).toBeGreaterThan(ids[1].updatedAt!);
  });

  it("puts the busiest project first", () => {
    expect(groupThreadsByProject(byInstance)[0].key).toBe("/repos/PwrAgnt");
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
