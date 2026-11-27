import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stackAutomationGates, stackDispatchBlock } from "@pwragent/shared/stacks/stack-automation";
import { createDesktopBackendRegistry } from "../app-server/backend-registry-wiring";
import { StateDb } from "../state/state-db";
import { getReviewAutoFixRuns, readReviewAutoFixStatus, resetReviewAutoFixArmingForTests } from "../thread-reviews/review-auto-fix";
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

  it("marks a lower review fix as repair work as soon as the queue claims it", async () => {
    const client = new MockBackendClient({ startTurnResults: [{ threadId: thread.threadId, turnId: "review-fix" }] });
    const registry = createDesktopBackendRegistry({
      codexClient: client, overlayStore: createOverlayStoreMock(), threadTitleGenerationService: null,
    });
    const preparing = createDeferred<void>();
    const resume = createDeferred<void>();
    vi.spyOn(registry, "assertThreadCodexInferenceAvailable").mockImplementationOnce(async () => {
      preparing.resolve();
      await resume.promise;
    });
    const start = registry.submitTurnIfIdle({
      ...thread, origin: "automation", input: [{ type: "text", text: "Fix the review" }],
      messageOrigin: { kind: "pwragent", reviewAutoFix: { reviewId: "review", findingCount: 1 } },
    });
    try {
      await Promise.race([preparing.promise, start]);
      expect(client.startTurnCalls).toHaveLength(0);
      expect(registry.getQueuedTurnsForThread(thread)).toEqual([]);
      expect(await registry.stackRepairActive(thread)).toBe(true);
      resume.resolve();
      await expect(start).resolves.toMatchObject({ status: "started" });
      await client.emit(completed("review-fix"));
      expect(await registry.stackRepairActive(thread)).toBe(false);
    } finally {
      resume.resolve();
      await Promise.allSettled([start]);
      await registry.close();
    }
  });

  it.each([
    { provenance: "with captured PRs", capturedTargets: true },
    { provenance: "without captured PRs", capturedTargets: false },
  ])("keeps a waiting review $provenance from becoming its own prerequisite", async ({ capturedTargets }) => {
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({}), overlayStore: createOverlayStoreMock(), threadTitleGenerationService: null,
    });
    try {
      const prs = [1, 2].map((number) => ({
        provider: "github.com", org: "fixture", repo: "stack", number,
        url: `https://github.com/fixture/stack/pull/${number}`,
      }));
      // The dispatcher publishes the queued card before testing the gate.
      // Nothing has been admitted to the turn queue yet.
      const review = { ...thread, ...(capturedTargets ? {
        context: { workspacePath: "/repo", pullRequest: prs[0], pullRequests: prs },
      } : {}) };
      getReviewAutoFixRuns().record(review, "review-of-stack", { kind: "queue", status: "held", at: 1 });
      const repair = await registry.stackRepairActive(thread);
      const layers = prs.map((pr) => ({
        branch: `layer-${pr.number}`, pullRequest: pr, number: pr.number,
        health: "in_sync" as const, checks: "passing" as const, conflict: false, repair,
      }));
      const gates = stackAutomationGates(layers);
      expect(layers.map((layer, index) => stackDispatchBlock({ ...layer, ...gates[index] })))
        .toEqual([undefined, undefined]);
    } finally {
      resetReviewAutoFixArmingForTests();
      await registry.close();
    }
  });

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

  it("preserves Auto-fix handoff precedence and does not strand when readReviewStackHold and Codex idle-before-completed run", async () => {
    const temp = createTempStateDb("pwragent-review-handoff-stack-");
    db = StateDb.open(temp.dbPath);
    const client = new MockBackendClient({
      initializeResult: { methods: ["turn/start", "turn/steer", "review/start"] },
      startTurnResults: [
        { threadId: thread.threadId, turnId: "fix-0" },
        { threadId: thread.threadId, turnId: "followup-1" },
      ],
    });
    const registry = createDesktopBackendRegistry({
      codexClient: client, overlayStore: createOverlayStoreMock(), threadTitleGenerationService: null,
    });
    const firstStarted = createDeferred<void>();
    const secondStarted = createDeferred<void>();
    let holdCalls = 0;
    const holdGate = createDeferred<void>();
    try {
      installThreadTodoRuntime({
        registry,
        broadcast: () => {},
        listProjects: async () => [],
        readDefaultMergeMethod: () => "squash",
        readReviewStackHold: async () => {
          holdCalls++;
          // Keep the initial check in flight across thread/status/changed(idle) and turn/completed.
          if (holdCalls === 1) await holdGate.promise;
          return undefined;
        },
        feed: { loadOwners: async () => [], managedThreadKeys: () => new Set(), onDelta: () => {} },
      });
      registry.onEvent(({ notification }) => {
        if (notification.method !== "thread/turnQueue/updated" || notification.params.status !== "started") return;
        if (notification.params.turnId === "fix-0") firstStarted.resolve();
        if (notification.params.turnId === "followup-1") secondStarted.resolve();
      });

      await registry.startReview({ ...thread, target: { type: "uncommittedChanges" }, afterReview: "auto-fix" });
      await registry.submitTurn({ ...thread, input: [{ type: "text", text: "Follow-up 0" }] });

      await client.emit(findings);
      // Real Codex sequence: status=idle right before turn/completed while stack check is still running.
      await client.emit({
        method: "thread/status/changed",
        params: { threadId: thread.threadId, status: { type: "idle" } },
      });
      await client.emit(completed(reviewTurnId));
      holdGate.resolve();

      await firstStarted.promise;
      expect(client.startTurnCalls).toHaveLength(1);
      expect(client.startTurnCalls[0]?.input[0]).toMatchObject({ text: expect.stringContaining("Preserve the draft") });
      expect(Object.values(readReviewAutoFixStatus(thread).runs)[0]?.phase).toBe("running");
      expect(await registry.stackRepairActive(thread)).toBe(true);

      await client.emit(completed("fix-0"));
      await secondStarted.promise;
      expect(client.startTurnCalls[1]?.input[0]).toMatchObject({ text: "Follow-up 0" });
      expect(await registry.stackRepairActive(thread)).toBe(false);
    } finally {
      holdGate.resolve();
      resetThreadTodoServiceForTests();
      resetReviewAutoFixArmingForTests();
      await registry.close();
      db.close();
      removeTempStateDbDir(temp.tempDir);
    }
  });

  it("matches an armed Codex review when exitedReviewMode carries Codex's mismatched inner turn id", async () => {
    const temp = createTempStateDb("pwragent-review-handoff-inner-");
    db = StateDb.open(temp.dbPath);
    const client = new MockBackendClient({
      initializeResult: { methods: ["turn/start", "turn/steer", "review/start"] },
      startTurnResults: [{ threadId: thread.threadId, turnId: "fix-inner-0" }],
    });
    const registry = createDesktopBackendRegistry({
      codexClient: client, overlayStore: createOverlayStoreMock(), threadTitleGenerationService: null,
    });
    const fixStarted = createDeferred<void>();
    try {
      installThreadTodoRuntime({
        registry,
        broadcast: () => {},
        listProjects: async () => [],
        readDefaultMergeMethod: () => "squash",
        readReviewStackHold: async () => undefined,
        feed: { loadOwners: async () => [], managedThreadKeys: () => new Set(), onDelta: () => {} },
      });
      const observedReviewItems: Array<{ type: string; relatedReviewTurnId?: string; reviewer?: unknown }> = [];
      let terminalRelatedReviewTurnId: string | undefined;
      registry.onEvent((event) => {
        const { notification } = event;
        if (notification.method === "item/completed") {
          const item = notification.params.item as { type?: string; data?: { reviewer?: unknown } } | undefined;
          if (item?.type === "enteredReviewMode" || item?.type === "exitedReviewMode") {
            observedReviewItems.push({
              type: item.type,
              relatedReviewTurnId: event.relatedReviewTurnId,
              reviewer: item.data?.reviewer,
            });
          }
        }
        if (notification.method === "turn/completed" && notification.params.turnId === "turn-inner-mismatched") {
          terminalRelatedReviewTurnId = event.relatedReviewTurnId;
        }
        if (notification.method === "thread/turnQueue/updated"
          && notification.params.status === "started"
          && notification.params.turnId === "fix-inner-0") {
          fixStarted.resolve();
        }
      });

      const reviewStart = client.startReview.bind(client);
      vi.spyOn(client, "startReview").mockImplementationOnce(async (params) => {
        await client.emit({
          method: "turn/started",
          params: { threadId: thread.threadId, turn: { id: "turn-inner-mismatched", status: "inProgress" } },
        });
        return await reviewStart(params);
      });

      await registry.startReview({ ...thread, target: { type: "uncommittedChanges" }, afterReview: "auto-fix" });
      await client.emit({
        method: "item/completed",
        params: {
          threadId: thread.threadId,
          turnId: "turn-inner-mismatched",
          item: {
            id: "review-enter-inner",
            type: "enteredReviewMode",
            review: "Reviewing uncommitted changes",
          },
        },
      });
      await client.emit({
        ...findings,
        params: { ...findings.params, turnId: "turn-inner-mismatched" },
      });
      await client.emit(completed("turn-inner-mismatched"));

      await fixStarted.promise;
      // relatedReviewTurnId is terminal-only: review item/completed events must
      // never carry it (which would prematurely retire live renderer entries),
      // while still receiving runtime metadata and terminal correlation.
      expect(observedReviewItems).toHaveLength(2);
      for (const item of observedReviewItems) {
        expect(item.relatedReviewTurnId).toBeUndefined();
        expect(item.reviewer).toBeDefined();
      }
      expect(terminalRelatedReviewTurnId).toBe(reviewTurnId);
      expect(client.startTurnCalls).toHaveLength(1);
      expect(client.startTurnCalls[0]?.input[0]).toMatchObject({ text: expect.stringContaining("Preserve the draft") });
      expect(readReviewAutoFixStatus(thread).armedTurnIds).toEqual([]);
    } finally {
      resetThreadTodoServiceForTests();
      resetReviewAutoFixArmingForTests();
      await registry.close();
      db.close();
      removeTempStateDbDir(temp.tempDir);
    }
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
