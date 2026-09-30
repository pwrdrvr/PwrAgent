import type { AgentEvent, AppServerBackendKind, ThreadUsageLineRecord } from "@pwragent/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import {
  createTempStateDb,
  openInMemoryStateDb,
  removeTempStateDbDir,
} from "./sqlite-test-utils";

// Every turn's pricing-ledger row needs an end time, including turns that end
// without a terminal event reaching the completion path. These drive the real
// registry against a real ledger.
describe("DesktopBackendRegistry usage turn ends", () => {
  let stateDb: StateDb;
  let store: SqliteOverlayStore;
  let tempDir: string | undefined;
  const registries: DesktopBackendRegistry[] = [];
  // Write metrics attach to a file database opened with them enabled.
  const measureOnFileStateDb = () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    stateDb.close();
    const temp = createTempStateDb("pwragent-usage-turn-end-");
    tempDir = temp.tempDir;
    stateDb = StateDb.open(temp.dbPath);
    store = new SqliteOverlayStore(stateDb);
  };

  const createRegistry = (
    liveRuntimeInstanceIds: string[] = [],
    options: {
      codexClient?: Record<string, unknown>;
      runningTurnShutdownStopTimeoutMs?: number;
    } = {},
  ) => {
    const registry = new DesktopBackendRegistry({
      codexClient: {
        close: async () => {},
        getInitializeResult: async () => ({ methods: [] }),
        listThreads: async () => [],
        onNotification: () => () => {},
        onPendingRequest: () => () => {},
        ...options.codexClient,
      } as never,
      overlayStore: store,
      runtimeInstanceId: "runtime-self",
      resolveLiveProfileRuntimeInstanceIds: () => liveRuntimeInstanceIds,
      runningTurnShutdownStopTimeoutMs: options.runningTurnShutdownStopTimeoutMs,
    });
    registries.push(registry);
    return registry;
  };
  const internals = (registry: DesktopBackendRegistry) => registry as unknown as {
    acpBackend: {
      cancelRunningSession(backend: string, sessionId: string): Promise<boolean>;
    };
    emit(event: AgentEvent): Promise<void>;
    flushLiveThreadUsageLines(): Promise<void>;
    startTurnNow(entry: unknown): Promise<unknown>;
    threadTurnQueue: {
      submit(entry: Record<string, unknown>): Promise<{ status: string }>;
    };
    usageTurnStartupRepair: Promise<void>;
  };
  const usage = (backend: AppServerBackendKind, turnId: string): AgentEvent => ({
    backend,
    notification: {
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-1",
        turnId,
        tokenUsage: {
          last: { inputTokens: 1_000, cachedInputTokens: 100, outputTokens: 20, totalTokens: 1_020 },
          total: { inputTokens: 1_000, cachedInputTokens: 100, outputTokens: 20, totalTokens: 1_020 },
        },
      },
    } as AgentEvent["notification"],
  });
  const started = (backend: AppServerBackendKind, turnId: string): AgentEvent => ({
    backend,
    notification: {
      method: "turn/started",
      params: { threadId: "thread-1", turnId, turn: { id: turnId, status: "inProgress" } },
    } as AgentEvent["notification"],
  });
  // Start a turn and flush its first usage, so no buffered line can carry the
  // end time and only the completion path under test can record it.
  const runTurn = async (registry: DesktopBackendRegistry, backend: AppServerBackendKind, turnId: string) => {
    await internals(registry).emit(started(backend, turnId));
    await internals(registry).emit(usage(backend, turnId));
    await internals(registry).flushLiveThreadUsageLines();
  };
  const completedAt = (turnId: string) => (stateDb.raw.prepare(
    "SELECT completed_at FROM thread_usage_turns WHERE turn_id = ?",
  ).get(turnId) as { completed_at: number | null } | undefined)?.completed_at;

  beforeEach(() => {
    tempDir = undefined;
    stateDb = openInMemoryStateDb();
    store = new SqliteOverlayStore(stateDb);
  });

  afterEach(async () => {
    for (const registry of registries.splice(0)) {
      await registry.close();
    }
    stateDb.close();
    vi.unstubAllEnvs();
    if (tempDir) {
      removeTempStateDbDir(tempDir);
    }
  });

  it("records an operator-interrupted Codex turn's end from its interrupted completion", async () => {
    const registry = createRegistry();
    await runTurn(registry, "codex", "turn-1");
    expect(completedAt("turn-1")).toBeNull();

    // Codex answers turn/interrupt with turn/completed, status interrupted,
    // and epoch-second times (codex-rs app-server bespoke_event_handling).
    await internals(registry).emit({
      backend: "codex",
      notification: {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          turn: { id: "turn-1", status: "interrupted", completedAt: 1_800_000_004, durationMs: 4_000 },
        },
      } as never,
    });

    expect(completedAt("turn-1")).toBe(1_800_000_004_000);
  });

  it("ends a turn still running at shutdown when the registry closes", async () => {
    const registry = createRegistry();
    await runTurn(registry, "codex", "turn-running");
    await runTurn(registry, "acp:grok", "pending:thread-1:1800000000000");
    const beforeClose = Date.now();

    await registry.close();
    registries.splice(registries.indexOf(registry), 1);

    // Neither backend can be asked to stop (no turn/interrupt, no live ACP
    // client), so close does not sit out the 2s stop deadline.
    expect(Date.now() - beforeClose).toBeLessThan(1_000);
    expect(completedAt("turn-running")).toBeGreaterThanOrEqual(beforeClose);
    expect(completedAt("pending:thread-1:1800000000000")).toBeGreaterThanOrEqual(beforeClose);
  });

  it.each(["turn/completed", "turn/failed"] as const)(
    "completes an ACP turn under its pending id on %s",
    async (method) => {
      const registry = createRegistry();
      const turnId = "pending:thread-1:1800000000000";
      await runTurn(registry, "acp:grok", turnId);

      await internals(registry).emit({
        backend: "acp:grok",
        notification: {
          method,
          params: {
            threadId: "thread-1",
            turnId,
            turn: {
              id: turnId,
              status: method === "turn/failed" ? "failed" : "completed",
              completedAt: 1_800_000_009_000,
              ...(method === "turn/failed" ? { error: { message: "fixture" } } : { output: [] }),
            },
          },
        } as AgentEvent["notification"],
      });

      expect(completedAt(turnId)).toBe(1_800_000_009_000);
    },
  );

  describe("stopping running turns at quit", () => {
    const acpTurnId = "pending:thread-1:1800000000000";
    // Codex answers turn/interrupt with turn/completed, status interrupted,
    // and epoch-second times, before the interrupt response itself
    // (codex-rs app-server bespoke_event_handling respond_to_pending_interrupts).
    const codexInterrupted = (turnId: string): AgentEvent => ({
      backend: "codex",
      notification: {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turnId,
          turn: { id: turnId, status: "interrupted", completedAt: 1_800_000_004, durationMs: 4_000 },
        },
      } as never,
    });
    // session/cancel settles the ACP prompt with stopReason cancelled, which
    // the adapter reports as turn/cancelled at the moment it settled.
    const acpCancelled = (turnId: string): AgentEvent => ({
      backend: "acp:grok",
      notification: {
        method: "turn/cancelled",
        params: {
          threadId: "thread-1",
          turnId,
          turn: { id: turnId, status: "cancelled", completedAt: 1_800_000_007_000 },
        },
      } as never,
    });
    const codexWithInterrupt = (interruptTurn: (params: { threadId: string; turnId: string }) => Promise<unknown>) => ({
      getInitializeResult: async () => ({ methods: ["turn/interrupt"] }),
      interruptTurn: vi.fn(interruptTurn),
    });

    it("interrupts Codex and ACP turns and records each backend's own end", async () => {
      const codex = codexWithInterrupt(async (params) => {
        await internals(registry).emit(codexInterrupted(params.turnId));
        return params;
      });
      const registry: DesktopBackendRegistry = createRegistry([], { codexClient: codex });
      const cancel = vi.spyOn(internals(registry).acpBackend, "cancelRunningSession")
        .mockImplementation(async () => {
          void internals(registry).emit(acpCancelled(acpTurnId));
          return true;
        });
      await runTurn(registry, "codex", "turn-1");
      await runTurn(registry, "acp:grok", acpTurnId);
      const heard: string[] = [];
      registry.onEvent((event) => {
        if (event.notification.method.startsWith("turn/")) {
          heard.push(`${event.backend} ${event.notification.method}`);
        }
      });

      await registry.stopRunningTurnsForShutdown();

      expect(codex.interruptTurn).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: "thread-1", turnId: "turn-1" }),
      );
      expect(cancel).toHaveBeenCalledWith("acp:grok", "thread-1");
      // Each terminal reached listeners before the quit moved on to stop them.
      expect(heard.sort()).toEqual(["acp:grok turn/cancelled", "codex turn/completed"]);
      expect(completedAt("turn-1")).toBe(1_800_000_004_000);
      expect(completedAt(acpTurnId)).toBe(1_800_000_007_000);

      // Close does not ask again, and its shutdown stamp has nothing left.
      await registry.close();
      registries.splice(registries.indexOf(registry), 1);
      expect(codex.interruptTurn).toHaveBeenCalledTimes(1);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(completedAt("turn-1")).toBe(1_800_000_004_000);
      expect(completedAt(acpTurnId)).toBe(1_800_000_007_000);
    });

    it("costs one commit per interrupted turn", async () => {
      measureOnFileStateDb();
      const registry: DesktopBackendRegistry = createRegistry([], {
        codexClient: codexWithInterrupt(async (params) => {
          await internals(registry).emit(codexInterrupted(params.turnId));
          return params;
        }),
      });
      vi.spyOn(internals(registry).acpBackend, "cancelRunningSession")
        .mockImplementation(async () => {
          void internals(registry).emit(acpCancelled(acpTurnId));
          return true;
        });
      await runTurn(registry, "codex", "turn-1");
      await runTurn(registry, "acp:grok", acpTurnId);

      const { writes } = await measureSqliteWrites(async () => {
        await registry.close();
      });
      registries.splice(registries.indexOf(registry), 1);

      expectSqliteWriteBudget({
        note: "Quit with a Codex and an ACP turn running, both answering their stop request: one ledger commit per turn, from its own terminal; no shutdown stamp",
        scenario: "usage-turn-shutdown-interrupt",
        writes,
      });
    });

    it("finishes by the deadline when a backend never answers, and stamps the shutdown", async () => {
      const codex = codexWithInterrupt(() => new Promise<never>(() => {}));
      const registry = createRegistry([], {
        codexClient: codex,
        runningTurnShutdownStopTimeoutMs: 50,
      });
      const cancel = vi.spyOn(internals(registry).acpBackend, "cancelRunningSession")
        .mockImplementation(() => new Promise<never>(() => {}));
      await runTurn(registry, "codex", "turn-hung");
      await runTurn(registry, "acp:grok", acpTurnId);
      const beforeClose = Date.now();

      await registry.close();
      registries.splice(registries.indexOf(registry), 1);

      expect(codex.interruptTurn).toHaveBeenCalledTimes(1);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(Date.now() - beforeClose).toBeLessThan(1_000);
      expect(completedAt("turn-hung")).toBeGreaterThanOrEqual(beforeClose);
      expect(completedAt(acpTurnId)).toBeGreaterThanOrEqual(beforeClose);
    });

    it("sends nothing and writes nothing when no turn is running", async () => {
      const codex = {
        ...codexWithInterrupt(async (params) => params),
        getInitializeResult: vi.fn(async () => ({ methods: ["turn/interrupt"] })),
      };
      measureOnFileStateDb();
      const registry = createRegistry([], { codexClient: codex });
      const cancel = vi.spyOn(internals(registry).acpBackend, "cancelRunningSession");
      await internals(registry).usageTurnStartupRepair;
      // A negative control: the measurement sees this database's commits.
      const { writes: seeded } = await measureSqliteWrites(async () => {
        await runTurn(registry, "codex", "turn-finished");
        await internals(registry).emit(codexInterrupted("turn-finished"));
      });
      expect(seeded.commits).toBeGreaterThan(0);

      const { writes } = await measureSqliteWrites(async () => {
        await registry.stopRunningTurnsForShutdown();
      });

      expect(codex.interruptTurn).not.toHaveBeenCalled();
      expect(codex.getInitializeResult).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
      expect(writes.commits).toBe(0);
    });

    it("does not start a queued turn in place of one it stopped", async () => {
      const registry: DesktopBackendRegistry = createRegistry([], {
        codexClient: codexWithInterrupt(async (params) => {
          await internals(registry).emit(codexInterrupted(params.turnId));
          await internals(registry).emit({
            backend: "codex",
            notification: {
              method: "thread/status/changed",
              params: { threadId: "thread-1", status: { type: "idle" } },
            },
          } as AgentEvent);
          return params;
        }),
      });
      await runTurn(registry, "codex", "turn-1");
      const startTurnNow = vi.spyOn(internals(registry), "startTurnNow")
        .mockResolvedValue({ backend: "codex", threadId: "thread-1", turnId: "turn-2" });
      const queued = await internals(registry).threadTurnQueue.submit({
        backend: "codex",
        threadId: "thread-1",
        origin: "manual",
        input: [{ type: "text", text: "next" }],
      });
      expect(queued.status).toBe("queued");

      await registry.stopRunningTurnsForShutdown();
      // The release a terminal triggers runs after the terminal's listeners.
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(completedAt("turn-1")).toBe(1_800_000_004_000);
      expect(startTurnNow).not.toHaveBeenCalled();
    });
  });

  describe("startup repair", () => {
    const hour = 60 * 60_000;
    const seedOpenTurn = async (turnId: string, lastWriteAt: number) => {
      const line: ThreadUsageLineRecord = {
        backend: "codex", provider: "openai", threadId: `thread-${turnId}`, turnId,
        usageLineId: `line-${turnId}`, source: "live", scope: "turn", status: "pending",
        turnUsageAttributed: true, startedAt: lastWriteAt - hour, createdAt: lastWriteAt - hour,
        currency: "USD", priceStatus: "unpriced", model: "gpt-5.5",
        inputTokens: 10, cachedInputTokens: 0, uncachedInputTokens: 10, outputTokens: 1,
        reasoningOutputTokens: 0, totalTokens: 11, uncachedInputCostMicros: 0,
        cachedInputCostMicros: 0, outputCostMicros: 0, totalCostMicros: 0,
      };
      await store.upsertThreadUsageLine({ line });
      stateDb.raw.prepare("UPDATE thread_usage_lines SET updated_at = ? WHERE usage_line_id = ?")
        .run(lastWriteAt, line.usageLineId);
    };

    it("closes every earlier open turn when this is the profile's only runtime", async () => {
      const longAgo = Date.now() - 48 * hour;
      const justNow = Date.now() - 1_000;
      await seedOpenTurn("crashed-long-ago", longAgo);
      await seedOpenTurn("crashed-just-now", justNow);

      const registry = createRegistry(["runtime-self"]);
      await internals(registry).usageTurnStartupRepair;

      expect(completedAt("crashed-long-ago")).toBe(longAgo);
      expect(completedAt("crashed-just-now")).toBe(justNow);
      // A turn started after the repair is left for its own terminal event.
      await runTurn(registry, "codex", "live-turn");
      expect(completedAt("live-turn")).toBeNull();
    });

    it("leaves a turn another live runtime may still be running open for a day", async () => {
      const quietForTwoDays = Date.now() - 48 * hour;
      await seedOpenTurn("quiet", quietForTwoDays);
      await seedOpenTurn("peer-live", Date.now() - hour);

      const registry = createRegistry(["runtime-self", "runtime-peer"]);
      await internals(registry).usageTurnStartupRepair;

      expect(completedAt("quiet")).toBe(quietForTwoDays);
      expect(completedAt("peer-live")).toBeNull();
    });
  });
});
