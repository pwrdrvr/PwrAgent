import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentEvent, AppServerBackendKind, ThreadUsageLineRecord } from "@pwragent/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import type { ClaudeBackendOptions } from "../claude/claude-backend";
import { ClaudeSessionStore, type ClaudeSession } from "../claude/claude-session-store";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { usageAccountKey } from "../usage-account-identity";
import {
  createTempStateDb,
  openInMemoryStateDb,
  removeTempStateDbDir,
} from "./sqlite-test-utils";

const logger = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("../log", () => ({ getMainLogger: () => logger }));

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
      claudeBackendOptions?: Partial<ClaudeBackendOptions>;
      codexClient?: Record<string, unknown>;
      runningTurnShutdownStopTimeoutMs?: number;
      resolveUsageAccountGroups?: () => Record<string, string>;
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
      resolveUsageAccountGroups: options.resolveUsageAccountGroups,
      claudeBackendOptions: options.claudeBackendOptions,
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
    refreshCodexQuotas(): Promise<void>;
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
    logger.warn.mockClear();
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

  it.each(["account", "configuration"])("records usage as unknown when %s identity lookup fails", async (failure) => {
    const registry = createRegistry([], {
      codexClient: { readAccount: async () => {
        if (failure === "account") throw new Error("Account unavailable");
        return { type: "chatgpt", accountId: "current" };
      } },
      resolveUsageAccountGroups: () => {
        if (failure === "configuration") throw new Error("Configuration unavailable");
        return {};
      },
    });
    await runTurn(registry, "codex", "turn-1");
    const { lines } = await store.readThreadPricing({ backend: "codex", threadId: "thread-1" });
    expect(lines).toHaveLength(1);
    expect(lines[0].accountKey).toBeUndefined();
    expect(lines[0].totalTokens).toBe(1_020);
  });

  it("records identity without limits and retains the start account through a login switch", async () => {
    let account = { type: "chatgpt" as const, accountId: "account-a", email: "same@example.test" };
    const readAccount = vi.fn(async () => ({ ...account }));
    const registry = createRegistry([], { codexClient: { readAccount } });
    await internals(registry).emit(started("codex", "turn-a"));
    account = { ...account, accountId: "account-b" };
    await internals(registry).emit(usage("codex", "turn-a"));
    await internals(registry).flushLiveThreadUsageLines();
    await runTurn(registry, "codex", "turn-b");
    const rows = (await store.readUsageActivity({ from: Date.now() - 60_000, to: Date.now() + 60_000 })).rows;
    expect(rows.find((row) => row.line.turnId === "turn-a")?.accountKey)
      .toBe(usageAccountKey({ ...account, accountId: "account-a" }));
    expect(rows.find((row) => row.line.turnId === "turn-b")?.accountKey).toBe(usageAccountKey(account));
    expect(readAccount).toHaveBeenCalledTimes(2);
  });

  it("snapshots explicit groups for ACP requests and leaves uncaptured historical turns unknown", async () => {
    let group = "team-account";
    const registry = createRegistry([], { resolveUsageAccountGroups: () => ({ "acp:grok": group }) });
    await internals(registry).emit(started("acp:grok", "turn-a"));
    group = "other-account";
    await internals(registry).emit(usage("acp:grok", "turn-a"));
    await internals(registry).flushLiveThreadUsageLines();
    await runTurn(registry, "acp:grok", "turn-b");
    const { lines } = await store.readThreadPricing({ backend: "acp:grok", threadId: "thread-1" });
    expect(lines.find((line) => line.turnId === "turn-a")?.accountKey).toBe(usageAccountKey(undefined, "team-account"));
    expect(lines.find((line) => line.turnId === "turn-b")?.accountKey).toBe(usageAccountKey(undefined, "other-account"));
    await internals(registry).emit(usage("acp:grok", "historical-without-start"));
    await internals(registry).flushLiveThreadUsageLines();
    expect((await store.readThreadPricing({ backend: "acp:grok", threadId: "thread-1" })).lines
      .find((line) => line.turnId === "historical-without-start")?.accountKey).toBeUndefined();
  });

  it("does not relabel a cached limit reading after the explicit account group changes", async () => {
    let group = "original-account";
    const readRateLimits = vi.fn(async () => [{ name: "5h limit", usedPercent: 10, windowMinutes: 300 }]);
    const registry = createRegistry([], {
      codexClient: { readRateLimits }, resolveUsageAccountGroups: () => ({ codex: group }),
    });
    Object.assign(registry, { codexBackendSummary: { kind: "codex", label: "Codex", available: true,
      rateLimits: [], account: { type: "apiKey" } } });
    const window = { from: Date.now() - 60_000, to: Date.now() + 60_000 };
    await internals(registry).refreshCodexQuotas();
    expect((await registry.readUsageActivity(window)).limitObservation?.accountKey)
      .toBe(usageAccountKey(undefined, group));
    group = "new-account";
    await internals(registry).refreshCodexQuotas();
    expect((await registry.readUsageActivity(window)).limitObservation?.accountKey)
      .toBe(usageAccountKey(undefined, "original-account"));
    expect(readRateLimits).toHaveBeenCalledTimes(1);
    await runTurn(registry, "codex", "new-account-turn");
    await internals(registry).emit({ backend: "codex", notification: { method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "new-account-turn", status: "completed" } } } } as AgentEvent);
    const snapshot = await store.readUsageActivity(window);
    expect(snapshot.rows[0].accountKey).toBe(usageAccountKey(undefined, group));
    expect(snapshot.limitHistory).toEqual([]);
  });

  it("relays Claude's account limits and records them on its turns, apart from Codex's", async () => {
    const registry = createRegistry();
    const reading = {
      observedAt: Date.now() - 1_000, provider: "anthropic", accountKey: "claude-account", planType: "max",
      limits: [{ name: "Weekly limit", limitId: "seven_day", usedPercent: 41, windowMinutes: 10_080 }],
    };
    const claude = (registry as unknown as { claudeBackend: object }).claudeBackend;
    vi.spyOn(claude as { usageAccountKey(): Promise<string | undefined> }, "usageAccountKey")
      .mockResolvedValue("claude-account");
    vi.spyOn(claude as { limitObservation(): unknown }, "limitObservation").mockReturnValue(reading);
    await runTurn(registry, "claude", "claude-turn");
    await internals(registry).emit({ backend: "claude", notification: { method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "claude-turn", status: "completed" } } } } as AgentEvent);
    const snapshot = await registry.readUsageActivity({ from: Date.now() - 60_000, to: Date.now() + 60_000 });
    expect(snapshot.rows[0].accountKey).toBe("claude-account");
    expect(snapshot.limitObservations).toEqual([reading]);
    expect(snapshot.providerLimitHistory).toEqual([reading]);
    // A viewer that predates other providers charts every `limitHistory` reading as Codex.
    expect(snapshot.limitHistory).toEqual([]);
    expect(snapshot.limitObservation).toBeUndefined();
  });

  it("keys Claude's reading by the operator's account group, as its turns are", async () => {
    const registry = createRegistry([], { resolveUsageAccountGroups: () => ({ claude: "team" }) });
    const claude = (registry as unknown as { claudeBackend: object }).claudeBackend;
    vi.spyOn(claude as { limitObservation(): unknown }, "limitObservation").mockReturnValue({
      observedAt: Date.now(), provider: "anthropic", accountKey: "claude-account", limits: [] });
    await runTurn(registry, "claude", "claude-turn");
    const snapshot = await registry.readUsageActivity({ from: Date.now() - 60_000, to: Date.now() + 60_000 });
    expect(snapshot.rows[0].accountKey).toBe(usageAccountKey(undefined, "team"));
    expect(snapshot.limitObservations?.[0].accountKey).toBe(usageAccountKey(undefined, "team"));
  });

  it("attributes refreshed quotas to the account read used for metadata recovery", async () => {
    const previous = { type: "chatgpt" as const, accountId: "previous", email: "same@example.test" };
    const current = { ...previous, accountId: "current" };
    const readAccount = vi.fn(async () => current);
    const registry = createRegistry([], {
      codexClient: { readAccount, readRateLimits: async () => [{ name: "5h limit", usedPercent: 22 }] },
    });
    Object.assign(registry, { codexBackendSummary: { kind: "codex", label: "Codex", available: true,
      account: previous, rateLimits: [{ name: "5h limit", usedPercent: 54 }] } });
    await internals(registry).refreshCodexQuotas();
    const snapshot = await registry.readUsageActivity({ from: Date.now() - 60_000, to: Date.now() + 60_000 });
    expect(readAccount).toHaveBeenCalledTimes(1);
    expect((await registry.listBackends()).backends[0].account).toEqual(current);
    expect(snapshot.limitObservation?.accountKey).toBe(usageAccountKey(current));
    expect(snapshot.limitObservation?.limits[0].usedPercent).toBe(22);
  });

  it("retains the requested account group when Settings changes during the account read", async () => {
    let group = "original-account";
    const registry = createRegistry([], {
      codexClient: {
        readAccount: async () => {
          group = "new-account";
          return { type: "chatgpt", accountId: "current" };
        },
        readRateLimits: async () => [{ name: "5h limit", usedPercent: 22 }],
      },
      resolveUsageAccountGroups: () => ({ codex: group }),
    });
    Object.assign(registry, { codexBackendSummary: { kind: "codex", label: "Codex", available: true, rateLimits: [] } });
    await internals(registry).refreshCodexQuotas();
    const snapshot = await registry.readUsageActivity({ from: Date.now() - 60_000, to: Date.now() + 60_000 });
    expect(group).toBe("new-account");
    expect(snapshot.limitObservation?.accountKey).toBe(usageAccountKey(undefined, "original-account"));
  });

  it.each(["account", "configuration"])("refreshes quotas with unknown attribution when %s lookup fails", async (failure) => {
    const account = { type: "chatgpt" as const, accountId: "previous", email: "user@example.test" };
    const readAccount = vi.fn(async () => {
      if (failure === "account") throw new Error("Account unavailable");
      return account;
    });
    const registry = createRegistry([], {
      codexClient: { readAccount, readRateLimits: async () => [{ name: "5h limit", usedPercent: 22 }] },
      resolveUsageAccountGroups: () => {
        if (failure === "configuration") throw new Error("Configuration unavailable");
        return {};
      },
    });
    Object.assign(registry, { codexBackendSummary: { kind: "codex", label: "Codex", available: true,
      account, rateLimits: [{ name: "5h limit", usedPercent: 54 }] } });
    await internals(registry).refreshCodexQuotas();
    const snapshot = await registry.readUsageActivity({ from: Date.now() - 60_000, to: Date.now() + 60_000 });
    expect(readAccount).toHaveBeenCalledTimes(1);
    expect((await registry.listBackends()).backends[0].account).toEqual(account);
    expect(snapshot.limitObservation?.accountKey).toBeUndefined();
    expect(snapshot.limitObservation?.limits[0].usedPercent).toBe(22);
  });

  it("clears stale quotas when only the refreshed account ID changes", async () => {
    const previous = { type: "chatgpt" as const, accountId: "previous", email: "same@example.test" };
    const current = { ...previous, accountId: "current" };
    const registry = createRegistry([], {
      codexClient: { readAccount: async () => current, readRateLimits: async () => { throw new Error("Quota unavailable"); } },
    });
    Object.assign(registry, { codexBackendSummary: { kind: "codex", label: "Codex", available: true,
      account: previous, rateLimits: [{ name: "5h limit", usedPercent: 54 }] } });
    await internals(registry).refreshCodexQuotas();
    expect((await registry.listBackends()).backends[0]).toMatchObject({ account: current, rateLimits: [] });
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

    it("keeps the shutdown deadline while an answered ACP terminal is still adopting its branch", async () => {
      const registry = createRegistry();
      const internal = registry as unknown as {
        activeTurnKeys: ReadonlySet<string>;
        adoptThreadBranchChangeFromActiveTurn(params: { backend: AppServerBackendKind; threadId: string }): Promise<void>;
      };
      let releaseBranch!: () => void;
      let branchEntered!: () => void;
      const branch = new Promise<void>((resolve) => { releaseBranch = resolve; });
      const entered = new Promise<void>((resolve) => { branchEntered = resolve; });
      const adopt = vi.spyOn(internal, "adoptThreadBranchChangeFromActiveTurn")
        .mockImplementation(async () => { branchEntered(); await branch; });
      let terminal: Promise<void> | undefined;
      vi.spyOn(internals(registry).acpBackend, "cancelRunningSession")
        .mockImplementation(async () => {
          terminal = internals(registry).emit(acpCancelled(acpTurnId));
          return true;
        });
      await runTurn(registry, "acp:grok", acpTurnId);
      const heard = vi.fn();
      registry.onEvent((event) => {
        if (event.notification.method === "turn/cancelled") heard(event);
      });
      vi.useFakeTimers();
      try {
        let stopped = false;
        const stop = registry.stopRunningTurnsForShutdown().then(() => { stopped = true; });
        await entered;
        expect(internal.activeTurnKeys.size).toBe(0);
        expect(heard).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1_999);
        expect(stopped).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await stop;
        expect(logger.warn).toHaveBeenCalledWith(
          "running turns still unanswered at the shutdown deadline",
          expect.objectContaining({
            durationMs: 2_000,
            turns: 1,
            unanswered: 0,
            unasked: 0,
            requests: { requested: 1, failed: 0, unsupported: 0 },
          }),
        );
        expect(heard).not.toHaveBeenCalled();
        releaseBranch();
        await terminal;
        expect(heard).toHaveBeenCalledWith(expect.objectContaining({
          notification: expect.objectContaining({ method: "turn/cancelled" }),
        }));
      } finally {
        releaseBranch();
        await terminal;
        adopt.mockRestore();
        vi.useRealTimers();
      }
    });

    it("waits only for the turns a backend was asked to stop", async () => {
      // This Codex has no turn/interrupt, so no terminal is coming for its
      // turn. Only the ACP turn is worth waiting for.
      const registry: DesktopBackendRegistry = createRegistry([], {
        runningTurnShutdownStopTimeoutMs: 60_000,
      });
      const cancel = vi.spyOn(internals(registry).acpBackend, "cancelRunningSession")
        .mockImplementation(async () => {
          void internals(registry).emit(acpCancelled(acpTurnId));
          return true;
        });
      await runTurn(registry, "codex", "turn-unstoppable");
      await runTurn(registry, "acp:grok", acpTurnId);
      const beforeStop = Date.now();

      await registry.stopRunningTurnsForShutdown();

      expect(cancel).toHaveBeenCalledTimes(1);
      expect(Date.now() - beforeStop).toBeLessThan(1_000);
      expect(completedAt(acpTurnId)).toBe(1_800_000_007_000);
      expect(completedAt("turn-unstoppable")).toBeNull();

      await registry.close();
      registries.splice(registries.indexOf(registry), 1);
      expect(completedAt("turn-unstoppable")).toBeGreaterThanOrEqual(beforeStop);
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

  // Only a UUIDv7 id carries a start time. Claude turn ids are UUIDv4, whose
  // leading bits are random: read as milliseconds, this one is Jan 7, 6903.
  describe("turn start times", () => {
    const claudeTurnId = "8d94fa8e-3a98-464b-914e-9b77c8bedc71";
    const startedAt = (turnId: string) => (stateDb.raw.prepare(
      "SELECT started_at FROM thread_usage_turns WHERE turn_id = ?",
    ).get(turnId) as { started_at: number } | undefined)?.started_at;
    const lineStartedAt = async (backend: AppServerBackendKind) => {
      const { lines } = await store.readThreadPricing({ backend, threadId: "thread-1" });
      expect(lines).toHaveLength(1);
      return lines[0].startedAt;
    };

    it("records the start a Claude turn reports, not a time read from its UUIDv4 id", async () => {
      const reported = 1_792_856_921_084;
      const registry = createRegistry();
      await internals(registry).emit({
        backend: "claude",
        notification: {
          method: "turn/started",
          params: {
            threadId: "thread-1",
            turn: { id: claudeTurnId, status: "in_progress", startedAt: reported },
          },
        },
      });
      await internals(registry).emit(usage("claude", claudeTurnId));
      await internals(registry).flushLiveThreadUsageLines();

      expect(startedAt(claudeTurnId)).toBe(reported);
      expect(await lineStartedAt("claude")).toBe(reported);
    });

    it("does not read a start time from a UUIDv4 turn id", async () => {
      const before = Date.now();
      const registry = createRegistry();
      await internals(registry).emit(started("claude", claudeTurnId));
      await internals(registry).emit(usage("claude", claudeTurnId));
      await internals(registry).flushLiveThreadUsageLines();

      const recorded = startedAt(claudeTurnId);
      expect(recorded).toBeGreaterThanOrEqual(before);
      expect(recorded).toBeLessThanOrEqual(Date.now());
    });

    it("still reads the start time from a Codex UUIDv7 turn id", async () => {
      const turnId = "019a3c1f-5e2b-7a82-b681-9ca30ad325fa";
      const registry = createRegistry();
      await runTurn(registry, "codex", turnId);

      expect(startedAt(turnId)).toBe(0x019a3c1f5e2b);
      expect(await lineStartedAt("codex")).toBe(0x019a3c1f5e2b);
    });

    it("repairs stored turn times once, from Codex turn ids and PwrAgent's own Claude transcripts", async () => {
      const claudeRoot = await mkdtemp(path.join(os.tmpdir(), "pwragent-claude-starts-"));
      try {
        const claudeStore = new ClaudeSessionStore(claudeRoot);
        const claudeThreadId = "3b1e9a4c-5d2f-4e6a-9b7c-0d1e2f3a4b5c";
        const userAt = 1_792_856_921_084;
        const completedAt = 1_792_856_926_771;
        const turn = { id: claudeTurnId, status: "failed" as const, completedAt };
        await claudeStore.save({
          cwd: claudeRoot,
          thread: { id: claudeThreadId, source: "claude", title: "Untitled thread", createdAt: userAt, updatedAt: completedAt },
        } as unknown as ClaudeSession);
        await claudeStore.append(claudeThreadId, [
          { type: "message", id: `user:${claudeTurnId}`, role: "user", text: "Hi", createdAt: userAt, turn },
          { type: "message", id: "answer", role: "assistant", text: "Hello", createdAt: userAt + 3_065, turn },
        ]);
        const seed = (
          backend: AppServerBackendKind,
          threadId: string,
          turnId: string,
          startedAt = 0x8d94fa8e3a98,
        ) => store.upsertThreadUsageLine({ line: {
          backend, provider: backend === "claude" ? "anthropic" : "openai", threadId, turnId,
          usageLineId: `line-${turnId}`, source: "live", scope: "turn", status: "finalized",
          turnUsageAttributed: true, startedAt, createdAt: completedAt, completedAt,
          currency: "USD", priceStatus: "unpriced", model: "claude-haiku-5-5",
          inputTokens: 10, cachedInputTokens: 0, uncachedInputTokens: 10, outputTokens: 1,
          reasoningOutputTokens: 0, totalTokens: 11, uncachedInputCostMicros: 0,
          cachedInputCostMicros: 0, outputCostMicros: 0, totalCostMicros: 0,
        } });
        await seed("claude", claudeThreadId, claudeTurnId);
        // No transcript to recover from: the start becomes unknown.
        await seed("claude", "0f2b7c1e-3d4a-4b5c-8d6e-7f8091a2b3c4", "8f477f20-e354-4c1a-9d2e-1f0a5b6c7d8e");
        // An earlier launch reset this Codex turn's start to its first usage
        // write; its UUIDv7 id still carries the real start.
        const codexTurnId = "01a16e99-96ab-7a82-b681-9ca30ad325fa";
        await seed("codex", "codex-thread", codexTurnId, completedAt);
        // The same rewrite cleared the Claude turn's end; startup inferred one.
        stateDb.raw.prepare(
          "UPDATE thread_usage_turns SET completed_at = ?, completed_at_inferred = 1 WHERE turn_id = ?",
        ).run(completedAt + 60_000, claudeTurnId);
        expect(startedAt(claudeTurnId)).toBe(0x8d94fa8e3a98);
        const turnTimes = (turnId: string) => stateDb.raw.prepare(
          "SELECT started_at, completed_at, completed_at_inferred FROM thread_usage_turns WHERE turn_id = ?",
        ).get(turnId);

        const registry = createRegistry([], { claudeBackendOptions: { store: claudeStore } });
        await internals(registry).usageTurnStartupRepair;

        expect(turnTimes(claudeTurnId)).toEqual({
          started_at: userAt, completed_at: completedAt, completed_at_inferred: null,
        });
        expect(startedAt("8f477f20-e354-4c1a-9d2e-1f0a5b6c7d8e")).toBeNull();
        expect(startedAt(codexTurnId)).toBe(0x01a16e9996ab);
        const { lines } = await store.readThreadPricing({ backend: "claude", threadId: claudeThreadId });
        expect(lines[0].startedAt).toBe(userAt);

        // The repair runs once per profile: a later launch leaves the ledger alone.
        stateDb.raw.prepare("UPDATE thread_usage_turns SET started_at = ? WHERE turn_id = ?")
          .run(completedAt, codexTurnId);
        const relaunched = createRegistry([], { claudeBackendOptions: { store: claudeStore } });
        await internals(relaunched).usageTurnStartupRepair;
        expect(startedAt(codexTurnId)).toBe(completedAt);
      } finally {
        await rm(claudeRoot, { recursive: true, force: true });
      }
    });
  });
});
