import type { AgentEvent, AppServerBackendKind, ThreadUsageLineRecord } from "@pwragent/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { openInMemoryStateDb } from "./sqlite-test-utils";

// Every turn's pricing-ledger row needs an end time, including turns that end
// without a terminal event reaching the completion path. These drive the real
// registry against a real ledger.
describe("DesktopBackendRegistry usage turn ends", () => {
  let stateDb: StateDb;
  let store: SqliteOverlayStore;
  const registries: DesktopBackendRegistry[] = [];

  const createRegistry = (liveRuntimeInstanceIds: string[] = []) => {
    const registry = new DesktopBackendRegistry({
      codexClient: {
        close: async () => {},
        getInitializeResult: async () => ({ methods: [] }),
        listThreads: async () => [],
        onNotification: () => () => {},
        onPendingRequest: () => () => {},
      } as never,
      overlayStore: store,
      runtimeInstanceId: "runtime-self",
      resolveLiveProfileRuntimeInstanceIds: () => liveRuntimeInstanceIds,
    });
    registries.push(registry);
    return registry;
  };
  const internals = (registry: DesktopBackendRegistry) => registry as unknown as {
    emit(event: AgentEvent): Promise<void>;
    flushLiveThreadUsageLines(): Promise<void>;
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
    stateDb = openInMemoryStateDb();
    store = new SqliteOverlayStore(stateDb);
  });

  afterEach(async () => {
    for (const registry of registries.splice(0)) {
      await registry.close();
    }
    stateDb.close();
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
