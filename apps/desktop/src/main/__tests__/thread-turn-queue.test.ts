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

  it("rejects an immediate-only submission without placing it on the queue", async () => {
    const events: ThreadTurnQueueLifecycleEvent[] = [];
    const queue = new ThreadTurnQueue({
      isThreadActive: () => true,
      startTurn: async (entry) => ({
        backend: entry.backend,
        threadId: entry.threadId,
        turnId: `turn-${entry.id}`,
      }),
      onLifecycle: (event) => {
        events.push(event);
      },
    });

    await expect(queue.submitIfIdle(buildEntry({ origin: "automation" })))
      .resolves.toEqual({ status: "busy" });
    expect(queue.getQueuedEntries({ backend: "codex", threadId: "thread-1" }))
      .toEqual([]);
    expect(events).toEqual([]);
  });

  it("claims the starting slot before another submission can race it", async () => {
    let releaseStart!: () => void;
    const starting = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const queue = new ThreadTurnQueue({
      startTurn: async (entry) => {
        await starting;
        return {
          backend: entry.backend,
          threadId: entry.threadId,
          turnId: `turn-${entry.id}`,
        };
      },
    });

    const automatic = queue.submitIfIdle(buildEntry({
      id: "automatic",
      origin: "automation",
    }));
    const manual = await queue.submit(buildEntry({ id: "manual" }));
    expect(manual).toMatchObject({ status: "queued", position: 1 });

    releaseStart();
    await expect(automatic).resolves.toMatchObject({
      status: "started",
      turnId: "turn-automatic",
    });
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

    expect(
      queue.cancelEntryWithDisposition("queued-1", "test cancel"),
    ).toMatchObject({
      disposition: "cancelled",
      entry: { id: "queued-1" },
    });
    expect(queue.getQueuedEntries({ backend: "codex", threadId: "thread-1" }))
      .toEqual([]);
    expect(queue.cancelEntryWithDisposition("missing")).toEqual({
      disposition: "not_found",
    });
  });

  it("recognizes a queue entry that was already admitted", async () => {
    const queue = new ThreadTurnQueue({
      startTurn: async (entry) => ({
        backend: entry.backend,
        threadId: entry.threadId,
        turnId: `turn-${entry.id}`,
      }),
    });

    await queue.submit(buildEntry({ id: "admitted-1" }));

    expect(queue.cancelEntryWithDisposition("admitted-1")).toMatchObject({
      disposition: "already_admitted",
      entryId: "admitted-1",
      turnId: "turn-admitted-1",
    });

    await queue.releaseThread({
      backend: "codex",
      threadId: "thread-1",
      turnId: "turn-admitted-1",
    });
    expect(queue.cancelEntryWithDisposition("admitted-1")).toMatchObject({
      disposition: "already_admitted",
      turnId: "turn-admitted-1",
    });
  });

  it("reports an admission without a turn id while backend startup is pending", async () => {
    let rejectStart!: (reason?: unknown) => void;
    const starting = new Promise<never>((_resolve, reject) => {
      rejectStart = reject;
    });
    const events: ThreadTurnQueueLifecycleEvent[] = [];
    const queue = new ThreadTurnQueue({
      startTurn: () => starting,
      onLifecycle: (event) => {
        events.push(event);
      },
    });

    const submission = queue.submit(buildEntry({ id: "starting-1" }));
    await Promise.resolve();

    expect(queue.cancelEntryWithDisposition("starting-1")).toEqual({
      disposition: "already_admitted",
      entryId: "starting-1",
    });

    rejectStart(new Error("backend startup failed"));
    await expect(submission).rejects.toThrow("backend startup failed");
    expect(events).toEqual([
      expect.objectContaining({
        type: "failed",
        entry: expect.objectContaining({ id: "starting-1" }),
      }),
    ]);
    expect(queue.cancelEntryWithDisposition("starting-1")).toEqual({
      disposition: "not_found",
    });
  });
});
