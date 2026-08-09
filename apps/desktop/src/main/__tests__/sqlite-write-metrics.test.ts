import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentEvent } from "@pwragent/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import { AppRuntimeInstanceStore } from "../state/app-runtime-instance-store";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import {
  measureSqliteWrites,
  readSqliteWriteMetrics,
  resetSqliteWriteMetrics,
  SQLITE_WRITE_METRICS_ENV,
} from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { StateDb } from "../state/state-db";

let stateDb: StateDb;
let store: SqliteOverlayStore;
let tempDir: string;

beforeEach(() => {
  process.env[SQLITE_WRITE_METRICS_ENV] = "1";
  tempDir = mkdtempSync(path.join(os.tmpdir(), "pwragent-write-metrics-"));
  stateDb = StateDb.open(path.join(tempDir, "state.db"));
  store = new SqliteOverlayStore(stateDb);
  // The collector is process-wide and this file asserts on exact counts, so
  // each test starts from zero. Ordinary test files do not do this — the
  // vitest setup resets once per file so the report attributes a whole file.
  resetSqliteWriteMetrics();
});

afterEach(() => {
  delete process.env[SQLITE_WRITE_METRICS_ENV];
  stateDb.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("sqlite write metrics", () => {
  it("attributes commits and rows to the table that took them", async () => {
    await store.upsertThreadToolInvocation({
      invocation: buildInvocation("tool-1"),
    });
    await store.upsertThreadToolInvocation({
      invocation: buildInvocation("tool-2"),
    });

    const metrics = readSqliteWriteMetrics();
    expect(metrics?.commits).toBe(2);
    expect(metrics?.rowsChanged).toBe(2);
    expect(
      metrics?.tables.find((table) => table.table === "thread_tool_invocations"),
    ).toMatchObject({ commits: 2, rowsChanged: 2, statements: 2 });
  });

  it("counts a batched transaction as one commit, not one per statement", () => {
    // Write amplification tracks commits, not statements: each implicit
    // transaction flushes its dirty pages plus every index they moved. A
    // report that counted statements would rank a batched migration as
    // expensive and a per-event write loop as cheap — exactly backwards.
    const insert = stateDb.raw.prepare(
      "INSERT INTO thread_tool_invocation_alerts (alert_id, backend, thread_id, "
        + "kind, severity, tool_name, message, suggested_prompt, invocation_count, "
        + "total_output_chars, estimated_output_tokens, average_interval_ms, "
        + "first_observed_at, last_observed_at, created_at, updated_at) "
        + "VALUES (?, 'codex', 'thread-1', 'noisy-polling', 'warning', "
        + "'write_stdin', 'm', 'p', 1, 1, 1, 1, 1, 1, 1, 1)",
    );
    stateDb.raw.transaction(() => {
      for (let index = 0; index < 50; index += 1) {
        insert.run(`batched-${index}`);
      }
    })();

    const metrics = readSqliteWriteMetrics();
    expect(metrics?.statements).toBe(50);
    expect(metrics?.commits).toBe(1);
  });

  it("keeps the transaction variants callable and counted", () => {
    // better-sqlite3 hangs .default/.deferred/.immediate/.exclusive off the
    // callable it returns, and they are not enumerable. The first version of
    // this wrapper copied with Object.assign and dropped them, so every
    // `tx.immediate(...)` caller died with "is not a function". Instrumentation
    // has to be invisible to the code it measures.
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

    expect(typeof transaction.immediate).toBe("function");
    expect(typeof transaction.deferred).toBe("function");
    expect(typeof transaction.exclusive).toBe("function");

    transaction("plain");
    transaction.immediate("immediate");

    const metrics = readSqliteWriteMetrics();
    expect(metrics?.statements).toBe(2);
    expect(metrics?.commits).toBe(2);
  });

  it("holds streamed command output to one commit per flush window", async () => {
    // The regression guard for PR #1406. Tool accounting used to run one
    // implicit transaction per streamed 8 KiB chunk — 3,693 commits and 58 MB
    // of WAL for a single `find /`. Nothing caught it: every test over that
    // path uses a mocked overlay store, so no sqlite was involved.
    const registry = new DesktopBackendRegistry({
      codexClient: createStubBackendClient(),
      overlayStore: store as never,
    });
    const emit = (registry as unknown as {
      emit(event: AgentEvent): Promise<void>;
    }).emit.bind(registry);

    // Everything above is setup and sits outside the measured region, so the
    // budget tracks the streaming path rather than the fixture.
    const { writes } = await measureSqliteWrites(async () => {
      for (let index = 0; index < 500; index += 1) {
        await emit({
          backend: "codex",
          notification: {
            method: "item/commandExecution/outputDelta",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              itemId: "cmd-1",
              delta: `line ${index}\n`,
            },
          },
        } as AgentEvent);
      }
      await emit({
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
      } as AgentEvent);
    });

    expectSqliteWriteBudget({
      note: "500 streamed output deltas plus the completion for one command",
      scenario: "streamed-command-output",
      writes,
    });

    await registry.close();
  });

  it("holds a burst of live token usage to one commit", async () => {
    vi.useFakeTimers();
    const registry = new DesktopBackendRegistry({
      codexClient: createStubBackendClient(),
      overlayStore: store as never,
    });
    const emit = (registry as unknown as {
      emit(event: AgentEvent): Promise<void>;
    }).emit.bind(registry);

    try {
      const { writes } = await measureSqliteWrites(async () => {
        // Fifty cumulative snapshots for each of ten concurrently active
        // turns. Only the last snapshot per usageLineId belongs in sqlite.
        for (let index = 0; index < 500; index += 1) {
          const turnIndex = index % 10;
          const observation = Math.floor(index / 10) + 1;
          const inputTokens = observation * 1_000 + turnIndex;
          await emit(buildLiveUsageEvent({
            inputTokens,
            threadId: `thread-${turnIndex}`,
            turnId: `turn-${turnIndex}`,
          }));
        }

        // A terminal notification is an explicit durability boundary. It
        // drains every pending turn, not only the terminal event's own turn.
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
        expect(pricing.lines).toHaveLength(1);
        expect(pricing.lines[0]).toMatchObject({
          inputTokens: 50_000 + turnIndex,
          threadId: `thread-${turnIndex}`,
          turnId: `turn-${turnIndex}`,
        });
      }
    } finally {
      await registry.close();
      vi.useRealTimers();
    }
  });

  it("flushes coalesced live usage on the bounded timer", async () => {
    vi.useFakeTimers();
    const batchWrite = vi.spyOn(store, "upsertThreadUsageLines");
    const registry = new DesktopBackendRegistry({
      codexClient: createStubBackendClient(),
      overlayStore: store as never,
    });
    const emit = (registry as unknown as {
      emit(event: AgentEvent): Promise<void>;
    }).emit.bind(registry);
    const pricingEvents: AgentEvent[] = [];
    registry.onEvent((event) => {
      if (event.notification.method === "thread/pricing/updated") {
        pricingEvents.push(event);
      }
    });

    try {
      await emit(buildLiveUsageEvent({
        inputTokens: 1_000,
        threadId: "thread-timer",
        turnId: "turn-timer",
      }));
      await emit(buildLiveUsageEvent({
        inputTokens: 2_000,
        threadId: "thread-timer",
        turnId: "turn-timer",
      }));

      expect(batchWrite).not.toHaveBeenCalled();
      expect(
        (await store.readThreadPricing({
          backend: "codex",
          threadId: "thread-timer",
        })).lines,
      ).toEqual([]);

      await vi.advanceTimersByTimeAsync(999);
      expect(batchWrite).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      expect(batchWrite).toHaveBeenCalledTimes(1);
      expect(batchWrite.mock.calls[0]?.[0].lines).toHaveLength(1);
      expect(batchWrite.mock.calls[0]?.[0].lines[0]).toMatchObject({
        inputTokens: 2_000,
        usageLineId: "codex:thread-timer:turn-timer:live-token-usage",
      });
      expect(pricingEvents).toHaveLength(1);
      expect(pricingEvents[0]?.notification).toMatchObject({
        method: "thread/pricing/updated",
        params: {
          pricing: {
            lines: [expect.objectContaining({ inputTokens: 2_000 })],
          },
          threadId: "thread-timer",
        },
      });
    } finally {
      await registry.close();
      vi.useRealTimers();
    }
  });

  it("retries a failed batch without overwriting a newer observation", async () => {
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
    const registry = new DesktopBackendRegistry({
      codexClient: createStubBackendClient(),
      overlayStore: store as never,
    });
    const emit = (registry as unknown as {
      emit(event: AgentEvent): Promise<void>;
    }).emit.bind(registry);
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

      // This newer cumulative snapshot arrives while the older batch is in
      // flight. Requeueing the failed batch must not put 1,000 back on top.
      await emit(buildLiveUsageEvent({
        inputTokens: 2_000,
        threadId: "thread-retry",
        turnId: "turn-retry",
      }));
      releaseFirstWrite.resolve();
      await firstFlush;
      await flush();

      expect(batchWrite).toHaveBeenCalledTimes(2);
      expect(batchWrite.mock.calls[1]?.[0].lines).toHaveLength(1);
      expect(batchWrite.mock.calls[1]?.[0].lines[0]).toMatchObject({
        inputTokens: 2_000,
      });
      expect(
        (await store.readThreadPricing({
          backend: "codex",
          threadId: "thread-retry",
        })).lines[0],
      ).toMatchObject({ inputTokens: 2_000 });
    } finally {
      releaseFirstWrite.resolve();
      await registry.close();
      vi.useRealTimers();
    }
  });

  it("flushes live usage on close and ignores post-close writes", async () => {
    vi.useFakeTimers();
    const batchWrite = vi.spyOn(store, "upsertThreadUsageLines");
    const registry = new DesktopBackendRegistry({
      codexClient: createStubBackendClient(),
      overlayStore: store as never,
    });
    const emit = (registry as unknown as {
      emit(event: AgentEvent): Promise<void>;
    }).emit.bind(registry);
    let closed = false;

    try {
      await emit(buildLiveUsageEvent({
        inputTokens: 1_000,
        threadId: "thread-close",
        turnId: "turn-close",
      }));
      expect(batchWrite).not.toHaveBeenCalled();

      await registry.close();
      closed = true;
      expect(batchWrite).toHaveBeenCalledTimes(1);
      expect(
        (await store.readThreadPricing({
          backend: "codex",
          threadId: "thread-close",
        })).lines[0],
      ).toMatchObject({ inputTokens: 1_000 });

      await emit(buildLiveUsageEvent({
        inputTokens: 2_000,
        threadId: "thread-close",
        turnId: "turn-close",
      }));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(batchWrite).toHaveBeenCalledTimes(1);
      expect(
        (await store.readThreadPricing({
          backend: "codex",
          threadId: "thread-close",
        })).lines[0],
      ).toMatchObject({ inputTokens: 1_000 });
    } finally {
      if (!closed) {
        await registry.close();
      }
      vi.useRealTimers();
    }
  });

  it("holds an idle hour of heartbeats to its budget", async () => {
    // The floor the app pays for existing: the profile-runtime heartbeat and
    // the federation lease renewal both tick every 10s against a 45s TTL, each
    // taking its own commit. Budgeted so a third ticker, or a shortened
    // interval, has to be a deliberate line in a diff.
    const instances = new AppRuntimeInstanceStore(stateDb);
    instances.recordInstanceStart({
      instanceId: "instance-1",
      profileName: "default",
      processId: 1234,
      startedAt: 1_800_000_000_000,
      desiredMessagingEnabled: false,
    });
    instances.acquireFederationLease({
      instanceId: "instance-1",
      now: 1_800_000_000_000,
      ttlMs: 45_000,
    });

    const { writes } = await measureSqliteWrites(() => {
      for (let tick = 0; tick < 360; tick += 1) {
        const now = 1_800_000_000_000 + tick * 10_000;
        instances.heartbeatInstance({ instanceId: "instance-1", now });
        instances.renewFederationLease({
          instanceId: "instance-1",
          now,
          ttlMs: 45_000,
        });
      }
    });

    expectSqliteWriteBudget({
      note: "one idle hour: 360 profile heartbeats + 360 federation lease renewals",
      scenario: "idle-hour-heartbeats",
      writes,
    });
  });
});

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

function buildInvocation(invocationId: string) {
  return {
    backend: "codex" as const,
    category: "shell" as const,
    debugLines: 0,
    errorLines: 0,
    estimatedOutputTokens: 25,
    infoLines: 0,
    invocationId,
    itemId: invocationId,
    noisy: false,
    observedAt: 1_800_000_000_000,
    outputChars: 100,
    outputLines: 4,
    outputTruncated: false,
    status: "completed" as const,
    threadId: "thread-1",
    toolName: "commandExecution",
    updatedAt: 1_800_000_000_000,
    warningLines: 0,
  };
}

function createStubBackendClient() {
  return {
    close: async () => {},
    getInitializeResult: async () => ({ methods: [] }),
    onNotification: () => () => {},
    onPendingRequest: () => () => {},
  } as never;
}
