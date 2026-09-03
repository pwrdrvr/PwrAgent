// What the map tells an Agent it is showing.
//
// The snapshot exists so a request like "rename that thread like the others
// in its cloud" can be resolved, so the assertions here are about the two
// things such a request depends on: cloud membership, and the difference
// between a card that is drawn and one that is folded behind a `+N more`
// chip. A snapshot that got either wrong would have an Agent confidently
// acting on threads the operator cannot see.
import { describe, expect, it } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import {
  buildInstanceClusters,
  computeClusterCloud,
} from "../star-map-clusters";
import { buildStarMapViewSnapshot } from "../star-map-view-snapshot";

const NOW = 1_000_000;

function thread(
  id: string,
  options?: { path?: string; title?: string; pinnedRank?: string },
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
    updatedAt: NOW,
    ...(options?.pinnedRank ? { pinnedRank: options.pinnedRank } : {}),
  } as unknown as NavigationThreadSummary;
}

function cloudFor(threads: NavigationThreadSummary[]) {
  return computeClusterCloud({
    clusters: buildInstanceClusters({ threads, expandedKeys: new Set() }),
    cardWidth: 220,
    heightForThread: () => 112,
  });
}

function baseInput(overrides: Partial<Parameters<typeof buildStarMapViewSnapshot>[0]> = {}) {
  return {
    surface: "window" as const,
    layout: "orbit" as const,
    camera: { x: 0, y: 0, scale: 1 },
    viewport: { width: 1280, height: 800 },
    filterSelection: {},
    hideOfflineInstances: false,
    hiddenInstanceCount: 0,
    matchedThreadCount: 0,
    localInstanceId: "local",
    threadsByInstance: new Map(),
    instanceLabels: new Map([["local", "This instance"]]),
    selection: new Set<string>(),
    openChatCardThreadKeys: new Set<string>(),
    now: NOW,
    ...overrides,
  };
}

/**
 * The cards the layout placed. A card's rect is what makes it drawn, so a
 * test that wants a card on screen gives it geometry.
 */
function drawn(...cardKeys: string[]): Map<
  string,
  { x: number; y: number; width: number; height: number }
> {
  return new Map(
    cardKeys.map((cardKey, index) => [
      cardKey,
      { x: index * 240, y: 0, width: 220, height: 112 },
    ]),
  );
}

describe("buildStarMapViewSnapshot", () => {
  it("names each thread's cloud so 'the others in its cloud' resolves", () => {
    const threads = [
      thread("a1", { path: "/repo/alpha" }),
      thread("a2", { path: "/repo/alpha" }),
      thread("b1", { path: "/repo/beta" }),
    ];
    const snapshot = buildStarMapViewSnapshot(
      baseInput({
        threadsByInstance: new Map([["local", threads]]),
        clouds: new Map([["local", cloudFor(threads)]]),
        cardRects: drawn(
          "local::codex:a1",
          "local::codex:a2",
          "local::codex:b1",
        ),
        matchedThreadCount: 3,
      }),
    );
    const alpha = snapshot.clouds.find((cloud) => cloud.label === "alpha");
    expect(alpha?.threadKeys).toEqual(["codex:a1", "codex:a2"]);
    expect(
      snapshot.threads
        .filter((entry) => entry.cloudKey === alpha?.key)
        .map((entry) => entry.threadKey),
    ).toEqual(["codex:a1", "codex:a2"]);
    // The beta thread is a different cloud, and must not be swept up with it.
    const beta = snapshot.clouds.find((cloud) => cloud.label === "beta");
    expect(beta?.threadKeys).toEqual(["codex:b1"]);
  });

  it("separates cards that are drawn from cards folded behind the chip", () => {
    const threads = [
      thread("a1", { path: "/repo/alpha" }),
      thread("a2", { path: "/repo/alpha" }),
    ];
    const snapshot = buildStarMapViewSnapshot(
      baseInput({
        threadsByInstance: new Map([["local", threads]]),
        clouds: new Map([["local", cloudFor(threads)]]),
        // Only the first card is on screen.
        cardRects: drawn("local::codex:a1"),
      }),
    );
    expect(
      snapshot.threads.map((entry) => [entry.threadKey, entry.visible]),
    ).toEqual([
      ["codex:a1", true],
      ["codex:a2", false],
    ]);
    expect(snapshot.instances[0].visibleThreadCount).toBe(1);
    expect(snapshot.instances[0].threadCount).toBe(2);
  });

  it("carries the operator's selection through as thread keys", () => {
    const threads = [thread("a1", { path: "/repo/alpha" })];
    const snapshot = buildStarMapViewSnapshot(
      baseInput({
        threadsByInstance: new Map([["local", threads]]),
        clouds: new Map([["local", cloudFor(threads)]]),
        cardRects: drawn("local::codex:a1"),
        selection: new Set(["local::codex:a1"]),
      }),
    );
    expect(snapshot.threads[0].selected).toBe(true);
    expect(snapshot.selectedThreadKeys).toEqual(["codex:a1"]);
  });

  it("reports which threads already have a chat card open", () => {
    const threads = [thread("a1", { path: "/repo/alpha" })];
    const snapshot = buildStarMapViewSnapshot(
      baseInput({
        threadsByInstance: new Map([["local", threads]]),
        clouds: new Map([["local", cloudFor(threads)]]),
        openChatCardThreadKeys: new Set(["codex:a1"]),
      }),
    );
    expect(snapshot.threads[0].chatCardOpen).toBe(true);
    expect(snapshot.openChatCardThreadKeys).toEqual(["codex:a1"]);
  });

  it("labels a peer's threads with the instance an Agent must address", () => {
    const threads = [thread("p1", { path: "/repo/alpha" })];
    const snapshot = buildStarMapViewSnapshot(
      baseInput({
        threadsByInstance: new Map([["peer-7", threads]]),
        instanceLabels: new Map([["peer-7", "Studio"]]),
        clouds: new Map([["peer-7", cloudFor(threads)]]),
        cardRects: drawn("peer-7::codex:p1"),
      }),
    );
    expect(snapshot.threads[0]).toMatchObject({
      instanceId: "peer-7",
      instanceLabel: "Studio",
      isLocal: false,
      backend: "codex",
      threadId: "p1",
    });
  });

  it("reports only the filters the operator actually set", () => {
    const snapshot = buildStarMapViewSnapshot(
      baseInput({
        filterSelection: { attention: "include", pinned: "exclude" },
      }),
    );
    expect(
      snapshot.filters.map((filter) => [filter.key, filter.state]),
    ).toEqual([
      ["attention", "include"],
      ["pinned", "exclude"],
    ]);
  });

  it("passes the card geometry through for the cards that have it", () => {
    const threads = [thread("a1", { path: "/repo/alpha" })];
    const snapshot = buildStarMapViewSnapshot(
      baseInput({
        threadsByInstance: new Map([["local", threads]]),
        clouds: new Map([["local", cloudFor(threads)]]),
        cardRects: new Map([
          ["local::codex:a1", { x: 10, y: 20, width: 220, height: 112 }],
        ]),
      }),
    );
    expect(snapshot.threads[0].rect).toEqual({
      x: 10,
      y: 20,
      width: 220,
      height: 112,
    });
  });

  it("pools the projects lens into clouds that belong to no one instance", () => {
    const local = [thread("a1", { path: "/repo/alpha" })];
    const peer = [thread("a2", { path: "/repo/alpha" })];
    const snapshot = buildStarMapViewSnapshot(
      baseInput({
        layout: "projects",
        threadsByInstance: new Map([
          ["local", local],
          ["peer-7", peer],
        ]),
        instanceLabels: new Map([
          ["local", "This instance"],
          ["peer-7", "Studio"],
        ]),
        projects: [
          {
            key: "alpha",
            label: "alpha",
            threads: [...local, ...peer],
            mass: 2,
            lastActivityAt: NOW,
          },
        ],
        cardRects: drawn("local::codex:a1"),
      }),
    );
    const alpha = snapshot.clouds[0];
    expect(alpha.instanceId).toBeUndefined();
    expect(alpha.threadKeys).toEqual(["codex:a1", "codex:a2"]);
    // One of the two is drawn; the other is folded away on some body.
    expect(alpha.visibleCount).toBe(1);
    expect(alpha.hiddenCount).toBe(1);
    // Every member names its cloud here too. Without this the one reference
    // the tool exists to resolve — "the others in its cloud" — is
    // unanswerable in this lens.
    expect(snapshot.threads.map((entry) => entry.cloudKey)).toEqual([
      "alpha",
      "alpha",
    ]);
  });

  it("marks pinned threads and the attention categories the chips filter on", () => {
    const pinned = thread("a1", { path: "/repo/alpha", pinnedRank: "a" });
    const unread = {
      ...thread("a2", { path: "/repo/alpha" }),
      inbox: { inInbox: true, reason: "updated-since-seen" },
    } as NavigationThreadSummary;
    const snapshot = buildStarMapViewSnapshot(
      baseInput({
        threadsByInstance: new Map([["local", [pinned, unread]]]),
        clouds: new Map([["local", cloudFor([pinned, unread])]]),
      }),
    );
    expect(snapshot.threads[0].pinned).toBe(true);
    expect(snapshot.threads[1].attention).toContain("unread");
  });
});
