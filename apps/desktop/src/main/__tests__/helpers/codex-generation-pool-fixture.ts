import { vi } from "vitest";
import type { AppServerNotification, AppServerPendingRequestNotification } from "@pwragent/shared";
import type { CodexAppServerClient } from "../../codex-app-server/desktop-client";
import type { CodexExecutableIdentity } from "../../codex-app-server/executable-identity";
import {
  createCodexAppServerGenerationPool,
  type CodexAppServerGenerationPoolOptions,
} from "../../codex-app-server/app-server-generation-pool";

/**
 * One app server process per generation. It runs from whatever is installed
 * when it starts, and keeps that identity after the installation changes.
 */
export type FakeGeneration = ReturnType<typeof fakeGeneration>;

export function fakeGeneration(
  id: number,
  installed: () => CodexExecutableIdentity,
  startFailure?: Error,
  handshake?: Promise<void>,
) {
  // A process runs from what was installed when it launched.
  let launchedFrom = installed();
  // A closed client starts again on its next request, from what is selected then.
  const launch = () => {
    if (!state.initialized) launchedFrom = installed();
    state.initialized = true;
    state.closed = false;
  };
  const notifications = new Set<(event: AppServerNotification) => void>();
  const requests = new Set<(event: AppServerPendingRequestNotification) => Promise<unknown>>();
  const exits = new Set<() => void>();
  const running = new Map<string, string>();
  const loaded = new Set<string>();
  const calls: Array<{ method: string; threadId?: string }> = [];
  const released: string[] = [];
  const state = { initialized: false, closed: false, retired: false, retireAttempts: 0, closes: 0 };
  let threadCounter = 0;
  const call = (method: string, threadId?: string) => {
    if (state.retired) throw new Error(`generation ${id} was asked to ${method} after it retired`);
    calls.push({ method, ...(threadId ? { threadId } : {}) });
    if (threadId) loaded.add(threadId);
  };
  const raw = {
    getInitializeResult: vi.fn(async () => {
      if (state.retired) throw new Error("codex app server generation retired");
      const closes = state.closes;
      await handshake;
      // A close during the handshake abandons it, as the client's does.
      if (state.closes !== closes) throw new Error("codex app server client closed");
      if (startFailure) throw startFailure;
      launch();
      return { userAgent: `codex_cli_rs/${launchedFrom.version} (fixture)` };
    }),
    readAppServerExecutable: () => state.initialized && !state.closed ? launchedFrom : undefined,
    hasAppServerProcess: () => state.initialized && !state.closed,
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
      state.closes += 1;
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
export const install = (version: string, ino: number): CodexExecutableIdentity => ({
  command: HOMEBREW,
  realPath: `/opt/homebrew/Caskroom/codex/${version}/codex`,
  ino,
  version,
});

export function poolFixture(overrides: Partial<CodexAppServerGenerationPoolOptions> = {}) {
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
    // A command no longer selected still names the file it always did.
    readExecutable: async (launched) =>
      launched.command === installed.command ? installed : launched,
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
    /** Settings now select another executable, as a path change or managed switch does. */
    select(command: string) {
      installed = { command, realPath: command, ino: installed.ino! + 1, version: installed.version };
    },
    get installed() {
      return installed;
    },
    gen(id: number) {
      return generations[id - 1]!;
    },
    live() {
      return generations.filter((generation) => !generation.state.closed);
    },
  };
}

export async function settle(ms = 50): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}
