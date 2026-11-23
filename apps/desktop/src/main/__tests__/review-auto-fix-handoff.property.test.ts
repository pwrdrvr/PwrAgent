import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopBackendRegistry } from "../app-server/backend-registry-wiring";
import { StateDb } from "../state/state-db";
import { readReviewAutoFixStatus, resetReviewAutoFixArmingForTests } from "../thread-reviews/review-auto-fix";
import { installThreadTodoRuntime, resetThreadTodoServiceForTests } from "../thread-todos/thread-todo-runtime";
import { createDeferred, createOverlayStoreMock, MockBackendClient } from "./helpers/backend-registry-fixture";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

let db: StateDb;
vi.mock("../state/app-state", async (importOriginal) => ({
  ...await importOriginal<typeof import("../state/app-state")>(),
  getAppStateDb: () => db,
}));

const thread = { backend: "codex" as const, threadId: "review-owner" };
const reviewTurnId = "turn-review-1";
const completed = (turnId: string) => ({
  method: "turn/completed" as const,
  params: { threadId: thread.threadId, turnId, turn: { id: turnId, status: "completed" as const, output: [] } },
});
const findings = {
  method: "item/completed" as const,
  params: { threadId: thread.threadId, turnId: reviewTurnId, item: {
    id: "review-result", type: "exitedReviewMode", review: "",
    reviewOutput: {
      overall_correctness: "patch is incorrect",
      overall_explanation: "Closing the editor can lose a draft.",
      findings: [{
        title: "Preserve the draft", body: "Closing the editor drops an unsaved draft.",
        code_location: { absolute_file_path: "/repo/editor.ts", line_range: { start: 1, end: 1 } },
        priority: 2,
      }],
    },
  } },
};

describe("review Auto-fix handoff", () => {
  afterEach(() => vi.restoreAllMocks());

  // Model: an armed review and its fix occupy consecutive turns. Other
  // messages wait in their admission order, including guidance that can steer.
  async function checkHandoff(
    deliveries: readonly ("message" | "guidance")[],
    pause: "admission" | "result delivery" | "refusal",
    steerDuringFix = false,
  ): Promise<void> {
    const temp = createTempStateDb("pwragent-review-handoff-");
    db = StateDb.open(temp.dbPath);
    const client = new MockBackendClient({
      initializeResult: { methods: ["turn/start", "turn/steer", "review/start"] },
      startTurnResults: Array.from({ length: deliveries.length + 1 }, (_, index) => ({
        threadId: thread.threadId, turnId: `next-${index}`,
      })),
    });
    const registry = createDesktopBackendRegistry({
      codexClient: client, overlayStore: createOverlayStoreMock(), threadTitleGenerationService: null,
    });
    const entered = createDeferred<void>();
    const resume = createDeferred<void>();
    const firstStarted = createDeferred<void>();
    const secondStarted = createDeferred<void>();
    let result: Promise<void> | undefined;
    let terminal: Promise<void> | undefined;
    let autoFixSubmission: Promise<unknown> | undefined;
    try {
      if (pause === "result delivery") {
        registry.onEvent(async ({ notification }) => {
          if (notification.method !== "item/completed") return;
          entered.resolve();
          await resume.promise;
        });
      }
      installThreadTodoRuntime({
        registry, broadcast: () => {}, listProjects: async () => [], readDefaultMergeMethod: () => "squash",
        feed: { loadOwners: async () => [], managedThreadKeys: () => new Set(), onDelta: () => {} },
      });
      registry.onEvent(({ notification }) => {
        if (notification.method !== "thread/turnQueue/updated" || notification.params.status !== "started") return;
        if (notification.params.turnId === "next-0") firstStarted.resolve();
        if (notification.params.turnId === "next-1") secondStarted.resolve();
      });
      await registry.startReview({ ...thread, target: { type: "uncommittedChanges" }, afterReview: "auto-fix" });
      for (const [index, delivery] of deliveries.entries()) {
        const input = [{ type: "text" as const, text: `Follow-up ${index}` }];
        if (delivery === "guidance") await registry.submitThreadReply({ ...thread, input });
        else await registry.submitTurn({ ...thread, input });
      }
      const submit = registry.submitTurn.bind(registry);
      vi.spyOn(registry, "submitTurn").mockImplementation((...args) => {
        const pending = submit(...args);
        if (args[0].messageOrigin?.reviewAutoFix) autoFixSubmission = pending;
        return pending;
      });
      if (pause !== "result delivery") {
        const assertInference = registry.assertThreadCodexInferenceAvailable.bind(registry);
        vi.spyOn(registry, "assertThreadCodexInferenceAvailable").mockImplementationOnce(async (params) => {
          entered.resolve();
          await resume.promise;
          if (pause === "refusal") throw new Error("Fix admission refused");
          await assertInference(params);
        });
      }
      result = client.emit(findings);
      await entered.promise;
      terminal = client.emit(completed(reviewTurnId));
      if (pause !== "result delivery") await terminal;
      else await new Promise<void>((resolve) => setImmediate(resolve));
      resume.resolve();
      await Promise.all([result, terminal]);
      expect(autoFixSubmission).toBeDefined();
      if (pause === "refusal") {
        await expect(autoFixSubmission).rejects.toThrow("Fix admission refused");
        await firstStarted.promise;
        expect(client.startTurnCalls[0]?.input[0]).toMatchObject({ text: "Follow-up 0" });
        expect(Object.values(readReviewAutoFixStatus(thread).runs)[0]).toMatchObject({
          phase: "failed", reason: "Fix admission refused",
        });
        return;
      }
      await autoFixSubmission;

      await firstStarted.promise;
      expect(client.startTurnCalls).toHaveLength(1);
      expect(client.startTurnCalls[0]?.input[0]).toMatchObject({ text: expect.stringContaining("Preserve the draft") });
      expect(client.lastSteerTurnParams).toBeUndefined();
      expect(Object.values(readReviewAutoFixStatus(thread).runs)[0]?.phase).toBe("running");
      if (steerDuringFix) {
        // The provider's stale-target rejection must reach the held fallback.
        vi.spyOn(client, "steerTurn").mockRejectedValueOnce(new Error("expected active turn id turn-review-1, found next-0"));
        await expect(registry.steerTurn({
          ...thread, expectedTurnId: reviewTurnId, requestId: "stale-steer",
          input: [{ type: "text", text: "Guidance for the finished review" }],
        })).rejects.toThrow("expected active turn id turn-review-1, found next-0");
        const steered = await registry.steerTurn({
          ...thread, expectedTurnId: "next-0", requestId: "operator-steer",
          input: [{ type: "text", text: "New guidance" }],
        });
        expect(steered).toMatchObject({ disposition: "queued" });
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(client.lastSteerTurnParams).toBeUndefined();
      expect(registry.getQueuedTurnsForThread(thread).map((entry) => entry.displayText)).toEqual([
        ...deliveries.map((_, index) => `Follow-up ${index}`),
        ...(steerDuringFix ? ["New guidance"] : []),
      ]);

      await client.emit(completed("next-0"));
      await secondStarted.promise;
      expect(client.startTurnCalls[1]?.input[0]).toMatchObject({ text: "Follow-up 0" });
    } finally {
      resume.resolve();
      await Promise.allSettled([result, terminal, autoFixSubmission]);
      resetThreadTodoServiceForTests();
      resetReviewAutoFixArmingForTests();
      await registry.close();
      db.close();
      removeTempStateDbDir(temp.tempDir);
    }
  }

  it("runs Auto-fix before an already queued message while fix admission is pending", async () => {
    await checkHandoff(["message"], "admission");
  });

  it("preserves the arm when terminal delivery overlaps the earlier result", async () => {
    await checkHandoff(["message"], "result delivery");
  });

  it("queues a steer targeted at the running fix", async () => {
    await checkHandoff(["guidance"], "admission", true);
  });

  it("releases the queue after a refused fix admission", async () => {
    await checkHandoff(["message"], "refusal");
  });

  // A terminal may start another review, whose synthetic turn/started event
  // is itself delivered on the parent thread. The terminal and start must
  // both settle even when delivery of the first review's result overlaps.
  async function checkScheduledReview(overlap: boolean): Promise<void> {
    const client = new MockBackendClient({
      initializeResult: { methods: ["thread/start", "turn/start", "review/start"] },
      startThreadResult: { threadId: "review-child" },
    });
    const registry = createDesktopBackendRegistry({
      codexClient: client, overlayStore: createOverlayStoreMock(), threadTitleGenerationService: null,
    });
    const resultEntered = createDeferred<void>();
    const releaseResult = createDeferred<void>();
    const scheduledStarted = createDeferred<void>();
    const delivered: string[] = [];
    registry.onEvent(async ({ notification }) => {
      if (notification.method === "item/completed" && notification.params.turnId === reviewTurnId) {
        resultEntered.resolve();
        await releaseResult.promise;
        delivered.push("result");
      }
      if (notification.method === "turn/completed" && notification.params.turnId === reviewTurnId) {
        delivered.push("terminal");
      }
      if (notification.method === "thread/reviewStart/updated" && notification.params.status === "started") {
        scheduledStarted.resolve();
      }
    });
    try {
      const request = { ...thread, target: { type: "uncommittedChanges" as const } };
      await registry.startReview(request);
      expect(await registry.submitReview({ ...request, runMode: "pwragent-sub-agent" }))
        .toMatchObject({ status: "scheduled", invokingTurnId: reviewTurnId });
      const result = client.emit(findings);
      await resultEntered.promise;
      if (!overlap) {
        releaseResult.resolve();
        await result;
      }
      const terminal = client.emit(completed(reviewTurnId));
      if (overlap) await new Promise<void>((resolve) => setImmediate(resolve));
      releaseResult.resolve();
      await Promise.all([result, terminal, scheduledStarted.promise]);
      expect(delivered).toEqual(["result", "terminal"]);
      expect(client.startTurnCalls).toHaveLength(1);
    } finally {
      releaseResult.resolve();
      resetReviewAutoFixArmingForTests();
      await registry.close();
    }
  }

  it("starts a scheduled managed review after an overlapping result and terminal", async () => {
    await checkScheduledReview(true);
  });

  it("settles both reviews across overlapping and consecutive deliveries", async () => {
    await fc.assert(fc.asyncProperty(fc.boolean(), checkScheduledReview), { numRuns: 8 });
  });

  it("gives the review and fix consecutive turns across queued messages and guidance", async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.constantFrom("message", "guidance"), { minLength: 1, maxLength: 4 }),
      fc.constantFrom("admission", "result delivery"),
      (deliveries, pause) => checkHandoff(deliveries, pause),
    ), { numRuns: 15 });
  }, 15_000);
});
