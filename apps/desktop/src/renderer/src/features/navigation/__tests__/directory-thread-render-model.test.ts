import { describe, expect, it } from "vitest";
import { buildDirectoryThreadRenderModel } from "../directory-thread-render-model";
import { buildLargeDirectoryFixture } from "./fixtures/directory-performance";

describe("large directory thread render model", () => {
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
});
