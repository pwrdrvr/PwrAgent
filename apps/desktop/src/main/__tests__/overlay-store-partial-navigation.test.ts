import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppServerThreadSummary } from "@pwragent/shared";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";

let stateDb: StateDb;
let store: SqliteOverlayStore;
let tempDir: string;

function buildThread(params: {
  id: string;
  path: string;
  updatedAt: number;
}): AppServerThreadSummary {
  return {
    id: params.id,
    title: params.id,
    titleSource: "explicit",
    source: "codex",
    linkedDirectories: [
      {
        id: params.path,
        kind: "local",
        label: path.basename(params.path),
        path: params.path,
      },
    ],
    updatedAt: params.updatedAt,
  };
}

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "pwragent-partial-nav-test-"));
  stateDb = StateDb.open(path.join(tempDir, "state.db"));
  store = new SqliteOverlayStore(stateDb);
});

afterEach(() => {
  stateDb.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("SqliteOverlayStore partial navigation snapshots", () => {
  it("renders overlays without replacing the full navigation baseline", async () => {
    const pinnedThread = buildThread({
      id: "thread-pinned",
      path: "/repo/alpha",
      updatedAt: 2_000,
    });
    const recentThread = buildThread({
      id: "thread-recent",
      path: "/repo/beta",
      updatedAt: 3_000,
    });
    const olderThread = buildThread({
      id: "thread-older",
      path: "/repo/gamma",
      updatedAt: 1_000,
    });
    await store.setThreadPin({
      backend: "codex",
      threadId: pinnedThread.id,
      pinnedRank: "1024",
    });
    await store.markThreadSeen({
      backend: "codex",
      threadId: pinnedThread.id,
      seenAt: 2_100,
      seenUpdatedAt: pinnedThread.updatedAt,
    });
    await store.setDirectoryPin({
      directoryKey: "directory:/repo/alpha",
      pinnedRank: "1024",
    });
    await store.setDirectoryThreadsCollapsed({
      directoryKey: "directory:/repo/alpha",
      collapsed: true,
    });

    const partial = await store.reconcileNavigationSnapshot({
      backend: "all",
      fetchedAt: 3_100,
      partial: true,
      threads: [recentThread, pinnedThread],
    });

    expect(partial.threads.map((thread) => thread.id)).toEqual([
      "thread-recent",
      "thread-pinned",
    ]);
    expect(partial.threads.find((thread) => thread.id === pinnedThread.id)).toMatchObject({
      inbox: { inInbox: false },
      pinnedRank: "1024",
    });
    expect(partial.directories.find((directory) => directory.path === "/repo/alpha"))
      .toMatchObject({
        directoryThreadsCollapsed: true,
        pinnedRank: "1024",
      });
    expect(
      stateDb.raw.prepare("SELECT payload FROM backends WHERE scope = ?").get("all"),
    ).toBeUndefined();
    await expect(store.getThreadOverlayState({
      backend: "codex",
      threadId: recentThread.id,
    })).resolves.toBeUndefined();

    const full = await store.reconcileNavigationSnapshot({
      backend: "all",
      fetchedAt: 3_200,
      threads: [recentThread, pinnedThread, olderThread],
    });

    expect(full.threads.map((thread) => thread.id)).toEqual([
      "thread-recent",
      "thread-pinned",
      "thread-older",
    ]);
    expect(full.threads.every((thread) => thread.inbox.inInbox === false)).toBe(true);
    expect(full.threads.find((thread) => thread.id === pinnedThread.id)).toMatchObject({
      pinnedRank: "1024",
    });
    expect(full.directories.find((directory) => directory.path === "/repo/alpha"))
      .toMatchObject({
        directoryThreadsCollapsed: true,
        pinnedRank: "1024",
      });
    expect(
      stateDb.raw.prepare("SELECT payload FROM backends WHERE scope = ?").get("all"),
    ).toBeDefined();
    await expect(store.getThreadOverlayState({
      backend: "codex",
      threadId: olderThread.id,
    })).resolves.toBeDefined();
  });
});
