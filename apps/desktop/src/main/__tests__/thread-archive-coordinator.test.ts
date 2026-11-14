import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildThreadIdentityKey,
  DEFAULT_CHECKOUT_HIBERNATION_POLICY,
  type AgentEvent,
  type AppServerBackendKind,
  type AppServerThreadSummary,
  type ThreadOverlayState,
  type WorktreeSnapshotSummary,
} from "@pwragent/shared";
import { createDesktopBackendRegistry, registryModules } from "../app-server/backend-registry-wiring";
import { ArchiveCleanupCancelledError } from "../app-server/archive-cleanup-queue";
import { isArchivedCheckoutCandidate } from "../app-server/checkout-hibernation";
import type { ThreadArchiveCoordinator } from "../app-server/thread-archive-coordinator";
import type { ThreadArchiveCandidate } from "../app-server/thread-archive-sweeper";
import { ArchiveCleanupCheckpointStore, type ArchiveCleanupIntent } from "../state/archive-cleanup-checkpoint";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import type { StateDb } from "../state/state-db";
import { archiveCoordinatorStandIn } from "./helpers/archive-coordinator-stand-in";
import { openInMemoryStateDb } from "./sqlite-test-utils";

const identity = { backend: "codex" as const, threadId: "sleeper" };
const key = buildThreadIdentityKey(identity.backend, identity.threadId);
const worktreePath = "/contrived/worktrees/sleeper";

const databases: StateDb[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.restoreAllMocks();
});

function snapshot(state: "hibernated" | "restored"): WorktreeSnapshotSummary {
  return {
    id: "snapshot-1", backend: "codex", threadId: identity.threadId,
    repositoryPath: "/contrived/repository", worktreePath,
    snapshotRef: "refs/pwragent/snapshots/sleeper", snapshotCommit: "abc123",
    sourceBranch: "feature/sleeper", sourceHead: "def456",
    createdAt: 1, archivedAt: 2, state, ignoredFilesExcluded: true,
  } as WorktreeSnapshotSummary;
}

/**
 * A coordinator over a one-thread hibernated checkout. Each restore attempt
 * takes the next scripted outcome: a failure message, or success.
 */
function hibernationFixture(outcomes: Array<string | undefined>, restoreOn: "send" | "open" = "send") {
  let hibernated = true;
  const attempts: number[] = [];
  const store = {
    getThreadOverlayState: async (): Promise<ThreadOverlayState> => ({
      backend: identity.backend, threadId: identity.threadId,
      worktreeSnapshots: [snapshot(hibernated ? "hibernated" : "restored")],
    } as ThreadOverlayState),
    upsertWorktreeSnapshot: async (params: { snapshot: WorktreeSnapshotSummary }) => {
      if (params.snapshot.state === "restored") hibernated = false;
    },
  };
  let gate: Promise<void> = Promise.resolve();
  const host = {
    runtimeInstanceId: "runtime-test",
    getCachedThreadSummary: () => undefined,
    invalidateThreadListCache: () => {},
    publishLocalEvent: async () => {},
    threadInfoStore: { invalidateSummaries: () => {} },
    threadTurnQueue: { scheduleThreadDrain: () => {} },
    worktreeRecoveryService: {
      recreate: async () => {
        attempts.push(attempts.length);
        await gate;
        const failure = outcomes[attempts.length - 1];
        return failure === undefined ? { status: "recreated" } : { status: "failed", message: failure };
      },
    },
  };
  const coordinator = archiveCoordinatorStandIn({
    registry: () => host,
    overlayStore: store,
    dependencies: { readCheckoutHibernationPolicy: () => ({ ...DEFAULT_CHECKOUT_HIBERNATION_POLICY, restoreOn }) },
  });
  return {
    coordinator,
    attempts: () => attempts.length,
    hibernated: () => hibernated,
    hold(): () => void {
      let release!: () => void;
      gate = new Promise<void>((resolve) => { release = resolve; });
      return release;
    },
  };
}

async function settleRestore(coordinator: ThreadArchiveCoordinator): Promise<void> {
  while (coordinator.checkoutRestoreRecords.size) {
    await Promise.all([...coordinator.checkoutRestoreRecords.values()].map(async (restore) => await restore.catch(() => {})));
  }
}

type Operation = "send" | "wake" | "open" | "restoreNow";

describe("hibernated checkout restore", () => {
  // Rule: a failed restore is reported once to the next send, without another
  // attempt, and only an operator request (wake, Restore now) retries it.
  // Opening the thread never retries a recorded failure. A success clears it.
  it("delivers each restore failure once and retries only on request (model)", async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.constantFrom<Operation>("send", "wake", "open", "restoreNow"), { minLength: 1, maxLength: 12 }),
      fc.array(fc.option(fc.constantFrom("Disk full", "Branch moved"), { nil: undefined }), { minLength: 12, maxLength: 12 }),
      async (operations, outcomes) => {
        const fixture = hibernationFixture(outcomes, "open");
        const model = { hibernated: true, failure: undefined as string | undefined, undelivered: false, attempts: 0 };
        const attempt = (): string | undefined => {
          const failure = outcomes[model.attempts];
          model.attempts += 1;
          if (failure === undefined) {
            model.hibernated = false;
            model.failure = undefined;
            model.undelivered = false;
          } else {
            model.failure = failure;
            model.undelivered = true;
          }
          return failure;
        };
        for (const operation of operations) {
          if (operation === "send") {
            let expected: string | undefined;
            if (model.failure !== undefined && model.undelivered) {
              model.undelivered = false;
              expected = model.failure;
            } else if (model.hibernated) {
              expected = attempt();
            }
            const result = await fixture.coordinator.ensureCheckoutAwake(identity).then(() => undefined, (error: Error) => error.message);
            expect(result, operation).toBe(expected);
          } else if (operation === "wake" || operation === "open") {
            const refused = operation === "open" && model.failure !== undefined;
            const expected = !refused && model.hibernated;
            if (expected) {
              model.undelivered = false;
              attempt();
            }
            const running = operation === "open"
              ? await fixture.coordinator.wakeHibernatedCheckoutOnOpen(identity)
              : await fixture.coordinator.wakeHibernatedCheckout(identity);
            expect(running, operation).toBe(expected);
            await settleRestore(fixture.coordinator);
          } else {
            let restoreError: string | undefined;
            if (model.hibernated) {
              model.undelivered = false;
              restoreError = attempt();
            }
            const response = await fixture.coordinator.setThreadCheckoutHibernation({ ...identity, restore: true });
            expect(response.restoreError, operation).toBe(restoreError);
            expect(response.hibernated, operation).toBe(model.hibernated);
          }
          expect(fixture.attempts()).toBe(model.attempts);
          expect(fixture.hibernated()).toBe(model.hibernated);
          expect(fixture.coordinator.readCheckoutHibernation(identity)).toEqual({
            restoring: false,
            ...(model.failure !== undefined ? { restoreFailure: { worktreePath, message: model.failure } } : {}),
          });
        }
      },
    ), { numRuns: 120 });
  });

  // Rule: concurrent sends and wakes share one restore, and every send sees
  // its outcome. The turn queue reads the running restore as busy.
  it("runs one restore for any number of concurrent callers (property)", async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.constantFrom<"send" | "wake">("send", "wake"), { minLength: 1, maxLength: 8 }),
      fc.option(fc.constant("Disk full"), { nil: undefined }),
      async (callers, failure) => {
        const fixture = hibernationFixture([failure]);
        const release = fixture.hold();
        const calls = callers.map((caller) => caller === "send"
          ? fixture.coordinator.ensureCheckoutAwake(identity).then(() => undefined, (error: Error) => error.message)
          : fixture.coordinator.wakeHibernatedCheckout(identity).then(() => undefined));
        await vi.waitFor(() => expect(fixture.attempts()).toBe(1));
        expect(fixture.coordinator.checkoutRestoreRecords.has(key)).toBe(true);
        expect(fixture.coordinator.readCheckoutHibernation(identity).restoring).toBe(true);
        release();
        const results = await Promise.all(calls);
        await settleRestore(fixture.coordinator);
        expect(fixture.attempts()).toBe(1);
        callers.forEach((caller, index) => {
          if (caller === "send") expect(results[index]).toBe(failure);
        });
        expect(fixture.coordinator.checkoutRestoreRecords.has(key)).toBe(false);
      },
    ), { numRuns: 60 });
  });
});

type BusySignals = {
  closed: boolean;
  stopping: boolean;
  mutating: boolean;
  handingOff: boolean;
  starting: boolean;
  backgroundTerminal: boolean;
  liveClaudeSession: boolean;
  activeTurn: boolean;
  workspaceMove: boolean;
  queued: boolean;
  infoArchived: boolean;
  infoNewer: boolean;
  candidateArchived: boolean;
  pendingRequest: "none" | "this" | "other";
  source: "codex" | "claude";
};

describe("automatic archive eligibility", () => {
  // Rule: the sweeper leaves a thread alone while anything could still be
  // using it. The oracle is the list of signals, each read independently.
  it("reads a candidate as busy exactly when one of its signals holds (oracle)", async () => {
    // A few signals at a time, so each one is regularly the only one that holds.
    const flags = ["closed", "stopping", "mutating", "handingOff", "starting", "backgroundTerminal", "liveClaudeSession",
      "activeTurn", "workspaceMove", "queued", "infoArchived", "infoNewer", "candidateArchived"] as const;
    const signals = fc.record({
      held: fc.subarray([...flags], { maxLength: 3 }),
      pendingRequest: fc.constantFrom<BusySignals["pendingRequest"]>("none", "none", "this", "other"),
      source: fc.constantFrom<BusySignals["source"]>("codex", "claude"),
    }).map(({ held, pendingRequest, source }): BusySignals => ({
      ...Object.fromEntries(flags.map((flag) => [flag, held.includes(flag)])) as Omit<BusySignals, "pendingRequest" | "source">,
      pendingRequest, source,
    }));
    await fc.assert(fc.asyncProperty(signals, async (s) => {
      const thread: AppServerThreadSummary = {
        id: "candidate", source: s.source, title: "Candidate", titleSource: "explicit", linkedDirectories: [], updatedAt: 10,
        ...(s.candidateArchived ? { archivedAt: 5 } : {}),
      };
      const candidate: ThreadArchiveCandidate = { thread };
      const pending = s.pendingRequest === "none" ? [] : [{ backend: s.source,
        notification: { params: { threadId: s.pendingRequest === "this" ? thread.id : "elsewhere" } } }];
      const host = {
        runtimeInstanceId: "runtime-test",
        stoppingRunningTurnsForShutdown: s.stopping,
        threadInfoStore: { get: () => ({ archived: s.infoArchived, updatedAt: s.infoNewer ? 20 : 1 }) },
        threadHandoffReservations: new Set(s.handingOff ? [buildThreadIdentityKey(s.source, thread.id)] : []),
        threadStarts: { hasPending: () => s.starting },
        codexBackgroundTerminals: new Map(s.backgroundTerminal ? [[thread.id, []]] : []),
        threadHasActiveTurn: () => s.activeTurn,
        threadHasBlockingWorkspaceMove: () => s.workspaceMove,
        threadTurnQueue: { getQueuedEntries: () => s.queued ? [{}] : [] },
        pendingServerRequests: new Map(pending.map((request, index) => [String(index), request])),
        threadLifecycleLocks: { run: async (_key: string, work: () => Promise<void>) => await work() },
      };
      const coordinator = archiveCoordinatorStandIn({
        registry: () => host,
        lifecycle: { closed: s.closed },
        providers: { claude: { hasLiveSession: () => s.liveClaudeSession } },
      });
      let finish!: () => void;
      const held = new Promise<void>((resolve) => { finish = resolve; });
      const mutation = s.mutating
        ? coordinator.withThreadLifecycleMutation({ backend: s.source, threadId: thread.id }, async () => await held)
        : undefined;
      const expected = s.closed || s.stopping || s.mutating || s.handingOff || s.starting
        || (s.source === "codex" && s.backgroundTerminal)
        || (s.source === "claude" && s.liveClaudeSession)
        || s.activeTurn || s.workspaceMove || s.queued
        || (s.infoArchived && !isArchivedCheckoutCandidate(candidate))
        || (!s.candidateArchived && s.infoNewer)
        || s.pendingRequest === "this";
      expect(coordinator.isArchiveCandidateBusy(candidate)).toBe(expected);
      expect(coordinator.threadLifecycleMutationCountRecords.has(buildThreadIdentityKey(s.source, thread.id))).toBe(s.mutating);
      if (mutation) {
        finish();
        await mutation;
        expect(coordinator.threadLifecycleMutationCountRecords.size).toBe(0);
      }
    }), { numRuns: 300 });
  });

  // Rule: registering a checkout cancels every automatic archive reserving
  // that checkout, under any spelling of its path, and nothing else.
  it("cancels exactly the hibernations of one checkout (oracle)", () => {
    fc.assert(fc.property(
      fc.array(fc.record({ checkout: fc.integer({ min: 0, max: 3 }), spelled: fc.nat(3), withPath: fc.boolean() }), { maxLength: 8 }),
      fc.integer({ min: 0, max: 3 }),
      (rows, target) => {
        const coordinator = archiveCoordinatorStandIn({});
        const reservations = (coordinator as unknown as {
          automaticArchiveReservations: Map<string, { cancelled: boolean; worktreePath?: string }>;
        }).automaticArchiveReservations;
        const expected: string[] = [];
        rows.forEach((row, index) => {
          // Spellings the checkout comparison treats as one path.
          const base = `/contrived/worktrees/checkout-${row.checkout}`;
          const variants = [base, `/contrived/worktrees/./checkout-${row.checkout}`,
            `${base}/../checkout-${row.checkout}`, `/contrived//worktrees/checkout-${row.checkout}`];
          reservations.set(`codex:thread-${index}`, { cancelled: false,
            ...(row.withPath ? { worktreePath: variants[row.spelled] } : {}) });
          if (row.withPath && row.checkout === target) expected.push(`codex:thread-${index}`);
        });
        const cancelled = coordinator.cancelCheckoutHibernations(`/contrived/worktrees/checkout-${target}`);
        expect(cancelled).toEqual(expected);
        for (const [reservationKey, reservation] of reservations) {
          expect(reservation.cancelled, reservationKey).toBe(expected.includes(reservationKey));
        }
      },
    ));
  });

  it("cancels only the named thread's automatic archive", () => {
    const coordinator = archiveCoordinatorStandIn({});
    const reservations = (coordinator as unknown as {
      automaticArchiveReservations: Map<string, { cancelled: boolean; worktreePath?: string }>;
    }).automaticArchiveReservations;
    reservations.set("codex:a", { cancelled: false });
    reservations.set("claude:a", { cancelled: false });
    coordinator.cancelAutomaticArchive("codex", "a");
    coordinator.cancelAutomaticArchive("codex", "absent");
    expect([...reservations]).toEqual([["codex:a", { cancelled: true }], ["claude:a", { cancelled: false }]]);
  });
});

function intent(threadId: string, backend: AppServerBackendKind = "codex"): ArchiveCleanupIntent {
  return { backend, threadId, archivedAt: 1_000, codexRolloutMissing: true, messagingCleanup: {} };
}

function checkpointCoordinator(store: ArchiveCleanupCheckpointStore, runtimeInstanceId: string) {
  const completed: Array<Record<string, unknown>> = [];
  const events: AgentEvent[] = [];
  const coordinator = archiveCoordinatorStandIn({
    registry: () => ({ runtimeInstanceId, resolveLiveProfileRuntimeInstanceIdsFn: () => [] }),
    emit: async (event) => { events.push(event); },
    dependencies: { archiveCleanupCheckpointStore: store },
  });
  const internals = coordinator as unknown as {
    pendingArchiveCleanupIntents: Map<string, ArchiveCleanupIntent>;
    completeArchivedThreadCleanup: (params: ArchiveCleanupIntent) => Promise<unknown>;
  };
  vi.spyOn(internals, "completeArchivedThreadCleanup").mockImplementation(async (params) => {
    completed.push({ ...params });
    return { backend: params.backend, threadId: params.threadId, archivedAt: params.archivedAt, cleanup: [] };
  });
  return { coordinator, internals, completed, events };
}

describe("archive cleanup checkpoints", () => {
  // Rule: cleanups pending at quit are written once per identity; the next
  // runtime resumes each exactly once, never repeats the provider archive,
  // and leaves alone the ones it already owns.
  it("resumes exactly the cleanups the previous runtime checkpointed (model)", async () => {
    await fc.assert(fc.asyncProperty(
      fc.uniqueArray(fc.record({ id: fc.integer({ min: 0, max: 20 }), backend: fc.constantFrom<AppServerBackendKind>("codex", "claude") }),
        { selector: (row) => `${row.backend}:${row.id}`, maxLength: 12 }),
      fc.func(fc.boolean()),
      async (rows, alreadyOwned) => {
        const db = openInMemoryStateDb();
        databases.push(db);
        const store = new ArchiveCleanupCheckpointStore(db.raw, { processAlive: () => false });
        const quitting = checkpointCoordinator(store, "runtime-before");
        const intents = rows.map((row) => intent(`thread-${row.id}`, row.backend));
        for (const item of intents) quitting.internals.pendingArchiveCleanupIntents.set(buildThreadIdentityKey(item.backend, item.threadId), item);
        expect(quitting.coordinator.getArchiveCleanupCountForQuit()).toBe(intents.length);
        quitting.coordinator.checkpointArchiveCleanupsForQuit();

        const next = checkpointCoordinator(store, "runtime-after");
        const owned = intents.filter((item, index) => alreadyOwned(index));
        for (const item of owned) next.internals.pendingArchiveCleanupIntents.set(buildThreadIdentityKey(item.backend, item.threadId), item);
        await next.coordinator.resumeArchiveCleanupsAtStartup();
        await vi.waitFor(() => expect(next.completed).toHaveLength(intents.length - owned.length));

        const ownedKeys = new Set(owned.map((item) => buildThreadIdentityKey(item.backend, item.threadId)));
        const resumed = intents.filter((item) => !ownedKeys.has(buildThreadIdentityKey(item.backend, item.threadId)));
        expect(next.completed.map((params) => buildThreadIdentityKey(params.backend as AppServerBackendKind, params.threadId as string)).sort())
          .toEqual(resumed.map((item) => buildThreadIdentityKey(item.backend, item.threadId)).sort());
        for (const params of next.completed) expect(params).toMatchObject({ requireArchived: true, codexRolloutMissing: false });
        expect(next.coordinator.getArchiveCleanupCountForQuit()).toBe(owned.length);
        // The next quit checkpoint keeps only the unfinished cleanups.
        next.coordinator.checkpointArchiveCleanupsForQuit();
        expect(store.recover("runtime-later", () => []).map((item) => buildThreadIdentityKey(item.backend, item.threadId)).sort())
          .toEqual([...ownedKeys].sort());
        // Resumption starts once per runtime.
        await next.coordinator.resumeArchiveCleanupsAtStartup();
        expect(next.completed).toHaveLength(resumed.length);
      },
    ), { numRuns: 40 });
  });
});

describe("registry-facing accessors", () => {
  it("exposes running restores, mutations, overflow and removal admissions read-only", async () => {
    const fixture = hibernationFixture([undefined]);
    const release = fixture.hold();
    const send = fixture.coordinator.ensureCheckoutAwake(identity);
    await vi.waitFor(() => expect(fixture.coordinator.checkoutRestoreRecords.has(key)).toBe(true));
    // The restore holds a lifecycle mutation for its thread.
    expect(fixture.coordinator.threadLifecycleMutationCountRecords.get(key)).toBe(1);
    release();
    await send;
    expect(fixture.coordinator.checkoutRestoreRecords.size).toBe(0);
    expect(fixture.coordinator.threadLifecycleMutationCountRecords.size).toBe(0);
  });

  it("shows the registry the overflow and removal admissions it holds", () => {
    const coordinator = archiveCoordinatorStandIn({});
    const internals = coordinator as unknown as {
      archiveCleanupOverflow: Map<string, unknown>;
      archiveWorktreeRemovalAdmissions: Set<unknown>;
    };
    const overflow = { intent: intent("waiting") };
    const admission = { scope: { isReserved: false } };
    internals.archiveCleanupOverflow.set("codex:waiting", overflow);
    internals.archiveWorktreeRemovalAdmissions.add(admission);
    expect([...coordinator.archiveCleanupOverflowRecords]).toEqual([["codex:waiting", overflow]]);
    expect([...coordinator.archiveWorktreeRemovalAdmissionRecords]).toEqual([admission]);
  });

  it("reads the cleanup read generation and advances it with each invalidation", () => {
    const coordinator = archiveCoordinatorStandIn({ providers: { codex: { invalidateThreadListings: () => {} } } });
    const before = coordinator.archiveCleanupReadGeneration("codex");
    coordinator.invalidateArchiveCleanupReads("codex");
    expect(coordinator.archiveCleanupReadGeneration("codex")).toBeGreaterThan(before);
  });

  it("advances the workspace revision", () => {
    const coordinator = archiveCoordinatorStandIn({});
    const revision = () => (coordinator as unknown as { archiveWorkspaceRevision: number }).archiveWorkspaceRevision;
    const before = revision();
    coordinator.advanceArchiveWorkspaceRevision();
    expect(revision()).toBe(before + 1);
  });

  // Rule: a turn start refuses a thread whose workspace a reserved removal
  // admission covers, even when that thread owns the admission.
  it("refuses a turn start only through a reserved removal's workspace", () => {
    const coordinator = archiveCoordinatorStandIn({});
    const admissions = (coordinator as unknown as { archiveWorktreeRemovalAdmissions: Set<unknown> }).archiveWorktreeRemovalAdmissions;
    const scope = { isReserved: true, ownerKey: key, intersects: (candidate: string) => candidate === key };
    admissions.add({ scope });
    expect(() => coordinator.assertArchiveWorkspaceUsable(key)).toThrow(/reserved by archive cleanup/);
    expect(() => coordinator.assertArchiveWorkspaceUsable("codex:elsewhere")).not.toThrow();
    scope.isReserved = false;
    expect(() => coordinator.assertArchiveWorkspaceUsable(key)).not.toThrow();
  });

  it("closes its queue to new cleanups at shutdown", async () => {
    const coordinator = archiveCoordinatorStandIn({ registry: () => ({ runtimeInstanceId: "runtime-test" }) });
    const queue = (coordinator as unknown as {
      archiveCleanupQueue: { enqueue(key: string, work: () => Promise<unknown>): Promise<unknown> };
    }).archiveCleanupQueue;
    await coordinator.closeArchiveCleanupQueue();
    const work = vi.fn(async () => "ran");
    await expect(queue.enqueue("codex:late", work)).rejects.toBeInstanceOf(ArchiveCleanupCancelledError);
    expect(work).not.toHaveBeenCalled();
  });

  it("stops its sweeper at shutdown, and has nothing to stop before one starts", async () => {
    const coordinator = archiveCoordinatorStandIn({});
    expect(coordinator.stopThreadArchiveSweeper()).toBeUndefined();
    const stopped = Promise.resolve();
    const stop = vi.fn(() => stopped);
    (coordinator as unknown as { threadArchiveSweeper: { stop: () => Promise<void> } }).threadArchiveSweeper = { stop };
    expect(coordinator.stopThreadArchiveSweeper()).toBe(stopped);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("reads neither its host nor its stores while it is constructed", () => {
    const refuse = new Proxy({}, { get: () => { throw new Error("read during construction"); } });
    expect(() => archiveCoordinatorStandIn({ registry: () => refuse, overlayStore: refuse })).not.toThrow();
  });
});

describe("registry facades", () => {
  it("returns the coordinator's own result for each importer-facing member", async () => {
    const db = openInMemoryStateDb();
    databases.push(db);
    const registry = createDesktopBackendRegistry({
      overlayStore: new SqliteOverlayStore(db),
      codexClient: {
        close: async () => {}, getInitializeResult: async () => ({ methods: [] }),
        listThreads: async () => [], onNotification: () => () => {}, onPendingRequest: () => () => {},
        readConfiguredMcpServerNames: async () => [], listModels: async () => [],
      } as never,
      archiveCleanupCheckpointStore: null,
      isBootstrapMode: () => false,
      resolveTokenMiserEnabled: () => false,
    });
    try {
      const coordinator = registryModules(registry).threadArchiveCoordinator;
      const result = Promise.resolve({ backend: "codex" as const, threadId: "t", archivedAt: 1, cleanup: [] });
      const archive = vi.spyOn(coordinator, "archiveThread").mockReturnValue(result);
      expect(registry.archiveThread({ backend: "codex", threadId: "t" })).toBe(result);
      expect(archive).toHaveBeenCalledWith({ backend: "codex", threadId: "t" });
      const restored = Promise.resolve({ backend: "codex" as const, threadId: "t", restoredAt: 2 });
      vi.spyOn(coordinator, "restoreThread").mockReturnValue(restored);
      expect(registry.restoreThread({ backend: "codex", threadId: "t" })).toBe(restored);
      vi.spyOn(coordinator, "getArchiveCleanupCountForQuit").mockReturnValue(7);
      expect(registry.getArchiveCleanupCountForQuit()).toBe(7);
      const cleaner = { requestBindingRevokeAllForThread: vi.fn() };
      const set = vi.spyOn(coordinator, "setMessagingArchiveCleaner");
      registry.setMessagingArchiveCleaner(cleaner as never);
      expect(set).toHaveBeenCalledWith(cleaner);
      expect(registry.readCheckoutHibernation(identity)).toEqual({ restoring: false });
    } finally {
      await registry.close();
    }
  });
});
