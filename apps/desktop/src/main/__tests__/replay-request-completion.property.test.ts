import { setImmediate } from "node:timers/promises";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import { ReplayClient } from "../shell/testing/replay-client";

type Scenario = {
  reuseRequestId: boolean;
  finishFirstBeforeSecond: boolean;
  rejectFirst: boolean;
};

async function replay({ reuseRequestId, finishFirstBeforeSecond, rejectFirst }: Scenario) {
  const secondRequestId = reuseRequestId ? "request-1" : "request-2";
  const client = ReplayClient.fromFixture({
    metadata: { backend: "codex", scenario: "replay-request-completion" },
    steps: ["request-1", secondRequestId].map((requestId, index) => ({
      id: `step-${index + 1}`,
      kind: "request",
      request: {
        method: "item/tool/call",
        params: { requestId, threadId: "thread-1", turnId: "turn-1" },
      },
    })),
  });
  const first = Promise.withResolvers<void>();
  const second = Promise.withResolvers<void>();
  const failure = new Error("listener rejected after explicit response");
  const listener = vi.fn()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  client.onRequest(listener);
  const log = vi.spyOn(console, "error").mockImplementation(() => {});

  function finishFirst() {
    if (rejectFirst) first.reject(failure);
    else first.resolve();
  }

  try {
    await client.advance({ stepId: "step-1" });
    await client.respondToPendingRequest("request-1");
    if (finishFirstBeforeSecond) {
      finishFirst();
      await setImmediate();
    }
    await client.advance({ stepId: "step-2" });
    if (!finishFirstBeforeSecond) {
      finishFirst();
      await setImmediate();
    }
    // Completion belongs to its own step. An explicitly answered step has
    // already left the pending set, even if the next step reuses its ID.
    expect(client.getPendingRequest()?.params.requestId).toBe(secondRequestId);
    second.resolve();
    await setImmediate();
    expect(client.getPendingRequest()).toBeUndefined();
    expect(listener).toHaveBeenCalledTimes(2);
    if (rejectFirst) {
      expect(log).toHaveBeenCalledExactlyOnceWith(
        "Replay request request-1 (item/tool/call) failed",
        failure.stack,
      );
    } else {
      expect(log).not.toHaveBeenCalled();
    }
  } finally {
    first.resolve();
    second.resolve();
    await setImmediate();
    log.mockRestore();
  }
}

it("does not report a successful listener as failed after an explicit response", async () => {
  await replay({ reuseRequestId: false, finishFirstBeforeSecond: true, rejectFirst: false });
});

it("does not let a late listener settle a newer step with the same request ID", async () => {
  await replay({ reuseRequestId: true, finishFirstBeforeSecond: false, rejectFirst: false });
});

it("keeps each listener's completion tied to its own replay step", async () => {
  await fc.assert(fc.asyncProperty(fc.record({
    reuseRequestId: fc.boolean(),
    finishFirstBeforeSecond: fc.boolean(),
    rejectFirst: fc.boolean(),
  }), replay), { numRuns: Number(process.env.MBT_RUNS ?? 8) });
});
