import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildThreadIdentityKey,
  type AppServerBackendKind,
  type ContinueThreadEnvironmentStartupRequest,
  type ContinueThreadEnvironmentStartupResponse,
} from "@pwragent/shared";
import { registryModules } from "../app-server/backend-registry-wiring";
import {
  ThreadDirectoryService,
  type ThreadDirectoryServiceDependencies,
} from "../app-server/thread-directory-service";
import type { StateDb } from "../state/state-db";
import { registryContextStandIn } from "./helpers/registry-context-stand-in";
import { registryWithInMemoryStore } from "./helpers/registry-in-memory-fixture";

const databases: StateDb[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.restoreAllMocks();
});

/**
 * A real directory service over the given host, stores and lifecycle. The
 * collaborators are empty; this file tests the directory service's own rules.
 */
function directoryService(params: {
  host?: object | (() => object);
  overlayStore?: object;
  lifecycle?: { readonly closed: boolean };
  emit?: () => Promise<void>;
  dependencies?: Partial<ThreadDirectoryServiceDependencies>;
} = {}): ThreadDirectoryService {
  const context = registryContextStandIn({ overlayStore: params.overlayStore, lifecycle: params.lifecycle, emit: params.emit });
  const host = params.host;
  return new ThreadDirectoryService(context, {
    threadArchiveCoordinator: {} as never,
    threadWorkspaceService: {} as never,
    threadInspectionTools: {} as never,
    threadMcpConnections: {} as never,
    ...params.dependencies,
  }, () => (typeof host === "function" ? host() : host ?? {}) as never);
}

function internals(service: ThreadDirectoryService) {
  return service as unknown as {
    environmentLaunchContinuations: Map<string, Promise<ContinueThreadEnvironmentStartupResponse>>;
    pendingDirectoryRepairs: Map<string, Promise<void>>;
    launchpadCreationOperations: { cancelAll(): void };
    resumeEnvironmentLaunch(request: ContinueThreadEnvironmentStartupRequest): Promise<ContinueThreadEnvironmentStartupResponse>;
    startMaterializedLaunchpadRequest(request: unknown): Promise<ContinueThreadEnvironmentStartupResponse>;
    loadCodexThreadDirectoryRelationship(params: { reason: "selected-thread"; threadId: string }): Promise<void>;
  };
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

type StartupSignal = "activeTurn" | "historyStarted" | "scheduledStart" | "acknowledgedBefore";
const STARTUP_SIGNALS: StartupSignal[] = ["activeTurn", "historyStarted", "scheduledStart", "acknowledgedBefore"];

describe("environment startup continuation", () => {
  // Rule: continuing a thread whose environment setup failed refuses a thread
  // with an active turn, and a thread that already has a message (dropping its
  // pending launch). Otherwise it replays the retained launch request, or the
  // caller's fallback turn when none is retained, unless the thread was
  // already scheduled or acknowledged. With neither it refuses. Success drops
  // the retained launch, even when the acknowledgement that follows fails,
  // and acknowledges the failure; a failed replay surfaces the turn start
  // failure and keeps the launch.
  it("continues exactly the startups the rules admit (oracle)", async () => {
    await fc.assert(fc.asyncProperty(
      // A couple of signals at a time, so each one is regularly the only one.
      fc.subarray(STARTUP_SIGNALS, { maxLength: 2 }),
      fc.constantFrom<"none" | "starts" | "fails">("none", "starts", "fails"),
      fc.boolean(),
      fc.boolean(),
      async (signals, pending, fallback, acknowledgementFails) => {
        const has = (signal: StartupSignal) => signals.includes(signal);
        const request: ContinueThreadEnvironmentStartupRequest = {
          backend: "codex", threadId: "setup",
          ...(fallback ? { fallbackTurn: { input: [{ type: "text", text: "go" }] } } : {}),
        } as ContinueThreadEnvironmentStartupRequest;
        const deleted: unknown[] = [];
        const acknowledged: unknown[] = [];
        const startTurn = vi.fn(async () => ({ backend: "codex" as const, threadId: "setup", turnId: "fallback-turn" }));
        const service = directoryService({
          host: {
            threadHasActiveTurn: () => has("activeTurn"),
            pendingEnvironmentLaunchStore: {
              get: () => (pending === "none" ? undefined : { request: "retained" }),
              delete: (identity: unknown) => { deleted.push(identity); },
            },
            readThread: async () => ({ replay: { messages: has("historyStarted") ? [{}] : [], entries: [] } }),
            startTurn,
            invalidateThreadListCache: () => {},
          },
          overlayStore: {
            getThreadOverlayState: async () => ({
              ...(has("scheduledStart") ? { scheduledStart: { at: 1 } } : {}),
              ...(has("acknowledgedBefore") ? { codexEnvironmentRuntime: { setupFailureAcknowledgedAt: 1 } } : {}),
            }),
            acknowledgeThreadEnvironmentFailure: async (params: unknown) => {
              acknowledged.push(params);
              if (acknowledgementFails) throw new Error("acknowledgement failed");
              return false;
            },
          },
        });
        const replay = vi.spyOn(internals(service), "startMaterializedLaunchpadRequest").mockImplementation(async () => ({
          backend: "codex", threadId: "setup", turnId: "replayed-turn",
          ...(pending === "fails" ? { turnStartFailure: { message: "turn start failed" } } : {}),
        }) as ContinueThreadEnvironmentStartupResponse);

        let expected: { error: string } | { turnId: string };
        if (has("activeTurn")) expected = { error: "This thread already has an active turn. Refresh it to view the conversation." };
        else if (has("historyStarted")) expected = { error: "This thread has already started. Refresh it to view the conversation." };
        else if (pending === "fails") expected = { error: "turn start failed" };
        else if (pending === "starts") expected = { turnId: "replayed-turn" };
        else if (!fallback) expected = { error: "The original request is unavailable. Send your prompt again to start this thread." };
        else if (has("scheduledStart") || has("acknowledgedBefore")) {
          expected = { error: "This thread's environment startup has already been continued. Refresh it to view its state." };
        } else expected = { turnId: "fallback-turn" };

        const outcome = service.continueThreadEnvironmentStartup(request);
        const succeeded = "turnId" in expected;
        if (succeeded && acknowledgementFails) {
          await expect(outcome).rejects.toThrow("acknowledgement failed");
        } else if ("error" in expected) {
          await expect(outcome).rejects.toThrow(expected.error);
        } else {
          await expect(outcome).resolves.toMatchObject({ turnId: expected.turnId });
        }
        const dropsLaunch = succeeded || (!has("activeTurn") && has("historyStarted"));
        expect(deleted.length > 0).toBe(dropsLaunch);
        expect(acknowledged.length).toBe(succeeded ? 1 : 0);
        expect(replay).toHaveBeenCalledTimes(!has("activeTurn") && !has("historyStarted") && pending !== "none" ? 1 : 0);
        expect(startTurn).toHaveBeenCalledTimes("turnId" in expected && expected.turnId === "fallback-turn" ? 1 : 0);
        expect(internals(service).environmentLaunchContinuations.size).toBe(0);
      },
    ), { numRuns: 120 });
  });

  // Rule: concurrent continuations of one thread share one resume and its
  // result; other threads resume on their own; once it settles, the next
  // continuation resumes again.
  it("runs one continuation per thread at a time (property)", async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.constantFrom("north", "south"), { minLength: 1, maxLength: 8 }),
      async (threads) => {
        const service = directoryService();
        const gates = new Map<string, ReturnType<typeof deferred<ContinueThreadEnvironmentStartupResponse>>>();
        const resume = vi.spyOn(internals(service), "resumeEnvironmentLaunch").mockImplementation(async (request) => {
          const gate = deferred<ContinueThreadEnvironmentStartupResponse>();
          gates.set(request.threadId, gate);
          return await gate.promise;
        });
        const results = threads.map((threadId) => service.continueThreadEnvironmentStartup({ backend: "codex", threadId }));
        const distinct = [...new Set(threads)];
        expect(resume).toHaveBeenCalledTimes(distinct.length);
        for (const threadId of distinct) gates.get(threadId)!.resolve({ backend: "codex", threadId, turnId: `turn-${threadId}` });
        const settled = await Promise.all(results);
        expect(settled.map((result) => result.turnId)).toEqual(threads.map((threadId) => `turn-${threadId}`));
        expect(internals(service).environmentLaunchContinuations.size).toBe(0);
        const again = service.continueThreadEnvironmentStartup({ backend: "codex", threadId: threads[0]! });
        expect(resume).toHaveBeenCalledTimes(distinct.length + 1);
        gates.get(threads[0]!)!.reject(new Error("done"));
        await expect(again).rejects.toThrow("done");
        expect(internals(service).environmentLaunchContinuations.size).toBe(0);
      },
    ));
  });
});

describe("Codex environment runtime lock", () => {
  // Rule: environment runtime work for one thread never overlaps; work for
  // different threads does not wait on each other.
  it("serializes each thread's runtime work and only its own (property)", async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.constantFrom<AppServerBackendKind>("codex", "claude"), { minLength: 1, maxLength: 6 }),
      fc.array(fc.constantFrom("north", "south"), { minLength: 6, maxLength: 6 }),
      async (backends, threads) => {
        const service = directoryService();
        const running = new Map<string, number>();
        let maxSameKey = 0;
        const gates = backends.map(() => deferred());
        const started: number[] = [];
        const tasks = backends.map((backend, index) => {
          const key = buildThreadIdentityKey(backend, threads[index]!);
          return service.withCodexEnvironmentRuntimeLock(backend, threads[index]!, async () => {
            started.push(index);
            running.set(key, (running.get(key) ?? 0) + 1);
            maxSameKey = Math.max(maxSameKey, running.get(key)!);
            await gates[index]!.promise;
            running.set(key, running.get(key)! - 1);
            return index;
          });
        });
        // Let every admitted task start, however the lock chains its promises.
        await new Promise<void>((resolve) => { setImmediate(resolve); });
        // Before anything is released, exactly the first task of each thread runs.
        const firstOfKey = new Map<string, number>();
        backends.forEach((backend, index) => {
          const key = buildThreadIdentityKey(backend, threads[index]!);
          if (!firstOfKey.has(key)) firstOfKey.set(key, index);
        });
        expect([...started].sort()).toEqual([...firstOfKey.values()].sort());
        for (const gate of gates) gate.resolve();
        expect(await Promise.all(tasks)).toEqual(backends.map((_, index) => index));
        expect(maxSameKey).toBe(1);
      },
    ));
  });
});

describe("directory relationship repair", () => {
  // Rule: concurrent repairs of one thread share one load, a closed registry
  // repairs nothing, and a settled repair (resolved or rejected) leaves the
  // in-flight set so the next request loads again.
  it("loads one relationship per thread at a time and none once closed (property)", async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.constantFrom("north", "south"), { minLength: 1, maxLength: 8 }),
      fc.boolean(),
      fc.boolean(),
      async (threads, closed, fails) => {
        const service = directoryService({ lifecycle: { closed } });
        const gates = new Map<string, ReturnType<typeof deferred<void>>>();
        const load = vi.spyOn(internals(service), "loadCodexThreadDirectoryRelationship").mockImplementation(async (params) => {
          const gate = deferred<void>();
          gates.set(params.threadId, gate);
          await gate.promise;
        });
        const repairs = threads.map((threadId) => service.repairCodexThreadDirectoryRelationship({ reason: "selected-thread", threadId }));
        const distinct = [...new Set(threads)];
        expect(load).toHaveBeenCalledTimes(closed ? 0 : distinct.length);
        for (const gate of gates.values()) {
          if (fails) gate.reject(new Error("repair failed"));
          else gate.resolve();
        }
        const outcomes = await Promise.allSettled(repairs);
        expect(outcomes.every((outcome) => outcome.status === (fails && !closed ? "rejected" : "fulfilled"))).toBe(true);
        expect(internals(service).pendingDirectoryRepairs.size).toBe(0);
        if (!closed) {
          void service.repairCodexThreadDirectoryRelationship({ reason: "selected-thread", threadId: threads[0]! });
          expect(load).toHaveBeenCalledTimes(distinct.length + 1);
          gates.get(threads[0]!)!.resolve();
        }
      },
    ));
  });
});

describe("shutdown and construction", () => {
  it("flushes buffered environment action output at shutdown, and tolerates a store without it", () => {
    const flush = vi.fn();
    directoryService({ overlayStore: { flushThreadCodexEnvironmentActionLiveOutputs: flush } })
      .flushCodexEnvironmentActionLiveOutputsForShutdown();
    expect(flush).toHaveBeenCalledTimes(1);
    expect(() => directoryService({ overlayStore: {} }).flushCodexEnvironmentActionLiveOutputsForShutdown()).not.toThrow();
    const failing = vi.fn(() => { throw new Error("disk full"); });
    expect(() => directoryService({ overlayStore: { flushThreadCodexEnvironmentActionLiveOutputs: failing } })
      .flushCodexEnvironmentActionLiveOutputsForShutdown()).not.toThrow();
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it("cancels its launchpad creations for the registry's close", () => {
    const service = directoryService();
    const cancel = vi.spyOn(internals(service).launchpadCreationOperations, "cancelAll");
    service.cancelLaunchpadCreations();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("reads neither its host nor its stores while it is constructed", () => {
    const refuse = new Proxy({}, { get: () => { throw new Error("read during construction"); } });
    expect(() => directoryService({ host: () => refuse, overlayStore: refuse, lifecycle: refuse as never })).not.toThrow();
  });
});

describe("registry facades and ports", () => {
  const registryFixture = () => registryWithInMemoryStore(databases);

  it("returns the service's own result for each importer-facing member", async () => {
    const registry = registryFixture();
    try {
      const service = registryModules(registry).threadDirectoryService;
      const request = { backend: "codex", threadId: "t", directoryKey: "k" } as never;
      const cases: Array<[string & keyof ThreadDirectoryService, () => unknown, unknown[]]> = [
        ["ensureDirectoryLaunchpad", () => registry.ensureDirectoryLaunchpad(request), [request]],
        ["updateDirectoryLaunchpad", () => registry.updateDirectoryLaunchpad(request), [request]],
        ["resetDirectoryLaunchpad", () => registry.resetDirectoryLaunchpad(request), [request]],
        ["runCodexEnvironmentAction", () => registry.runCodexEnvironmentAction(request), [request]],
        ["stopCodexEnvironmentAction", () => registry.stopCodexEnvironmentAction(request), [request]],
        ["setCodexThreadEnvironment", () => registry.setCodexThreadEnvironment(request), [request]],
        ["materializeDirectoryLaunchpad", () => registry.materializeDirectoryLaunchpad(request), [request]],
        ["acknowledgeThreadEnvironmentFailure", () => registry.acknowledgeThreadEnvironmentFailure(request), [request]],
        ["continueThreadEnvironmentStartup", () => registry.continueThreadEnvironmentStartup(request), [request]],
        ["refreshThreadDirectoryRelationship", () => registry.refreshThreadDirectoryRelationship(request), [request]],
        ["manageLaunchpadCreation", () => registry.manageLaunchpadCreation(request), [request]],
      ];
      for (const [name, call, args] of cases) {
        const result = Promise.resolve({ name });
        const spy = vi.spyOn(service as unknown as Record<string, (...args: unknown[]) => unknown>, name).mockReturnValue(result);
        expect(call()).toBe(result);
        expect(spy.mock.calls[0]!.slice(0, args.length)).toEqual(args);
      }
    } finally {
      await registry.close();
    }
  });

  // The workspace service and archive coordinator reach these through their
  // hosts, so a port that stopped delegating would leave them a stale answer.
  it("routes the other modules' host ports to the service", async () => {
    const registry = registryFixture();
    try {
      const service = registryModules(registry).threadDirectoryService;
      const ports = registry.constructionPorts();
      const launchpad = Promise.resolve({} as never);
      vi.spyOn(service, "ensureDirectoryLaunchpad").mockReturnValue(launchpad);
      expect(ports.ensureDirectoryLaunchpad({ directoryKey: "k" } as never)).toBe(launchpad);
      const replaced = Promise.resolve({} as never);
      vi.spyOn(service, "replaceWorkspaceLinkedDirectory").mockReturnValue(replaced);
      expect(ports.replaceWorkspaceLinkedDirectory({ backend: "codex", threadId: "t" } as never)).toBe(replaced);
      const runtime = Promise.resolve(undefined);
      vi.spyOn(service, "buildForkedCodexEnvironmentRuntime").mockReturnValue(runtime);
      expect(ports.buildForkedCodexEnvironmentRuntime({ workMode: "local" })).toBe(runtime);
    } finally {
      await registry.close();
    }
  });

  it("cancels launchpad creations and flushes environment output when the registry closes", async () => {
    const registry = registryFixture();
    const service = registryModules(registry).threadDirectoryService;
    const cancel = vi.spyOn(service, "cancelLaunchpadCreations");
    const flush = vi.spyOn(service, "flushCodexEnvironmentActionLiveOutputsForShutdown");
    await registry.close();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledTimes(1);
  });
});
