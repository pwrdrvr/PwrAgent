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
