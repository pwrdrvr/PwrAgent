import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import type {
  AgentEvent,
  AppServerBackendKind,
  StartReviewRequest,
  ThreadSubAgentSummary,
} from "@pwragent/shared";
import type { BackendClient, ReviewTerminal } from "../app-server/backend-registry-types";
import { ManagedReviewService, type ManagedReviewServiceHost } from "../app-server/managed-review-service";
import type { RegistryContext } from "../app-server/registry-context";
import { reviewStartFailureFingerprint } from "../app-server/thread-orchestration-prompts";
import { ActiveTurnKeySet, buildActiveTurnKey, reviewSubAgentId } from "../app-server/thread-turn-keys";

const THREAD = "thread-parent";
const REVIEW_TURN = "review-turn";
const REVIEW_REQUEST: StartReviewRequest = {
  backend: "codex",
  threadId: THREAD,
  target: { type: "uncommittedChanges" },
  delivery: "inline",
};

/**
 * Every awaited call a native Codex review start makes outside the module,
 * in the order it makes them. Each one is a point where a concurrent
 * notification can run.
 */
const START_STEPS = [
  "assertThreadNotLocked",
  "ensureCheckoutAwake",
  "flushQueuedAgentChange",
  "flushQueuedExecutionModeIfPresent",
  "getThreadOverlayState",
  "resolveThreadEnvironmentCwd",
  "getInitializeResult",
  "buildSupportedCodexTokenMiserConfig",
  "buildSupportedCodexDynamicToolsRefresh",
  "startReview",
  "resolveCodexThreadExecutionModeForActiveTurn",
  "getThreadSubAgent",
  "upsertThreadSubAgent",
  "emit",
] as const;
type StartStep = typeof START_STEPS[number];

/** The steps before the start records its review, where only retained evidence can carry a terminal. */
const PRE_RECORD_STEPS = START_STEPS.slice(0, START_STEPS.indexOf("resolveCodexThreadExecutionModeForActiveTurn") + 1);

/**
 * A review service over an in-memory host whose turn-activity sets are real,
 * so the test reads what the registry would read. `onStep` runs inside each
 * awaited call, before it returns, as a concurrent notification would.
 */
function createReviewHarness(options: {
  failAt?: StartStep;
  onStep?: (step: StartStep) => Promise<void> | void;
} = {}) {
  const steps: StartStep[] = [];
  const step = async (name: StartStep): Promise<void> => {
    steps.push(name);
    await options.onStep?.(name);
    if (options.failAt === name) throw new Error(`fixture failure at ${name}`);
  };
  const cards = new Map<string, ThreadSubAgentSummary>();
  const cardWrites: ThreadSubAgentSummary[] = [];
  const events: AgentEvent[] = [];
  const client = {
    getInitializeResult: async () => {
      await step("getInitializeResult");
      return { methods: ["review/start", "thread/start", "turn/start"] };
    },
    startReview: async () => {
      await step("startReview");
      return { threadId: THREAD, reviewThreadId: THREAD, turnId: REVIEW_TURN };
    },
  } as unknown as BackendClient;
  const host = {
    activeCodexReviewInterruptTurnIds: new Map<string, string>(),
    activeCodexReviewTurnKeys: new Set<string>(),
    activeCodexTurnModes: new Map(),
    activeTurnKeys: new ActiveTurnKeySet(),
    registrySessionId: "session-fixture",
    reservedAcpStartThreadKeys: new Set<string>(),
    reservedCodexStartThreadIds: new Set<string>(),
    runtimeInstanceId: "runtime-fixture",
    threadTurnQueue: { releaseThread: vi.fn(async () => {}) },
    assertNotBootstrap: () => {},
    assertThreadOwnership: () => {},
    assertThreadNotLocked: async () => { await step("assertThreadNotLocked"); },
    ensureCheckoutAwake: async () => { await step("ensureCheckoutAwake"); },
    threadHasActiveTurn: (threadId: string) => busy(threadId),
    flushQueuedAgentChange: async () => { await step("flushQueuedAgentChange"); },
    flushQueuedExecutionModeIfPresent: async () => { await step("flushQueuedExecutionModeIfPresent"); },
    resolveTokenMiserEnabledForOverride: () => false,
    resolveThreadEnvironmentCwd: async () => { await step("resolveThreadEnvironmentCwd"); return undefined; },
    getClient: () => client,
    withCodexThreadClient: async <T>(_threadId: string, operation: (client: BackendClient, mode: "default") => Promise<T>) =>
      await operation(client, "default"),
    buildSupportedCodexTokenMiserConfig: async () => { await step("buildSupportedCodexTokenMiserConfig"); return undefined; },
    buildSupportedCodexDynamicToolsRefresh: async () => { await step("buildSupportedCodexDynamicToolsRefresh"); return undefined; },
    resolveCodexThreadExecutionModeForActiveTurn: async () => {
      await step("resolveCodexThreadExecutionModeForActiveTurn");
      return "default";
    },
    getActiveTurnForThread: () => undefined,
    getPendingTurnForThread: () => undefined,
    invalidateThreadListCache: () => {},
    drainPendingThreadWorkspaceMovesForTerminalTurn: () => {},
    scheduleQueuedAgentChange: () => {},
    submitTurn: vi.fn(async () => ({ status: "started" })),
  };
  // Busy as the registry's threadHasActiveTurn reads it: a start reservation or a live turn key.
  function busy(threadId: string): boolean {
    return host.reservedCodexStartThreadIds.has(threadId)
      || [...host.activeTurnKeys].some((key) => key.startsWith(`codex:${threadId}:`));
  }
  const context = {
    stores: {
      threads: {
        getThreadOverlayState: async ({ backend, threadId }: { backend: AppServerBackendKind; threadId: string }) => {
          await step("getThreadOverlayState");
          return { backend, threadId };
        },
      },
      subAgents: {
        getThreadSubAgent: async ({ monitorId }: { monitorId: string }) => {
          await step("getThreadSubAgent");
          return cards.get(monitorId);
        },
        upsertThreadSubAgent: async ({ subAgent }: { subAgent: ThreadSubAgentSummary }) => {
          await step("upsertThreadSubAgent");
          cards.set(subAgent.monitorId, subAgent);
          cardWrites.push(subAgent);
        },
      },
    },
    providers: { acp: { supportsManagedReview: () => false } },
    lifecycle: { closed: false },
    emit: async (event: AgentEvent) => {
      events.push(event);
      await step("emit");
    },
  } as unknown as RegistryContext;
  const service = new ManagedReviewService(context, () => host as unknown as ManagedReviewServiceHost);
  return { service, host, busy, steps, cards, cardWrites, events };
}

const reviewTerminal: ReviewTerminal = {
  backend: "codex",
  threadId: THREAD,
  turnId: REVIEW_TURN,
  method: "turn/completed",
};

describe("ManagedReviewService", () => {
  it("reads neither its host nor its stores until a review runs", async () => {
    let bound = false;
    const context = {
      get stores() {
        if (!bound) throw new Error("store read while constructing");
        return { threads: { getThreadOverlayState: async () => undefined } };
      },
    } as unknown as RegistryContext;
    const service = new ManagedReviewService(context, () => {
      if (!bound) throw new Error("host read while constructing");
      return { resolveThreadEnvironmentCwd: async () => "/repo" } as unknown as ManagedReviewServiceHost;
    });
    bound = true;
    expect(service.cancelPendingReview("pending-review:unknown", "fixture")).toBe(false);
    await expect(service.prepareReviewRequest(REVIEW_REQUEST)).resolves.toBe(REVIEW_REQUEST);
  });

  it("lets the registry read its review records only through read-only views", async () => {
    const { service } = createReviewHarness();
    expect(service.activeReviewSubAgentRecords.size).toBe(0);
    expect(service.reviewSubAgentRecordsByReviewTurn.size).toBe(0);

    await service.startReview(REVIEW_REQUEST);

    const live = [...service.activeReviewSubAgentRecords.values()];
    expect(live).toEqual([expect.objectContaining({ mode: "native", parentThreadId: THREAD, turnId: REVIEW_TURN })]);
    expect([...service.reviewSubAgentRecordsByReviewTurn.values()]).toEqual(live);
    expect(service.findReviewForParentTurn({ backend: "codex", parentThreadId: THREAD })).toBe(live[0]);

    await service.completeReviewSubAgent(reviewTerminal);
    // The live view drops a finished review; the by-turn view keeps it for usage reads.
    expect(service.activeReviewSubAgentRecords.size).toBe(0);
    expect(service.reviewSubAgentRecordsByReviewTurn.size).toBe(1);
  });

  it("never leaves the thread idle mid-start and always releases its start reservation", async () => {
    await fc.assert(fc.asyncProperty(
      fc.option(fc.constantFrom(...START_STEPS), { nil: undefined }),
      async (failAt) => {
        const idleSteps: string[] = [];
        let reserved = false;
        let settled = false;
        const harness = createReviewHarness({
          failAt,
          onStep: (name) => {
            reserved ||= harness.host.reservedCodexStartThreadIds.has(THREAD);
            // From the reservation until the start settles, a turn submitted
            // now must see this thread as busy.
            if (reserved && !settled && !harness.busy(THREAD)) idleSteps.push(name);
          },
        });
        const outcome = await harness.service.startReview(REVIEW_REQUEST).then(
          () => "started" as const,
          () => "failed" as const,
        );
        settled = true;

        expect(idleSteps).toEqual([]);
        expect(harness.host.reservedCodexStartThreadIds.has(THREAD)).toBe(false);
        expect(outcome).toBe(failAt ? "failed" : "started");
        const turnKey = buildActiveTurnKey("codex", THREAD, REVIEW_TURN);
        if (failAt && PRE_RECORD_STEPS.includes(failAt)) {
          // The start never took effect: nothing of it may remain.
          expect(harness.host.activeTurnKeys.has(turnKey)).toBe(false);
          expect(harness.service.findReviewForParentTurn({ backend: "codex", parentThreadId: THREAD })).toBeUndefined();
        } else {
          // The review turn is running; its terminal will clear it.
          expect(harness.host.activeTurnKeys.has(turnKey)).toBe(true);
        }
      },
    ), { numRuns: 60 });
  });

  it("applies a review terminal that arrives while the start is still in flight, exactly once", async () => {
    await fc.assert(fc.asyncProperty(
      fc.option(fc.constantFrom(...PRE_RECORD_STEPS), { nil: undefined }),
      async (arrivesAt) => {
        let delivered = false;
        const harness = createReviewHarness({
          onStep: async (name) => {
            if (name !== arrivesAt || delivered) return;
            delivered = true;
            // What the event hub does with the review turn's terminal.
            await harness.service.completeReviewSubAgent(reviewTerminal);
          },
        });
        await harness.service.startReview(REVIEW_REQUEST);

        const card = harness.cards.get(reviewSubAgentId(REVIEW_TURN));
        const live = harness.service.findReviewForParentTurn({ backend: "codex", parentThreadId: THREAD });
        const turnKey = buildActiveTurnKey("codex", THREAD, REVIEW_TURN);
        if (arrivesAt === undefined) {
          expect(live).toBeDefined();
          expect(card?.status).toBe("running");
          expect(harness.host.activeTurnKeys.has(turnKey)).toBe(true);
          expect(harness.host.threadTurnQueue.releaseThread).not.toHaveBeenCalled();
          return;
        }
        expect(live).toBeUndefined();
        expect(card?.status).toBe("success");
        expect(harness.host.activeTurnKeys.has(turnKey)).toBe(false);
        expect(harness.host.activeCodexTurnModes.size).toBe(0);
        expect(harness.host.activeCodexReviewTurnKeys.size).toBe(0);
        expect(harness.host.reservedCodexStartThreadIds.has(THREAD)).toBe(false);
        expect(harness.host.threadTurnQueue.releaseThread).toHaveBeenCalledTimes(1);
        expect(harness.host.threadTurnQueue.releaseThread).toHaveBeenCalledWith(expect.objectContaining({
          threadId: THREAD, turnId: REVIEW_TURN, status: "turn/completed",
        }));
      },
    ), { numRuns: 40 });
  });
});

type ModelRecord = {
  invokingTurnId: string;
  idempotencyKey?: string;
  status: "scheduled" | "cancelled" | "starting" | "started" | "failed";
};

type PendingCommand =
  | { kind: "submit"; activeTurnId: string; idempotencyKey?: string }
  | { kind: "cancel"; index: number }
  | { kind: "rebind"; from: string; to: string }
  | { kind: "drain"; turnId: string; method: "turn/completed" | "turn/failed" | "turn/cancelled"; starts: boolean };

const TURNS = ["turn-a", "turn-b", REVIEW_TURN];
const pendingCommand: fc.Arbitrary<PendingCommand> = fc.oneof(
  fc.record({
    kind: fc.constant("submit" as const),
    activeTurnId: fc.constantFrom(...TURNS),
    idempotencyKey: fc.option(fc.constantFrom("key-1", "key-2"), { nil: undefined }),
  }),
  fc.record({ kind: fc.constant("cancel" as const), index: fc.nat({ max: 6 }) }),
  fc.record({ kind: fc.constant("rebind" as const), from: fc.constantFrom(...TURNS), to: fc.constantFrom(...TURNS) }),
  fc.record({
    kind: fc.constant("drain" as const),
    turnId: fc.constantFrom(...TURNS),
    method: fc.constantFrom("turn/completed" as const, "turn/failed" as const, "turn/cancelled" as const),
    starts: fc.boolean(),
  }),
);

describe("ManagedReviewService pending review starts", () => {
  it("schedules, cancels, rebinds and drains agent-requested reviews as the model does", async () => {
    await fc.assert(fc.asyncProperty(fc.array(pendingCommand, { maxLength: 24 }), async (commands) => {
      const events: AgentEvent[] = [];
      let activeTurnId: string | undefined;
      let startsSucceed = true;
      const submitTurn = vi.fn(async () => ({ status: "started" }));
      const host = {
        reservedCodexStartThreadIds: new Set<string>(),
        reservedAcpStartThreadKeys: new Set<string>(),
        assertThreadNotLocked: async () => {},
        getActiveTurnForThread: () => activeTurnId ? { backend: "codex", threadId: THREAD, turnId: activeTurnId } : undefined,
        getPendingTurnForThread: () => undefined,
        submitTurn,
      } as unknown as ManagedReviewServiceHost;
      const context = {
        emit: async (event: AgentEvent) => { events.push(event); },
      } as unknown as RegistryContext;
      const service = new ManagedReviewService(context, () => host);
      const startReview = vi.spyOn(service, "startReview").mockImplementation(async () => {
        if (!startsSucceed) throw new Error("fixture start refused");
        return { backend: "codex", threadId: THREAD, reviewThreadId: THREAD, turnId: REVIEW_TURN };
      });

      const model: ModelRecord[] = [];
      const ids: string[] = [];
      const expectedEvents: Array<{ pendingReviewId: string; status: string }> = [];
      let expectedStarts = 0;
      let expectedNotices = 0;
      let lastNotice: string | undefined;

      for (const command of commands) {
        if (command.kind === "submit") {
          activeTurnId = command.activeTurnId;
          const existing = command.idempotencyKey
            ? model.findIndex((record) => record.idempotencyKey === command.idempotencyKey)
            : model.findIndex((record) => record.invokingTurnId === command.activeTurnId && record.status === "scheduled");
          const result = await service.submitReview({ ...REVIEW_REQUEST, idempotencyKey: command.idempotencyKey });
          if (result.status !== "scheduled") throw new Error("expected a scheduled review");
          if (existing >= 0) {
            expect(result.pendingReviewId).toBe(ids[existing]);
            expect(result.invokingTurnId).toBe(model[existing]!.invokingTurnId);
          } else {
            model.push({ invokingTurnId: command.activeTurnId, idempotencyKey: command.idempotencyKey, status: "scheduled" });
            ids.push(result.pendingReviewId);
            expect(result.invokingTurnId).toBe(command.activeTurnId);
          }
          continue;
        }
        if (command.kind === "cancel") {
          const id = ids[command.index] ?? `pending-review:unknown-${command.index}`;
          const record = model[command.index];
          const expected = record?.status === "scheduled";
          if (record && expected) record.status = "cancelled";
          expect(service.cancelPendingReview(id, "operator cancelled")).toBe(expected);
          continue;
        }
        if (command.kind === "rebind") {
          for (const record of model) {
            if (record.status === "scheduled" && record.invokingTurnId === command.from) record.invokingTurnId = command.to;
          }
          service.rebindPendingReviewStartsForStartedTurn({
            backend: "codex", threadId: THREAD, pendingTurnId: command.from, turnId: command.to,
          });
          continue;
        }
        startsSucceed = command.starts;
        const candidates = model
          .map((record, index) => ({ record, index }))
          .filter(({ record }) => record.status === "scheduled" && record.invokingTurnId === command.turnId);
        const failures: Array<{ error: string; target: StartReviewRequest["target"] }> = [];
        for (const { record, index } of candidates) {
          if (command.method !== "turn/completed") {
            record.status = "cancelled";
            expectedEvents.push({ pendingReviewId: ids[index]!, status: "cancelled" });
            continue;
          }
          if (record.status !== "scheduled") continue;
          expectedStarts += 1;
          if (command.starts) {
            record.status = "started";
            expectedEvents.push({ pendingReviewId: ids[index]!, status: "started" });
            for (const waiting of candidates) {
              if (waiting.record !== record && waiting.record.status === "scheduled") waiting.record.invokingTurnId = REVIEW_TURN;
            }
            // The started review is now the thread's turn; the rest wait for it.
            break;
          }
          record.status = "failed";
          expectedEvents.push({ pendingReviewId: ids[index]!, status: "failed" });
          failures.push({ error: "fixture start refused", target: REVIEW_REQUEST.target });
        }
        if (failures.length > 0) {
          const fingerprint = reviewStartFailureFingerprint(failures);
          if (lastNotice !== fingerprint) {
            expectedNotices += 1;
            lastNotice = fingerprint;
          }
        } else {
          lastNotice = undefined;
        }
        await service.drainPendingReviewStartsForTerminalTurn({
          backend: "codex", threadId: THREAD, turnId: command.turnId, method: command.method,
        });
      }

      expect(events
        .filter((event) => event.notification.method === "thread/reviewStart/updated")
        .map((event) => {
          const params = event.notification.params as { pendingReviewId: string; status: string };
          return { pendingReviewId: params.pendingReviewId, status: params.status };
        })).toEqual(expectedEvents);
      expect(startReview).toHaveBeenCalledTimes(expectedStarts);
      expect(submitTurn).toHaveBeenCalledTimes(expectedNotices);
    }), { numRuns: 200 });
  });
});
