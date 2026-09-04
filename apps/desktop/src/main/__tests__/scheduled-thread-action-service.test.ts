import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, ReleaseQueuedTurnResponse } from "@pwragent/shared";
import type { DesktopBackendRegistry } from "../app-server/backend-registry";
import { ScheduledThreadActionService } from "../scheduled-actions/scheduled-thread-action-service";
import { ScheduledThreadActionStore } from "../scheduled-actions/scheduled-thread-action-store";
import { StateDb } from "../state/state-db";

let stateDb: StateDb;
let store: ScheduledThreadActionStore;

beforeEach(() => {
  stateDb = StateDb.open(":memory:");
  store = new ScheduledThreadActionStore(stateDb);
});

afterEach(() => {
  stateDb.close();
});

function createHarness(now = 1_000) {
  const listeners = new Set<(event: AgentEvent) => void | Promise<void>>();
  const submitTurn = vi.fn(async () => ({
    status: "queued" as const,
    entry: {
      id: "scheduled-turn:scheduled-1",
      backend: "codex" as const,
      threadId: "thread-1",
      origin: "scheduled" as const,
      input: [{ type: "text" as const, text: "Follow up" }],
      createdAt: now,
    },
    position: 1,
  }));
  const submitReview = vi.fn(async () => ({
    status: "scheduled" as const,
    pendingReviewId: "review-1",
    invokingTurnId: "turn-active",
  }));
  const cancelQueuedTurn = vi.fn(() => true);
  const cancelPendingReview = vi.fn(() => true);
  const submitHeldTurn = vi.fn(async (input: { queueEntryId?: string }) => ({
    status: "held" as const,
    entry: {
      id: input.queueEntryId ?? "scheduled-turn:scheduled-1",
      backend: "codex" as const,
      threadId: "thread-1",
      origin: "scheduled" as const,
      input: [{ type: "text" as const, text: "Follow up" }],
      createdAt: now,
      manualReleaseRequired: true,
      holdReason:
        "This steering message was held after its target turn ended. Retry it when the provider is ready.",
    },
    position: 1,
  }));
  const releaseQueuedTurnWithDisposition = vi.fn(
    async (): Promise<ReleaseQueuedTurnResponse> => ({
      disposition: "started" as const,
      queueEntryId: "scheduled-turn:scheduled-1",
      turnId: "turn-retried",
    }),
  );
  const publishLocalEvent = vi.fn(async () => undefined);
  const markScheduledThreadBorn = vi.fn(async () => undefined);
  const markScheduledThreadStartTerminal = vi.fn(async () => undefined);
  const registry = {
    cancelPendingReview,
    cancelQueuedTurn,
    onEvent: (listener: (event: AgentEvent) => void | Promise<void>) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    markScheduledThreadBorn,
    markScheduledThreadStartTerminal,
    publishLocalEvent,
    releaseQueuedTurnWithDisposition,
    submitReview,
    submitHeldTurn,
    submitTurn,
  } as unknown as DesktopBackendRegistry;
  const service = new ScheduledThreadActionService({
    registry,
    store,
    now: () => now,
    setTimer: vi.fn(() => ({}) as ReturnType<typeof setTimeout>),
    clearTimer: vi.fn(),
  });
  return {
    cancelPendingReview,
    cancelQueuedTurn,
    listeners,
    markScheduledThreadBorn,
    markScheduledThreadStartTerminal,
    publishLocalEvent,
    registry,
    releaseQueuedTurnWithDisposition,
    service,
    submitReview,
    submitHeldTurn,
    submitTurn,
  };
}

describe("ScheduledThreadActionService", () => {
  it("persists future turns without dispatching them", async () => {
    const harness = createHarness();
    const response = await harness.service.create({
      backend: "codex",
      threadId: "thread-1",
      kind: "turn",
      scheduledFor: 20_000,
      displayText: "Follow up",
      turn: { input: [{ type: "text", text: "Follow up" }] },
    });

    expect(response.action).toMatchObject({
      status: "scheduled",
      scheduledFor: 20_000,
    });
    expect(harness.submitTurn).not.toHaveBeenCalled();
    expect(store.get(response.action.id)).toMatchObject({ status: "scheduled" });
  });

  it("returns the same durable action for an idempotent admission retry", async () => {
    const harness = createHarness();
    const request = {
      backend: "codex" as const,
      threadId: "thread-1",
      kind: "turn" as const,
      scheduledFor: 20_000,
      displayText: "Follow up",
      turn: { input: [{ type: "text" as const, text: "Follow up" }] },
    };

    const first = await harness.service.create(request, { id: "stable-action" });
    const second = await harness.service.create(
      { ...request, scheduledFor: 20_001 },
      { id: "stable-action" },
    );

    expect(second.action).toEqual(first.action);
    expect(store.list()).toHaveLength(1);
  });

  it("accepts attachment-only scheduled turns", async () => {
    const harness = createHarness();
    const response = await harness.service.create({
      backend: "codex",
      threadId: "thread-1",
      kind: "turn",
      scheduledFor: 20_000,
      displayText: "",
      turn: {
        input: [{
          type: "image",
          name: "diagram.png",
          url: "data:image/png;base64,aW1hZ2U=",
        }],
      },
    });

    expect(response.action).toMatchObject({
      displayText: "",
      status: "scheduled",
    });
  });

  it("dispatches from its main-process timer without any renderer activity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const harness = createHarness();
    const service = new ScheduledThreadActionService({
      registry: harness.registry,
      store,
    });
    service.start();
    await service.create({
      backend: "codex",
      threadId: "thread-1",
      kind: "turn",
      scheduledFor: 2_000,
      displayText: "Follow up",
      turn: { input: [{ type: "text", text: "Follow up" }] },
    });

    await vi.advanceTimersByTimeAsync(1_000);

    expect(harness.submitTurn).toHaveBeenCalledTimes(1);
    expect(store.list()).toEqual([
      expect.objectContaining({ status: "queued" }),
    ]);
    service.dispose();
    vi.useRealTimers();
  });

  it("claims due turns and hands them to the registry FIFO once", async () => {
    const harness = createHarness(20_000);
    store.create({
      id: "scheduled-1",
      backend: "codex",
      threadId: "thread-1",
      kind: "turn",
      origin: "desktop",
      scheduledFor: 10_000,
      displayText: "Follow up",
      turn: { input: [{ type: "text", text: "Follow up" }] },
      now: 1_000,
    });

    await harness.service.evaluateDueActions();
    await harness.service.evaluateDueActions();

    expect(harness.submitTurn).toHaveBeenCalledTimes(1);
    expect(harness.submitTurn).toHaveBeenCalledWith(expect.objectContaining({
      queueEntryId: "scheduled-turn:scheduled-1",
      origin: "scheduled",
    }));
    expect(store.get("scheduled-1")).toMatchObject({
      status: "queued",
      queueEntryId: "scheduled-turn:scheduled-1",
    });
  });

  it("persists a registry hold and retries its existing queue entry", async () => {
    const harness = createHarness(20_000);
    store.create({
      id: "scheduled-1",
      backend: "codex",
      threadId: "thread-1",
      kind: "turn",
      origin: "desktop",
      scheduledFor: 10_000,
      displayText: "Follow up",
      turn: { input: [{ type: "text", text: "Follow up" }] },
      now: 1_000,
    });
    await harness.service.evaluateDueActions();
    harness.service.start();

    for (const listener of harness.listeners) {
      await listener({
        backend: "codex",
        notification: {
          method: "thread/turnQueue/updated",
          params: {
            threadId: "thread-1",
            queueEntryId: "scheduled-turn:scheduled-1",
            origin: "scheduled",
            status: "held",
            errorMessage: "Provider unavailable",
          },
        },
      });
    }

    expect(store.get("scheduled-1")).toMatchObject({
      status: "held",
      queueEntryId: "scheduled-turn:scheduled-1",
      errorMessage: "Provider unavailable",
      manualReleaseRequired: true,
    });
    const retried = await harness.service.sendNow({ id: "scheduled-1" });
    expect(retried.action).toMatchObject({
      status: "started",
      turnId: "turn-retried",
    });
    expect(harness.submitHeldTurn).toHaveBeenCalledWith(expect.objectContaining({
      queueEntryId: "scheduled-turn:scheduled-1",
    }));
    expect(harness.releaseQueuedTurnWithDisposition)
      .toHaveBeenCalledWith("scheduled-turn:scheduled-1");
    harness.service.dispose();
  });

  it("does not claim a later action until the current admission settles", async () => {
    const harness = createHarness(20_000);
    let releaseFirst!: () => void;
    harness.submitTurn.mockImplementationOnce(() => new Promise((resolve) => {
      releaseFirst = () => resolve({
        status: "queued" as const,
        entry: {
          id: "scheduled-turn:scheduled-1",
          backend: "codex" as const,
          threadId: "thread-1",
          origin: "scheduled" as const,
          input: [{ type: "text" as const, text: "First" }],
          createdAt: 20_000,
        },
        position: 1,
      });
    }));
    for (const [id, text, createdAt] of [
      ["scheduled-1", "First", 1_000],
      ["scheduled-2", "Second", 2_000],
    ] as const) {
      store.create({
        id,
        backend: "codex",
        threadId: "thread-1",
        kind: "turn",
        origin: "desktop",
        scheduledFor: 10_000,
        displayText: text,
        turn: { input: [{ type: "text", text }] },
        now: createdAt,
      });
    }

    const evaluating = harness.service.evaluateDueActions();
    await vi.waitFor(() => expect(harness.submitTurn).toHaveBeenCalledTimes(1));

    expect(store.get("scheduled-1")?.status).toBe("dispatching");
    expect(store.get("scheduled-2")?.status).toBe("scheduled");

    releaseFirst();
    await evaluating;
    expect(harness.submitTurn).toHaveBeenCalledTimes(2);
  });

  it("does not recover an expired claim while its scheduler process is alive", async () => {
    const harness = createHarness(20_000);
    store.create({
      id: "scheduled-1",
      backend: "codex",
      threadId: "thread-1",
      kind: "turn",
      origin: "desktop",
      scheduledFor: 10_000,
      displayText: "Follow up",
      turn: { input: [{ type: "text", text: "Follow up" }] },
      now: 1_000,
    });
    const first = new ScheduledThreadActionService({
      registry: harness.registry,
      store,
      now: () => 20_000,
      ownerId: "instance-1",
      setTimer: vi.fn(() => ({}) as ReturnType<typeof setTimeout>),
      clearTimer: vi.fn(),
      setLeaseTimer: vi.fn(() => ({}) as ReturnType<typeof setInterval>),
      clearLeaseTimer: vi.fn(),
    });
    first.start();
    await vi.waitFor(() => expect(harness.submitTurn).toHaveBeenCalledTimes(1));
    let ownerAlive = true;
    let secondHeartbeat: (() => void) | undefined;
    const second = new ScheduledThreadActionService({
      registry: harness.registry,
      store,
      now: () => 100_000,
      ownerId: "instance-2",
      isOwnerAlive: (ownerId) => ownerId === "instance-1" && ownerAlive,
      setTimer: vi.fn(() => ({}) as ReturnType<typeof setTimeout>),
      clearTimer: vi.fn(),
      setLeaseTimer: vi.fn((callback) => {
        secondHeartbeat = callback;
        return {} as ReturnType<typeof setInterval>;
      }),
      clearLeaseTimer: vi.fn(),
    });

    second.start();
    await Promise.resolve();

    expect(harness.submitTurn).toHaveBeenCalledTimes(1);
    expect(store.get("scheduled-1")?.status).toBe("queued");

    ownerAlive = false;
    secondHeartbeat?.();
    await vi.waitFor(() => expect(harness.submitTurn).toHaveBeenCalledTimes(2));
    expect(store.get("scheduled-1")?.status).toBe("queued");
    second.dispose();
    first.dispose();
  });

  it("keeps queued claims leased when the scheduler stops before the registry", async () => {
    const harness = createHarness(20_000);
    store.create({
      id: "scheduled-1",
      backend: "codex",
      threadId: "thread-1",
      kind: "turn",
      origin: "desktop",
      scheduledFor: 10_000,
      displayText: "Follow up",
      turn: { input: [{ type: "text", text: "Follow up" }] },
      now: 1_000,
    });
    const first = new ScheduledThreadActionService({
      registry: harness.registry,
      store,
      now: () => 20_000,
      ownerId: "instance-1",
      setTimer: vi.fn(() => ({}) as ReturnType<typeof setTimeout>),
      clearTimer: vi.fn(),
      setLeaseTimer: vi.fn(() => ({}) as ReturnType<typeof setInterval>),
      clearLeaseTimer: vi.fn(),
    });
    first.start();
    await vi.waitFor(() => expect(harness.submitTurn).toHaveBeenCalledTimes(1));

    first.dispose();
    const second = new ScheduledThreadActionService({
      registry: harness.registry,
      store,
      now: () => 20_001,
      ownerId: "instance-2",
      setTimer: vi.fn(() => ({}) as ReturnType<typeof setTimeout>),
      clearTimer: vi.fn(),
      setLeaseTimer: vi.fn(() => ({}) as ReturnType<typeof setInterval>),
      clearLeaseTimer: vi.fn(),
    });
    second.start();
    await Promise.resolve();

    expect(store.get("scheduled-1")?.status).toBe("queued");
    expect(harness.submitTurn).toHaveBeenCalledTimes(1);
    second.dispose();
  });

  it("sends a future action now through the same atomic claim", async () => {
    const harness = createHarness(5_000);
    store.create({
      id: "scheduled-1",
      backend: "codex",
      threadId: "thread-1",
      kind: "turn",
      origin: "desktop",
      scheduledFor: 50_000,
      displayText: "Follow up",
      turn: { input: [{ type: "text", text: "Follow up" }] },
      now: 1_000,
    });

    const first = await harness.service.sendNow({ id: "scheduled-1" });
    await expect(harness.service.sendNow({ id: "scheduled-1" }))
      .rejects.toThrow("no longer scheduled");

    expect(first.action.status).toBe("queued");
    expect(harness.submitTurn).toHaveBeenCalledTimes(1);
  });

  it("keeps a stale steer held until send-now explicitly releases it", async () => {
    const harness = createHarness(5_000);
    const created = await harness.service.create(
      {
        backend: "codex",
        threadId: "thread-1",
        kind: "turn",
        origin: "desktop",
        scheduledFor: 5_000,
        manualReleaseRequired: true,
        displayText: "Follow up",
        turn: { input: [{ type: "text", text: "Follow up" }] },
      },
      { id: "stale-steer-1" },
    );

    expect(created.action).toMatchObject({
      status: "held",
      manualReleaseRequired: true,
    });
    expect(harness.submitTurn).not.toHaveBeenCalled();
    expect(harness.submitHeldTurn).not.toHaveBeenCalled();

    const retried = await harness.service.sendNow({ id: created.action.id });

    expect(retried.action).toMatchObject({
      status: "started",
      turnId: "turn-retried",
    });
    expect(harness.submitHeldTurn).toHaveBeenCalledWith(expect.objectContaining({
      backend: "codex",
      threadId: "thread-1",
      queueEntryId: `scheduled-turn:${created.action.id}`,
    }));
    expect(harness.releaseQueuedTurnWithDisposition)
      .toHaveBeenCalledWith(`scheduled-turn:${created.action.id}`);
  });

  it("keeps a stale steer retryable when provider admission is still blocked", async () => {
    const harness = createHarness(5_000);
    harness.releaseQueuedTurnWithDisposition
      .mockResolvedValueOnce({
        disposition: "blocked",
        queueEntryId: "scheduled-turn:scheduled-1",
        errorMessage: "provider still offline",
      })
      .mockResolvedValueOnce({
        disposition: "started",
        queueEntryId: "scheduled-turn:scheduled-1",
        turnId: "turn-retried",
      });
    const created = await harness.service.create(
      {
        backend: "codex",
        threadId: "thread-1",
        kind: "turn",
        origin: "desktop",
        scheduledFor: 5_000,
        manualReleaseRequired: true,
        displayText: "Follow up",
        turn: { input: [{ type: "text", text: "Follow up" }] },
      },
      { id: "stale-steer-1" },
    );

    const blocked = await harness.service.sendNow({ id: created.action.id });
    expect(blocked.action).toMatchObject({
      status: "held",
      errorMessage: "provider still offline",
      manualReleaseRequired: true,
    });

    const retried = await harness.service.sendNow({ id: created.action.id });
    expect(retried.action).toMatchObject({
      status: "started",
      turnId: "turn-retried",
    });
    expect(harness.releaseQueuedTurnWithDisposition).toHaveBeenCalledTimes(2);
  });

  it("rejects send-now when backend admission fails without losing the error", async () => {
    const harness = createHarness(5_000);
    harness.submitTurn.mockRejectedValueOnce(new Error("backend offline"));
    store.create({
      id: "scheduled-1",
      backend: "codex",
      threadId: "thread-1",
      kind: "turn",
      origin: "desktop",
      scheduledFor: 50_000,
      displayText: "Follow up",
      turn: { input: [{ type: "text", text: "Follow up" }] },
      now: 1_000,
    });

    await expect(harness.service.sendNow({ id: "scheduled-1" }))
      .rejects.toThrow("backend offline");

    expect(store.get("scheduled-1")).toMatchObject({
      status: "failed",
      errorMessage: "backend offline",
    });
  });

  it("rejects an immediately due create when backend admission fails", async () => {
    const harness = createHarness(5_000);
    harness.submitTurn.mockRejectedValueOnce(new Error("backend unavailable"));

    await expect(harness.service.create({
      backend: "codex",
      threadId: "thread-1",
      kind: "turn",
      scheduledFor: 5_000,
      displayText: "Follow up",
      turn: { input: [{ type: "text", text: "Follow up" }] },
    })).rejects.toThrow("backend unavailable");

    expect(store.list({ includeTerminal: true })).toEqual([
      expect.objectContaining({
        status: "failed",
        errorMessage: "backend unavailable",
      }),
    ]);
  });

  it("cancels an action already waiting in the registry", async () => {
    const harness = createHarness(20_000);
    store.create({
      id: "scheduled-1",
      backend: "codex",
      threadId: "thread-1",
      kind: "turn",
      origin: "desktop",
      scheduledFor: 10_000,
      displayText: "Follow up",
      turn: { input: [{ type: "text", text: "Follow up" }] },
      now: 1_000,
    });
    await harness.service.evaluateDueActions();

    const response = await harness.service.cancel({ id: "scheduled-1" });

    expect(harness.cancelQueuedTurn).toHaveBeenCalledWith(
      "scheduled-turn:scheduled-1",
      "Scheduled action cancelled.",
    );
    expect(response.action.status).toBe("cancelled");
    expect(harness.markScheduledThreadStartTerminal).toHaveBeenCalledWith({
      actionId: "scheduled-1",
      backend: "codex",
      state: "cancelled",
      threadId: "thread-1",
    });
  });

  it("accepts cancellation when the registry event wins the store race", async () => {
    const harness = createHarness(20_000);
    store.create({
      id: "scheduled-1",
      backend: "codex",
      threadId: "thread-1",
      kind: "turn",
      origin: "desktop",
      scheduledFor: 10_000,
      displayText: "Follow up",
      turn: { input: [{ type: "text", text: "Follow up" }] },
      now: 1_000,
    });
    await harness.service.evaluateDueActions();
    harness.cancelQueuedTurn.mockImplementation(() => {
      store.markCancelled("scheduled-1", 20_000);
      return true;
    });

    await expect(harness.service.cancel({ id: "scheduled-1" }))
      .resolves.toMatchObject({
        action: { status: "cancelled" },
      });
  });

  it("cancels a held action whose process-local queue entry was lost", async () => {
    const harness = createHarness(20_000);
    store.create({
      id: "scheduled-1",
      backend: "codex",
      threadId: "thread-1",
      kind: "turn",
      origin: "desktop",
      scheduledFor: 10_000,
      manualReleaseRequired: true,
      displayText: "Follow up",
      turn: { input: [{ type: "text", text: "Follow up" }] },
      now: 1_000,
    });
    store.claim("scheduled-1", {
      now: 2_000,
      ownerId: "scheduler-1",
      leaseExpiresAt: 32_000,
    });
    store.markQueued(
      "scheduled-1",
      "scheduled-turn:scheduled-1",
      2_001,
      "scheduler-1",
    );
    store.markHeld(
      "scheduled-1",
      "scheduled-turn:scheduled-1",
      "Provider unavailable",
      2_002,
      "scheduler-1",
    );
    harness.cancelQueuedTurn.mockReturnValueOnce(false);

    await expect(harness.service.cancel({ id: "scheduled-1" }))
      .resolves.toMatchObject({
        action: { status: "cancelled" },
      });
    expect(harness.cancelQueuedTurn).toHaveBeenCalledWith(
      "scheduled-turn:scheduled-1",
      "Scheduled action cancelled.",
    );
  });

  it("tracks a scheduled review until the registry actually starts it", async () => {
    const harness = createHarness(20_000);
    harness.service.start();
    const response = await harness.service.create({
      backend: "codex",
      threadId: "thread-1",
      kind: "review",
      origin: "desktop",
      scheduledFor: 10_000,
      displayText: "/review",
      review: { target: { type: "uncommittedChanges" } },
    });

    expect(store.get(response.action.id)).toMatchObject({
      status: "queued",
      queueEntryId: "review-1",
    });
    expect(harness.submitReview).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: response.action.id,
      }),
    );
    await Promise.all([...harness.listeners].map((listener) => listener({
      backend: "codex",
      notification: {
        method: "thread/reviewStart/updated",
        params: {
          threadId: "thread-1",
          pendingReviewId: "review-1",
          status: "started",
          reviewTurnId: "review-turn-1",
        },
      },
    })));
    expect(store.get(response.action.id)).toMatchObject({
      status: "started",
      turnId: "review-turn-1",
    });
    expect(harness.markScheduledThreadBorn).toHaveBeenCalledWith({
      actionId: response.action.id,
      backend: "codex",
      threadId: "thread-1",
    });
    harness.service.dispose();
  });
});
