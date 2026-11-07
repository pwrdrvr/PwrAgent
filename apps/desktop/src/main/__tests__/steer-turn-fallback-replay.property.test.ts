import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import type { SteerTurnRequest } from "@pwragent/shared";
import type { DesktopBackendRegistry } from "../app-server/backend-registry";
import { ScheduledThreadActionService } from "../scheduled-actions/scheduled-thread-action-service";
import { ScheduledThreadActionStore } from "../storage/scheduled-thread-action-store";
import { admitSteerTurn } from "../scheduled-actions/steer-turn-admission";
import { openInMemoryStateDb } from "./sqlite-test-utils";

async function replayAfterReview(params: { text: string; started: boolean; retries: number }) {
  const db = openInMemoryStateDb();
  const store = new ScheduledThreadActionStore(db);
  let reviewRunning = true;
  const steerTurn = vi.fn(async () => {
    throw new Error(reviewRunning
      ? "Native review steering is unsupported; queue a follow-up instead."
      : "expected active turn id `review` but found `follow-up`");
  });
  const submitTurn = vi.fn(async (turn) => ({
    status: "queued" as const,
    entry: { ...turn, id: turn.queueEntryId, createdAt: 1 }, position: 1,
  }));
  const registry = { steerTurn, submitTurn, publishLocalEvent: vi.fn(async () => undefined) } as unknown as DesktopBackendRegistry;
  const scheduler = new ScheduledThreadActionService({ registry, store });
  const request: SteerTurnRequest = {
    backend: "codex", threadId: "parent", expectedTurnId: "review", requestId: "steer",
    input: [{ type: "text", text: params.text }],
    fallback: { displayText: params.text, turn: { input: [{ type: "text", text: params.text }] } },
  };
  try {
    const admitted = await admitSteerTurn(registry, scheduler, request);
    const id = admitted.scheduledAction!.id;
    reviewRunning = false;
    if (params.started) store.markStarted(id, "follow-up", Date.now());
    for (let retry = 0; retry < params.retries; retry += 1) {
      const replay = await admitSteerTurn(registry, scheduler, request);
      expect(replay.scheduledAction).toEqual(store.get(id));
      expect(replay.scheduledAction?.manualReleaseRequired).not.toBe(true);
      if (params.started) expect(replay.turnId).toBe("follow-up");
    }
    expect(steerTurn).toHaveBeenCalledOnce();
    expect(submitTurn).toHaveBeenCalledOnce();
    // A replay still validates the sender's payload before returning a receipt.
    await expect(admitSteerTurn(registry, scheduler, {
      ...request,
      fallback: { ...request.fallback!, displayText: `${params.text} changed` },
    })).rejects.toThrow("reused with different input");
    expect(steerTurn).toHaveBeenCalledOnce();
    expect(submitTurn).toHaveBeenCalledOnce();
  } finally {
    scheduler.dispose();
    db.close();
  }
}

describe("steer fallback replay", () => {
  it("replays an admitted native-review fallback after the review ends", async () => {
    await replayAfterReview({ text: "Follow up after review", started: false, retries: 1 });
  });

  // Provider state may change between attempts; the durable admission owns
  // the result of every later attempt with the same identity and payload.
  it("never reclassifies or resubmits an admitted fallback", async () => {
    await fc.assert(fc.asyncProperty(fc.record({
      text: fc.string({ maxLength: 40 }).map((text) => `Follow up: ${text}`),
      started: fc.boolean(), retries: fc.integer({ min: 1, max: 4 }),
    }), replayAfterReview), { numRuns: 25 });
  });
});
