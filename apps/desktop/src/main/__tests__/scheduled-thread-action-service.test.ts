import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@pwragent/shared";
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
  const publishLocalEvent = vi.fn(async () => undefined);
  const registry = {
    cancelPendingReview,
    cancelQueuedTurn,
    onEvent: (listener: (event: AgentEvent) => void | Promise<void>) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publishLocalEvent,
    submitReview,
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
    publishLocalEvent,
    registry,
    service,
    submitReview,
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
    harness.service.dispose();
  });
});
