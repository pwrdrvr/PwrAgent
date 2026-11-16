import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildThreadIdentityKey,
  type AppServerBackendKind,
  type AppServerThreadSummary,
  type LinkedDirectorySummary,
  type PendingThreadHandoffSummary,
  type PendingThreadWorkspaceMoveSummary,
  type ThreadOverlayState,
} from "@pwragent/shared";
import { registryModules } from "../app-server/backend-registry-wiring";
import {
  ThreadWorkspaceService,
  type ThreadWorkspaceServiceDependencies,
} from "../app-server/thread-workspace-service";
import type { StateDb } from "../state/state-db";
import { registryContextStandIn } from "./helpers/registry-context-stand-in";
import { registryWithInMemoryStore } from "./helpers/registry-in-memory-fixture";

const databases: StateDb[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/**
 * A real workspace service over the given host and providers. The archive
 * fences run their work directly; this file tests the workspace rules, not
 * the archive coordinator's.
 */
function workspaceService(params: {
  host?: object | (() => object);
  providers?: { codex?: object; claude?: object; acp?: object };
  overlayStore?: object;
  dependencies?: Partial<ThreadWorkspaceServiceDependencies>;
} = {}): ThreadWorkspaceService {
  const context = registryContextStandIn({ overlayStore: params.overlayStore, providers: params.providers });
  const host = params.host;
  return new ThreadWorkspaceService(context, {
    threadArchiveCoordinator: {
      recordArchiveWorkspaceChange: () => {},
      invalidateArchiveCleanupReads: () => {},
      withArchiveWorkspaceWrite: async <T>(_paths: readonly string[], work: () => Promise<T>) => await work(),
      withThreadLifecycleMutation: async <T>(_identity: unknown, work: (finish: () => void) => Promise<T>) => await work(() => {}),
    } as never,
    gitWorkspaceHandoffService: {} as never,
    ...params.dependencies,
  }, () => (typeof host === "function" ? host() : host ?? {}) as never);
}

function internals(service: ThreadWorkspaceService) {
  return service as unknown as {
    pendingThreadHandoffs: Map<string, PendingThreadHandoffSummary>;
    pendingThreadWorkspaceMoves: Map<string, PendingThreadWorkspaceMoveSummary>;
    pendingCodexWorkspaceCwdSyncs: Map<string, { cwd: string; promise: Promise<void> }>;
    runPendingThreadWorkspaceMove(workspaceMoveId: string): Promise<void>;
  };
}

type BusySignal = "pendingStart" | "queueBlocked" | "queued" | "pausedQueued";
const BUSY_SIGNALS: BusySignal[] = ["pendingStart", "queueBlocked", "queued", "pausedQueued"];

describe("instance handoff admission", () => {
  // Rule: a handoff runs only while its Codex thread has no pending start, no
  // queue hold and no queued prompt. A refusal names paused prompts when one
  // is queued. The thread is reserved for exactly the duration of the work:
  // a second handoff of it is refused meanwhile, other threads are not, and
  // the reservation is released whether the work succeeds or fails.
  it("admits only idle threads and holds each reservation for exactly its work (model)", async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.record({
        threadId: fc.constantFrom("north", "south"),
        // A few signals at a time, so each one is regularly the only one.
        signals: fc.subarray(BUSY_SIGNALS, { maxLength: 2 }),
        fails: fc.boolean(),
        nested: fc.constantFrom<"none" | "same" | "other">("none", "same", "other"),
      }), { minLength: 1, maxLength: 8 }),
      async (attempts) => {
        const busy = new Map<string, Set<BusySignal>>();
        const signals = (threadId: string) => busy.get(threadId) ?? new Set<BusySignal>();
        const host = {
          assertThreadNotHandingOff: (backend: AppServerBackendKind, threadId: string) => {
            if (service.threadHandoffReservationRecords.has(buildThreadIdentityKey(backend, threadId))) {
              throw new Error("This thread is being handed off. Wait for the transfer to finish.");
            }
          },
          threadStarts: { hasPending: ({ threadId }: { threadId: string }) => signals(threadId).has("pendingStart") },
          threadTurnQueue: {
            canStartImmediately: ({ threadId }: { threadId: string }) => !signals(threadId).has("queueBlocked"),
            getQueuedEntries: ({ threadId }: { threadId: string }) => [
              ...(signals(threadId).has("queued") ? [{ paused: false }] : []),
              ...(signals(threadId).has("pausedQueued") ? [{ paused: true }] : []),
            ],
          },
        };
        const service = workspaceService({ host });
        for (const attempt of attempts) {
          busy.clear();
          busy.set(attempt.threadId, new Set(attempt.signals));
          const key = buildThreadIdentityKey("codex", attempt.threadId);
          let ran = false;
          let nestedOutcome: "admitted" | "refused" | undefined;
          const result = service.withThreadHandoff(attempt.threadId, async () => {
            ran = true;
            expect([...service.threadHandoffReservationRecords]).toEqual([key]);
            if (attempt.nested !== "none") {
              const nestedThread = attempt.nested === "same" ? attempt.threadId : attempt.threadId === "north" ? "south" : "north";
              nestedOutcome = await service.withThreadHandoff(nestedThread, async () => "admitted" as const)
                .catch((error: Error) => {
                  expect(error.message).toBe("This thread is being handed off. Wait for the transfer to finish.");
                  return "refused" as const;
                });
            }
            if (attempt.fails) throw new Error("transfer failed");
            return "done";
          });
          if (attempt.signals.length > 0) {
            await expect(result).rejects.toThrow(attempt.signals.includes("pausedQueued")
              ? "Resume or delete paused queued prompts, and wait for source turns and queued prompts to finish before handoff."
              : "Wait for source turns and queued prompts to finish before handoff.");
            expect(ran).toBe(false);
          } else if (attempt.fails) {
            await expect(result).rejects.toThrow("transfer failed");
            expect(ran).toBe(true);
          } else {
            await expect(result).resolves.toBe("done");
          }
          if (ran && attempt.nested !== "none") {
            expect(nestedOutcome).toBe(attempt.nested === "same" ? "refused" : "admitted");
          }
          expect(service.threadHandoffReservationRecords.size).toBe(0);
        }
      },
    ), { numRuns: 60 });
  });
});

function move(
  overrides: Partial<PendingThreadWorkspaceMoveSummary> & Pick<PendingThreadWorkspaceMoveSummary, "workspaceMoveId">,
): PendingThreadWorkspaceMoveSummary {
  return {
    status: "queued", phase: "waiting_for_turn_boundary",
    sourceBackend: "codex", sourceThreadId: "manager", sourceTurnId: "turn-1",
    backend: "codex", threadId: "worker", direction: "local-to-worktree",
    createdAt: 1, updatedAt: 1,
    ...overrides,
  } as PendingThreadWorkspaceMoveSummary;
}

const moveArbitrary = fc.record({
  status: fc.constantFrom<PendingThreadWorkspaceMoveSummary["status"]>("queued", "running", "completed", "failed"),
  sourceBackend: fc.constantFrom<AppServerBackendKind>("codex", "claude"),
  sourceThreadId: fc.constantFrom("manager", "lead"),
  // A move with no source turn must never start from a turn end without one.
  sourceTurnId: fc.option(fc.constantFrom("turn-1", "turn-2"), { nil: undefined, freq: 3 }),
  backend: fc.constantFrom<AppServerBackendKind>("codex", "claude"),
  threadId: fc.constantFrom("worker", "helper"),
});

describe("pending workspace moves", () => {
  // Rule: a thread's turn submission waits exactly while one of its own moves
  // is queued or running. Another thread's move, a move on another backend,
  // and a finished move never hold it.
  it("blocks a thread exactly while one of its moves is queued or running (oracle)", () => {
    fc.assert(fc.property(
      fc.array(moveArbitrary, { maxLength: 6 }),
      fc.constantFrom<AppServerBackendKind>("codex", "claude"),
      fc.constantFrom("worker", "helper"),
      (moves, backend, threadId) => {
        const service = workspaceService();
        moves.forEach((fields, index) => internals(service).pendingThreadWorkspaceMoves.set(`move-${index}`, move({ ...fields, workspaceMoveId: `move-${index}` })));
        const expected = moves.some((candidate) => candidate.backend === backend && candidate.threadId === threadId
          && (candidate.status === "queued" || candidate.status === "running"));
        expect(service.threadHasBlockingWorkspaceMove({ backend, threadId })).toBe(expected);
      },
    ));
  });

  // Rule: a source turn's end starts exactly the queued moves that turn
  // requested, and nothing when the ending turn has no id. Ending several
  // turns starts the moves of each, in turn order.
  it("starts exactly the queued moves of each ended source turn (oracle)", () => {
    fc.assert(fc.property(
      fc.array(moveArbitrary, { maxLength: 6 }),
      fc.constantFrom<AppServerBackendKind>("codex", "claude"),
      fc.constantFrom("manager", "lead"),
      fc.subarray(["turn-1", "turn-2", "turn-3"]),
      fc.option(fc.constantFrom("turn-1", "turn-2"), { nil: undefined, freq: 3 }),
      (moves, backend, threadId, turnIds, turnId) => {
        const service = workspaceService();
        moves.forEach((fields, index) => internals(service).pendingThreadWorkspaceMoves.set(`move-${index}`, move({ ...fields, workspaceMoveId: `move-${index}` })));
        const started: string[] = [];
        vi.spyOn(internals(service), "runPendingThreadWorkspaceMove").mockImplementation(async (id) => { started.push(id); });
        const startedBy = (turn: string | undefined) => turn === undefined ? [] : moves.flatMap((candidate, index) =>
          candidate.status === "queued" && candidate.sourceBackend === backend && candidate.sourceThreadId === threadId
          && candidate.sourceTurnId === turn ? [`move-${index}`] : []);

        service.drainPendingThreadWorkspaceMovesForTerminalTurn({ backend, threadId, turnId });
        expect(started).toEqual(startedBy(turnId));
        started.length = 0;
        service.drainPendingThreadWorkspaceMovesForTurnIds({ backend, threadId, turnIds });
        expect(started).toEqual(turnIds.flatMap(startedBy));
      },
    ), { numRuns: 200 });
  });
});

const HOUR = 60 * 60 * 1000;

describe("pending handoff and move inspection", () => {
  // Rule: inspection forgets an entry an hour after its last update, matches
  // a backend on either side of the entry and a source thread exactly, and
  // lists the most recently updated first, ten by default.
  it("prunes, filters and orders handoffs and moves alike (model)", () => {
    fc.assert(fc.property(
      fc.array(fc.record({
        ageMinutes: fc.integer({ min: 0, max: 90 }),
        sourceBackend: fc.constantFrom<AppServerBackendKind>("codex", "claude"),
        backend: fc.constantFrom<AppServerBackendKind>("codex", "claude"),
        sourceThreadId: fc.constantFrom("manager", "lead"),
      }), { maxLength: 24 }),
      fc.option(fc.constantFrom<AppServerBackendKind | "all">("codex", "claude", "all"), { nil: undefined, freq: 3 }),
      fc.option(fc.constantFrom("manager", "lead"), { nil: undefined, freq: 3 }),
      // The default limit applies often enough to be checked.
      fc.option(fc.integer({ min: 1, max: 12 }), { nil: undefined, freq: 2 }),
      (entries, backend, sourceThreadId, limit) => {
        const now = 10 * HOUR;
        vi.useFakeTimers();
        vi.setSystemTime(now);
        const service = workspaceService();
        // Distinct update times keep the order total.
        const updatedAt = (index: number, ageMinutes: number) => now - ageMinutes * 60 * 1000 - index;
        entries.forEach((entry, index) => {
          const common = { ...entry, createdAt: 0, updatedAt: updatedAt(index, entry.ageMinutes) };
          internals(service).pendingThreadWorkspaceMoves.set(`id-${index}`, move({ ...common, workspaceMoveId: `id-${index}` }));
          internals(service).pendingThreadHandoffs.set(`id-${index}`, {
            ...common, handoffId: `id-${index}`, status: "starting", phase: "resolving_source",
            title: "Handoff", taskPreview: "Task", seedMode: "clean", groupingMode: "none", workspaceMode: "same",
          } as PendingThreadHandoffSummary);
        });
        const expected = entries
          .map((entry, index) => ({ ...entry, id: `id-${index}`, updatedAt: updatedAt(index, entry.ageMinutes) }))
          .filter((entry) => now - entry.updatedAt <= HOUR)
          .filter((entry) => !backend || backend === "all" || entry.backend === backend || entry.sourceBackend === backend)
          .filter((entry) => !sourceThreadId || entry.sourceThreadId === sourceThreadId)
          .sort((left, right) => right.updatedAt - left.updatedAt)
          .slice(0, limit ?? 10)
          .map((entry) => entry.id);
        const request = { ...(backend ? { backend } : {}), ...(sourceThreadId ? { sourceThreadId } : {}), ...(limit ? { limit } : {}) };
        expect(service.getPendingThreadWorkspaceMovesForInspection(request).map((entry) => entry.workspaceMoveId)).toEqual(expected);
        expect(service.getPendingThreadHandoffsForInspection(request).map((entry) => entry.handoffId)).toEqual(expected);
        const kept = entries.flatMap((entry, index) => now - updatedAt(index, entry.ageMinutes) <= HOUR ? [`id-${index}`] : []);
        expect([...service.pendingThreadWorkspaceMoveRecords.keys()]).toEqual(kept);
        vi.useRealTimers();
      },
    ), { numRuns: 200 });
  });
});

function handoffDirectory(cwd: string): LinkedDirectorySummary {
  return { id: `pwragent-handoff:${cwd}`, path: cwd, label: "Handoff" } as LinkedDirectorySummary;
}

describe("Codex workspace cwd synchronization", () => {
  // Rule: a listed Codex thread whose handoff directory differs from the cwd
  // Codex reports gets one workspace write per directory while a write is in
  // flight, however often the list repeats. A thread already recorded missing,
  // one without a handoff directory, or one Codex already reports in place is
  // never written. A write Codex answers with "thread not found" records the
  // thread missing; a success refreshes the Codex list. Either way the write
  // leaves the in-flight set once it settles.
  it("writes each moved thread's cwd once per pending directory (property)", async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.record({
        handoff: fc.option(fc.constantFrom("/contrived/a", "/contrived/b"), { nil: undefined }),
        provider: fc.constantFrom("/contrived/a", "/contrived/b", "/contrived/main"),
        knownMissing: fc.boolean(),
        outcome: fc.constantFrom("ok", "missing", "error"),
      }), { minLength: 1, maxLength: 4 }),
      fc.integer({ min: 1, max: 3 }),
      async (threads, passes) => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const writes: Array<{ threadId: string; cwd: string }> = [];
        const recorded: string[] = [];
        const refreshed: Array<AppServerBackendKind | undefined> = [];
        const ids = threads.map((_, index) => `thread-${index}`);
        const client = {
          updateThreadWorkspace: async (params: { threadId: string; cwd: string }) => {
            writes.push(params);
            await gate;
            const outcome = threads[ids.indexOf(params.threadId)]!.outcome;
            if (outcome === "missing") throw new Error(`thread not found: ${params.threadId}`);
            if (outcome === "error") throw new Error("Codex is restarting");
          },
        };
        const service = workspaceService({
          host: {
            isCodexThreadKnownMissing: (threadId: string) => threads[ids.indexOf(threadId)]!.knownMissing,
            withCodexThreadClient: async (_threadId: string, operation: (value: object) => Promise<void>) => await operation(client),
            invalidateThreadListCache: (backend?: AppServerBackendKind) => { refreshed.push(backend); },
            clearMissingCodexThread: () => {},
            recordMissingCodexThread: (threadId: string) => { recorded.push(threadId); },
          },
        });
        const summaries = threads.map((thread, index) => ({ id: ids[index], projectKey: thread.provider } as AppServerThreadSummary));
        const overlays = Object.fromEntries(threads.map((thread, index) => [ids[index], {
          backend: "codex", threadId: ids[index],
          extraLinkedDirectories: thread.handoff ? [handoffDirectory(thread.handoff)] : [],
        } as unknown as ThreadOverlayState]));
        for (let pass = 0; pass < passes; pass += 1) {
          service.schedulePendingCodexWorkspaceCwdSyncs({ overlaysByThreadId: overlays, threads: summaries });
        }
        const eligible = threads.flatMap((thread, index) =>
          !thread.knownMissing && thread.handoff && thread.handoff !== thread.provider ? [{ threadId: ids[index]!, cwd: thread.handoff }] : []);
        expect([...service.pendingCodexWorkspaceCwdSyncRecords].map(([threadId, sync]) => ({ threadId, cwd: sync.cwd }))).toEqual(eligible);
        await Promise.resolve();
        expect(writes).toEqual(eligible);
        release();
        await Promise.all([...service.pendingCodexWorkspaceCwdSyncRecords.values()].map(async (sync) => await sync.promise));
        expect(service.pendingCodexWorkspaceCwdSyncRecords.size).toBe(0);
        expect(recorded).toEqual(eligible.filter((sync) => threads[ids.indexOf(sync.threadId)]!.outcome === "missing").map((sync) => sync.threadId));
        expect(refreshed).toEqual(eligible.filter((sync) => threads[ids.indexOf(sync.threadId)]!.outcome === "ok").map(() => "codex"));
      },
    ), { numRuns: 60 });
  });
});

describe("module construction", () => {
  it("reads neither its host nor its stores while it is constructed", () => {
    const refuse = new Proxy({}, { get: () => { throw new Error("read during construction"); } });
    expect(() => workspaceService({ host: () => refuse, overlayStore: refuse, providers: { codex: refuse, claude: refuse, acp: refuse } })).not.toThrow();
  });
});

describe("registry facades and reads", () => {
  const registryFixture = () => registryWithInMemoryStore(databases);

  it("returns the service's own result for each importer-facing member", async () => {
    const registry = registryFixture();
    try {
      const service = registryModules(registry).threadWorkspaceService;
      const cases: Array<[string & keyof ThreadWorkspaceService, () => unknown, unknown[]]> = [
        ["readThreadHandoffSettings", () => registry.readThreadHandoffSettings({ backend: "codex", threadId: "t" }), [{ backend: "codex", threadId: "t" }]],
        ["handoffThreadWorkspace", () => registry.handoffThreadWorkspace({ backend: "codex", threadId: "t", direction: "local-to-worktree" }), [{ backend: "codex", threadId: "t", direction: "local-to-worktree" }]],
        ["recreateThreadWorktree", () => registry.recreateThreadWorktree({ backend: "codex", threadId: "t" } as never), [{ backend: "codex", threadId: "t" }]],
        ["moveThreadToMainCheckout", () => registry.moveThreadToMainCheckout({ backend: "codex", threadId: "t" } as never), [{ backend: "codex", threadId: "t" }]],
        ["allocateHandoffWorktreePath", () => registry.allocateHandoffWorktreePath("/contrived/repository"), ["/contrived/repository"]],
        ["exportThreadForHandoff", () => registry.exportThreadForHandoff("t"), ["t"]],
      ];
      for (const [name, call, args] of cases) {
        const result = Promise.resolve({ name });
        const spy = vi.spyOn(service as unknown as Record<string, (...args: unknown[]) => unknown>, name).mockReturnValue(result);
        expect(call()).toBe(result);
        expect(spy).toHaveBeenCalledWith(...args);
      }
      const work = async () => "work";
      const handoff = Promise.resolve("handed off");
      const withHandoff = vi.spyOn(service, "withThreadHandoff").mockReturnValue(handoff as never);
      expect(registry.withThreadHandoff("t", work)).toBe(handoff);
      expect(withHandoff).toHaveBeenCalledWith("t", work);
    } finally {
      await registry.close();
    }
  });

  // Modules 1 to 7 reach these through their hosts, so a port that stopped
  // delegating would leave them reading a stale or empty answer.
  it("routes the other modules' host ports to the service", async () => {
    const registry = registryFixture();
    try {
      const service = registryModules(registry).threadWorkspaceService;
      const ports = registry.constructionPorts();
      const handoff = Promise.resolve({} as never);
      vi.spyOn(service, "handoffThreadWorkspace").mockReturnValue(handoff);
      expect(ports.handoffThreadWorkspace({ backend: "codex", threadId: "t", direction: "local-to-worktree" })).toBe(handoff);
      vi.spyOn(service, "threadHasBlockingWorkspaceMove").mockReturnValue(true);
      expect(ports.threadHasBlockingWorkspaceMove({ backend: "codex", threadId: "t" })).toBe(true);
      const handoffs: PendingThreadHandoffSummary[] = [];
      vi.spyOn(service, "getPendingThreadHandoffsForInspection").mockReturnValue(handoffs);
      expect(ports.getPendingThreadHandoffsForInspection({ sourceThreadId: "t" })).toBe(handoffs);
      const moves: PendingThreadWorkspaceMoveSummary[] = [];
      vi.spyOn(service, "getPendingThreadWorkspaceMovesForInspection").mockReturnValue(moves);
      expect(ports.getPendingThreadWorkspaceMovesForInspection({ sourceThreadId: "t" })).toBe(moves);
      const drain = vi.spyOn(service, "drainPendingThreadWorkspaceMovesForTerminalTurn").mockImplementation(() => {});
      ports.drainPendingThreadWorkspaceMovesForTerminalTurn({ backend: "codex", threadId: "t", turnId: "u" });
      expect(drain).toHaveBeenCalledWith({ backend: "codex", threadId: "t", turnId: "u" });
      expect(ports.threadHandoffReservations).toBe(service.threadHandoffReservationRecords);
    } finally {
      await registry.close();
    }
  });

  it("shows the registry each reservation, move and cwd sync the service holds", async () => {
    const registry = registryFixture();
    try {
      const service = registryModules(registry).threadWorkspaceService;
      // A reserved thread refuses the registry's own handoff check.
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const reservation = service.withThreadHandoff("reserved", async () => await held);
      await vi.waitFor(() => expect(service.threadHandoffReservationRecords.size).toBe(1));
      await expect(registry.withThreadHandoff("reserved", async () => {})).rejects.toThrow("being handed off");
      release();
      await reservation;

      // A running move is in progress at quit.
      internals(service).pendingThreadWorkspaceMoves.set("move-1", move({ workspaceMoveId: "move-1", status: "running", threadId: "moving" }));
      expect(registry.getInProgressThreadSnapshotForQuit().threadIds).toContain(buildThreadIdentityKey("codex", "moving"));

      // The registry's settle helper waits for an in-flight cwd sync.
      let settle!: () => void;
      const sync = new Promise<void>((resolve) => { settle = resolve; });
      internals(service).pendingCodexWorkspaceCwdSyncs.set("syncing", { cwd: "/contrived/a", promise: sync });
      let settled = false;
      const waiting = registry.whenMissingCodexThreadWorkSettledForTests().then(() => { settled = true; });
      await Promise.resolve();
      expect(settled).toBe(false);
      internals(service).pendingCodexWorkspaceCwdSyncs.delete("syncing");
      settle();
      await waiting;
      expect(settled).toBe(true);
    } finally {
      await registry.close();
    }
  });
});
