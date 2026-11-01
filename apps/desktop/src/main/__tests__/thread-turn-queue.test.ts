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
  it("keeps a display title on a queued entry until its input changes", async () => {
    const queue = new ThreadTurnQueue({
      isThreadActive: () => true,
      startTurn: async (entry) => ({
        backend: entry.backend,
        threadId: entry.threadId,
        turnId: `turn-${entry.id}`,
      }),
    });
    await queue.submit(buildEntry());

    expect(queue.setQueuedEntryTitle("entry-1", "Greeting")).toMatchObject({ title: "Greeting" });
    expect(queue.getAllQueuedEntries()[0]?.title).toBe("Greeting");
    const updated = queue.updateQueuedEntryInput("entry-1", [{ type: "text", text: "goodbye" }]);
    expect(updated).not.toHaveProperty("title");
    expect(queue.getAllQueuedEntries()[0]).not.toHaveProperty("title");
    expect(queue.setQueuedEntryTitle("missing", "Nothing")).toBeUndefined();
  });

  it("drops a grouped steer's title when another message joins the batch", async () => {
    const queue = new ThreadTurnQueue({
      isThreadActive: () => true,
      startTurn: async (entry) => ({
        backend: entry.backend,
        threadId: entry.threadId,
        turnId: `turn-${entry.id}`,
      }),
    });
    const first = await queue.submitGroupedSteer(buildEntry({ id: "group" }));
    expect(first.status).toBe("queued");
    queue.setQueuedEntryTitle("group", "First report");

    await queue.submitGroupedSteer({
      ...buildEntry({ id: "second" }),
      input: [{ type: "text", text: "second report" }],
    });

    const entries = queue.getAllQueuedEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).not.toHaveProperty("title");
  });

  it("keeps a to-do marker on one grouped message and drops it from a mixed batch", async () => {
    const todoOrigin = {
      kind: "agent" as const,
      sourceThread: { backend: "codex" as const, threadId: "raiser" },
      threadTodo: { id: "todo-1", title: "Refresh the PR" },
    };
    const agentOrigin = {
      kind: "agent" as const,
      sourceThread: { backend: "codex" as const, threadId: "sender" },
    };
    for (const order of [[todoOrigin, agentOrigin], [agentOrigin, todoOrigin]]) {
      const queue = new ThreadTurnQueue({
        isThreadActive: () => true,
        startTurn: async (entry) => ({
          backend: entry.backend,
          threadId: entry.threadId,
          turnId: `turn-${entry.id}`,
        }),
      });
      const [first, second] = order;
      await queue.submitGroupedSteer(buildEntry({ id: "group", messageOrigin: first }));
      const alone = queue.getAllQueuedEntries()[0]!;
      if (first === todoOrigin) expect(alone.messageOrigin?.threadTodo).toEqual(todoOrigin.threadTodo);
      else expect(alone.messageOrigin).not.toHaveProperty("threadTodo");

      await queue.submitGroupedSteer({
        ...buildEntry({ id: "second", messageOrigin: second }),
        input: [{ type: "text", text: "second report" }],
      });

      const batch = queue.getAllQueuedEntries()[0]!;
      // The batch is no one card's prompt; each message keeps its own origin.
      expect(batch.messageOrigin).not.toHaveProperty("threadTodo");
      expect(batch.agentMessages?.map((message) => message.origin)).toEqual(order);
      expect(batch.agentMessageOrigins).toEqual(order);
    }
  });

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

  it("keeps queued submissions after an in-flight start rejects after release", async () => {
    let rejectStart!: (reason?: unknown) => void;
    const starting = new Promise<never>((_resolve, reject) => {
      rejectStart = reject;
    });
    const startedEntries: string[] = [];
    const queue = new ThreadTurnQueue({
      startTurn: async (entry) => {
        if (entry.id === "first") {
          return await starting;
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

    const first = queue.submit(buildEntry({ id: "first" }));
    await Promise.resolve();
    await expect(queue.submit(buildEntry({ id: "second" }))).resolves.toMatchObject({
      status: "queued",
      position: 1,
    });

    await queue.releaseThread({ backend: "codex", threadId: "thread-1" });
    rejectStart(new Error("backend rejected start"));

    await expect(first).rejects.toThrow("backend rejected start");
    await Promise.resolve();
    expect(startedEntries).toEqual([]);
    expect(queue.getQueuedEntries({ backend: "codex", threadId: "thread-1" }))
      .toMatchObject([{ id: "second" }]);
  });

  it("waits for a later release when a failed start leaves the thread active", async () => {
    let active = false;
    let rejectStart!: (reason?: unknown) => void;
    const starting = new Promise<never>((_resolve, reject) => {
      rejectStart = reject;
    });
    const startedEntries: string[] = [];
    const queue = new ThreadTurnQueue({
      isThreadActive: () => active,
      startTurn: async (entry) => {
        if (entry.id === "first") {
          return await starting;
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

    const first = queue.submit(buildEntry({ id: "first" }));
    await Promise.resolve();
    await queue.submit(buildEntry({ id: "second" }));

    active = true;
    rejectStart(new Error("backend rejected start"));

    await expect(first).rejects.toThrow("backend rejected start");
    await Promise.resolve();
    expect(startedEntries).toEqual([]);
    expect(queue.getQueuedEntries({ backend: "codex", threadId: "thread-1" }))
      .toMatchObject([{ id: "second" }]);

    active = false;
    await queue.releaseThread({ backend: "codex", threadId: "thread-1" });
    expect(startedEntries).toEqual(["second"]);
  });

  it("does not apply a coalesced idle release to a successfully started turn", async () => {
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
    await queue.submit(buildEntry({ id: "queued-2" }));

    active = false;
    await Promise.all([
      queue.releaseThread({ backend: "codex", threadId: "thread-1" }),
      queue.releaseThread({ backend: "codex", threadId: "thread-1" }),
    ]);

    expect(startedEntries).toEqual(["queued-1"]);
    expect(queue.getQueuedEntries({ backend: "codex", threadId: "thread-1" }))
      .toMatchObject([{ id: "queued-2" }]);
  });

  it("holds a blocked queued start until an operator releases it", async () => {
    let rejectFirstQueuedStart!: (reason?: unknown) => void;
    let resolveFirstQueuedAttempt!: () => void;
    let resolveRetriedQueuedStart!: () => void;
    const firstQueuedStart = new Promise<never>((_resolve, reject) => {
      rejectFirstQueuedStart = reject;
    });
    const firstQueuedAttempt = new Promise<void>((resolve) => {
      resolveFirstQueuedAttempt = resolve;
    });
    const retriedQueuedStart = new Promise<void>((resolve) => {
      resolveRetriedQueuedStart = resolve;
    });
    const startedEntries: string[] = [];
    let queuedAttempts = 0;
    const queue = new ThreadTurnQueue({
      startTurn: async (entry) => {
        startedEntries.push(entry.id);
        if (entry.id === "queued" && queuedAttempts++ === 0) {
          resolveFirstQueuedAttempt();
          return await firstQueuedStart;
        }
        if (entry.id === "queued") {
          resolveRetriedQueuedStart();
        }
        return {
          backend: entry.backend,
          threadId: entry.threadId,
          turnId: `turn-${entry.id}-${queuedAttempts}`,
        };
      },
    });

    await queue.submit(buildEntry({ id: "running" }));
    await queue.submit(buildEntry({ id: "queued" }));

    const terminalRelease = queue.releaseThread({
      backend: "codex",
      threadId: "thread-1",
      turnId: "turn-running-0",
    });
    await firstQueuedAttempt;
    await queue.releaseThread({ backend: "codex", threadId: "thread-1" });
    rejectFirstQueuedStart(new Error("backend rejected queued start"));

    await terminalRelease;
    expect(startedEntries).toEqual(["running", "queued"]);
    expect(queue.getQueuedEntries({ backend: "codex", threadId: "thread-1" }))
      .toMatchObject([{
        id: "queued",
        manualReleaseRequired: true,
        holdReason: "backend rejected queued start",
      }]);

    await expect(queue.releaseEntryWithDisposition("queued"))
      .resolves.toMatchObject({
        disposition: "started",
        turnId: "turn-queued-2",
      });
    await retriedQueuedStart;
    expect(startedEntries).toEqual(["running", "queued", "queued"]);
    expect(queue.getQueuedEntries({ backend: "codex", threadId: "thread-1" }))
      .toEqual([]);
  });

  it("retains a failed queued entry and retries it before later entries", async () => {
    let active = true;
    let rejectBadEntry = true;
    const startedEntries: string[] = [];
    const events: ThreadTurnQueueLifecycleEvent[] = [];
    const failed = new Error("backend rejected start");
    const queue = new ThreadTurnQueue({
      isThreadActive: () => active,
      startTurn: async (entry) => {
        if (entry.id === "bad-entry" && rejectBadEntry) {
          throw failed;
        }
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

    await queue.submit(buildEntry({ id: "bad-entry" }));
    await queue.submit(buildEntry({ id: "good-entry" }));

    active = false;
    await queue.releaseThread({ backend: "codex", threadId: "thread-1" });

    expect(startedEntries).toEqual([]);
    expect(queue.getQueuedEntries({ backend: "codex", threadId: "thread-1" }))
      .toMatchObject([{ id: "bad-entry" }, { id: "good-entry" }]);
    expect(events.map((event) => event.type)).toEqual([
      "queued",
      "queued",
      "blocked",
      "held",
      "held",
    ]);

    rejectBadEntry = false;
    await queue.releaseThread({ backend: "codex", threadId: "thread-1" });
    expect(startedEntries).toEqual([]);
    await queue.releaseEntryWithDisposition("bad-entry");
    expect(startedEntries).toEqual(["bad-entry"]);
    await queue.releaseThread({
      backend: "codex",
      threadId: "thread-1",
      turnId: "turn-bad-entry",
    });
    expect(startedEntries).toEqual(["bad-entry", "good-entry"]);
  });

  it("holds queued work after a failed running turn until manual release", async () => {
    const startedEntries: string[] = [];
    const queue = new ThreadTurnQueue({
      startTurn: async (entry) => {
        startedEntries.push(entry.id);
        return {
          backend: entry.backend,
          threadId: entry.threadId,
          turnId: `turn-${entry.id}`,
        };
      },
    });

    await queue.submit(buildEntry({ id: "running" }));
    await queue.submit(buildEntry({ id: "queued" }));
    await queue.releaseThread({
      backend: "codex",
      threadId: "thread-1",
      turnId: "turn-running",
      status: "turn/failed",
      errorMessage: "Provider unavailable",
    });

    expect(startedEntries).toEqual(["running"]);
    expect(queue.getQueuedEntries({ backend: "codex", threadId: "thread-1" }))
      .toMatchObject([{
        id: "queued",
        manualReleaseRequired: true,
        holdReason: "Provider unavailable",
      }]);

    await queue.releaseThread({ backend: "codex", threadId: "thread-1" });
    expect(startedEntries).toEqual(["running"]);
    await expect(queue.releaseEntryWithDisposition("queued"))
      .resolves.toMatchObject({ disposition: "started" });
    expect(startedEntries).toEqual(["running", "queued"]);
  });

  it("places stale steering fallbacks at the held queue head", async () => {
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

    await queue.submit(buildEntry({ id: "already-queued" }));
    await queue.submitHeld(
      buildEntry({ id: "stale-steer" }),
      "The steer target ended.",
    );
    expect(queue.getQueuedEntries({ backend: "codex", threadId: "thread-1" }))
      .toMatchObject([
        { id: "stale-steer", manualReleaseRequired: true },
        { id: "already-queued" },
      ]);
    await expect(queue.releaseEntryWithDisposition("already-queued"))
      .resolves.toEqual({
        disposition: "not_head",
        entryId: "already-queued",
      });

    active = false;
    await expect(queue.releaseEntryWithDisposition("stale-steer"))
      .resolves.toMatchObject({ disposition: "started" });
    expect(startedEntries).toEqual(["stale-steer"]);
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


describe("grouped queued steering", () => {
  const target = { backend: "codex" as const, threadId: "thread-1" };
  const senderEntry = (sender: string, text = sender) => ({
    ...buildEntry({ id: sender }),
    input: [{ type: "text" as const, text }],
    messageOrigin: { kind: "agent" as const, sourceThread: {
      backend: "codex" as const, threadId: sender, title: `Title ${sender}`,
      instanceId: `instance-${sender}`, instanceLabel: `Machine ${sender}`,
    } },
  });
  const result = (entry: ThreadTurnQueueEntry) => ({ ...target, turnId: `turn-${entry.id}` });
  const barrier = () => {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    return { promise, release };
  };

  it("groups 20 senders and five later arrivals into one steer at the original position", async () => {
    const edit = barrier();
    const entered = barrier();
    const start = vi.fn(async (entry: ThreadTurnQueueEntry) => result(entry));
    const steer = vi.fn(async (entry: ThreadTurnQueueEntry) => result(entry));
    const queue = new ThreadTurnQueue({
      isThreadActive: () => true, canSteerThread: () => true, startTurn: start, steerTurn: steer,
      now: () => 1_000,
    });
    const suspension = queue.withDispatchSuspended(target, async () => {
      entered.release();
      await edit.promise;
    });
    await entered.promise;
    const sends = Array.from({ length: 20 }, (_, index) => queue.submitGroupedSteer(senderEntry(`sender-${index}`)));
    edit.release();
    await suspension;
    const submissions = await Promise.all(sends);
    const id = submissions[0]!.entry.id;
    expect(new Set(submissions.map((item) => item.entry.id))).toEqual(new Set([id]));
    await Promise.all(Array.from({ length: 5 }, (_, index) => queue.submitGroupedSteer(senderEntry(`late-${index}`))));
    const [batch] = queue.getQueuedEntries(target);
    expect(batch?.id).toBe(id);
    expect(batch?.createdAt).toBe(1_000);
    expect(batch?.agentMessages).toHaveLength(25);
    const text = batch!.input.flatMap((item) => item.type === "text" ? [item.text] : []).join("\n");
    expect(text).toContain("Title sender-0");
    expect(text).toContain("Machine late-4");
    expect(text).toContain("1970-01-01T00:00:01.000Z");
    await vi.waitFor(() => expect(steer).toHaveBeenCalledTimes(1));
    expect(steer.mock.calls[0]![0].agentMessages).toHaveLength(25);
    expect(start).not.toHaveBeenCalled();
    queue.close();
  });

  it("freezes the batch claimed by the backend and groups arrivals in a second steer", async () => {
    const dispatch = barrier();
    const steer = vi.fn(async (entry: ThreadTurnQueueEntry) => {
      if (steer.mock.calls.length === 1) await dispatch.promise;
      return result(entry);
    });
    const queue = new ThreadTurnQueue({
      isThreadActive: () => true, canSteerThread: () => true, startTurn: async (entry) => result(entry), steerTurn: steer,
    });
    await queue.submitGroupedSteer(senderEntry("first"));
    await vi.waitFor(() => expect(steer).toHaveBeenCalledTimes(1));
    const frozen = steer.mock.calls[0]![0];
    await Promise.all(Array.from({ length: 7 }, (_, index) => queue.submitGroupedSteer(senderEntry(`next-${index}`))));
    expect(frozen.agentMessages).toHaveLength(1);
    expect(queue.getQueuedEntries(target)[0]?.agentMessages).toHaveLength(7);
    expect(queue.updateQueuedEntryInput(frozen.id, [])).toBeUndefined();
    expect(queue.cancelEntryWithDisposition(frozen.id).disposition).toBe("already_admitted");
    dispatch.release();
    await vi.waitFor(() => expect(steer).toHaveBeenCalledTimes(2));
    expect(steer.mock.calls[1]![0].agentMessages).toHaveLength(7);
    queue.close();
  });

  it("holds the entire line until an asynchronous head edit and deletions finish", async () => {
    let active = true;
    const start = vi.fn(async (entry: ThreadTurnQueueEntry) => result(entry));
    const queue = new ThreadTurnQueue({ isThreadActive: () => active, startTurn: start });
    await queue.submit(buildEntry({ id: "head" }));
    await queue.submit(buildEntry({ id: "second" }));
    const edit = barrier();
    const entered = barrier();
    const editing = queue.withDispatchSuspended(target, async () => {
      entered.release();
      await edit.promise;
      queue.updateQueuedEntryInput("head", [{ type: "text", text: "Edited head" }]);
      queue.cancelEntry("second");
    });
    await entered.promise;
    active = false;
    await queue.releaseThread(target);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(start).not.toHaveBeenCalled();
    expect(queue.canStartImmediately(target)).toBe(false);
    edit.release();
    await editing;
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    expect(start.mock.calls[0]![0]).toMatchObject({ id: "head", input: [{ type: "text", text: "Edited head" }] });
    queue.close();
  });

  it("keeps dispatch suspended through serialized editors and releases it after an edit rejects", async () => {
    const first = barrier();
    const entered = barrier();
    const second = barrier();
    const order: string[] = [];
    const queue = new ThreadTurnQueue({ startTurn: async (entry) => { order.push("dispatch"); return result(entry); } });
    const editing = queue.withDispatchSuspended(target, async () => { entered.release(); await first.promise; order.push("first"); });
    await entered.promise;
    const nextEdit = queue.withDispatchSuspended(target, async () => { order.push("second"); await second.promise; throw new Error("edit failed"); });
    const failed = expect(nextEdit).rejects.toThrow("edit failed");
    await queue.submit(buildEntry());
    first.release();
    await editing;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(order).toEqual(["first", "second"]);
    second.release();
    await failed;
    await vi.waitFor(() => expect(order).toEqual(["first", "second", "dispatch"]));
    queue.close();
  });

  it("replaces only the sender's contributions and preserves the other sender", async () => {
    const queue = new ThreadTurnQueue({ isThreadActive: () => true, startTurn: async (entry) => result(entry) });
    const first = await queue.submitGroupedSteer(senderEntry("alice", "old"));
    await queue.submitGroupedSteer(senderEntry("bob", "bob evidence"));
    await queue.submitGroupedSteer(senderEntry("alice", "overlapping update"));
    const updated = queue.replaceQueuedAgentInput(first.entry.id, [{ type: "text", text: "consolidated" }], senderEntry("alice").messageOrigin.sourceThread);
    expect(updated?.agentMessages?.map((message) => message.input)).toEqual([
      [{ type: "text", text: "consolidated" }], [{ type: "text", text: "bob evidence" }],
    ]);
    expect(updated?.id).toBe(first.entry.id);
    expect(queue.replaceQueuedAgentInput(first.entry.id, [], { backend: "codex", threadId: "intruder" })).toBeUndefined();
    queue.close();
  });

  it.each(["source", "ambiguous"] as const)("clears stale %s provenance when replacement removes the last attributed contribution", async (kind) => {
    const queue = new ThreadTurnQueue({ isThreadActive: () => true, startTurn: async (entry) => result(entry) });
    const sender = senderEntry("alice");
    const attributed = { ...sender, messageOrigin: { ...sender.messageOrigin,
      ...(kind === "source"
        ? { causalMessagingSource: { ownerId: "profile", requestId: "old-request", surfaceSelector: "old-topic" } }
        : { causalMessagingAmbiguous: true }),
    } };
    const first = await queue.submitGroupedSteer(attributed);
    const updated = queue.replaceQueuedAgentInput(first.entry.id, [{ type: "text", text: "unrelated replacement" }],
      sender.messageOrigin.sourceThread, sender.messageOrigin);
    expect(updated?.agentMessages?.[0]?.origin).toEqual(sender.messageOrigin);
    expect(updated?.messageOrigin?.causalMessagingSource).toBeUndefined();
    expect(updated?.messageOrigin?.causalMessagingAmbiguous).toBeUndefined();
    expect(queue.getQueuedEntries(target)[0]?.messageOrigin).toEqual(updated?.messageOrigin);
    queue.close();
  });

  it("recomputes a replaced batch from the remaining sender's provenance", async () => {
    const queue = new ThreadTurnQueue({ isThreadActive: () => true, startTurn: async (entry) => result(entry) });
    const alice = senderEntry("alice");
    const bob = senderEntry("bob");
    const source = { ownerId: "profile", requestId: "bob-request", surfaceSelector: "bob-topic" };
    const first = await queue.submitGroupedSteer({ ...alice, messageOrigin: { ...alice.messageOrigin,
      causalMessagingSource: { ...source, requestId: "alice-request", surfaceSelector: "alice-topic" } } });
    await queue.submitGroupedSteer({ ...bob, messageOrigin: { ...bob.messageOrigin, causalMessagingSource: source } });
    expect(queue.getQueuedEntries(target)[0]?.messageOrigin?.causalMessagingAmbiguous).toBe(true);
    const updated = queue.replaceQueuedAgentInput(first.entry.id, [{ type: "text", text: "same request as Bob" }],
      alice.messageOrigin.sourceThread, { ...alice.messageOrigin, causalMessagingSource: source });
    expect(updated?.messageOrigin?.causalMessagingSource).toEqual(source);
    expect(updated?.messageOrigin?.causalMessagingAmbiguous).toBeUndefined();
    queue.close();
  });

  it("preserves an operator-edited steer when a new sender arrives", async () => {
    const queue = new ThreadTurnQueue({ isThreadActive: () => true, startTurn: async (entry) => result(entry) });
    const first = await queue.submitGroupedSteer(senderEntry("alice"));
    const edited = [{ type: "text" as const, text: "Operator revision" }];
    queue.updateQueuedEntryInput(first.entry.id, edited);
    await queue.submitGroupedSteer(senderEntry("bob"));
    const entries = queue.getQueuedEntries(target);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ id: first.entry.id, delivery: "queued-steer", input: edited });
    expect(entries[1]?.agentMessages).toHaveLength(1);
    expect(queue.replaceQueuedAgentInput(first.entry.id, [], senderEntry("alice").messageOrigin.sourceThread)).toBeUndefined();
    queue.close();
  });

  it("retries a changed active turn without losing or duplicating the batch", async () => {
    const steer = vi.fn(async (entry: ThreadTurnQueueEntry) => {
      if (steer.mock.calls.length === 1) return "retry" as const;
      return result(entry);
    });
    const start = vi.fn(async (entry: ThreadTurnQueueEntry) => result(entry));
    const queue = new ThreadTurnQueue({ isThreadActive: () => true, canSteerThread: () => true, startTurn: start, steerTurn: steer });
    await queue.submitGroupedSteer(senderEntry("alice"));
    await vi.waitFor(() => expect(steer).toHaveBeenCalledTimes(2));
    expect(steer.mock.calls[1]![0].id).toBe(steer.mock.calls[0]![0].id);
    expect(steer.mock.calls[1]![0].input).toEqual(steer.mock.calls[0]![0].input);
    expect(start).not.toHaveBeenCalled();
    expect(queue.getQueuedEntries(target)).toEqual([]);
    queue.close();
  });

  it("starts one grouped follow-up when the target is idle", async () => {
    const start = vi.fn(async (entry: ThreadTurnQueueEntry) => result(entry));
    const queue = new ThreadTurnQueue({ startTurn: start });
    await Promise.all([queue.submitGroupedSteer(senderEntry("alice")), queue.submitGroupedSteer(senderEntry("bob"))]);
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    expect(start.mock.calls[0]![0].agentMessages).toHaveLength(2);
    queue.close();
  });

  it.each([false, true])("steers exposed guidance when the blocking head is cancelled (edit suspended: %s)", async (suspended) => {
    const steer = vi.fn(async (entry: ThreadTurnQueueEntry) => result(entry));
    const start = vi.fn(async (entry: ThreadTurnQueueEntry) => result(entry));
    const queue = new ThreadTurnQueue({ isThreadActive: () => true, canSteerThread: () => true, startTurn: start, steerTurn: steer });
    try {
      await queue.submit(buildEntry({ id: "operator" }));
      const guidance = await queue.submitGroupedSteer(senderEntry("alice"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(steer).not.toHaveBeenCalled();
      if (suspended) {
        const edit = barrier();
        const entered = barrier();
        const editing = queue.withDispatchSuspended(target, async () => {
          expect(queue.cancelEntry("operator")?.id).toBe("operator");
          entered.release();
          await edit.promise;
        });
        await entered.promise;
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(steer).not.toHaveBeenCalled();
        edit.release();
        await editing;
      } else expect(queue.cancelEntry("operator")?.id).toBe("operator");
      await vi.waitFor(() => expect(steer).toHaveBeenCalledTimes(1));
      expect(steer.mock.calls[0]![0].id).toBe(guidance.entry.id);
      expect(start).not.toHaveBeenCalled();
      expect(queue.getQueuedEntries(target)).toEqual([]);
    } finally {
      queue.close();
    }
  });

  it("does not overtake an operator turn and holds the line on a steer failure", async () => {
    let active = true;
    const steer = vi.fn(async () => { throw new Error("backend disconnected"); });
    const start = vi.fn(async (entry: ThreadTurnQueueEntry) => result(entry));
    const queue = new ThreadTurnQueue({ isThreadActive: () => active, canSteerThread: () => true, startTurn: start, steerTurn: steer });
    await queue.submit(buildEntry({ id: "operator" }));
    await queue.submitGroupedSteer(senderEntry("alice"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(steer).not.toHaveBeenCalled();
    active = false;
    await queue.releaseThread(target);
    expect(start.mock.calls[0]![0].id).toBe("operator");
    active = true;
    await queue.releaseThread({ ...target, turnId: "turn-operator" });
    await vi.waitFor(() => expect(queue.getQueuedEntries(target)[0]?.holdReason).toBe("backend disconnected"));
    await queue.submitGroupedSteer(senderEntry("bob"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(steer).toHaveBeenCalledTimes(1);
    expect(queue.getQueuedEntries(target)[0]?.agentMessages).toHaveLength(2);
    queue.close();
  });
});

describe("operator reply steering", () => {
  const target = { backend: "codex" as const, threadId: "thread-1" };
  const result = (entry: ThreadTurnQueueEntry) => ({ ...target, turnId: `turn-${entry.id}` });
  const reply = (id = "reply") => ({
    ...buildEntry({ id }),
    input: [{ type: "text" as const, text: "use the staging bucket" }],
  });

  it("starts a turn at once on an idle thread", async () => {
    const start = vi.fn(async (entry: ThreadTurnQueueEntry) => result(entry));
    const steer = vi.fn(async (entry: ThreadTurnQueueEntry) => result(entry));
    const queue = new ThreadTurnQueue({ startTurn: start, steerTurn: steer });
    const submitted = await queue.submitSteer(reply());
    expect(submitted).toMatchObject({ status: "started", turnId: "turn-reply" });
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]![0]).toMatchObject({ id: "reply", delivery: "queued-steer" });
    expect(steer).not.toHaveBeenCalled();
    queue.close();
  });

  it("steers into the running turn when it reaches the head", async () => {
    const start = vi.fn(async (entry: ThreadTurnQueueEntry) => result(entry));
    const steer = vi.fn(async (entry: ThreadTurnQueueEntry) => result(entry));
    const queue = new ThreadTurnQueue({
      isThreadActive: () => true, canSteerThread: () => true, startTurn: start, steerTurn: steer,
    });
    const submitted = await queue.submitSteer(reply());
    expect(submitted.status).toBe("queued");
    await vi.waitFor(() => expect(steer).toHaveBeenCalledTimes(1));
    expect(steer.mock.calls[0]![0]).toMatchObject({
      id: "reply",
      input: [{ type: "text", text: "use the staging bucket" }],
    });
    expect(steer.mock.calls[0]![0]).not.toHaveProperty("agentMessages");
    expect(start).not.toHaveBeenCalled();
    expect(queue.getQueuedEntries(target)).toEqual([]);
    queue.close();
  });

  it("waits behind messages queued before it", async () => {
    const steer = vi.fn(async (entry: ThreadTurnQueueEntry) => result(entry));
    const queue = new ThreadTurnQueue({
      isThreadActive: () => true, canSteerThread: () => true,
      startTurn: async (entry) => result(entry), steerTurn: steer,
    });
    await queue.submit(buildEntry({ id: "operator" }));
    await queue.submitSteer(reply());
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(steer).not.toHaveBeenCalled();
    expect(queue.getQueuedEntries(target).map((entry) => entry.id)).toEqual(["operator", "reply"]);
    queue.close();
  });

  it("is never absorbed into an Agent message batch", async () => {
    const queue = new ThreadTurnQueue({
      isThreadActive: () => true, startTurn: async (entry) => result(entry),
    });
    await queue.submitSteer(reply());
    await queue.submitGroupedSteer({
      ...buildEntry({ id: "agent" }),
      input: [{ type: "text", text: "agent report" }],
      messageOrigin: { kind: "agent", sourceThread: { backend: "codex", threadId: "source" } },
    });
    const entries = queue.getQueuedEntries(target);
    expect(entries.map((entry) => entry.id)).toEqual(["reply", "agent"]);
    expect(entries[0]!.input).toEqual([{ type: "text", text: "use the staging bucket" }]);
    expect(entries[0]).not.toHaveProperty("agentMessages");
    queue.close();
  });

  it("starts the next turn when the running one cannot take it", async () => {
    let active = true;
    const start = vi.fn(async (entry: ThreadTurnQueueEntry) => result(entry));
    // The backend found nothing to steer into, as for a turn that ended first.
    const steer = vi.fn(async () => undefined);
    const queue = new ThreadTurnQueue({
      isThreadActive: () => active, canSteerThread: () => active,
      startTurn: start, steerTurn: steer,
    });
    await queue.submitSteer(reply());
    await vi.waitFor(() => expect(steer).toHaveBeenCalledTimes(1));
    expect(queue.getQueuedEntries(target).map((entry) => entry.id)).toEqual(["reply"]);
    active = false;
    await queue.releaseThread(target);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]![0].id).toBe("reply");
    expect(steer).toHaveBeenCalledTimes(1);
    queue.close();
  });

  it("joins a held queue as held, behind its head", async () => {
    const start = vi.fn(async (entry: ThreadTurnQueueEntry) => result(entry));
    const queue = new ThreadTurnQueue({ startTurn: start });
    await queue.submit(buildEntry({ id: "running" }));
    await queue.submit(buildEntry({ id: "queued" }));
    await queue.releaseThread({
      ...target,
      turnId: "turn-running",
      status: "turn/failed",
      errorMessage: "Provider unavailable",
    });
    await queue.submitSteer(reply());
    // A failed turn holds the line until the operator releases it.
    expect(queue.getQueuedEntries(target)).toMatchObject([
      { id: "queued", manualReleaseRequired: true },
      { id: "reply", manualReleaseRequired: true, holdReason: "Provider unavailable" },
    ]);
    expect(start.mock.calls.map(([entry]) => entry.id)).toEqual(["running"]);
    queue.close();
  });
});

describe("ThreadTurnQueue.moveEntry", () => {
  const ids = (queue: ThreadTurnQueue): string[] =>
    queue.getQueuedEntries({ backend: "codex", threadId: "thread-1" }).map((entry) => entry.id);
  const busyQueue = async (
    entryIds: string[],
    options: { isThreadActive?: () => boolean; startTurn?: ConstructorParameters<typeof ThreadTurnQueue>[0]["startTurn"] } = {},
  ): Promise<ThreadTurnQueue> => {
    const queue = new ThreadTurnQueue({
      isThreadActive: options.isThreadActive ?? (() => true),
      startTurn: options.startTurn ?? (async (entry) => ({
        backend: entry.backend,
        threadId: entry.threadId,
        turnId: `turn-${entry.id}`,
      })),
    });
    for (const id of entryIds) await queue.submit(buildEntry({ id }));
    return queue;
  };

  it("moves an entry in front of its anchor, or to the end without one", async () => {
    const queue = await busyQueue(["a", "b", "c", "d"]);

    await expect(queue.moveEntry("d", "a")).resolves.toMatchObject({
      disposition: "moved",
      entryIds: ["d", "a", "b", "c"],
      backend: "codex",
      threadId: "thread-1",
    });
    expect(ids(queue)).toEqual(["d", "a", "b", "c"]);

    await expect(queue.moveEntry("d", "c")).resolves.toMatchObject({ disposition: "moved" });
    expect(ids(queue)).toEqual(["a", "b", "d", "c"]);

    await expect(queue.moveEntry("a")).resolves.toMatchObject({ disposition: "moved" });
    expect(ids(queue)).toEqual(["b", "d", "c", "a"]);
  });

  it("answers unchanged when the entry is already where it was asked to go", async () => {
    const queue = await busyQueue(["a", "b", "c"]);

    await expect(queue.moveEntry("a", "b")).resolves.toMatchObject({ disposition: "unchanged" });
    await expect(queue.moveEntry("c")).resolves.toMatchObject({ disposition: "unchanged" });
    await expect(queue.moveEntry("b", "b")).resolves.toMatchObject({ disposition: "unchanged" });
    expect(ids(queue)).toEqual(["a", "b", "c"]);
  });

  it("refuses an entry or an anchor that has left the queue", async () => {
    const queue = await busyQueue(["a", "b"]);

    await expect(queue.moveEntry("gone", "a")).resolves.toEqual({
      disposition: "not_found",
      entryId: "gone",
    });
    await expect(queue.moveEntry("b", "gone")).resolves.toMatchObject({
      disposition: "anchor_not_found",
      entryIds: ["a", "b"],
    });
    expect(ids(queue)).toEqual(["a", "b"]);
  });

  it("does not move a held entry, so nothing gets around a hold", async () => {
    const queue = await busyQueue(["queued"]);
    await queue.submitHeld(buildEntry({ id: "held" }), "The steer target ended.");
    expect(ids(queue)).toEqual(["held", "queued"]);

    // A hold marks the whole FIFO: every entry waits for Retry.
    await expect(queue.moveEntry("queued", "held")).resolves.toMatchObject({ disposition: "held" });
    await expect(queue.moveEntry("held")).resolves.toMatchObject({ disposition: "held" });
    expect(ids(queue)).toEqual(["held", "queued"]);
  });

  it("starts the new head when the thread is idle by the time the move ends", async () => {
    let active = true;
    const started: string[] = [];
    const queue = await busyQueue(["a", "b", "c"], {
      isThreadActive: () => active,
      startTurn: async (entry) => {
        started.push(entry.id);
        return { backend: entry.backend, threadId: entry.threadId, turnId: `turn-${entry.id}` };
      },
    });
    active = false;

    await queue.moveEntry("c", "a");
    await vi.waitFor(() => expect(started).toEqual(["c"]));
    expect(ids(queue)).toEqual(["a", "b"]);
    queue.close();
  });

  describe("while a move is in transit", () => {
    /** a, b, c queued; the thread goes idle and dispatches a. */
    const afterHeadDispatched = async (): Promise<{ queue: ThreadTurnQueue; started: string[] }> => {
      let active = true;
      const started: string[] = [];
      const queue = await busyQueue(["a", "b", "c"], {
        isThreadActive: () => active,
        startTurn: async (entry) => {
          started.push(entry.id);
          active = true;
          return { backend: entry.backend, threadId: entry.threadId, turnId: `turn-${entry.id}` };
        },
      });
      active = false;
      // Any edit's end drains the idle thread.
      await queue.moveEntry("b", "b");
      await vi.waitFor(() => expect(started).toEqual(["a"]));
      return { queue, started };
    };

    it("answers anchor_not_found with the current order when the anchor dispatched first", async () => {
      const { queue, started } = await afterHeadDispatched();

      // The viewer dropped c in front of a, which started before the move landed.
      await expect(queue.moveEntry("c", "a")).resolves.toMatchObject({
        disposition: "anchor_not_found",
        entryIds: ["b", "c"],
      });
      expect(ids(queue)).toEqual(["b", "c"]);
      // Re-aimed at the next entry still queued, the move lands.
      await expect(queue.moveEntry("c", "b")).resolves.toMatchObject({
        disposition: "moved",
        entryIds: ["c", "b"],
      });
      expect(started).toEqual(["a"]);
      queue.close();
    });

    it("answers not_found when the moved entry itself dispatched first", async () => {
      const { queue } = await afterHeadDispatched();

      await expect(queue.moveEntry("a", "c")).resolves.toEqual({ disposition: "not_found", entryId: "a" });
      expect(ids(queue)).toEqual(["b", "c"]);
      queue.close();
    });

    it("waits for an edit in progress, then answers for the queue as that edit left it", async () => {
      const queue = await busyQueue(["a", "b", "c"]);
      let finishEdit!: () => void;
      const edit = queue.withDispatchSuspended(
        { backend: "codex", threadId: "thread-1" },
        async () => await new Promise<void>((resolve) => { finishEdit = resolve; }),
      );
      await vi.waitFor(() => expect(finishEdit).toBeTypeOf("function"));
      const cancelledMove = queue.moveEntry("c", "a");
      const anchorLostMove = queue.moveEntry("b", "a");
      // Another window cancels c, then a, while the edit holds the queue.
      queue.cancelEntryWithDisposition("c");
      queue.cancelEntryWithDisposition("a");
      finishEdit();
      await edit;

      await expect(cancelledMove).resolves.toEqual({ disposition: "not_found", entryId: "c" });
      await expect(anchorLostMove).resolves.toMatchObject({ disposition: "anchor_not_found", entryIds: ["b"] });
      expect(ids(queue)).toEqual(["b"]);
    });

    it("runs moves in the order they arrived", async () => {
      const queue = await busyQueue(["a", "b", "c"]);

      const first = queue.moveEntry("c", "a");
      const second = queue.moveEntry("a");
      await expect(first).resolves.toMatchObject({ disposition: "moved", entryIds: ["c", "a", "b"] });
      await expect(second).resolves.toMatchObject({ disposition: "moved", entryIds: ["c", "b", "a"] });
    });
  });
});

describe("ThreadTurnQueue.setEntryPaused", () => {
  const thread = { backend: "codex" as const, threadId: "thread-1" };
  const ids = (queue: ThreadTurnQueue): string[] =>
    queue.getQueuedEntries(thread).map((entry) => entry.id);
  const pausedIds = (queue: ThreadTurnQueue): string[] =>
    queue.getQueuedEntries(thread).filter((entry) => entry.paused).map((entry) => entry.id);
  /** A queue whose thread is busy until `state.active` turns false. */
  const busyQueue = async (
    entryIds: string[],
    startTurn?: ConstructorParameters<typeof ThreadTurnQueue>[0]["startTurn"],
  ): Promise<{ queue: ThreadTurnQueue; started: string[]; state: { active: boolean } }> => {
    const state = { active: true };
    const started: string[] = [];
    const queue = new ThreadTurnQueue({
      isThreadActive: () => state.active,
      startTurn: startTurn ?? (async (entry) => {
        started.push(entry.id);
        return { backend: entry.backend, threadId: entry.threadId, turnId: `turn-${entry.id}` };
      }),
    });
    for (const id of entryIds) await queue.submit(buildEntry({ id }));
    return { queue, started, state };
  };

  it("passes over a paused entry when the turn ends and keeps it in place", async () => {
    const { queue, started, state } = await busyQueue(["a", "b", "c"]);

    await expect(queue.setEntryPaused("a", true)).resolves.toMatchObject({
      disposition: "updated",
      entry: { id: "a", paused: true },
    });
    state.active = false;
    await queue.releaseThread(thread);

    expect(started).toEqual(["b"]);
    expect(ids(queue)).toEqual(["a", "c"]);
    expect(pausedIds(queue)).toEqual(["a"]);
    queue.close();
  });

  it("starts a new message at once when everything queued is paused", async () => {
    const { queue, started, state } = await busyQueue(["a"]);
    await queue.setEntryPaused("a", true);
    state.active = false;

    await expect(queue.submit(buildEntry({ id: "b" }))).resolves.toMatchObject({ status: "started" });
    expect(started).toEqual(["b"]);
    expect(ids(queue)).toEqual(["a"]);
    queue.close();
  });

  it("starts a resumed entry when the thread is idle", async () => {
    const { queue, started, state } = await busyQueue(["a"]);
    await queue.setEntryPaused("a", true);
    state.active = false;
    await queue.releaseThread(thread);
    expect(started).toEqual([]);

    await expect(queue.setEntryPaused("a", false)).resolves.toMatchObject({
      disposition: "updated",
      entry: { id: "a" },
    });
    await vi.waitFor(() => expect(started).toEqual(["a"]));
    expect(ids(queue)).toEqual([]);
    queue.close();
  });

  it("answers unchanged and not_found without touching the queue", async () => {
    const { queue } = await busyQueue(["a"]);

    await expect(queue.setEntryPaused("a", false)).resolves.toMatchObject({ disposition: "unchanged" });
    await queue.setEntryPaused("a", true);
    await expect(queue.setEntryPaused("a", true)).resolves.toMatchObject({ disposition: "unchanged" });
    await expect(queue.setEntryPaused("gone", true)).resolves.toEqual({
      disposition: "not_found",
      entryId: "gone",
    });
    expect(pausedIds(queue)).toEqual(["a"]);
  });

  it("does not pause a held entry, but a paused entry a hold reached still resumes", async () => {
    const { queue } = await busyQueue(["queued"]);
    await queue.setEntryPaused("queued", true);
    await queue.submitHeld(buildEntry({ id: "held" }), "The steer target ended.");

    await expect(queue.setEntryPaused("held", true)).resolves.toMatchObject({ disposition: "held" });
    await expect(queue.setEntryPaused("queued", false)).resolves.toMatchObject({ disposition: "updated" });
    expect(pausedIds(queue)).toEqual([]);
  });

  it("keeps an entry that could not start behind the paused ones, and Retry answers it", async () => {
    let fail = true;
    const started: string[] = [];
    const { queue, state } = await busyQueue(["a", "b"], async (entry) => {
      if (fail) throw new Error("backend unavailable");
      started.push(entry.id);
      return { backend: entry.backend, threadId: entry.threadId, turnId: `turn-${entry.id}` };
    });
    await queue.setEntryPaused("a", true);
    state.active = false;
    await queue.releaseThread(thread);

    expect(ids(queue)).toEqual(["a", "b"]);
    expect(queue.getQueuedEntries(thread).every((entry) => entry.manualReleaseRequired)).toBe(true);
    await expect(queue.releaseEntryWithDisposition("a")).resolves.toMatchObject({ disposition: "not_head" });

    fail = false;
    await expect(queue.releaseEntryWithDisposition("b")).resolves.toMatchObject({ disposition: "started" });
    expect(started).toEqual(["b"]);
    expect(ids(queue)).toEqual(["a"]);
    queue.close();
  });

  it("counts each pause change on the entry", async () => {
    const { queue } = await busyQueue(["a"]);

    await expect(queue.setEntryPaused("a", true)).resolves.toMatchObject({ entry: { paused: true, pauseRevision: 1 } });
    await queue.setEntryPaused("a", true);
    await expect(queue.setEntryPaused("a", false)).resolves.toMatchObject({ entry: { pauseRevision: 2 } });
    expect(queue.getQueuedEntries(thread)[0]).not.toHaveProperty("paused");
  });

  it("puts an entry that could not start back in its own place when one ahead resumed meanwhile", async () => {
    let failStart!: (error: Error) => void;
    const { queue, state } = await busyQueue(["a", "b", "c"], async () =>
      await new Promise((_resolve, reject) => { failStart = reject; }));
    await queue.setEntryPaused("a", true);
    state.active = false;
    const release = queue.releaseThread(thread);
    await vi.waitFor(() => expect(failStart).toBeTypeOf("function"));
    expect(ids(queue)).toEqual(["a", "c"]);

    // The operator resumes a while b's start is in flight, then b fails.
    await queue.setEntryPaused("a", false);
    failStart(new Error("backend unavailable"));
    await release;

    expect(ids(queue)).toEqual(["a", "b", "c"]);
    queue.close();
  });

  it("starts a new grouped steer beside a paused batch instead of joining it", async () => {
    const queue = new ThreadTurnQueue({
      isThreadActive: () => true,
      startTurn: async (entry) => ({ backend: entry.backend, threadId: entry.threadId, turnId: `turn-${entry.id}` }),
    });
    await queue.submitGroupedSteer(buildEntry({ id: "first" }));
    await queue.setEntryPaused("first", true);

    await queue.submitGroupedSteer(buildEntry({ id: "second" }));

    expect(ids(queue)).toEqual(["first", "second"]);
    expect(queue.getQueuedEntries(thread)[0]?.agentMessages).toHaveLength(1);
  });
});
