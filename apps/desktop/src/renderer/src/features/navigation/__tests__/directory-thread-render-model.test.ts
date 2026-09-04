import { describe, expect, it } from "vitest";
import {
  buildFederatedThreadRef,
  federatedThreadIdentityKey,
  type NavigationThreadSummary,
} from "@pwragent/shared";
import { buildDirectoryThreadRenderModel } from "../directory-thread-render-model";
import { buildLargeDirectoryFixture } from "./fixtures/directory-performance";

describe("large directory thread render model", () => {
  it("groups same-owner remote children under their scoped parent", () => {
    const parentRef = buildFederatedThreadRef({
      backend: "codex",
      instanceId: "remote-owner",
      threadId: "parent",
    });
    const childRef = buildFederatedThreadRef({
      backend: "codex",
      instanceId: "remote-owner",
      threadId: "child",
    });
    const parent = {
      id: "parent",
      title: "Remote parent",
      titleSource: "explicit",
      source: "codex",
      linkedDirectories: [],
      inbox: { inInbox: false },
      federation: { ref: parentRef, instanceLabel: "Remote owner" },
    } as NavigationThreadSummary;
    const child = {
      id: "child",
      title: "Remote child",
      titleSource: "explicit",
      source: "codex",
      linkedDirectories: [],
      inbox: { inInbox: false },
      parentThreadBackend: "codex",
      parentThreadId: "parent",
      federation: { ref: childRef, instanceLabel: "Remote owner" },
    } as NavigationThreadSummary;
    const parentKey = federatedThreadIdentityKey(parentRef);
    const childKey = federatedThreadIdentityKey(childRef);
    const model = buildDirectoryThreadRenderModel({
      directory: {
        key: "directory:/remote/repo",
        kind: "directory",
        label: "Remote repo",
        path: "/remote/repo",
        threadKeys: [parentKey, childKey],
        needsAttentionCount: 0,
      },
      expanded: true,
      threadsByKey: new Map([
        [parentKey, parent],
        [childKey, child],
      ]),
    });

    expect(model.expanded?.childThreadsByParentKey.get(parentKey)).toEqual([
      child,
    ]);
    expect(model.expanded?.selectionOrder).toEqual([parentKey, childKey]);
  });

  it("does not prepare hidden thread structure for collapsed project folders", () => {
    const fixture = buildLargeDirectoryFixture({
      directoryCount: 12,
      pinnedThreadsPerDirectory: 1,
      unpinnedThreadsPerDirectory: 107,
    });

    const models = fixture.directories.map((directory) =>
      buildDirectoryThreadRenderModel({
        directory,
        expanded: false,
        threadsByKey: fixture.threadsByKey,
      }),
    );

    expect(fixture.threads).toHaveLength(1_296);
    expect(models.every((model) => model.expanded === undefined)).toBe(true);
    expect(
      models.reduce((count, model) => count + model.visibleThreadCount, 0),
    ).toBe(1_296);
  });

  it("keeps 107 minimized directory threads out of the visible row model", () => {
    const fixture = buildLargeDirectoryFixture({
      pinnedThreadsPerDirectory: 1,
      unpinnedThreadsPerDirectory: 107,
      directoryThreadsCollapsed: true,
    });
    const model = buildDirectoryThreadRenderModel({
      directory: fixture.directories[0]!,
      expanded: true,
      threadsByKey: fixture.threadsByKey,
    });

    expect(model.expanded?.directoryPinnedThreads).toHaveLength(1);
    expect(model.expanded?.directoryUnpinnedThreadCount).toBe(107);
    expect(model.expanded?.cappedUnpinnedThreads).toHaveLength(0);
    expect(model.expanded?.overflowUnpinnedThreads).toHaveLength(0);
    expect(model.expanded?.hiddenUnpinnedCount).toBe(107);
    expect(model.expanded?.directoryThreadsCollapsed).toBe(true);
    expect(model.expanded?.selectionOrder).toHaveLength(1);
  });

  it("prepares only the ten-row window while Show more is collapsed", () => {
    const fixture = buildLargeDirectoryFixture({
      pinnedThreadsPerDirectory: 0,
      unpinnedThreadsPerDirectory: 107,
      directoryThreadsCollapsed: false,
    });
    const model = buildDirectoryThreadRenderModel({
      directory: fixture.directories[0]!,
      expanded: true,
      threadsByKey: fixture.threadsByKey,
    });

    expect(model.expanded?.directoryThreadsCollapsed).toBe(false);
    expect(model.expanded?.cappedUnpinnedThreads).toHaveLength(10);
    expect(model.expanded?.overflowUnpinnedThreads).toHaveLength(97);
    expect(model.expanded?.selectionOrder).toHaveLength(10);
  });

  it("gives a pinned subthread its own row when its parent stays collapsed", () => {
    const hiddenParent = {
      id: "hidden-parent",
      title: "Hidden parent",
      titleSource: "explicit",
      source: "codex",
      linkedDirectories: [],
      inbox: { inInbox: false },
    } as NavigationThreadSummary;
    const pinnedAnchor = {
      id: "pinned-anchor",
      title: "Pinned anchor",
      titleSource: "explicit",
      source: "codex",
      linkedDirectories: [],
      inbox: { inInbox: false },
      pinnedRank: "1024",
    } as NavigationThreadSummary;
    const pinnedChild = {
      id: "pinned-child",
      title: "Pinned child",
      titleSource: "explicit",
      source: "codex",
      linkedDirectories: [],
      inbox: { inInbox: false },
      parentThreadBackend: "codex",
      parentThreadId: "hidden-parent",
      pinnedRank: "2048",
    } as NavigationThreadSummary;
    const model = buildDirectoryThreadRenderModel({
      directory: {
        key: "directory:/repo",
        kind: "directory",
        label: "Repo",
        path: "/repo",
        threadKeys: [
          "codex:pinned-anchor",
          "codex:hidden-parent",
          "codex:pinned-child",
        ],
        needsAttentionCount: 0,
        directoryThreadsCollapsed: true,
      },
      expanded: true,
      threadsByKey: new Map([
        ["codex:pinned-anchor", pinnedAnchor],
        ["codex:hidden-parent", hiddenParent],
        ["codex:pinned-child", pinnedChild],
      ]),
    });

    expect(model.expanded?.directoryThreadsCollapsed).toBe(true);
    expect(
      model.expanded?.directoryPinnedThreads.map((thread) => thread.id),
    ).toEqual(["pinned-anchor", "pinned-child"]);
    expect(model.expanded?.childThreadsByParentKey.size).toBe(0);
    expect(model.expanded?.selectionOrder).toEqual([
      "codex:pinned-anchor",
      "codex:pinned-child",
    ]);
  });

  it("keeps an unpinned subthread nested under its rendered parent", () => {
    const parent = {
      id: "parent",
      title: "Parent",
      titleSource: "explicit",
      source: "codex",
      linkedDirectories: [],
      inbox: { inInbox: false },
      pinnedRank: "1024",
    } as NavigationThreadSummary;
    const child = {
      id: "child",
      title: "Child",
      titleSource: "explicit",
      source: "codex",
      linkedDirectories: [],
      inbox: { inInbox: false },
      parentThreadBackend: "codex",
      parentThreadId: "parent",
      pinnedRank: "2048",
    } as NavigationThreadSummary;
    const model = buildDirectoryThreadRenderModel({
      directory: {
        key: "directory:/repo",
        kind: "directory",
        label: "Repo",
        path: "/repo",
        threadKeys: ["codex:parent", "codex:child"],
        needsAttentionCount: 0,
        directoryThreadsCollapsed: true,
      },
      expanded: true,
      threadsByKey: new Map([
        ["codex:parent", parent],
        ["codex:child", child],
      ]),
    });

    expect(
      model.expanded?.directoryPinnedThreads.map((thread) => thread.id),
    ).toEqual(["parent"]);
    expect(model.expanded?.childThreadsByParentKey.get("codex:parent")).toEqual([
      child,
    ]);
    expect(model.expanded?.selectionOrder).toEqual([
      "codex:parent",
      "codex:child",
    ]);
  });
});
