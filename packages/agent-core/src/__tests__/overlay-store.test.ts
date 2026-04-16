import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppServerThreadSummary } from "@pwragnt/shared";
import { OverlayStore } from "../persistence/overlay-store";

const tempDirs: string[] = [];

async function createStore(): Promise<OverlayStore> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pwragnt-overlay-store-"));
  tempDirs.push(tempDir);
  return new OverlayStore(path.join(tempDir, "overlay-state.json"));
}

function buildThread(overrides: Partial<AppServerThreadSummary> = {}): AppServerThreadSummary {
  return {
    id: "thread-1",
    title: "Desktop App",
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

describe("OverlayStore", () => {
  it("persists seen state without mutating app-server-owned thread data", async () => {
    const store = await createStore();

    await store.reconcileNavigationSnapshot({
      backend: "codex",
      fetchedAt: 1000,
      threads: [buildThread()],
    });

    await store.markThreadSeen({
      backend: "codex",
      threadId: "thread-1",
      seenAt: 2000,
      seenUpdatedAt: 1000,
    });

    const raw = JSON.parse(
      await readFile(path.join(tempDirs[0]!, "overlay-state.json"), "utf8"),
    ) as {
      threads: Record<string, { lastSeenAt?: number; lastSeenUpdatedAt?: number }>;
    };

    expect(raw.threads["thread-1"]).toMatchObject({
      lastSeenAt: 2000,
      lastSeenUpdatedAt: 1000,
    });
  });

  it("stores extra linked directories for desktop-only multi-project overlays", async () => {
    const store = await createStore();

    await store.addLinkedDirectory({
      threadId: "thread-2",
      directory: {
        id: "/Users/huntharo/pwrdrvr/openclaw",
        kind: "local",
        label: "openclaw",
        path: "/Users/huntharo/pwrdrvr/openclaw",
      },
    });

    const raw = JSON.parse(
      await readFile(path.join(tempDirs[0]!, "overlay-state.json"), "utf8"),
    ) as {
      threads: Record<string, { extraLinkedDirectories: Array<{ label: string }> }>;
    };

    expect(raw.threads["thread-2"]?.extraLinkedDirectories).toEqual([
      expect.objectContaining({ label: "openclaw" }),
    ]);
  });
});
