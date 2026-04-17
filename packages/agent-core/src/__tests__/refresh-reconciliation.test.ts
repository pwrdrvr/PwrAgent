import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppServerThreadSummary } from "@pwragnt/shared";
import { OverlayStore } from "../persistence/overlay-store";

const tempDirs: string[] = [];

async function createStore(): Promise<OverlayStore> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pwragnt-refresh-reconcile-"));
  tempDirs.push(tempDir);
  return new OverlayStore(path.join(tempDir, "overlay-state.json"));
}

function buildThread(overrides: Partial<AppServerThreadSummary> = {}): AppServerThreadSummary {
  return {
    id: "thread-1",
    title: "Desktop App",
    titleSource: "explicit",
    source: "codex",
    linkedDirectories: [],
    updatedAt: 1000,
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (tempDir) => {
      await import("node:fs/promises").then(({ rm }) =>
        rm(tempDir, { recursive: true, force: true }),
      );
    }),
  );
});

describe("refresh reconciliation", () => {
  it("treats the first snapshot as a baseline instead of flooding inbox", async () => {
    const store = await createStore();

    const snapshot = await store.reconcileNavigationSnapshot({
      backend: "codex",
      fetchedAt: 1000,
      threads: [buildThread()],
    });

    expect(snapshot.unchanged).toBe(false);
    expect(snapshot.inboxThreadKeys).toEqual([]);
    expect(snapshot.threads[0]?.inbox.inInbox).toBe(false);
  });

  it("marks later thread updates as changed and inbox-worthy", async () => {
    const store = await createStore();

    await store.reconcileNavigationSnapshot({
      backend: "codex",
      fetchedAt: 1000,
      threads: [buildThread()],
    });

    const snapshot = await store.reconcileNavigationSnapshot({
      backend: "codex",
      fetchedAt: 2000,
      threads: [buildThread({ updatedAt: 3000 })],
    });

    expect(snapshot.unchanged).toBe(false);
    expect(snapshot.inboxThreadKeys).toEqual(["codex:thread-1"]);
    expect(snapshot.threads[0]?.inbox.reason).toBe("updated-since-seen");
  });

  it("returns unchanged when the material thread snapshot did not move", async () => {
    const store = await createStore();

    await store.reconcileNavigationSnapshot({
      backend: "codex",
      fetchedAt: 1000,
      threads: [buildThread()],
    });

    const snapshot = await store.reconcileNavigationSnapshot({
      backend: "codex",
      fetchedAt: 2000,
      threads: [buildThread()],
    });

    expect(snapshot.unchanged).toBe(true);
  });

  it("treats title metadata changes as material snapshot changes", async () => {
    const store = await createStore();

    await store.reconcileNavigationSnapshot({
      backend: "codex",
      fetchedAt: 1000,
      threads: [buildThread()],
    });

    const snapshot = await store.reconcileNavigationSnapshot({
      backend: "codex",
      fetchedAt: 2000,
      threads: [buildThread({ title: "first prompt", titleSource: "derived" })],
    });

    expect(snapshot.unchanged).toBe(false);
  });

  it("tracks mixed-backend threads with duplicate ids independently in aggregate snapshots", async () => {
    const store = await createStore();

    await store.reconcileNavigationSnapshot({
      backend: "all",
      fetchedAt: 1000,
      threads: [
        buildThread(),
        buildThread({
          source: "grok",
          title: "Desktop App (Grok)",
          updatedAt: 1000,
        }),
      ],
    });

    const snapshot = await store.reconcileNavigationSnapshot({
      backend: "all",
      fetchedAt: 2000,
      threads: [
        buildThread({ updatedAt: 3000 }),
        buildThread({
          source: "grok",
          title: "Desktop App (Grok)",
          updatedAt: 1000,
        }),
      ],
    });

    expect(snapshot.inboxThreadKeys).toEqual(["codex:thread-1"]);
    expect(snapshot.threads).toHaveLength(2);
    expect(snapshot.threads.map((thread) => `${thread.source}:${thread.id}`)).toEqual([
      "codex:thread-1",
      "grok:thread-1",
    ]);
  });
});
