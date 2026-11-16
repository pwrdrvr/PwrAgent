import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, CodexBackgroundTerminal, ThreadCodexInvalidIdRecovery } from "@pwragent/shared";
import { DEFAULT_CODEX_APP_SERVER_RECYCLE_SETTINGS } from "../codex-app-server/app-server-recycle-policy";
import { registryModules } from "../app-server/backend-registry-wiring";
import {
  CodexRuntimeSupervisor,
  type CodexRuntimeSupervisorDependencies,
} from "../app-server/codex-runtime-supervisor";
import type {
  CodexRetryableOperation,
  LiveCodexToolItem,
  PendingCodexInvalidIdRecovery,
} from "../app-server/backend-registry-types";
import type { StateDb } from "../state/state-db";
import { registryContextStandIn } from "./helpers/registry-context-stand-in";
import { registryWithInMemoryStore } from "./helpers/registry-in-memory-fixture";

const databases: StateDb[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function supervisor(params: {
  host?: object | (() => object);
  codex?: object;
  overlayStore?: object;
  lifecycle?: { closed: boolean };
  emit?: (event: AgentEvent) => Promise<void>;
  dependencies?: Partial<CodexRuntimeSupervisorDependencies>;
} = {}): CodexRuntimeSupervisor {
  const context = registryContextStandIn({
    overlayStore: params.overlayStore,
    providers: { codex: params.codex },
    lifecycle: params.lifecycle,
    emit: params.emit,
  });
  const host = params.host;
  return new CodexRuntimeSupervisor(context, {
    threadUsageLedger: { initializeTokenMiserLedger: async () => {} } as never,
    threadArchiveCoordinator: { threadLifecycleMutationCountRecords: new Map() } as never,
    threadWorkspaceService: { threadHandoffReservationRecords: new Set() } as never,
    resolveCodexAppServerRecycleSettingsFn: () => ({ ...DEFAULT_CODEX_APP_SERVER_RECYCLE_SETTINGS }),
    codexThreadIdleUnsubscribeMs: 1000,
    markManagedCodexRuntimeSwitchCompleteFn: () => {},
    ...params.dependencies,
  }, () => (typeof host === "function" ? host() : host ?? {}) as never);
}

function internals(service: CodexRuntimeSupervisor) {
  return service as unknown as {
    codexBackgroundTerminals: Map<string, CodexBackgroundTerminal[]>;
    liveCodexToolItemsByThread: Map<string, Map<string, LiveCodexToolItem>>;
    pendingCodexInvalidIdRecoveries: PendingCodexInvalidIdRecovery[];
    codexInvalidIdRecoveryAttemptedAt: Map<string, number>;
    codexInvalidIdRecoveryAbort: AbortController;
    backgroundTerminalReadRevisions: Map<string, number>;
    backgroundTerminalGeneration: number;
    codexAppServerRecycleTimer?: NodeJS.Timeout;
    codexIdleThreadTimer?: NodeJS.Timeout;
    publishCodexBackgroundTerminals(threadId: string, terminals: CodexBackgroundTerminal[]): void;
    pruneUnlistedCodexCommands(threadId: string, terminals: CodexBackgroundTerminal[]): void;
    resolveCodexInvalidIdRecoveryForkLineage(threadId: string): Promise<string[]>;
  };
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const nextTask = () => new Promise<void>((resolve) => { setImmediate(resolve); });
const terminal = (id: string, processId = id) => ({ itemId: id, processId, command: id }) as CodexBackgroundTerminal;

describe("managed runtime restart admission", () => {
  const signals = ["voice", "reserved", "backend", "terminal", "tool", "mode", "turn"] as const;
  // Rule: switch only at an idle Codex boundary. Every independent work
  // owner can hold it; unrelated Claude activity cannot hold a Codex switch.
  it("restarts exactly at an open, requested, idle Codex boundary (oracle)", async () => {
    await fc.assert(fc.asyncProperty(
      fc.subarray([...signals], { maxLength: 2 }),
      fc.constantFrom("open", "open", "closed", "unrequested"),
      fc.boolean(),
      async (busy, admission, managed) => {
        const close = vi.fn(async () => {});
        const reset = vi.fn();
        const complete = vi.fn();
        const ledger = vi.fn(async () => {});
        const prepare = vi.fn(async () => {});
        const client = { close, resetAppServerRestarts: reset };
        const host = {
          nativeVoiceLeases: busy.includes("voice") ? 1 : 0,
          reservedCodexStartThreadIds: new Set(busy.includes("reserved") ? ["t"] : []),
          backendActiveCodexThreadIds: new Set(busy.includes("backend") ? ["t"] : []),
          activeCodexTurnModes: new Map(busy.includes("mode") ? [["t:turn", "default"]] : []),
          activeTurnKeys: new Set(["claude:unrelated:turn", ...(busy.includes("turn") ? ["codex:t:turn"] : [])]),
          tokenMiserServerCapabilities: new WeakMap([[client, Promise.resolve(undefined)]]),
          tokenMiserReducerCapabilityState: "supported",
          tokenMiserCodeModeGroupingVersion: 1,
          tokenMiserPostToolUseExactOutputVersion: 1,
          tokenMiserRuntimePreparationFailure: "old runtime",
          tokenMiserStore: {},
          resolveTokenMiserEnabledFn: () => true,
          prepareTokenMiserRuntime: prepare,
        };
        const service = supervisor({ host, codex: client, lifecycle: { closed: admission === "closed" }, dependencies: {
          markManagedCodexRuntimeSwitchCompleteFn: complete,
          threadUsageLedger: { initializeTokenMiserLedger: ledger } as never,
        } });
        if (busy.includes("terminal")) internals(service).codexBackgroundTerminals.set("t", [terminal("cmd")]);
        if (busy.includes("tool")) internals(service).liveCodexToolItemsByThread.set("t", new Map());
        service.setRuntimeRestartPending(admission !== "unrequested");
        service.setManagedRuntimeSwitchPending(managed);
        const allowed = admission === "open" && busy.length === 0;
        expect(await service.maybeRestartCodexForManagedRuntimeChange()).toBe(allowed);
        expect(close).toHaveBeenCalledTimes(allowed ? 1 : 0);
        expect(reset).toHaveBeenCalledTimes(allowed ? 1 : 0);
        expect(complete).toHaveBeenCalledTimes(allowed && managed ? 1 : 0);
        expect(ledger).toHaveBeenCalledTimes(allowed ? 1 : 0);
        expect(prepare).toHaveBeenCalledTimes(allowed ? 1 : 0);
        expect(service.runtimeRestartPending).toBe(admission !== "unrequested" && !allowed);
        expect(service.managedRuntimeSwitchPending).toBe(managed && !allowed);
        expect(service.runtimeRestartPromise).toBeUndefined();
        if (allowed) {
          expect(host.tokenMiserServerCapabilities.has(client)).toBe(false);
          expect(host.tokenMiserReducerCapabilityState).toBeUndefined();
          expect(host.tokenMiserCodeModeGroupingVersion).toBeUndefined();
          expect(host.tokenMiserPostToolUseExactOutputVersion).toBeUndefined();
          expect(host.tokenMiserRuntimePreparationFailure).toBeUndefined();
        }
      },
    ));
  });

  it("keeps the switch requested after a failed close and completes it once on retry", async () => {
    const close = vi.fn().mockRejectedValueOnce(new Error("close failed")).mockResolvedValue(undefined);
    const complete = vi.fn();
    const service = supervisor({ codex: { close }, host: {
      nativeVoiceLeases: 0, reservedCodexStartThreadIds: new Set(), backendActiveCodexThreadIds: new Set(),
      activeCodexTurnModes: new Map(), activeTurnKeys: new Set(), tokenMiserServerCapabilities: new WeakMap(),
      resolveTokenMiserEnabledFn: () => false,
    }, dependencies: { markManagedCodexRuntimeSwitchCompleteFn: complete } });
    service.setRuntimeRestartPending(true);
    service.setManagedRuntimeSwitchPending(true);
    expect(await service.maybeRestartCodexForManagedRuntimeChange()).toBe(false);
    expect(service.runtimeRestartPending).toBe(true);
    expect(service.managedRuntimeSwitchPending).toBe(true);
    expect(service.runtimeRestartPromise).toBeUndefined();
    expect(await service.maybeRestartCodexForManagedRuntimeChange()).toBe(true);
    expect(close).toHaveBeenCalledTimes(2);
    expect(complete).toHaveBeenCalledTimes(1);
  });
});

describe("background terminals", () => {
  // Rule: a successful terminal list retires exactly the unlisted commands
  // whose turns ended. Live turns and other tool kinds keep their ownership.
  it("prunes only ended, unlisted commands (oracle)", () => {
    fc.assert(fc.property(
      fc.array(fc.record({ command: fc.boolean(), ended: fc.boolean(), listed: fc.boolean() }), { minLength: 1, maxLength: 12 }),
      (items) => {
        const service = supervisor();
        vi.spyOn(service, "maybeRestartCodexForManagedRuntimeChange").mockResolvedValue(false);
        const rows = items.map((item, index) => [`item-${index}`, {
          itemType: item.command ? "commandexecution" : "mcptoolcall", turnId: "turn", turnEnded: item.ended,
        }] as const);
        internals(service).liveCodexToolItemsByThread.set("t", new Map(rows));
        internals(service).pruneUnlistedCodexCommands("t", items.flatMap((item, index) => item.listed ? [terminal(`item-${index}`)] : []));
        const expected = rows.filter((_, index) => !items[index]!.command || !items[index]!.ended || items[index]!.listed).map(([id]) => id);
        expect([...(service.liveToolItemRecords.get("t")?.keys() ?? [])]).toEqual(expected);
        expect(service.liveToolItemRecords.has("t")).toBe(expected.length > 0);
        expect(service.maybeRestartCodexForManagedRuntimeChange).toHaveBeenCalledTimes(expected.length < rows.length ? 1 : 0);
        // Always exercise retirement of the last command. Independent
        // booleans alone rarely generate an entirely prunable collection.
        internals(service).liveCodexToolItemsByThread.set("last", new Map(rows.map(([id]) => [id, {
          turnId: "ended", itemType: "commandexecution", turnEnded: true,
        }])));
        internals(service).pruneUnlistedCodexCommands("last", []);
        expect(service.liveToolItemRecords.has("last")).toBe(false);
      },
    ));
  });

  // Rule: publish a changed set of (item, process) identities, including an
  // empty set; reordering and changing usage do not announce a membership.
  it("publishes membership changes only, while retaining the latest list (model)", () => {
    fc.assert(fc.property(
      fc.array(fc.uniqueArray(fc.integer({ min: 0, max: 3 }), { maxLength: 4 }), { minLength: 1, maxLength: 12 }),
      fc.boolean(),
      (snapshots, closed) => {
        const emit = vi.fn(async (_event: AgentEvent) => {});
        const service = supervisor({ emit, lifecycle: { closed } });
        let previous: string[] = [];
        let changes = 0;
        snapshots.forEach((ids, index) => {
          const rows = ids.map((id) => ({ ...terminal(`i-${id}`, `p-${id}`), cpuPercent: index }));
          const identities = ids.map((id) => `i-${id}:p-${id}`).sort();
          if (!closed && JSON.stringify(previous) !== JSON.stringify(identities)) changes += 1;
          internals(service).publishCodexBackgroundTerminals("t", rows);
          expect(service.backgroundTerminalRecords.get("t")).toEqual(rows.length ? rows : undefined);
          expect(emit).toHaveBeenCalledTimes(changes);
          if (changes && !closed) expect(emit.mock.calls.at(-1)![0].notification.method).toBe("thread/backgroundTasks/updated");
          previous = identities;
        });
      },
    ));
  });

  it("ignores reads made stale by a newer read, a lifecycle event or shutdown (property)", async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom("read", "event", "shutdown", "closed", "exit"), async (boundary) => {
      const first = deferred<{ supported: boolean; terminals: CodexBackgroundTerminal[] }>();
      const second = deferred<{ supported: boolean; terminals: CodexBackgroundTerminal[] }>();
      const list = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
      const emit = vi.fn(async () => {});
      const lifecycle = { closed: false };
      const client = { listBackgroundTerminals: list };
      const service = supervisor({ lifecycle, emit, host: {
        codexRetryableOperations: new Map(),
        withCodexThreadClient: async (_id: string, work: (client: object) => unknown) => await work(client),
      } });
      const old = service.listBackgroundTerminals({ backend: "codex", threadId: "t" });
      await nextTask();
      if (boundary === "read") {
        const newer = service.listBackgroundTerminals({ backend: "codex", threadId: "t" });
        second.resolve({ supported: true, terminals: [terminal("new")] });
        await newer;
      } else if (boundary === "event") {
        service.trackLiveCodexToolItem({ backend: "codex", notification: { method: "item/completed", params: { threadId: "t", item: { id: "old" } } } } as AgentEvent);
      } else if (boundary === "exit") await service.handleCodexAppServerUnexpectedExit(new Set());
      else if (boundary === "shutdown") service.clearBackgroundTerminalsForShutdown();
      else lifecycle.closed = true;
      first.resolve({ supported: true, terminals: [terminal("old")] });
      await old;
      expect(service.backgroundTerminalRecords.get("t")).toEqual(boundary === "read" ? [terminal("new")] : undefined);
      expect(emit).toHaveBeenCalledTimes(boundary === "read" ? 1 : 0);
      expect(internals(service).backgroundTerminalReadRevisions.size).toBe(0);
    }));
  });
});

function candidate(threadId: string, compact = false): CodexRetryableOperation {
  return compact
    ? { kind: "compact", params: { backend: "codex", threadId }, turnId: `failed-${threadId}` }
    : { kind: "turn", params: { backend: "codex", threadId, input: [{ type: "text", text: threadId }], messageOrigin: { kind: "pwragent", systemReason: "app-restart" } }, turnId: `failed-${threadId}` };
}

describe("invalid-ID recovery", () => {
  // Rule: duplicate observations share one queued recovery; a busy Codex
  // holds the FIFO; each persisted recovery repairs and resubmits at most
  // once, and a failed repair never resubmits. The barrier covers the drain.
  it("drains one persisted FIFO after work becomes idle (model)", async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.record({ compact: fc.boolean(), fails: fc.boolean(), duplicate: fc.boolean() }), { minLength: 1, maxLength: 6 }),
      async (requests) => {
        let busy = true;
        const repaired: string[] = [];
        const retried: Array<{ threadId: string; invalidIdRecoveryAttempted?: boolean; messageOrigin?: unknown }> = [];
        const writes: Array<{ threadId: string; recovery: ThreadCodexInvalidIdRecovery }> = [];
        const events: AgentEvent[] = [];
        const recover = vi.fn(async ({ threadId }: { threadId: string }) => {
          repaired.push(threadId);
          if (requests[Number(threadId.slice(2))]!.fails) throw new Error("repair refused");
          return { threadId, backupPath: "/contrived/backup", removedMessageIdCount: 1 };
        });
        const retry = async (params: typeof retried[number]) => {
          retried.push(params);
          return { backend: "codex", threadId: params.threadId, turnId: `retry-${params.threadId}` };
        };
        const service = supervisor({ codex: { recoverInvalidPersistedResponseMessageIds: recover }, emit: async (event) => { events.push(event); }, host: {
          hasActiveCodexWork: () => busy, listActiveCodexWorkThreadIds: () => busy ? ["other"] : [],
          codexRetryableOperations: new Map(), startTurnNow: retry, compactThreadNow: retry,
        }, overlayStore: {
          getThreadOverlayState: async ({ threadId }: { threadId: string }) => ({ turnFailureLog: [{ turnId: `failed-${threadId}`, occurredAt: 0 }] }),
          setTurnFailureCodexInvalidIdRecovery: async (write: typeof writes[number]) => { writes.push(structuredClone(write)); },
        } });
        const queued: PendingCodexInvalidIdRecovery[] = [];
        for (const [index, request] of requests.entries()) {
          const operation = candidate(`t-${index}`, request.compact);
          const recovery = await service.queueCodexInvalidIdRecovery(operation, "invalid message id");
          void recovery.completion.catch(() => {});
          queued.push(recovery);
          if (request.duplicate) expect(await service.queueCodexInvalidIdRecovery(operation, "duplicate")).toBe(recovery);
        }
        expect(service.pendingInvalidIdRecoveryRecords).toEqual(queued);
        const barrier = service.invalidIdRecoveryBarrier;
        expect(barrier).toBeInstanceOf(Promise);
        let released = false;
        void barrier!.then(() => { released = true; });
        service.maybeDrainCodexInvalidIdRecoveries();
        await nextTask();
        expect(repaired).toEqual([]);
        expect(released).toBe(false);
        busy = false;
        service.maybeDrainCodexInvalidIdRecoveries();
        const drain = service.invalidIdRecoveryDrain;
        expect(drain).toBeInstanceOf(Promise);
        await drain;
        await barrier;
        expect(repaired).toEqual(requests.map((_, index) => `t-${index}`));
        expect(retried.map((entry) => entry.threadId)).toEqual(requests.flatMap((entry, index) => entry.fails ? [] : [`t-${index}`]));
        expect(retried.every((entry) => entry.invalidIdRecoveryAttempted === true)).toBe(true);
        for (const [index, request] of requests.entries()) {
          const audit = writes.filter((write) => write.threadId === `t-${index}`).map((write) => write.recovery);
          expect(audit).toHaveLength(request.fails ? 2 : 4);
          expect(audit[0]!.attemptedAt).toBeGreaterThan(0);
          if (request.fails) await expect(queued[index]!.completion).rejects.toThrow("repair refused");
          else {
            expect(audit[1]!.repairedAt).toBeGreaterThan(audit[0]!.attemptedAt);
            expect(audit[2]!.retrySubmittedAt).toBeGreaterThan(audit[1]!.repairedAt!);
            expect(audit[3]!.retryTurnId).toBe(`retry-t-${index}`);
            await expect(queued[index]!.completion).resolves.toMatchObject({ threadId: `t-${index}`, turnId: `retry-t-${index}` });
            if (!request.compact) expect(retried.find((entry) => entry.threadId === `t-${index}`)!.messageOrigin).toEqual({ kind: "pwragent", systemReason: "app-restart" });
          }
        }
        expect(events.filter((event) => event.notification.method === "thread/codexInvalidIdRecovery/updated")
          .map((event) => (event.notification.params as { status: string }).status)).toEqual([
          ...requests.map(() => "waiting"), ...requests.flatMap((entry) => ["repairing", entry.fails ? "failed" : "succeeded"]),
        ]);
        expect(service.pendingInvalidIdRecoveryRecords).toEqual([]);
        expect(service.invalidIdRecoveryDrain).toBeUndefined();
        expect(service.invalidIdRecoveryBarrier).toBeUndefined();
        expect(released).toBe(true);
      },
    ), { numRuns: 35 });
  });

  it("fails closed when the durable reservation cannot be saved", async () => {
    const recover = vi.fn();
    const service = supervisor({ codex: { recoverInvalidPersistedResponseMessageIds: recover }, overlayStore: {
      getThreadOverlayState: async () => ({ turnFailureLog: [{ turnId: "failed-t", occurredAt: 0 }] }),
      setTurnFailureCodexInvalidIdRecovery: async () => { throw new Error("disk full"); },
    } });
    await expect(service.queueCodexInvalidIdRecovery(candidate("t"), "invalid id")).rejects.toThrow("disk full");
    expect(service.pendingInvalidIdRecoveryRecords).toEqual([]);
    expect(service.invalidIdRecoveryBarrier).toBeUndefined();
    expect(recover).not.toHaveBeenCalled();
  });

  it("refuses closed, unidentified, unlogged or recently attempted failures (oracle)", async () => {
    await fc.assert(fc.asyncProperty(
      fc.constantFrom("closed", "unidentified", "unlogged", "memory", "persisted", "log"),
      async (reason) => {
        const now = Date.now();
        const save = vi.fn(async () => {});
        const service = supervisor({ lifecycle: { closed: reason === "closed" }, overlayStore: {
          getThreadOverlayState: async () => ({
            ...(reason === "persisted" ? { codexInvalidIdRecoveryLastAttemptedAt: now } : {}),
            turnFailureLog: reason === "unlogged" ? [] : [{ turnId: "failed-t", occurredAt: 0,
              ...(reason === "log" ? { codexInvalidIdRecovery: { attemptedAt: now, attemptId: "old" } } : {}),
            }],
          }),
          setTurnFailureCodexInvalidIdRecovery: save,
        } });
        if (reason === "memory") internals(service).codexInvalidIdRecoveryAttemptedAt.set("t", now);
        const operation = candidate("t");
        if (reason === "unidentified") operation.turnId = undefined;
        const refusal = reason === "closed" ? "Desktop backend registry is closed"
          : reason === "unidentified" ? "requires the failed turn id"
            : reason === "unlogged" ? "could not find failed turn"
              : "already attempted";
        await expect(service.queueCodexInvalidIdRecovery(operation, "invalid id")).rejects.toThrow(refusal);
        expect(save).not.toHaveBeenCalled();
        expect(service.pendingInvalidIdRecoveryRecords).toEqual([]);
        expect(service.invalidIdRecoveryBarrier).toBeUndefined();
      },
    ));
  });

  it("follows fork provenance in order and refuses cycles (oracle)", async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 10 }), fc.boolean(), async (length, cyclic) => {
      const service = supervisor({ overlayStore: { getThreadOverlayState: async ({ threadId }: { threadId: string }) => {
        const index = Number(threadId);
        return { forkSourceThreadId: index < length ? String(index + 1) : cyclic ? "0" : undefined };
      } } });
      const lineage = internals(service).resolveCodexInvalidIdRecoveryForkLineage("0");
      if (cyclic) await expect(lineage).rejects.toThrow("cyclic fork provenance");
      else expect(await lineage).toEqual(Array.from({ length }, (_, index) => String(index + 1)));
    }));
  });
});

describe("registry adapters and shutdown", () => {
  it("reads no host or store port while constructing", () => {
    const refuse = new Proxy({}, { get: () => { throw new Error("read during construction"); } });
    expect(() => supervisor({ host: () => { throw new Error("host during construction"); }, overlayStore: refuse, lifecycle: refuse as never })).not.toThrow();
  });

  it("clears terminal reads, aborts recovery, rejects queued work and stops timers", async () => {
    vi.useFakeTimers();
    const service = supervisor({ host: { shutdownRequested: false } });
    const data = internals(service);
    data.codexBackgroundTerminals.set("t", [terminal("cmd")]);
    data.backgroundTerminalReadRevisions.set("t", 1);
    const generation = data.backgroundTerminalGeneration;
    service.clearBackgroundTerminalsForShutdown();
    expect(data.backgroundTerminalGeneration).toBe(generation + 1);
    expect(service.backgroundTerminalRecords.size).toBe(0);
    expect(data.backgroundTerminalReadRevisions.size).toBe(0);
    service.abortInvalidIdRecoveriesForShutdown();
    expect(data.codexInvalidIdRecoveryAbort.signal.aborted).toBe(true);
    const reject = vi.fn();
    data.pendingCodexInvalidIdRecoveries.push({ reject } as never);
    service.rejectPendingInvalidIdRecoveriesForShutdown();
    expect(reject).toHaveBeenCalledWith(expect.objectContaining({ message: "Desktop backend registry closed before Codex history recovery completed" }));
    expect(service.pendingInvalidIdRecoveryRecords).toEqual([]);
    service.startCodexAppServerRecycler();
    service.startCodexIdleThreadUnsubscriber();
    expect(vi.getTimerCount()).toBe(2);
    service.stopAppServerRecycler();
    expect(vi.getTimerCount()).toBe(1);
    service.stopIdleThreadUnsubscriber();
    expect(vi.getTimerCount()).toBe(0);
    expect(data.codexAppServerRecycleTimer).toBeUndefined();
    expect(data.codexIdleThreadTimer).toBeUndefined();
  });

  it("returns the module's exact results through every production facade", async () => {
    const registry = registryWithInMemoryStore(databases);
    try {
      const service = registryModules(registry).codexRuntimeSupervisor;
      const request = { backend: "codex", threadId: "t", processId: "p" } as const;
      const listener = () => {};
      const cases: Array<[keyof CodexRuntimeSupervisor, () => unknown, unknown[]]> = [
        ["listBackgroundTerminals", () => registry.listBackgroundTerminals(request), [request]],
        ["terminateBackgroundTerminal", () => registry.terminateBackgroundTerminal(request), [request]],
        ["startCodexIdleThreadUnsubscriber", () => registry.startCodexIdleThreadUnsubscriber(), []],
        ["startCodexAppServerRecycler", () => registry.startCodexAppServerRecycler(), []],
        ["readCodexAppServerDiagnostics", () => registry.readCodexAppServerDiagnostics(), []],
        ["onCodexAppServerRestartStatusChanged", () => registry.onCodexAppServerRestartStatusChanged(listener), [listener]],
        ["getCodexAppServerRestartStatus", () => registry.getCodexAppServerRestartStatus(), []],
        ["restartCodexAppServer", () => registry.restartCodexAppServer(), []],
      ];
      for (const [name, call, args] of cases) {
        const result = { name };
        const spy = vi.spyOn(service as unknown as Record<string, (...args: unknown[]) => unknown>, name).mockReturnValue(result);
        expect(call()).toBe(result);
        expect(spy).toHaveBeenCalledWith(...args);
      }
    } finally { await registry.close(); }
  });

  it("routes existing host reads, writes, exit and restart ports to the module", async () => {
    const registry = registryWithInMemoryStore(databases);
    try {
      const service = registryModules(registry).codexRuntimeSupervisor;
      const ports = registry.constructionPorts();
      expect(ports.codexBackgroundTerminals).toBe(service.backgroundTerminalRecords);
      ports.codexRuntimeRestartPending = true;
      expect(service.runtimeRestartPending).toBe(true);
      service.setRuntimeRestartPending(false);
      expect(ports.codexRuntimeRestartPending).toBe(false);
      ports.managedCodexRuntimeSwitchPending = true;
      expect(service.managedRuntimeSwitchPending).toBe(true);
      service.setManagedRuntimeSwitchPending(false);
      expect(ports.managedCodexRuntimeSwitchPending).toBe(false);
      const restart = Promise.resolve(true);
      vi.spyOn(service, "maybeRestartCodexForManagedRuntimeChange").mockReturnValue(restart);
      expect(ports.maybeRestartCodexForManagedRuntimeChange()).toBe(restart);
      const exit = Promise.resolve();
      const exited = vi.spyOn(service, "handleCodexAppServerUnexpectedExit").mockReturnValue(exit);
      const affected = new Set(["t"]);
      expect(ports.handleCodexAppServerUnexpectedExit(affected)).toBe(exit);
      expect(exited).toHaveBeenCalledWith(affected);
      for (const name of ["clearBackgroundTerminalsForShutdown", "abortInvalidIdRecoveriesForShutdown", "stopAppServerRecycler", "stopIdleThreadUnsubscriber", "rejectPendingInvalidIdRecoveriesForShutdown"] as const) vi.spyOn(service, name);
      await registry.close();
      for (const name of ["clearBackgroundTerminalsForShutdown", "abortInvalidIdRecoveriesForShutdown", "stopAppServerRecycler", "stopIdleThreadUnsubscriber", "rejectPendingInvalidIdRecoveriesForShutdown"] as const) expect(service[name]).toHaveBeenCalledTimes(1);
    } finally { await registry.close(); }
  });

  it("shows module-owned background work to registry navigation and quit readers", async () => {
    const registry = registryWithInMemoryStore(databases);
    try {
      const service = registryModules(registry).codexRuntimeSupervisor;
      internals(service).codexBackgroundTerminals.set("terminal", [terminal("cmd")]);
      internals(service).liveCodexToolItemsByThread.set("tool", new Map([["mcp", { turnId: "turn", itemType: "mcptoolcall" }]]));
      expect(registry.getInProgressThreadSnapshotForQuit().threadIds).toEqual(expect.arrayContaining(["codex:terminal", "codex:tool"]));
      const rows = registry.withNavigationSubAgentActivity([{ id: "terminal", source: "codex" } as never]);
      expect(rows[0]!.hasAgentCommands).toBe(true);
      expect(registry.getQuitBlockerDiagnostics()).toEqual(expect.objectContaining({
        contributors: expect.arrayContaining([expect.objectContaining({ sourceThreadId: "terminal" }), expect.objectContaining({ sourceThreadId: "tool" })]),
      }));
    } finally { await registry.close(); }
  });
});
