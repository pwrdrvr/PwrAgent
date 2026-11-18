import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import type { AppServerNotification, AppServerPendingRequestNotification } from "@pwragent/shared";
import type { CodexAppServerClient } from "../codex-app-server/desktop-client";
import type { CodexExecutableIdentity } from "../codex-app-server/executable-identity";
import {
  createCodexAppServerGenerationPool,
  type CodexAppServerGenerationPoolOptions,
} from "../codex-app-server/app-server-generation-pool";

/**
 * One app server process per generation. It runs from whatever is installed
 * when it starts, and keeps that identity after the installation changes.
 */
type FakeGeneration = ReturnType<typeof fakeGeneration>;

function fakeGeneration(
  id: number,
  installed: () => CodexExecutableIdentity,
  startFailure?: Error,
  handshake?: Promise<void>,
) {
  // A process runs from what was installed when it launched.
  let launchedFrom = installed();
  const launch = () => {
    if (!state.initialized) launchedFrom = installed();
    state.initialized = true;
  };
  const notifications = new Set<(event: AppServerNotification) => void>();
  const requests = new Set<(event: AppServerPendingRequestNotification) => Promise<unknown>>();
  const exits = new Set<() => void>();
  const running = new Map<string, string>();
  const loaded = new Set<string>();
  const calls: Array<{ method: string; threadId?: string }> = [];
  const released: string[] = [];
  const state = { initialized: false, closed: false, retired: false, retireAttempts: 0 };
  let threadCounter = 0;
  const call = (method: string, threadId?: string) => {
    if (state.retired) throw new Error(`generation ${id} was asked to ${method} after it retired`);
    calls.push({ method, ...(threadId ? { threadId } : {}) });
    if (threadId) loaded.add(threadId);
  };
  const raw = {
    getInitializeResult: vi.fn(async () => {
      if (state.retired) throw new Error("codex app server generation retired");
      await handshake;
      if (state.closed) throw new Error("codex app server client closed");
      if (startFailure) throw startFailure;
      launch();
      return { userAgent: `codex_cli_rs/${launchedFrom.version} (fixture)` };
    }),
    readAppServerExecutable: () => state.initialized && !state.closed ? launchedFrom : undefined,
    threadDependsOnAppServer: (threadId: string) => running.has(threadId),
    releaseThread: vi.fn(async (threadId: string) => {
      if (running.has(threadId)) return false;
      released.push(threadId);
      return loaded.delete(threadId);
    }),
    retireAppServerWhenIdle: vi.fn(async (params: {
      isThreadBusy: (threadId: string) => boolean;
      blocker?: () => string | undefined;
    }) => {
      state.retireAttempts += 1;
      if (state.retired) return { kind: "retired" as const };
      const blocker = params.blocker?.();
      if (blocker) return { kind: "busy" as const, blocker };
      if (running.size > 0) return { kind: "busy" as const, blocker: "running-turn" };
      for (const threadId of loaded) {
        if (params.isThreadBusy(threadId)) return { kind: "busy" as const, blocker: "registry-work" };
      }
      state.retired = true;
      state.closed = true;
      return { kind: "retired" as const };
    }),
    close: vi.fn(async () => {
      state.closed = true;
      state.initialized = false;
      running.clear();
      loaded.clear();
    }),
    startThread: vi.fn(async () => {
      call("startThread");
      launch();
      const threadId = `g${id}-thread-${++threadCounter}`;
      loaded.add(threadId);
      return { threadId };
    }),
    forkThread: vi.fn(async (params: { threadId: string }) => {
      call("forkThread", params.threadId);
      const threadId = `g${id}-fork-${++threadCounter}`;
      loaded.add(threadId);
      return { threadId };
    }),
    startTurn: vi.fn(async (params: { threadId: string }) => {
      call("startTurn", params.threadId);
      launch();
      const turnId = `g${id}-turn-${++threadCounter}`;
      running.set(params.threadId, turnId);
      return { threadId: params.threadId, turnId };
    }),
    steerTurn: vi.fn(async (params: { threadId: string }) => {
      call("steerTurn", params.threadId);
      return { threadId: params.threadId, turnId: running.get(params.threadId) ?? "none" };
    }),
    interruptTurn: vi.fn(async (params: { threadId: string; turnId: string }) => {
      call("interruptTurn", params.threadId);
      return params;
    }),
    readThread: vi.fn(async (params: { threadId: string }) => {
      call("readThread", params.threadId);
      return { entries: [] };
    }),
    listThreads: vi.fn(async () => {
      call("listThreads");
      return [];
    }),
    unsubscribeIdleThreads: vi.fn(async () => [] as string[]),
    getSubscribedThreadCount: () => loaded.size,
    resetAppServerRestarts: vi.fn(),
    modelProviderForThread: () => undefined,
    onNotification: (listener: (event: AppServerNotification) => void) => {
      notifications.add(listener);
      return () => notifications.delete(listener);
    },
    onRequest: (listener: (event: AppServerPendingRequestNotification) => Promise<unknown>) => {
      requests.add(listener);
      return () => requests.delete(listener);
    },
    onAppServerUnexpectedExit: (listener: () => void) => {
      exits.add(listener);
      return () => exits.delete(listener);
    },
  };
  return {
    id,
    raw,
    client: raw as unknown as CodexAppServerClient,
    get launchedFrom() { return launchedFrom; },
    state,
    running,
    loaded,
    calls,
    released,
    emit(method: string, params: Record<string, unknown>) {
      for (const listener of notifications) listener({ method, params } as unknown as AppServerNotification);
    },
    async request(params: Record<string, unknown>) {
      const results = [];
      for (const listener of requests) {
        results.push(await listener({ method: "item/commandExecution/requestApproval", params } as unknown as AppServerPendingRequestNotification));
      }
      return results;
    },
    completeTurn(threadId: string) {
      const turnId = running.get(threadId);
      running.delete(threadId);
      this.emit("turn/completed", { threadId, turn: { id: turnId, status: "completed" } });
    },
    /** As the client does: exit listeners first, then a failure per turn that died. */
    exit() {
      state.closed = true;
      state.initialized = false;
      const died = [...running];
      running.clear();
      for (const listener of exits) listener();
      for (const [threadId, turnId] of died) {
        this.emit("turn/failed", { threadId, turn: { id: turnId, status: "failed" } });
      }
    },
  };
}

const HOMEBREW = "/opt/homebrew/bin/codex";
const install = (version: string, ino: number): CodexExecutableIdentity => ({
  command: HOMEBREW,
  realPath: `/opt/homebrew/Caskroom/codex/${version}/codex`,
  ino,
  version,
});

function poolFixture(overrides: Partial<CodexAppServerGenerationPoolOptions> = {}) {
  const generations: FakeGeneration[] = [];
  const pinned = new Set<string>();
  const busy = new Set<string>();
  const promotions: number[] = [];
  const launchFailures: Error[] = [];
  const handshakes: Array<Promise<void>> = [];
  let installed = install("0.160.0", 1);
  const pool = createCodexAppServerGenerationPool(() => {
    const generation = fakeGeneration(generations.length + 1, () => installed, launchFailures.shift(), handshakes.shift());
    generations.push(generation);
    return generation.client;
  }, {
    isThreadBusy: (threadId) => busy.has(threadId) || pinned.has(threadId),
    isThreadPinned: (threadId) => pinned.has(threadId),
    readExecutable: async (launched) =>
      launched.command === installed.command ? installed : { command: launched.command },
    onGenerationPromoted: (event) => promotions.push(event.generation),
    checkIntervalMs: 0,
    minCheckIntervalMs: 0,
    retireSettleMs: 10,
    retireRetryMs: 1_000,
    failureBackoffMs: { initial: 30_000, max: 120_000 },
    ...overrides,
  });
  const delivered: Array<{ method: string; threadId?: string }> = [];
  pool.onNotification((event) => {
    const params = event.params as { threadId?: string };
    delivered.push({ method: event.method, ...(params?.threadId ? { threadId: params.threadId } : {}) });
  });
  const exits: Array<ReadonlySet<string> | undefined> = [];
  pool.onAppServerUnexpectedExit((threadIds) => exits.push(threadIds));
  return {
    pool,
    generations,
    pinned,
    busy,
    promotions,
    delivered,
    exits,
    launchFailures,
    handshakes,
    upgrade(version: string) {
      installed = install(version, installed.ino! + 1);
    },
    gen(id: number) {
      return generations[id - 1]!;
    },
    live() {
      return generations.filter((generation) => !generation.state.closed);
    },
  };
}

async function settle(ms = 50): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

describe("Codex app server generations", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts and validates a new generation from the upgraded installation, then routes new threads to it", async () => {
    const fixture = poolFixture();
    const first = await fixture.pool.startThread({});
    expect(first.threadId).toBe("g1-thread-1");

    fixture.upgrade("0.161.0");
    const second = await fixture.pool.startThread({});

    expect(fixture.generations).toHaveLength(2);
    // The handshake finished before the generation took any work.
    expect(fixture.gen(2).raw.getInitializeResult.mock.invocationCallOrder[0])
      .toBeLessThan(fixture.gen(2).raw.startThread.mock.invocationCallOrder[0]!);
    expect(fixture.gen(2).launchedFrom.version).toBe("0.161.0");
    expect(second.threadId).toBe("g2-thread-1");
    expect(fixture.promotions).toEqual([2]);
    expect(fixture.pool.readAppServerGenerationStatus()).toEqual(expect.objectContaining({
      current: 2,
      lastRollover: expect.objectContaining({ generation: 2, reason: "executable-moved" }),
    }));
    // Nothing was running on the old process: it retires at once.
    await settle();
    expect(fixture.gen(1).state.retired).toBe(true);
    expect(fixture.live().map((generation) => generation.id)).toEqual([2]);
  });

  it("lets a running turn drain on the old generation, then resumes the thread on the new one", async () => {
    const fixture = poolFixture();
    const { threadId } = await fixture.pool.startThread({});
    await fixture.pool.startTurn({ threadId, input: [] });
    fixture.upgrade("0.161.0");
    await fixture.pool.checkAppServerInstallation();
    await settle(5_000);

    // The turn keeps its process: steering, interrupting and its events stay there.
    await fixture.pool.steerTurn({ threadId, input: [], expectedTurnId: "g1-turn-2" } as never);
    await fixture.pool.interruptTurn({ threadId, turnId: "g1-turn-2" });
    expect(fixture.gen(1).calls.filter((entry) => entry.threadId === threadId).map((entry) => entry.method))
      .toEqual(["startTurn", "steerTurn", "interruptTurn"]);
    expect(fixture.gen(2).calls).toEqual([]);
    expect(fixture.gen(1).state.retired).toBe(false);

    fixture.gen(1).emit("item/agentMessage/delta", { threadId, delta: "still running" });
    fixture.gen(1).completeTurn(threadId);
    expect(fixture.delivered.filter((entry) => entry.threadId === threadId).map((entry) => entry.method))
      .toEqual(["item/agentMessage/delta", "turn/completed"]);

    await settle();
    expect(fixture.gen(1).state.retired).toBe(true);
    // The next turn resumes the same thread on the current generation.
    await fixture.pool.startTurn({ threadId, input: [] });
    expect(fixture.gen(2).calls).toEqual([{ method: "startTurn", threadId }]);
  });

  it("moves an idle thread on its next turn and stops delivering the old process's events for it", async () => {
    const fixture = poolFixture();
    const idle = (await fixture.pool.startThread({})).threadId;
    const busy = (await fixture.pool.startThread({})).threadId;
    await fixture.pool.startTurn({ threadId: busy, input: [] });
    fixture.upgrade("0.161.0");
    await fixture.pool.checkAppServerInstallation();

    await fixture.pool.startTurn({ threadId: idle, input: [] });

    expect(fixture.gen(2).calls).toEqual([{ method: "startTurn", threadId: idle }]);
    expect(fixture.gen(1).released).toEqual([idle]);
    // The old process no longer speaks for it; only the owner does.
    fixture.gen(1).emit("thread/closed", { threadId: idle });
    fixture.gen(2).emit("turn/started", { threadId: idle, turn: { id: "g2-turn-1" } });
    expect(fixture.delivered.filter((entry) => entry.threadId === idle).map((entry) => entry.method))
      .toEqual(["turn/started"]);
    // The busy thread still pins the old generation.
    await settle(5_000);
    expect(fixture.gen(1).state.retired).toBe(false);
  });

  it("keeps a thread with process-bound owner work on the old process, but not one with only queued input", async () => {
    const fixture = poolFixture();
    const terminal = (await fixture.pool.startThread({})).threadId;
    const queued = (await fixture.pool.startThread({})).threadId;
    fixture.pinned.add(terminal);
    fixture.busy.add(queued);
    fixture.upgrade("0.161.0");
    await fixture.pool.checkAppServerInstallation();

    await fixture.pool.readThread({ threadId: terminal });
    await fixture.pool.startTurn({ threadId: queued, input: [] });
    expect(fixture.gen(1).calls.at(-1)).toEqual({ method: "readThread", threadId: terminal });
    expect(fixture.gen(2).calls).toEqual([{ method: "startTurn", threadId: queued }]);

    await settle(5_000);
    expect(fixture.gen(1).state.retired).toBe(false);
    fixture.pinned.delete(terminal);
    await settle(5_000);
    expect(fixture.gen(1).state.retired).toBe(true);
  });

  it("does not retire while a call into the old process is still in flight", async () => {
    const fixture = poolFixture();
    const { threadId } = await fixture.pool.startThread({});
    let finish!: () => void;
    fixture.gen(1).raw.readThread.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { finish = resolve; });
      return { entries: [] };
    });
    const read = fixture.pool.readThread({ threadId });
    fixture.upgrade("0.161.0");
    await fixture.pool.checkAppServerInstallation();
    await settle(5_000);
    expect(fixture.gen(1).state.retired).toBe(false);
    finish();
    await read;
    await settle();
    expect(fixture.gen(1).state.retired).toBe(true);
  });

  it("keeps the running generation in service when the new one cannot start, and retries later", async () => {
    const fixture = poolFixture();
    await fixture.pool.startThread({});
    fixture.upgrade("0.161.0");
    fixture.launchFailures.push(new Error("codex app server stdio pipes unavailable"));

    const during = await fixture.pool.startThread({});
    expect(during.threadId).toBe("g1-thread-2");
    expect(fixture.gen(2).state.closed).toBe(true);
    expect(fixture.pool.readAppServerGenerationStatus()).toEqual(expect.objectContaining({
      current: 1,
      lastFailure: expect.objectContaining({ reason: "executable-moved" }),
    }));
    // Inside the backoff, new work does not relaunch.
    await fixture.pool.startThread({});
    expect(fixture.generations).toHaveLength(2);

    await settle(30_000);
    const after = await fixture.pool.startThread({});
    expect(fixture.generations).toHaveLength(3);
    expect(after.threadId).toBe("g3-thread-1");
    expect(fixture.live().map((generation) => generation.id)).toEqual([3]);
  });

  it("starts one generation for concurrent new threads during a rollover", async () => {
    const fixture = poolFixture();
    await fixture.pool.startThread({});
    fixture.upgrade("0.161.0");
    const started = await Promise.all([1, 2, 3].map(() => fixture.pool.startThread({})));
    expect(fixture.generations).toHaveLength(2);
    expect(started.map((result) => result.threadId).sort())
      .toEqual(["g2-thread-1", "g2-thread-2", "g2-thread-3"]);
  });

  it("drains repeated upgrades independently", async () => {
    const fixture = poolFixture();
    const onFirst = (await fixture.pool.startThread({})).threadId;
    await fixture.pool.startTurn({ threadId: onFirst, input: [] });
    fixture.upgrade("0.161.0");
    const onSecond = (await fixture.pool.startThread({})).threadId;
    await fixture.pool.startTurn({ threadId: onSecond, input: [] });
    fixture.upgrade("0.162.0");
    const onThird = (await fixture.pool.startThread({})).threadId;

    expect([onFirst, onSecond, onThird]).toEqual(["g1-thread-1", "g2-thread-1", "g3-thread-1"]);
    fixture.gen(2).completeTurn(onSecond);
    await settle(5_000);
    expect(fixture.gen(2).state.retired).toBe(true);
    expect(fixture.gen(1).state.retired).toBe(false);
    fixture.gen(1).completeTurn(onFirst);
    await settle(5_000);
    expect(fixture.live().map((generation) => generation.id)).toEqual([3]);
  });

  it("scopes an old generation's crash to its own threads and does not restart it", async () => {
    const fixture = poolFixture();
    const old = (await fixture.pool.startThread({})).threadId;
    await fixture.pool.startTurn({ threadId: old, input: [] });
    fixture.upgrade("0.161.0");
    const fresh = (await fixture.pool.startThread({})).threadId;

    fixture.gen(1).exit();

    expect(fixture.exits).toEqual([new Set([old])]);
    // The turn that died with it is reported, so nothing shows it running.
    expect(fixture.delivered.filter((entry) => entry.threadId === old).map((entry) => entry.method))
      .toEqual(["turn/failed"]);
    await fixture.pool.startTurn({ threadId: old, input: [] });
    expect(fixture.gen(2).calls.map((entry) => entry.threadId)).toEqual([undefined, old]);
    expect(fresh).toBe("g2-thread-1");
    // Fan-out never reaches the dead client, which would start it again.
    await fixture.pool.unsubscribeIdleThreads({ idleMs: 0, isThreadBusy: () => false });
    expect(fixture.gen(1).raw.unsubscribeIdleThreads).not.toHaveBeenCalled();
    await settle(1_000);
    expect(fixture.gen(1).raw.close).toHaveBeenCalled();
    expect(fixture.pool.readAppServerGenerationStatus().draining).toEqual([]);
  });

  it("namespaces approval request IDs from later generations", async () => {
    const fixture = poolFixture();
    const seen: string[] = [];
    fixture.pool.onRequest(async (request) => {
      seen.push(String((request.params as { requestId?: string }).requestId));
      return { decision: "accept" };
    });
    const first = (await fixture.pool.startThread({})).threadId;
    // A turn keeps the first generation draining, so it still speaks.
    await fixture.pool.startTurn({ threadId: first, input: [] });
    fixture.upgrade("0.161.0");
    const { threadId } = await fixture.pool.startThread({});
    await fixture.gen(2).request({ threadId, requestId: "0" });
    expect(seen).toEqual(["g2:0"]);
    // Its resolution must name the same ID, or the pending entry never clears.
    const resolutions: unknown[] = [];
    fixture.pool.onNotification((event) => {
      if (event.method === "serverRequest/resolved") resolutions.push((event.params as { requestId?: unknown }).requestId);
    });
    fixture.gen(2).emit("serverRequest/resolved", { threadId, requestId: "0" });
    fixture.gen(1).emit("serverRequest/resolved", { threadId: "g1-thread-1", requestId: "0" });
    expect(resolutions).toEqual(["g2:0", "0"]);
  });

  it("does not replace a process with one running the very same file", async () => {
    let misread = false;
    const fixture = poolFixture({
      readExecutable: async (launched) => misread ? { command: launched.command } : launched,
    });
    await fixture.pool.startThread({});
    // A transient stat failure looks like a deleted executable.
    misread = true;
    const during = await fixture.pool.startThread({});
    expect(fixture.generations).toHaveLength(2);
    expect(fixture.gen(2).state.closed).toBe(true);
    expect(during.threadId).toBe("g1-thread-2");
    expect(fixture.promotions).toEqual([]);
    expect(fixture.pool.readAppServerGenerationStatus()).toEqual(expect.objectContaining({
      current: 1,
      lastFailure: expect.objectContaining({ reason: "executable-missing" }),
    }));
    // The backoff keeps a persistent misread from launching on every call.
    await fixture.pool.startThread({});
    expect(fixture.generations).toHaveLength(2);
  });

  it("closes replaced generations and abandons a rollover still starting", async () => {
    const fixture = poolFixture();
    const old = (await fixture.pool.startThread({})).threadId;
    await fixture.pool.startTurn({ threadId: old, input: [] });
    fixture.upgrade("0.161.0");
    await fixture.pool.checkAppServerInstallation();
    let release!: () => void;
    // Hold the third generation's handshake open across close().
    fixture.handshakes.push(new Promise<void>((resolve) => { release = resolve; }));
    fixture.upgrade("0.162.0");
    const starting = fixture.pool.checkAppServerInstallation();
    await vi.waitFor(() => expect(fixture.generations).toHaveLength(3));
    await fixture.pool.close();
    release();
    await starting;
    await settle();

    expect(fixture.gen(1).state.closed).toBe(true);
    expect(fixture.gen(3).state.closed).toBe(true);
    // The current generation is closed but reconnects on its next request.
    expect(fixture.gen(2).raw.close).toHaveBeenCalled();
    expect(fixture.pool.readAppServerGenerationStatus().current).toBe(2);
    expect(fixture.pool.readAppServerGenerationStatus().draining).toEqual([]);
  });

  it("never checks the disk while Codex is not running", async () => {
    const readExecutable = vi.fn(async (launched: CodexExecutableIdentity) => launched);
    const fixture = poolFixture({ readExecutable });
    await fixture.pool.checkAppServerInstallation();
    expect(readExecutable).not.toHaveBeenCalled();
    expect(fixture.generations).toHaveLength(1);
  });
});

/**
 * Model: each thread's turn runs on the generation it started on, and only
 * that generation. Commands interleave starts, turns, completions, process-
 * bound owner work, upgrades, checks and time.
 */
describe("Codex app server generation model", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  type Command =
    | { kind: "start" }
    | { kind: "turn"; thread: number }
    | { kind: "steer"; thread: number }
    | { kind: "complete"; thread: number }
    | { kind: "pin"; thread: number }
    | { kind: "unpin"; thread: number }
    | { kind: "upgrade" }
    | { kind: "check" }
    | { kind: "tick" }
    | { kind: "crash-old" };

  const command: fc.Arbitrary<Command> = fc.oneof(
    fc.constant({ kind: "start" as const }),
    fc.record({ kind: fc.constant("turn" as const), thread: fc.nat(7) }),
    fc.record({ kind: fc.constant("steer" as const), thread: fc.nat(7) }),
    fc.record({ kind: fc.constant("complete" as const), thread: fc.nat(7) }),
    fc.record({ kind: fc.constant("pin" as const), thread: fc.nat(7) }),
    fc.record({ kind: fc.constant("unpin" as const), thread: fc.nat(7) }),
    fc.constant({ kind: "upgrade" as const }),
    fc.constant({ kind: "check" as const }),
    fc.constant({ kind: "tick" as const }),
    fc.constant({ kind: "crash-old" as const }),
  );

  it("never moves or stops a thread's running work, retires every idle replaced process, and leaks none", async () => {
    await fc.assert(fc.asyncProperty(fc.array(command, { minLength: 1, maxLength: 40 }), async (commands) => {
      const fixture = poolFixture();
      const threads: string[] = [];
      // Model: the generation a thread's live work belongs to.
      const runningOn = new Map<string, number>();
      // Process-bound owner work (a background terminal) and where it runs.
      const pinnedOn = new Map<string, number>();
      let version = 160;
      const generationOf = (id: number) => fixture.gen(id);
      const assertSafe = () => {
        for (const [threadId, id] of pinnedOn) {
          expect(generationOf(id).state.retired, `${threadId} has owner work on ${id}`).toBe(false);
        }
        for (const [threadId, id] of runningOn) {
          expect(generationOf(id).state.retired, `${threadId} still runs on ${id}`).toBe(false);
          expect(generationOf(id).running.has(threadId)).toBe(true);
        }
        for (const threadId of threads) {
          const owners = fixture.generations.filter((generation) => generation.loaded.has(threadId) && !generation.state.closed);
          expect(owners.length).toBeLessThanOrEqual(1);
        }
      };
      for (const step of commands) {
        const threadId = threads.length ? threads[("thread" in step ? step.thread : 0) % threads.length] : undefined;
        switch (step.kind) {
          case "start": {
            const result = await fixture.pool.startThread({});
            threads.push(result.threadId);
            const id = Number(result.threadId.slice(1, result.threadId.indexOf("-")));
            // Every new thread goes to the newest generation, which already
            // replaced an upgraded installation before the thread started.
            expect(id).toBe(fixture.pool.readAppServerGenerationStatus().current);
            expect(generationOf(id).launchedFrom.version).toBe(`0.${version}.0`);
            break;
          }
          case "turn":
            if (!threadId || runningOn.has(threadId)) break;
            {
              const result = await fixture.pool.startTurn({ threadId, input: [] });
              const id = Number(result.turnId.slice(1, result.turnId.indexOf("-")));
              const holder = pinnedOn.get(threadId);
              if (holder !== undefined) expect(id).toBe(holder);
              // An idle thread's next turn runs on the current generation
              // unless owner work pins it to the process that holds it.
              if (!fixture.pinned.has(threadId)) {
                expect(id).toBe(fixture.pool.readAppServerGenerationStatus().current);
              }
              runningOn.set(threadId, id);
            }
            break;
          case "steer":
            if (!threadId || !runningOn.has(threadId)) break;
            {
              const id = runningOn.get(threadId)!;
              const before = generationOf(id).raw.steerTurn.mock.calls.length;
              await fixture.pool.steerTurn({ threadId, input: [], expectedTurnId: "" } as never);
              expect(generationOf(id).raw.steerTurn.mock.calls.length).toBe(before + 1);
            }
            break;
          case "complete":
            if (!threadId || !runningOn.has(threadId)) break;
            {
              const id = runningOn.get(threadId)!;
              const before = fixture.delivered.length;
              generationOf(id).completeTurn(threadId);
              runningOn.delete(threadId);
              expect(fixture.delivered.slice(before)).toEqual([{ method: "turn/completed", threadId }]);
            }
            break;
          case "pin": {
            if (!threadId || fixture.pinned.has(threadId)) break;
            const holder = fixture.live().find((generation) => generation.loaded.has(threadId));
            fixture.pinned.add(threadId);
            if (holder) pinnedOn.set(threadId, holder.id);
            break;
          }
          case "unpin":
            if (threadId) fixture.pinned.delete(threadId);
            if (threadId) pinnedOn.delete(threadId);
            break;
          case "upgrade":
            version += 1;
            fixture.upgrade(`0.${version}.0`);
            break;
          case "check":
            await fixture.pool.checkAppServerInstallation();
            break;
          case "tick":
            await settle(2_000);
            break;
          case "crash-old": {
            const old = fixture.live().find((generation) => generation.id !== fixture.pool.readAppServerGenerationStatus().current);
            if (!old) break;
            old.exit();
            for (const [running, id] of runningOn) if (id === old.id) runningOn.delete(running);
            for (const [pinnedThread, id] of pinnedOn) if (id === old.id) pinnedOn.delete(pinnedThread);
            break;
          }
        }
        assertSafe();
      }
      // Drain: finish every turn, release owner work, let retirement run.
      for (const [threadId, id] of runningOn) generationOf(id).completeTurn(threadId);
      runningOn.clear();
      fixture.pinned.clear();
      pinnedOn.clear();
      await settle(5_000);
      const current = fixture.pool.readAppServerGenerationStatus().current;
      expect(fixture.live().map((generation) => generation.id).filter((id) => id !== current)).toEqual([]);
      expect(fixture.pool.readAppServerGenerationStatus().draining).toEqual([]);
      // No retired process was asked to do anything afterwards (the fake throws).
    }), { numRuns: 150 });
  });
});
