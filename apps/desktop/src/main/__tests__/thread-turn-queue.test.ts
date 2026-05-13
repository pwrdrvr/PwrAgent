import { describe, expect, it, vi } from "vitest";
import {
  ThreadTurnQueue,
  type ThreadTurnQueueEntry,
  type ThreadTurnQueueLifecycleEvent,
} from "../app-server/thread-turn-queue";

function buildEntry(
  overrides: Partial<Omit<ThreadTurnQueueEntry, "input">> = {},
): Omit<ThreadTurnQueueEntry, "id" | "createdAt"> &
  Partial<Pick<ThreadTurnQueueEntry, "id" | "createdAt">> {
  return {
    id: "entry-1",
    backend: "codex",
    threadId: "thread-1",
    origin: "manual",
    input: [{ type: "text", text: "hello" }],
    createdAt: 1_000,
    ...overrides,
  };
}

describe("ThreadTurnQueue", () => {
  it("starts idle thread submissions immediately", async () => {
    const startedEntries: string[] = [];
    const events: ThreadTurnQueueLifecycleEvent[] = [];
    const queue = new ThreadTurnQueue({
      startTurn: async (entry) => {
        startedEntries.push(entry.id);
        return {
          backend: entry.backend,
          threadId: entry.threadId,
          turnId: `turn-${entry.id}`,
        };
      },
      onLifecycle: (event) => {
        events.push(event);
      },
    });

    await expect(queue.submit(buildEntry())).resolves.toMatchObject({
      status: "started",
      turnId: "turn-entry-1",
    });
    expect(startedEntries).toEqual(["entry-1"]);
    expect(events).toEqual([
      expect.objectContaining({
        type: "started",
        turnId: "turn-entry-1",
      }),
    ]);
  });

  it("queues active-thread submissions and starts them FIFO on release", async () => {
    let active = true;
    const startedEntries: string[] = [];
    const events: ThreadTurnQueueLifecycleEvent[] = [];
    const queue = new ThreadTurnQueue({
      isThreadActive: () => active,
      startTurn: async (entry) => {
        startedEntries.push(entry.id);
        return {
          backend: entry.backend,
          threadId: entry.threadId,
          turnId: `turn-${entry.id}`,
        };
      },
      onLifecycle: (event) => {
        events.push(event);
      },
    });

    await expect(queue.submit(buildEntry({ id: "manual-1", origin: "manual" })))
      .resolves.toMatchObject({
        status: "queued",
        position: 1,
      });
    await expect(
      queue.submit(buildEntry({ id: "automation-1", origin: "automation" })),
    ).resolves.toMatchObject({
      status: "queued",
      position: 2,
    });

    active = false;
    await queue.releaseThread({ backend: "codex", threadId: "thread-1" });
    await queue.releaseThread({
      backend: "codex",
      threadId: "thread-1",
      turnId: "turn-manual-1",
    });

    expect(startedEntries).toEqual(["manual-1", "automation-1"]);
    expect(events.map((event) => event.type)).toEqual([
      "queued",
      "queued",
      "started",
      "terminal",
      "started",
    ]);
  });

  it("guards duplicate terminal release signals", async () => {
    let active = true;
    const startedEntries: string[] = [];
    const queue = new ThreadTurnQueue({
      isThreadActive: () => active,
      startTurn: async (entry) => {
        startedEntries.push(entry.id);
        return {
          backend: entry.backend,
          threadId: entry.threadId,
          turnId: `turn-${entry.id}`,
        };
      },
    });

    await queue.submit(buildEntry({ id: "queued-1" }));

    active = false;
    await Promise.all([
      queue.releaseThread({ backend: "codex", threadId: "thread-1" }),
      queue.releaseThread({ backend: "codex", threadId: "thread-1" }),
    ]);

    expect(startedEntries).toEqual(["queued-1"]);
  });

  it("starts later queued entries when one queued start fails", async () => {
    let active = true;
    const startedEntries: string[] = [];
    const failed = new Error("backend rejected start");
    const queue = new ThreadTurnQueue({
      isThreadActive: () => active,
      startTurn: async (entry) => {
        if (entry.id === "bad-entry") {
          throw failed;
        }
        startedEntries.push(entry.id);
        return {
          backend: entry.backend,
          threadId: entry.threadId,
          turnId: `turn-${entry.id}`,
        };
      },
      onLifecycle: vi.fn(),
    });

    await queue.submit(buildEntry({ id: "bad-entry" }));
    await queue.submit(buildEntry({ id: "good-entry" }));

    active = false;
    await queue.releaseThread({ backend: "codex", threadId: "thread-1" });

    expect(startedEntries).toEqual(["good-entry"]);
  });

  it("cancels pending queue entries by id", async () => {
    const queue = new ThreadTurnQueue({
      isThreadActive: () => true,
      startTurn: async (entry) => ({
        backend: entry.backend,
        threadId: entry.threadId,
        turnId: `turn-${entry.id}`,
      }),
    });

    await queue.submit(buildEntry({ id: "queued-1" }));

    expect(queue.cancelEntry("queued-1", "test cancel")).toMatchObject({
      id: "queued-1",
    });
    expect(queue.getQueuedEntries({ backend: "codex", threadId: "thread-1" }))
      .toEqual([]);
  });
});
