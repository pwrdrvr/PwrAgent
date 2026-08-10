import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AgentEvent,
  AppServerThreadReplay,
  ThreadUsageLineRecord,
} from "@pwragent/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { attachSqliteWriteMeter } from "./fixtures/sqlite-write-metrics";

let meter: ReturnType<typeof attachSqliteWriteMeter>;
let stateDb: StateDb;
let store: SqliteOverlayStore;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "pwragent-write-budget-"));
  const dbPath = path.join(tempDir, "state.db");
  stateDb = StateDb.open(dbPath);
  meter = attachSqliteWriteMeter({ db: stateDb.raw, dbPath });
  store = new SqliteOverlayStore(stateDb);
});

afterEach(() => {
  stateDb.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("sqlite write budgets", () => {
  it("keeps transaction variants callable and counts one commit per batch", async () => {
    const insert = stateDb.raw.prepare(
      "INSERT INTO thread_tool_invocations (invocation_id, backend, thread_id, "
        + "item_id, tool_name, category, status, observed_at, updated_at, "
        + "output_chars, output_lines, estimated_output_tokens, warning_lines, "
        + "error_lines, info_lines, debug_lines, output_truncated, noisy) "
        + "VALUES (?, 'codex', 't', 'i', 'commandExecution', 'shell', "
        + "'completed', 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0)",
    );
    const transaction = stateDb.raw.transaction((id: string) => {
      insert.run(id);
    });

    expect(typeof transaction.deferred).toBe("function");
    expect(typeof transaction.immediate).toBe("function");
    expect(typeof transaction.exclusive).toBe("function");
    const { writes } = await meter.measure(() => {
      transaction("plain");
      transaction.immediate("immediate");
    });
    expect(writes).toMatchObject({ commits: 2, rowsChanged: 2, statements: 2 });
  });

  it("pins streamed command output to one delta batch plus completion", async () => {
    const upsert = vi.spyOn(store, "upsertThreadToolInvocation");
    const registry = createRegistry();
    const emit = registryEmit(registry);

    const { writes } = await meter.measure(async () => {
      for (let index = 0; index < 500; index += 1) {
        await emit(buildOutputDeltaEvent(`line ${index}\n`));
      }
      expect(upsert).not.toHaveBeenCalled();
      await emit(buildCommandCompletedEvent());
    });

    expectSqliteWriteBudget({
      note: "500 streamed output deltas plus the completion for one command",
      scenario: "streamed-command-output",
      writes,
    });
    const accounting = await store.readThreadToolAccounting({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(accounting.invocations[0]).toMatchObject({
      outputChars: Array.from(
        { length: 500 },
        (_, index) => `line ${index}\n`.length,
      ).reduce((sum, length) => sum + length, 0),
      status: "completed",
    });
    expect(upsert.mock.calls).toHaveLength(2);
    expect(upsert.mock.calls[0]?.[0].invocation.status).toBe("in_progress");
    expect(upsert.mock.calls[1]?.[0].invocation.status).toBe("completed");

    await registry.close();
  });

  it("flushes streamed command output on each bounded timer window", async () => {
    vi.useFakeTimers();
    const upsert = vi.spyOn(store, "upsertThreadToolInvocation");
    const registry = createRegistry();
    const emit = registryEmit(registry);

    try {
      await emit(buildOutputDeltaEvent("chunk one\n"));
      await emit(buildOutputDeltaEvent("chunk two\n"));
      await vi.advanceTimersByTimeAsync(249);
      expect(upsert).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(upsert).toHaveBeenCalledTimes(1);
      expect(upsert.mock.calls[0]?.[0].invocation).toMatchObject({
        outputChars: 20,
        status: "in_progress",
      });

      await emit(buildOutputDeltaEvent("chunk three\n"));
      await vi.advanceTimersByTimeAsync(250);
      expect(upsert).toHaveBeenCalledTimes(2);
      expect(
        (await store.readThreadToolAccounting({
          backend: "codex",
          threadId: "thread-1",
        })).invocations[0],
      ).toMatchObject({ outputChars: 32, status: "in_progress" });
    } finally {
      await registry.close();
      vi.useRealTimers();
    }
  });

  it("retries a failed streamed-output batch", async () => {
    vi.useFakeTimers();
    const originalUpsert = store.upsertThreadToolInvocation.bind(store);
    const upsert = vi
      .spyOn(store, "upsertThreadToolInvocation")
      .mockRejectedValueOnce(new Error("disk busy"))
      .mockImplementation(async (params) => await originalUpsert(params));
    const registry = createRegistry();
    const emit = registryEmit(registry);

    try {
      await emit(buildOutputDeltaEvent("chunk one\n"));
      await vi.advanceTimersByTimeAsync(250);
      expect(upsert).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(250);
      expect(upsert).toHaveBeenCalledTimes(2);
      expect(
        (await store.readThreadToolAccounting({
          backend: "codex",
          threadId: "thread-1",
        })).invocations[0],
      ).toMatchObject({ outputChars: 10 });
    } finally {
      await registry.close();
      vi.useRealTimers();
    }
  });

  it("pins a burst of cumulative live usage to one transaction", async () => {
    vi.useFakeTimers();
    const registry = createRegistry();
    const emit = registryEmit(registry);

    try {
      const { writes } = await meter.measure(async () => {
        for (let index = 0; index < 500; index += 1) {
          const turnIndex = index % 10;
          const observation = Math.floor(index / 10) + 1;
          await emit(buildLiveUsageEvent({
            inputTokens: observation * 1_000 + turnIndex,
            threadId: `thread-${turnIndex}`,
            turnId: `turn-${turnIndex}`,
          }));
        }
        await emit(buildTurnCompletedEvent("thread-0", "turn-0"));
      });

      expectSqliteWriteBudget({
        note:
          "500 cumulative usage observations across 10 turns, then one terminal flush",
        scenario: "live-thread-token-usage",
        writes,
      });
      for (let turnIndex = 0; turnIndex < 10; turnIndex += 1) {
        const pricing = await store.readThreadPricing({
          backend: "codex",
          threadId: `thread-${turnIndex}`,
        });
        expect(pricing.lines[0]).toMatchObject({
          inputTokens: 50_000 + turnIndex,
          turnId: `turn-${turnIndex}`,
        });
      }
    } finally {
      await registry.close();
      vi.useRealTimers();
    }
  });

  it("pins recurring live usage to one commit per timer window", async () => {
    vi.useFakeTimers({
      toFake: ["Date", "clearTimeout", "setTimeout"],
    });
    const batchWrite = vi.spyOn(store, "upsertThreadUsageLines");
    const registry = createRegistry();
    const emit = registryEmit(registry);

    try {
      const { writes } = await meter.measure(async () => {
        for (let window = 1; window <= 10; window += 1) {
          await emit(buildLiveUsageEvent({
            inputTokens: window * 1_000,
            threadId: "timer-thread",
            turnId: "timer-turn",
          }));
          await vi.advanceTimersByTimeAsync(1_000);
        }
      });

      expect(batchWrite).toHaveBeenCalledTimes(10);
      expectSqliteWriteBudget({
        note:
          "10 cumulative live-usage observations separated by full one-second timer windows",
        scenario: "live-thread-token-usage-timer-windows",
        writes,
      });
    } finally {
      await registry.close();
      vi.useRealTimers();
    }
  });

  it("requeues a failed usage batch without overwriting a newer snapshot", async () => {
    vi.useFakeTimers();
    const firstWriteStarted = createDeferred();
    const releaseFirstWrite = createDeferred();
    const originalBatchWrite = store.upsertThreadUsageLines.bind(store);
    const batchWrite = vi
      .spyOn(store, "upsertThreadUsageLines")
      .mockImplementationOnce(async () => {
        firstWriteStarted.resolve();
        await releaseFirstWrite.promise;
        throw new Error("disk busy");
      })
      .mockImplementation(async (params) => await originalBatchWrite(params));
    const registry = createRegistry();
    const emit = registryEmit(registry);
    const flush = (registry as unknown as {
      flushLiveThreadUsageLines(): Promise<void>;
    }).flushLiveThreadUsageLines.bind(registry);

    try {
      await emit(buildLiveUsageEvent({
        inputTokens: 1_000,
        threadId: "thread-retry",
        turnId: "turn-retry",
      }));
      const firstFlush = flush();
      await firstWriteStarted.promise;
      await emit(buildLiveUsageEvent({
        inputTokens: 2_000,
        threadId: "thread-retry",
        turnId: "turn-retry",
      }));
      releaseFirstWrite.resolve();
      await firstFlush;
      await flush();

      expect(batchWrite).toHaveBeenCalledTimes(2);
      expect(batchWrite.mock.calls[1]?.[0].lines[0]).toMatchObject({
        inputTokens: 2_000,
      });
    } finally {
      releaseFirstWrite.resolve();
      await registry.close();
      vi.useRealTimers();
    }
  });

  it("flushes live usage before replay hydration supersedes it", async () => {
    vi.useFakeTimers();
    const threadId = "thread-hydration-race";
    const turnId = "turn-hydration-race";
    const registry = createRegistry({
      replay: buildHydratedUsageReplay({ threadId, turnId }),
    });
    const emit = registryEmit(registry);

    try {
      await emit(buildLiveUsageEvent({ inputTokens: 1_000, threadId, turnId }));
      await registry.readThread({ backend: "codex", threadId });
      await vi.advanceTimersByTimeAsync(1_000);

      const pricing = await store.readThreadPricing({
        backend: "codex",
        threadId,
      });
      expect(pricing.lines).toHaveLength(1);
      expect(pricing.lines[0]).toMatchObject({
        source: "hydration",
        status: "finalized",
        usageLineId: `codex:${threadId}:${turnId}:hydration`,
      });
    } finally {
      await registry.close();
      vi.useRealTimers();
    }
  });

  it("waits for an earlier usage derivation at the terminal boundary", async () => {
    const lookupStarted = createDeferred();
    const releaseLookup = createDeferred();
    const readOverlay = store.getThreadOverlayState.bind(store);
    vi.spyOn(store, "getThreadOverlayState").mockImplementationOnce(
      async (params) => {
        lookupStarted.resolve();
        await releaseLookup.promise;
        return await readOverlay(params);
      },
    );
    const registry = createRegistry();
    const emit = registryEmit(registry);
    let terminalDelivered = false;
    registry.onEvent((event) => {
      if (event.notification.method === "turn/completed") {
        terminalDelivered = true;
      }
    });

    const usageEmit = emit(buildLiveUsageEvent({
      inputTokens: 1_000,
      threadId: "thread-race",
      turnId: "turn-race",
    }));
    await lookupStarted.promise;
    const terminalEmit = emit(buildTurnCompletedEvent("thread-race", "turn-race"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(terminalDelivered).toBe(false);

    releaseLookup.resolve();
    await Promise.all([usageEmit, terminalEmit]);
    expect(terminalDelivered).toBe(true);
    expect(
      (await store.readThreadPricing({
        backend: "codex",
        threadId: "thread-race",
      })).lines[0],
    ).toMatchObject({ inputTokens: 1_000 });
    await registry.close();
  });

  it("drains pre-close usage and ignores observations accepted after close", async () => {
    const registry = createRegistry();
    const emit = registryEmit(registry);
    await emit(buildLiveUsageEvent({
      inputTokens: 1_000,
      threadId: "thread-close",
      turnId: "turn-close",
    }));

    await registry.close();
    await emit(buildLiveUsageEvent({
      inputTokens: 2_000,
      threadId: "thread-close",
      turnId: "turn-close",
    }));

    expect(
      (await store.readThreadPricing({
        backend: "codex",
        threadId: "thread-close",
      })).lines[0],
    ).toMatchObject({ inputTokens: 1_000 });
  });
});

function createRegistry(options?: { replay?: AppServerThreadReplay }) {
  return new DesktopBackendRegistry({
    codexClient: createStubBackendClient(options),
    overlayStore: store as never,
  });
}

function registryEmit(registry: DesktopBackendRegistry) {
  return (registry as unknown as {
    emit(event: AgentEvent): Promise<void>;
  }).emit.bind(registry);
}

function buildOutputDeltaEvent(delta: string): AgentEvent {
  return {
    backend: "codex",
    notification: {
      method: "item/commandExecution/outputDelta",
      params: {
        delta,
        itemId: "cmd-1",
        threadId: "thread-1",
        turnId: "turn-1",
      },
    },
  } as AgentEvent;
}

function buildCommandCompletedEvent(): AgentEvent {
  return {
    backend: "codex",
    notification: {
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          id: "cmd-1",
          type: "commandExecution",
          command: "find / -xdev",
          status: "completed",
          exitCode: 0,
        },
      },
    },
  } as AgentEvent;
}

function buildLiveUsageEvent(params: {
  inputTokens: number;
  threadId: string;
  turnId: string;
}): AgentEvent {
  const cachedInputTokens = Math.max(0, params.inputTokens - 100);
  return {
    backend: "codex",
    notification: {
      method: "thread/tokenUsage/updated",
      params: {
        threadId: params.threadId,
        turnId: params.turnId,
        model: "gpt-5.5",
        tokenUsage: {
          total: {
            inputTokens: params.inputTokens,
            cachedInputTokens,
            outputTokens: 100,
          },
          last: {
            inputTokens: params.inputTokens,
            cachedInputTokens,
            outputTokens: 100,
          },
        },
      },
    },
  } as AgentEvent;
}

function buildTurnCompletedEvent(threadId: string, turnId: string): AgentEvent {
  return {
    backend: "codex",
    notification: {
      method: "turn/completed",
      params: {
        threadId,
        turnId,
        turn: {
          id: turnId,
          status: "completed",
          output: [],
        },
      },
    },
  } as AgentEvent;
}

function buildHydratedUsageReplay(params: {
  threadId: string;
  turnId: string;
}): AppServerThreadReplay {
  const usageLine: ThreadUsageLineRecord = {
    backend: "codex",
    cachedInputCostMicros: 0,
    cachedInputTokens: 1_200,
    completedAt: 2_000,
    createdAt: 2_000,
    currency: "USD",
    inputTokens: 1_500,
    model: "gpt-5.5",
    outputCostMicros: 0,
    outputTokens: 150,
    priceStatus: "unpriced",
    provider: "openai",
    reasoningOutputTokens: 0,
    scope: "turn",
    source: "hydration",
    sourceItemId: "hydrated-usage",
    status: "finalized",
    threadId: params.threadId,
    totalCostMicros: 0,
    totalTokens: 1_650,
    turnId: params.turnId,
    uncachedInputCostMicros: 0,
    uncachedInputTokens: 300,
    usageLineId: `codex:${params.threadId}:${params.turnId}:hydration`,
  };
  return {
    entries: [
      {
        type: "activity",
        id: "hydrated-usage",
        summary: "Turn usage: hydrated",
        status: "completed",
        createdAt: 2_000,
        details: [],
        turn: { id: params.turnId, status: "completed" },
        usageLine,
      },
    ],
    messages: [],
    pagination: {
      hasPreviousPage: false,
      supportsPagination: false,
    },
  };
}

function createDeferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function createStubBackendClient(options?: { replay?: AppServerThreadReplay }) {
  return {
    close: async () => {},
    getInitializeResult: async () => ({
      methods: options?.replay ? ["thread/read"] : [],
    }),
    onNotification: () => () => {},
    onPendingRequest: () => () => {},
    readThread: async () =>
      options?.replay ?? {
        entries: [],
        messages: [],
        pagination: {
          hasPreviousPage: false,
          supportsPagination: false,
        },
      },
  } as never;
}
