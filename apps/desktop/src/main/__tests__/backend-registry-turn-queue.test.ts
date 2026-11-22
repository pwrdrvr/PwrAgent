import {
  createDeferred,
  waitForCondition,
  createOverlayStoreMock,
  MockBackendClient,
  createKimiAgentRecord,
  createKimiAcpRegistry,
  emitCompletedTurn,
  emitStartedTurn,
  discoverCodexBackendForTest,
} from "./helpers/backend-registry-fixture";
import { createDesktopBackendRegistry } from "../app-server/backend-registry-wiring";
import { getOwnerHostServices } from "../owner-host";
import { createPwrAgentAppManagementHandler } from "../agent-tools/pwragent-app-management-service";
import fc from "fast-check";
import { threadLockRefusalMessage } from "@pwragent/shared/thread-lock";
import { ThreadCorrespondenceStore } from "../app-server/thread-correspondence-store";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import { buildThreadIdentityKey } from "@pwragent/shared/contracts/navigation";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import type {
  AppServerPendingRequestNotification,
  AppServerThreadMessageOrigin,
  AppServerTurnInputItem,
} from "@pwragent/shared/contracts/normalized-app-server";
import type {
  PwrAgentThreadOrchestrationRequest,
  PwrAgentThreadOrchestrationResponse,
} from "@pwragent/shared/contracts/thread-orchestration-tools";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import { QUIET_RESTART_STEER_TEXT } from "../app-server/thread-restart-helpers";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { TaskMonitorWakeStore } from "@pwragent/sqlite-storage/task-monitor-wake-store";
import { RestartContinuationStore, type StoredRestartContinuation } from "../state/restart-continuation-store";
import type { RestartDispatchPlanOptions } from "../app-server/restart-continuation-gate";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { ScheduledThreadActionService } from "../scheduled-actions/scheduled-thread-action-service";
import { ScheduledThreadActionStore } from "../storage/scheduled-thread-action-store";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";
import { type PwrAgentFederatedThreadMessageRequest } from "../agent-tools/pwragent-thread-orchestration-agent-tools";

describe("DesktopBackendRegistry", () => {
  it("constructs the shared owner queue and projects generated held admissions through its actual host", async () => {
    const shared = await import("@pwragent/owner-core/thread-turn-queue").catch(() => undefined);
    await fc.assert(fc.asyncProperty(
      fc.array(fc.constantFrom("awaiting-review", "target-ended"), { minLength: 1, maxLength: 8 }),
      async (reasons) => {
        const client = new MockBackendClient({ threads: [] });
        const registry = createDesktopBackendRegistry({ codexClient: client, overlayStore: createOverlayStoreMock() });
        const identity = { backend: "codex" as const, threadId: "shared-queue-owner" };
        const events: AgentEvent[] = [];
        registry.onEvent((event) => { events.push(event); });
        try {
          // This is the queue the production registry constructs, not a test
          // adapter. Its class and its host-facing projection share one owner.
          expect(shared?.ThreadTurnQueue, "owner-core must export the production queue").toBeDefined();
          const queue = (registry as unknown as { threadTurnQueue: object }).threadTurnQueue;
          expect(Object.getPrototypeOf(queue)).toBe(shared!.ThreadTurnQueue.prototype);
          const admitted: string[] = [];
          for (const [index, holdReason] of reasons.entries()) {
            const entryId = `held-${index}`;
            await registry.submitHeldTurn({ ...identity, queueEntryId: entryId, holdReason,
              input: [{ type: "text", text: entryId }] });
            admitted.push(entryId);
            expect(registry.listHeldThreadQueueEntries(identity).map((entry) => entry.entryId)).toEqual(admitted);
          }
          expect(client.startTurnCallCount).toBe(0);
          expect(events.filter((event) => event.notification.method === "thread/turnQueue/updated"
            && event.notification.params.status === "queued").map((event) =>
            (event.notification.params as { queueEntryId: string }).queueEntryId)).toEqual(admitted);
          for (const entryId of admitted) {
            expect(registry.cancelQueuedTurnWithDisposition(entryId)).toMatchObject({ disposition: "cancelled" });
          }
          expect(registry.listHeldThreadQueueEntries(identity)).toEqual([]);
          expect(client.startTurnCallCount).toBe(0);
        } finally { await registry.close(); }
      },
    ), { numRuns: 25 });
  });

  it("keeps unsupported live steering Retry held through native completion", async () => {
    await fc.assert(fc.asyncProperty(
      fc.constantFrom("acp:gemini" as const, "acp:kimi" as const),
      fc.integer({ min: 1, max: 3 }),
      fc.array(fc.constantFrom("review", "locked"), { minLength: 1, maxLength: 3 }),
      async (backend, retries, reasons) => {
        const agent = { ...createKimiAgentRecord(backend), registryId: backend.slice(4) };
        const { registry, acpClient } = createKimiAcpRegistry({ installedAgent: agent });
        const identity = { backend, threadId: "held-steering-owner" };
        const queue = (registry as unknown as {
          threadTurnQueue: import("@pwragent/owner-core/thread-turn-queue").ThreadTurnQueue;
        }).threadTurnQueue;
        const events: AgentEvent[] = [];
        registry.onEvent(event => { events.push(event); });
        try {
          const provider = (await registry.listBackends({ includeUnavailable: true })).backends
            .find(candidate => candidate.kind === backend);
          expect(provider?.capabilities.steerTurn).toBe(false);
          await emitStartedTurn(registry, backend, identity.threadId, "native-owner");
          for (const [index, reason] of reasons.entries()) {
            await queue.submitHeld({ ...identity, id: `held-${index}`, origin: "manual", delivery: "queued-steer",
              input: [{ type: "text", text: `Invented held guidance ${index}` }] }, reason);
          }
          const before = queue.getQueuedEntries(identity);
          events.length = 0;
          for (let index = 0; index < retries; index++) {
            expect(await registry.releaseQueuedTurnWithDisposition("held-0")).toMatchObject({ disposition: "busy" });
            expect(queue.getQueuedEntries(identity)).toEqual(before);
          }
          await emitCompletedTurn(registry, backend, identity.threadId, "native-owner");
          await new Promise<void>(resolve => setTimeout(resolve, 0));
          await new Promise<void>(resolve => setTimeout(resolve, 0));
          expect(queue.getQueuedEntries(identity)).toEqual(before);
          expect(acpClient.startPrompt).not.toHaveBeenCalled();
          expect(acpClient.steerSession).not.toHaveBeenCalled();
          expect(events.filter(event => event.notification.method === "thread/turnQueue/updated"
            && event.notification.params.status === "queued")).toEqual([]);
        } finally { await registry.close(); }
      },
    ), { numRuns: 12, examples: [["acp:gemini", 1, ["review"]]] });
  });

  it("budgets unsupported live steering Retry without releasing review holds", async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const temp = createTempStateDb("pwragent-held-steer-capability-");
    const db = StateDb.open(temp.dbPath);
    const { registry, acpBackendId } = createKimiAcpRegistry({ overlayStore: new SqliteOverlayStore(db) as never });
    const identity = { backend: acpBackendId, threadId: "held-steering-budget" };
    const queue = (registry as unknown as {
      threadTurnQueue: import("@pwragent/owner-core/thread-turn-queue").ThreadTurnQueue;
    }).threadTurnQueue;
    try {
      await emitStartedTurn(registry, acpBackendId, identity.threadId, "native-owner");
      await queue.submitHeld({ ...identity, id: "held-guidance", origin: "manual", delivery: "queued-steer",
        input: [{ type: "text", text: "Invented held guidance" }] }, "review");
      const before = queue.getQueuedEntries(identity);
      const { writes } = await measureSqliteWrites(async () => {
        for (let index = 0; index < 100; index++) {
          expect(await registry.releaseQueuedTurnWithDisposition("held-guidance")).toMatchObject({ disposition: "busy" });
          expect(queue.getQueuedEntries(identity)).toEqual(before);
        }
      });
      expectSqliteWriteBudget({ budgetFile: "held-steer-capability-write-budgets.json",
        scenario: "unsupported-live-steer-100-retries",
        note: "100 unsupported live steering Retry commands through the actual desktop registry with real SQLite overlay; setup excluded. Zero writes, WAL bytes and MB/day.",
        writes });
    } finally {
      await registry.close(); db.close(); removeTempStateDbDir(temp.tempDir); vi.unstubAllEnvs();
    }
  });

  it("refuses every turn source on a locked thread, naming the note, until it is unlocked", async () => {
    const registry = createDesktopBackendRegistry({ codexClient: new MockBackendClient({}), overlayStore: createOverlayStoreMock() });
    onTestFinished(() => registry.close());
    const params = { backend: "codex" as const, threadId: "parked", input: [{ type: "text" as const, text: "Continue" }] };
    await registry.setThreadLock({ ...params, locked: true, note: "Worktree handed to the repair thread" }, { source: "operator" });
    const refusal = "This thread is locked: Worktree handed to the repair thread. Unlock it before starting a turn.";

    await expect(registry.submitTurn(params)).rejects.toThrow(refusal);
    await expect(registry.submitThreadReply(params)).rejects.toThrow(refusal);
    // Automations see a lock as busy, so a PR watch waits without spending an attempt.
    await expect(registry.submitTurnIfIdle(params)).resolves.toEqual({ status: "busy" });
    await expect(registry.startTurn(params)).rejects.toThrow(refusal);
    await expect(registry.steerTurn({ ...params, expectedTurnId: "turn-1", requestId: "steer-1" })).rejects.toThrow(refusal);
    await expect(registry.startReview({ backend: "codex", threadId: "parked", target: { type: "uncommittedChanges" } }))
      .rejects.toThrow(refusal);
    await expect(registry.compactThread({ backend: "codex", threadId: "parked" })).rejects.toThrow(refusal);

    await registry.setThreadLock({ ...params, locked: false }, { source: "operator" });
    await expect(registry.submitTurnIfIdle(params)).resolves.toMatchObject({ status: "started" });
  });

  it("starts an off-screen reply on an idle thread and steers one into a running turn", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start", "turn/steer"] },
    });
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore: createOverlayStoreMock() });
    onTestFinished(() => registry.close());
    const idle = { backend: "codex" as const, threadId: "answered-idle" };
    await expect(registry.submitThreadReply({
      ...idle, input: [{ type: "text", text: "Use the staging bucket" }],
    })).resolves.toMatchObject({ status: "started", entry: { origin: "manual", delivery: "queued-steer" } });

    const running = { backend: "codex" as const, threadId: "answered-running" };
    const turn = await registry.startTurn({ ...running, input: [{ type: "text", text: "Export" }] });
    const steer = vi.spyOn(registry, "steerTurn");
    const reply = [{ type: "text" as const, text: "Keep last week's export" }];
    await expect(registry.submitThreadReply({ ...running, input: reply }))
      .resolves.toMatchObject({ status: "queued" });
    await vi.waitFor(() => expect(codexClient.steerTurnCallCount).toBe(1));
    expect(steer).toHaveBeenCalledWith(
      expect.objectContaining({ ...running, expectedTurnId: turn.turnId, input: reply }),
      undefined,
    );
    expect(registry.getQueuedTurnsForThread(running)).toEqual([]);
  });

  it("returns busy when a turn becomes active after immediate admission", async () => {
    const codexClient = new MockBackendClient({});
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore: createOverlayStoreMock() });
    onTestFinished(() => registry.close());
    const startTurn = vi.spyOn(codexClient, "startTurn");
    const params = { backend: "codex" as const, threadId: "thread-race", input: [{ type: "text" as const, text: "Repair PR" }] };
    // Turn preparation yields after the idle check. A backend notification
    // from another instance can claim the thread during that window.
    vi.spyOn(registry, "applyThreadModelMigration").mockImplementationOnce(async ({ backend, threadId }) => {
      await registry.publishLocalEvent({ backend, notification: { method: "turn/started", params: {
        threadId, turnId: "existing-turn", turn: { id: "existing-turn" },
      } } });
      return { backend, threadId, status: "none" };
    });

    await expect(registry.submitTurnIfIdle(params)).resolves.toEqual({ status: "busy" });
    expect(startTurn).not.toHaveBeenCalled();
    expect(registry.getQueuedTurnsForThread(params)).toEqual([]);
    await registry.publishLocalEvent({ backend: "codex", notification: { method: "turn/completed", params: {
      threadId: params.threadId, turnId: "existing-turn", turn: { id: "existing-turn", status: "completed", output: [] },
    } } });
    await expect(registry.submitTurnIfIdle(params)).resolves.toMatchObject({ status: "started" });
    expect(startTurn).toHaveBeenCalledTimes(1);
  });

  it("keeps a provider-confirmed busy resume pending for immediate admission", async () => {
    const { CodexThreadBusyBeforeStartError } = await import("../codex-app-server/desktop-client");
    const codexClient = new MockBackendClient({});
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore: createOverlayStoreMock() });
    onTestFinished(() => registry.close());
    vi.spyOn(codexClient, "startTurn").mockRejectedValueOnce(new CodexThreadBusyBeforeStartError(new Error("Provider rejected resume")));
    const params = { backend: "codex" as const, threadId: "busy-resume", input: [{ type: "text" as const, text: "Continue" }] };
    await expect(registry.submitTurnIfIdle(params)).resolves.toEqual({ status: "busy" });
    expect(registry.getQueuedTurnsForThread(params)).toEqual([]);
    await expect(registry.submitTurnIfIdle(params)).resolves.toMatchObject({ status: "started" });
  });

  it("preserves backend submission errors from immediate admission", async () => {
    const error = new Error("Backend disconnected before turn start");
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ startTurnError: error }), overlayStore: createOverlayStoreMock(),
    });
    onTestFinished(() => registry.close());
    await expect(registry.submitTurnIfIdle({
      backend: "codex", threadId: "thread-error", input: [{ type: "text", text: "Repair PR" }],
    })).rejects.toThrow("Backend disconnected before turn start");
  });

  it("holds a delivery on a locked thread and starts it once unlocked", async () => {
    const codexClient = new MockBackendClient({});
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore: createOverlayStoreMock() });
    onTestFinished(() => registry.close());
    const params = { backend: "codex" as const, threadId: "parked", input: [{ type: "text" as const, text: "Monitor result" }] };
    const { lock } = await registry.setThreadLock({ ...params, locked: true, note: "Parked" }, { source: "operator" });

    // A monitor's result for a locked parent is held, not refused.
    await expect(registry.submitHeldTurn({
      ...params,
      queueEntryId: "monitor-result",
      holdReason: threadLockRefusalMessage(lock!),
    })).resolves.toMatchObject({ status: "queued" });
    // A release while locked keeps it held.
    await expect(registry.releaseQueuedTurnWithDisposition("monitor-result"))
      .resolves.toMatchObject({ disposition: "blocked" });
    expect(codexClient.startTurnCallCount).toBe(0);

    await registry.setThreadLock({ ...params, locked: false }, { source: "operator" });
    await vi.waitFor(() => expect(codexClient.startTurnCallCount).toBe(1));
  });

  it("starts deliveries held on a locked thread in the order they arrived", async () => {
    const codexClient = new MockBackendClient({});
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore: createOverlayStoreMock() });
    onTestFinished(() => registry.close());
    const identity = { backend: "codex" as const, threadId: "parked" };
    const { lock } = await registry.setThreadLock({ ...identity, locked: true, note: "Parked" }, { source: "operator" });
    const holdReason = threadLockRefusalMessage(lock!);

    await registry.submitHeldTurn({
      ...identity,
      queueEntryId: "monitor-result",
      input: [{ type: "text", text: "Monitor result" }],
      holdReason,
    });
    await registry.submitHeldTurn({
      ...identity,
      queueEntryId: "later-result",
      input: [{ type: "text", text: "Later result" }],
      holdReason,
    });
    expect(registry.listHeldThreadQueueEntries(identity).map((entry) => entry.entryId))
      .toEqual(["monitor-result", "later-result"]);

    const startTurn = vi.spyOn(codexClient, "startTurn");
    await registry.setThreadLock({ ...identity, locked: false }, { source: "operator" });
    await vi.waitFor(() => expect(startTurn).toHaveBeenCalledOnce());
    // The delivery held first starts first.
    expect(JSON.stringify(startTurn.mock.calls[0])).toContain("Monitor result");
    expect(JSON.stringify(startTurn.mock.calls[0])).not.toContain("Later result");
  });

  it("holds distinct self-started prompts under fresh identities and sends them in order on unlock", async () => {
    const codexClient = new MockBackendClient({});
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore: createOverlayStoreMock() });
    onTestFinished(() => registry.close());
    const identity = { backend: "codex" as const, threadId: "parked" };
    const notification = { ...identity, prompt: "<task-notification>Build passed</task-notification>", source: "task_notification" as const };
    const cron = { ...identity, prompt: "Check CI", source: "cron" as const };

    // With no lock, the backend runs the turn itself.
    await expect(registry.holdBackendSelfStartedTurn(notification)).resolves.toBe(false);
    expect(registry.listHeldThreadQueueEntries(identity)).toEqual([]);

    await registry.setThreadLock({ ...identity, locked: true, note: "Parked" }, { source: "operator" });
    await expect(registry.holdBackendSelfStartedTurn(notification)).resolves.toBe(true);
    const first = registry.listHeldThreadQueueEntries(identity)[0]!;
    expect(registry.listHeldThreadQueueEntries(identity)).toEqual([expect.objectContaining({
      entryId: expect.stringMatching(/^self-started:/), text: "Claude's answer to a finished background task",
      holdReason: "This thread is locked: Parked. Unlock it before starting a turn.",
    })]);
    await expect(registry.holdBackendSelfStartedTurn(cron)).resolves.toBe(true);
    // A recurring cron that fires again while locked is kept once.
    await expect(registry.holdBackendSelfStartedTurn(cron)).resolves.toBe(true);
    const held = registry.listHeldThreadQueueEntries(identity);
    expect(held).toEqual([first, expect.objectContaining({ text: "Claude's scheduled task" })]);
    expect(held[1]!.entryId).not.toBe(first.entryId);
    expect(codexClient.startTurnCallCount).toBe(0);

    const startTurn = vi.spyOn(codexClient, "startTurn");
    await registry.setThreadLock({ ...identity, locked: false }, { source: "operator" });
    await vi.waitFor(() => expect(startTurn).toHaveBeenCalledOnce());
    expect(startTurn.mock.calls[0]![0].input).toEqual([{ type: "text", text: notification.prompt }]);
    const turnId = registry.getActiveTurnForThread(identity)!.turnId;
    await codexClient.emit({ method: "turn/completed", params: { threadId: identity.threadId, turnId,
      turn: { id: turnId, status: "completed", output: [] } } });
    await vi.waitFor(() => expect(startTurn).toHaveBeenCalledTimes(2));
    expect(startTurn.mock.calls[1]![0].input).toEqual([{ type: "text", text: cron.prompt }]);
    expect(registry.listHeldThreadQueueEntries(identity)).toEqual([]);
  });

  it("leaves a queue held for another reason alone on unlock", async () => {
    const codexClient = new MockBackendClient({});
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore: createOverlayStoreMock() });
    onTestFinished(() => registry.close());
    const params = { backend: "codex" as const, threadId: "parked", input: [{ type: "text" as const, text: "Retry me" }] };
    await registry.submitHeldTurn({ ...params, queueEntryId: "failed-turn", holdReason: "The previous turn failed." });
    await registry.setThreadLock({ ...params, locked: true }, { source: "operator" });
    await registry.setThreadLock({ ...params, locked: false }, { source: "operator" });

    await new Promise((resolve) => setImmediate(resolve));
    expect(codexClient.startTurnCallCount).toBe(0);
  });

  it("keeps a failed turn's hold when a delivery held by a lock is unlocked", async () => {
    const codexClient = new MockBackendClient({});
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore: createOverlayStoreMock() });
    onTestFinished(() => registry.close());
    const identity = { backend: "codex" as const, threadId: "parked" };
    const failed = "The previous turn failed.";
    await registry.submitHeldTurn({
      ...identity, queueEntryId: "failed-turn", input: [{ type: "text", text: "Retry me" }], holdReason: failed,
    });
    const { lock } = await registry.setThreadLock({ ...identity, locked: true, note: "Parked" }, { source: "operator" });
    // A monitor's result for the locked thread.
    await registry.submitHeldTurn({
      ...identity,
      queueEntryId: "task-monitor:build",
      input: [{ type: "text", text: "Monitor result" }],
      holdReason: threadLockRefusalMessage(lock!),
    });

    await registry.setThreadLock({ ...identity, locked: false }, { source: "operator" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(codexClient.startTurnCallCount).toBe(0);
    // Both wait for the operator to review the failure and press Retry.
    expect(registry.listHeldThreadQueueEntries(identity).map(({ entryId, holdReason }) => [entryId, holdReason]))
      .toEqual([["failed-turn", failed], ["task-monitor:build", failed]]);
  });

  it("starts a delivery held by a lock on unlock though a later stale steer stays held", async () => {
    const codexClient = new MockBackendClient({});
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore: createOverlayStoreMock() });
    onTestFinished(() => registry.close());
    const identity = { backend: "codex" as const, threadId: "parked" };
    const staleSteer = "This steering message was held after its target turn ended. Retry it when the provider is ready.";
    const { lock } = await registry.setThreadLock({ ...identity, locked: true, note: "Parked" }, { source: "operator" });
    await registry.submitHeldTurn({
      ...identity,
      queueEntryId: "task-monitor:build",
      input: [{ type: "text", text: "Monitor result" }],
      holdReason: threadLockRefusalMessage(lock!),
    });
    await registry.submitHeldTurn({
      ...identity, queueEntryId: "stale-steer", input: [{ type: "text", text: "Steer" }], holdReason: staleSteer,
    });

    const startTurn = vi.spyOn(codexClient, "startTurn");
    await registry.setThreadLock({ ...identity, locked: false }, { source: "operator" });
    await vi.waitFor(() => expect(startTurn).toHaveBeenCalledOnce());
    expect(JSON.stringify(startTurn.mock.calls[0])).toContain("Monitor result");
    expect(registry.listHeldThreadQueueEntries(identity).map(({ entryId, holdReason }) => [entryId, holdReason]))
      .toEqual([["stale-steer", staleSteer]]);
  });

  describe("quiet restart continuations", () => {
    const durableStore = () => {
      vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
      const temp = createTempStateDb("pwragent-restart-continuations-");
      const db = StateDb.open(temp.dbPath);
      onTestFinished(() => {
        db.close();
        removeTempStateDbDir(temp.tempDir);
        vi.unstubAllEnvs();
      });
      const rows = () => db.raw.prepare(
        "SELECT owner_instance_id FROM restart_continuations ORDER BY created_at, entry_id",
      ).all() as { owner_instance_id: string }[];
      const payloads = () => (db.raw.prepare(
        "SELECT payload FROM restart_continuations ORDER BY created_at, entry_id",
      ).all() as { payload: string }[]).map((row) => JSON.parse(row.payload) as StoredRestartContinuation);
      return { db, payloads, rows, store: new RestartContinuationStore(db.raw, { processId: 4_242, processAlive: () => false }) };
    };
    const launch = (
      store: RestartContinuationStore,
      instanceId: string,
      live: string[] = [],
      plan: Omit<RestartDispatchPlanOptions, "now"> = {},
      uniqueTurns = false,
      taskMonitorWakeStore?: TaskMonitorWakeStore,
    ) => {
      const codexClient = new MockBackendClient(uniqueTurns ? { startTurnResults: Array.from({ length: 10 }, (_, index) => ({ threadId: "manager", turnId: `turn-${index + 1}` })) } : {});
      const registry = createDesktopBackendRegistry({
        codexClient,
        overlayStore: createOverlayStoreMock(),
        projectHeldWakeupStore: null,
        restartContinuationStore: store,
        taskMonitorWakeStore,
        restartDispatchPlan: { firstDelayMs: 0, intervalMs: 0, jitterMs: 0, releaseGraceMs: 60_000, ...plan },
        runtimeInstanceId: instanceId,
        resolveLiveProfileRuntimeInstanceIds: () => live,
      });
      onTestFinished(() => registry.close());
      return { codexClient, registry };
    };
    const text = (value: string) => [{ type: "text" as const, text: value }];
    const fixtureMonitorOrigin = (monitorId: string): AppServerThreadMessageOrigin => ({
      kind: "sub-agent", subAgent: { kind: "monitor", monitorId, task: "Check build", summary: "Finished", outcome: "success" },
    });
    it("preserves the FIFO of unrelated messages in a checkpointed monitor batch on trip and rearm", async () => {
      // The stored batch belongs to all of its senders. Suppression of one
      // contribution must preserve the others in order and keep the batch ID.
      await fc.assert(fc.asyncProperty(fc.boolean(), fc.nat(2), async (rearm, position) => {
        const db = StateDb.open(":memory:");
        const store = new RestartContinuationStore(db.raw, { processAlive: () => false });
        const guard = new TaskMonitorWakeStore(db.raw);
        const parent = { backend: "codex", threadId: "thread-1" } as const;
        const origin: AppServerThreadMessageOrigin = { kind: "agent" };
        const agentMessages = ["first agent input", "second agent input"].map((message) => ({ input: text(message), origin, receivedAt: 1 }));
        agentMessages.splice(position, 0, { input: text("monitor input"), origin: fixtureMonitorOrigin("old"), receivedAt: 1 });
        store.saveAll("before", [{ ...parent, id: "old-batch", kind: "queued", createdAt: 1,
          input: agentMessages.flatMap((message) => message.input), messageOrigin: agentMessages[0]!.origin,
          queued: { origin: "manual", delivery: "queued-steer", agentMessages, agentMessageOrigins: agentMessages.map((message) => message.origin), paused: true },
        }]);
        for (const monitorId of ["1", "2", "3"]) guard.reserve({ ...parent, monitorId }, 0);
        const review = guard.claimReview(parent);
        if (typeof review === "string") throw new Error(`Expected a claimed review, received ${review}`);
        guard.settleReview(parent, review, "loop");
        const { registry, codexClient } = launch(store, "after", ["after"], {}, false, guard);
        try {
          if (rearm) expect(registry.rearmTaskMonitorWakes(parent)).toBe(true);
          await registry.setQueuedTurnPaused({ queueEntryId: "old-batch", paused: false });
          await vi.waitFor(() => expect(registry.getQueuedTurnsForThread(parent)).toHaveLength(0));
          await vi.waitFor(() => expect(codexClient.startTurnCalls).toHaveLength(1));
          const delivered = JSON.stringify(codexClient.startTurnCalls[0]!.input);
          expect(delivered).not.toContain("monitor input");
          expect(delivered.indexOf("first agent input")).toBeGreaterThanOrEqual(0);
          expect(delivered.indexOf("first agent input")).toBeLessThan(delivered.indexOf("second agent input"));
        } finally { await registry.close(); db.close(); }
      }), { numRuns: 6, examples: [[false, 0], [true, 1]] });
    });

    it("delivers a monitor wake after restart if the active parent could not steer", async () => {
      const { db, store, payloads } = durableStore();
      const guard = new TaskMonitorWakeStore(db.raw);
      const parent = { backend: "codex", threadId: "thread-1" } as const;
      const first = launch(store, "instance-a", [], {}, false, guard);
      await emitStartedTurn(first.registry, parent.backend, parent.threadId, "active");
      const discover = first.registry.listBackends.bind(first.registry);
      const listBackends = vi.spyOn(first.registry, "listBackends").mockImplementation(async (request) => {
        const catalog = await discover(request);
        return { ...catalog, backends: catalog.backends.map((backend) => ({
          ...backend, capabilities: { ...backend.capabilities, steerTurn: false },
        })) };
      });
      expect(guard.reserve({ ...parent, monitorId: "pending" }, 0)).toBe("admitted");
      await first.registry.submitTurn({ ...parent, queueEntryId: "task-monitor:wake:pending",
        input: text("Unsent monitor result"), messageOrigin: fixtureMonitorOrigin("pending") });
      await vi.waitFor(() => expect(listBackends).toHaveBeenCalled());
      await Promise.all(listBackends.mock.results.map(({ value }) => value));
      await vi.waitFor(() => expect(first.registry.getQueuedTurnsForThread(parent)).toHaveLength(1));
      expect(first.codexClient.steerTurnCallCount).toBe(0);
      first.registry.beginQuietRestart();
      // The parent can finish while quieting. The restart gate keeps the
      // waiting wake queued, with no continuation needed for the parent.
      await emitCompletedTurn(first.registry, parent.backend, parent.threadId, "active");
      first.registry.saveRestartContinuations([]);
      expect(payloads().map((row) => row.id)).toEqual(["task-monitor:wake:pending"]);
      await first.registry.close();

      const second = launch(store, "instance-b", ["instance-b"], {}, false, guard);
      second.registry.beginRestartContinuationDispatch();
      await vi.waitFor(() => expect(second.codexClient.startTurnCalls).toHaveLength(1));
      expect(second.codexClient.startTurnCalls[0]!.input).toEqual(text("Unsent monitor result"));
    });

    const startRunningTurn = async (registry: DesktopBackendRegistry, threadId: string) => {
      const started = await registry.submitTurn({ backend: "codex", threadId, input: text("Long task") });
      expect(started).toMatchObject({ status: "started" });
      if (started.status !== "started") throw new Error("expected a started turn");
      await emitStartedTurn(registry, "codex", threadId, started.turnId);
    };

    const prepareVerification = async (registry: DesktopBackendRegistry) => {
      vi.spyOn(registry, "canManagePwrAgent").mockResolvedValue(true);
      const host = registry as unknown as { readTurnCausalMessagingOrigin: () => Promise<AppServerThreadMessageOrigin | undefined> };
      vi.spyOn(host, "readTurnCausalMessagingOrigin").mockResolvedValue({ kind: "messaging",
        causalMessagingSource: { ownerId: "profile", requestId: "owner-request" } });
      return await registry.prepareAgentRestartVerification({ backend: "codex", threadId: "manager", turnId: "turn" }, {
        operationId: "upgrade-1", expectedVersion: "1.4.8", previousRuntimeId: "instance-a",
      });
    };

    it.each(["1.4.7", "1.4.8", "1.4.9"])("reports the observed %s after recovery while preserving accepted work", async (version) => {
      const { store, payloads, rows } = durableStore();
      vi.spyOn(getOwnerHostServices().application, "getVersion").mockReturnValue(version);
      vi.spyOn(getOwnerHostServices().updates, "read").mockReturnValue({ status: "idle" });
      const first = launch(store, "instance-a", [], {}, true);
      await startRunningTurn(first.registry, "manager");
      await first.registry.submitTurn({ backend: "codex", threadId: "manager", input: text("Accepted reply") });
      await prepareVerification(first.registry);
      const { writes } = await measureSqliteWrites(async () => {
        first.registry.saveRestartContinuations(first.registry.beginQuietRestart(), Date.now(), true);
        first.registry.saveRestartContinuations(first.registry.beginQuietRestart());
        expect(payloads()).toHaveLength(3);
        await first.registry.close();
        const second = launch(store, "instance-b", ["instance-b"], {}, true);
        second.registry.beginRestartContinuationDispatch();
        await vi.waitFor(() => expect(second.codexClient.startTurnCallCount).toBe(1));
        expect(second.codexClient.startTurnCalls[0]!.input).toEqual([{ type: "text", text: expect.stringContaining("PwrAgent restarted") }]);
        const finish = async () => {
          const active = second.registry.getActiveTurnForThread({ backend: "codex", threadId: "manager" });
          await emitCompletedTurn(second.registry, "codex", "manager", active!.turnId);
        };
        await finish();
        await vi.waitFor(() => expect(second.codexClient.startTurnCallCount).toBe(2));
        expect(second.codexClient.startTurnCalls[1]!.input).toEqual(text("Accepted reply"));
        await finish();
        await vi.waitFor(() => expect(second.codexClient.startTurnCallCount).toBe(3));
        const receipt = second.codexClient.startTurnCalls[2]!;
        expect(JSON.stringify(receipt.input)).toContain("targeting version 1.4.8 from runtime instance-a");
        expect(JSON.stringify(receipt.input)).toContain("with current authorization");
        const verify = createPwrAgentAppManagementHandler({ startedAt: 1, runtimeId: "instance-b", version: () => version, authorize: async () => true });
        expect(await verify({ operation: "manage_pwragent", args: { action: "status" }, context: {} }))
          .toMatchObject({ data: { runtime: { runtimeId: "instance-b", currentVersion: version } } });
        const denied = createPwrAgentAppManagementHandler({ startedAt: 1, authorize: async () => false });
        expect(await denied({ operation: "manage_pwragent", args: { action: "status" }, context: {} })).toMatchObject({ ok: false });
        expect(second.registry.getActiveTurnForThread({ backend: "codex", threadId: "manager" })).toBeDefined();
        expect(rows()).toEqual([]);
      });
      expectSqliteWriteBudget({ scenario: "agent-upgrade-verification-cycle", writes,
        note: "One checkpoint holds a running continuation, accepted reply, and version-verification receipt; one claim and three deletes. No polling writes. About 0.4 MB/day at 10 restart cycles/day." });
    });

    it("resumes checkpointed work and a cancellation receipt when authorization changes after quieting", async () => {
      const { store, rows } = durableStore();
      const first = launch(store, "instance-a", [], {}, true);
      await startRunningTurn(first.registry, "manager");
      await prepareVerification(first.registry);
      const { writes } = await measureSqliteWrites(async () => {
        first.registry.saveRestartContinuations(first.registry.beginQuietRestart(), Date.now(), true);
        first.registry.cancelQuietRestart(true);
        expect(first.registry.isRestartGateClosed()).toBe(false);
        const finish = async () => {
          const active = first.registry.getActiveTurnForThread({ backend: "codex", threadId: "manager" });
          await emitCompletedTurn(first.registry, "codex", "manager", active!.turnId);
        };
        await finish();
        await vi.waitFor(() => expect(first.codexClient.startTurnCallCount).toBe(2));
        expect(JSON.stringify(first.codexClient.startTurnCalls[1]!.input)).toContain("restart was cancelled");
        await finish();
        await vi.waitFor(() => expect(first.codexClient.startTurnCallCount).toBe(3));
        expect(JSON.stringify(first.codexClient.startTurnCalls[2]!.input)).toContain("restart request was cancelled");
        expect(rows()).toEqual([]);
      });
      expectSqliteWriteBudget({ scenario: "agent-upgrade-verification-cancel", writes,
        note: "Checkpoint once, mark the verification receipt cancelled, and delete the continuation and receipt when each resumes. No per-turn or idle writes; about 0.3 MB/day at 10 cancellations/day." });
    });

    it("keeps verification identity across another checkpoint before its turn can run", async () => {
      const { store, payloads } = durableStore();
      const first = launch(store, "instance-a");
      await startRunningTurn(first.registry, "manager");
      await prepareVerification(first.registry);
      first.registry.saveRestartContinuations(first.registry.beginQuietRestart(), Date.now(), true);
      await first.registry.close();
      const second = launch(store, "instance-b", ["instance-b"]);
      second.registry.saveRestartContinuations(second.registry.beginQuietRestart(), Date.now(), true);
      const verification = payloads().find((entry) => entry.id === "app-upgrade-verification:upgrade-1");
      expect(verification?.upgradeVerification).toEqual({ operationId: "upgrade-1", expectedVersion: "1.4.8", previousRuntimeId: "instance-a" });
      expect(verification?.messageOrigin?.causalMessagingSource).toEqual({ ownerId: "profile", requestId: "owner-request" });
      await second.registry.close();
      const third = launch(store, "instance-c", ["instance-c"]);
      expect(third.registry.getQueuedTurnsForThread({ backend: "codex", threadId: "manager" }))
        .toContainEqual(expect.objectContaining({ queueEntryId: verification!.id, displayText: expect.stringContaining("with current authorization") }));
    });

    it("dispatches verification after readiness when the initiating turn finished before checkpointing", async () => {
      const { store, rows } = durableStore();
      const first = launch(store, "instance-a");
      await startRunningTurn(first.registry, "manager");
      await prepareVerification(first.registry);
      await emitCompletedTurn(first.registry, "codex", "manager", "turn-1");
      const { writes } = await measureSqliteWrites(async () => {
        expect(first.registry.beginQuietRestart()).toEqual([]);
        first.registry.saveRestartContinuations([], Date.now(), true);
        expect(rows()).toHaveLength(1);
        await first.registry.close();
        const second = launch(store, "instance-b", ["instance-b"]);
        expect(second.codexClient.startTurnCallCount).toBe(0);
        second.registry.beginRestartContinuationDispatch();
        await vi.waitFor(() => expect(second.codexClient.startTurnCallCount).toBe(1));
        expect(JSON.stringify(second.codexClient.startTurnCalls[0]!.input)).toContain("targeting version 1.4.8");
        expect(rows()).toEqual([]);
      });
      expectSqliteWriteBudget({ scenario: "agent-upgrade-verification-only", writes,
        note: "Only the initiating Agent's verification remains: one checkpoint, one startup claim, one delete at dispatch. No polling writes; about 0.2 MB/day at 10 restarts/day." });
    });

    it("restores admission after an initial checkpoint error and preserves a pending start", async () => {
      const { store, payloads } = durableStore();
      let finish!: () => void;
      const delay = new Promise<void>((resolve) => { finish = resolve; });
      const codexClient = new MockBackendClient({ startTurnDelay: delay });
      const registry = createDesktopBackendRegistry({ codexClient, overlayStore: createOverlayStoreMock(),
        projectHeldWakeupStore: null, restartContinuationStore: store, runtimeInstanceId: "instance-a" });
      onTestFinished(() => registry.close());
      const starting = registry.submitTurn({ backend: "codex", threadId: "busy", input: text("Task") });
      await vi.waitFor(() => expect(codexClient.startTurnCallCount).toBe(1));
      const targets = registry.beginQuietRestart();
      expect(targets).toContainEqual(expect.objectContaining({ threadId: "busy" }));
      const save = vi.spyOn(store, "saveAll").mockImplementationOnce(() => { throw new Error("disk full"); });
      expect(() => registry.saveRestartContinuations(targets, 1, true)).toThrow("disk full");
      registry.cancelQuietRestart();
      expect(registry.isRestartGateClosed()).toBe(false);
      expect(payloads()).toEqual([]);
      save.mockRestore();
      const retry = registry.beginQuietRestart();
      expect(registry.saveRestartContinuations(retry, 1, true)).toBe(1);
      finish();
      await starting;
      registry.saveRestartContinuations(retry, 1);
      expect(payloads()).toHaveLength(1);
    });

    it("steers the running turn, then continues it first after a restart while other work waits", async () => {
      const { rows, store } = durableStore();
      const { writes } = await measureSqliteWrites(async () => {
        const first = launch(store, "instance-a");
        await startRunningTurn(first.registry, "busy");

        // Work accepted before quiet begins is carried across the restart.
        await expect(first.registry.submitTurn({ backend: "codex", threadId: "busy", input: text("Later") }))
          .resolves.toMatchObject({ status: "queued" });
        const targets = first.registry.beginQuietRestart();
        expect(targets).toEqual([expect.objectContaining({ backend: "codex", threadId: "busy" })]);
        expect(first.registry.isRestartGateClosed()).toBe(true);
        // Nothing new starts on the way down.
        await expect(first.registry.submitTurn({ backend: "codex", threadId: "idle", input: text("Later") }))
          .rejects.toThrow("this message was not accepted");
        expect(first.codexClient.startTurnCallCount).toBe(1);

        await expect(first.registry.steerTurnsForQuietRestart(targets)).resolves.toBe(1);
        expect(first.codexClient.lastSteerTurnParams).toMatchObject({
          threadId: "busy",
          input: [{ type: "text", text: expect.stringContaining("PwrAgent is restarting") }],
        });
        expect(first.registry.saveRestartContinuations(targets, Date.UTC(2026, 10, 4))).toBe(1);
        // A second quiet restart does not add a second continuation.
        expect(first.registry.saveRestartContinuations(targets)).toBe(0);
        // The continuation and the message accepted before shutdown.
        expect(rows()).toEqual([{ owner_instance_id: "instance-a" }, { owner_instance_id: "instance-a" }]);
        await first.registry.close();

        const second = launch(store, "instance-b", ["instance-b"]);
        expect(rows()).toEqual([{ owner_instance_id: "instance-b" }, { owner_instance_id: "instance-b" }]);
        expect(second.registry.isRestartGateClosed()).toBe(true);
        await expect(second.registry.submitTurn({ backend: "codex", threadId: "elsewhere", input: text("Queued reply") }))
          .resolves.toMatchObject({ status: "queued" });
        await expect(second.registry.submitTurnIfIdle({ backend: "codex", threadId: "watcher", input: text("PR"), origin: "automation" }))
          .resolves.toEqual({ status: "busy" });
        // Nothing starts until providers are ready and the schedule begins.
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(second.codexClient.startTurnCallCount).toBe(0);

        second.registry.beginRestartContinuationDispatch();
        await vi.waitFor(() => expect(second.codexClient.startTurnCallCount).toBe(2));
        const resumed = second.registry.getActiveTurnForThread({ backend: "codex", threadId: "busy" });
        await emitCompletedTurn(second.registry, "codex", "busy", resumed!.turnId);
        await vi.waitFor(() => expect(second.codexClient.startTurnCallCount).toBe(3));
        expect(second.codexClient.startTurnCalls[0]).toMatchObject({
          threadId: "busy",
          input: [{ type: "text", text: expect.stringContaining("PwrAgent restarted. Your previous turn was stopped at 2026-11-04T00:00:00.000Z") }],
        });
        expect(second.codexClient.startTurnCalls.slice(1).map((call) => call.threadId).sort()).toEqual(["busy", "elsewhere"]);
        expect(second.registry.isRestartGateClosed()).toBe(false);
        await vi.waitFor(() => expect(rows()).toEqual([]));
      });
      expectSqliteWriteBudget({
        scenario: "restart-continuation-cycle",
        note: "one quiet restart with one running thread and one queued message: one commit saves both, one startup claim, one delete as each entry starts (~29 KB). Restarts are rare: 10 a day is ~0.3 MB/day. Idle and per-turn writes are 0.",
        writes,
      });
    });

    it.each(["checkpoint", "legacy receipt", "reused PID"] as const)(
      "recovers a lock-held follow-up from its scheduled action exactly once (%s)",
      async (scenario) => {
        const { db, store, payloads } = durableStore();
        const actions = new ScheduledThreadActionStore(db);
        const thread = { backend: "codex" as const, threadId: "manager" };
        const origin = { source: "operator" as const };
        let now = Date.now();
        const first = launch(store, "instance-a");
        await first.registry.setThreadLock({ ...thread, locked: true }, origin);
        const previous = new ScheduledThreadActionService({
          registry: first.registry, store: actions, now: () => now, ownerId: "instance-a",
        });
        const followUp = await previous.createAgentFollowUp({
          ...thread, scheduledFor: now + 60_000, prompt: "Check the deployment.",
        });
        now += 60_000;
        await previous.evaluateDueActions();
        const held = actions.get(followUp.id);
        expect(held).toMatchObject({ status: "held", holdCause: "thread_lock", queueEntryId: expect.any(String) });
        expect(first.codexClient.startTurnCallCount).toBe(0);
        const queueEntryId = held!.queueEntryId!;

        if (scenario === "checkpoint") {
          first.registry.saveRestartContinuations(first.registry.beginQuietRestart(), now, true);
          expect(payloads()).toEqual([]);
        } else {
          // Older builds checkpointed a lock hold as a plain paused entry.
          store.saveAll("instance-a", [{
            ...thread, id: queueEntryId, kind: "queued", input: text("Check the deployment."),
            createdAt: now, queued: { origin: "scheduled", paused: true },
          }]);
          expect(payloads()).toHaveLength(1);
        }
        await first.registry.close();

        const restartStore = scenario === "reused PID"
          ? new RestartContinuationStore(db.raw, { processId: 4_243, processAlive: (pid) => pid === 4_242 })
          : store;
        const second = launch(restartStore, "instance-b");
        expect(second.registry.getQueuedTurnsForThread(thread)).toEqual([]);
        await second.registry.setThreadLock({ ...thread, locked: true }, origin);
        const scheduler = new ScheduledThreadActionService({
          registry: second.registry, store: actions, now: () => now, ownerId: "instance-b",
          isOwnerAlive: () => false,
        });
        onTestFinished(() => scheduler.dispose());
        scheduler.start();
        await vi.waitFor(() => expect(actions.listHeldHolds(followUp.id)).toEqual([
          expect.objectContaining({ holderId: "instance-b" }),
        ]));
        expect(second.registry.getQueuedTurnsForThread(thread)).toEqual([
          expect.objectContaining({ queueEntryId, manualReleaseRequired: true }),
        ]);
        await second.registry.setThreadLock({ ...thread, locked: false }, origin);
        await vi.waitFor(() => expect(actions.get(followUp.id)?.status).toBe("started"));
        expect(second.codexClient.startTurnCallCount).toBe(1);

        // Even if a reused PID delayed receipt recovery, a later launch must
        // never restore a paused copy of a turn that has already run.
        const third = launch(store, "instance-c");
        expect(third.registry.getQueuedTurnsForThread(thread)).toEqual([]);
        expect(payloads()).toEqual([]);
        expect(third.codexClient.startTurnCallCount).toBe(0);
      },
    );

    it.each([true, false])("restores checkpointed scheduled work while preserving its explicit pause (%s)", async (paused) => {
      const { db, store, payloads } = durableStore();
      const actions = new ScheduledThreadActionStore(db);
      const thread = { backend: "codex" as const, threadId: "manager" };
      const operator = { source: "operator" as const };
      let now = Date.now();
      const first = launch(store, "instance-a", [], {}, true);
      await startRunningTurn(first.registry, thread.threadId);
      const scheduler = (registry: DesktopBackendRegistry, ownerId: string) => {
        const service = new ScheduledThreadActionService({
          registry, store: actions, now: () => now, ownerId, isOwnerAlive: () => false,
          setTimer: () => ({}) as ReturnType<typeof setTimeout>, clearTimer: () => undefined,
        });
        onTestFinished(() => service.dispose());
        service.start();
        return service;
      };
      const previous = scheduler(first.registry, "instance-a");
      const followUp = await previous.createAgentFollowUp({
        ...thread, scheduledFor: now + 60_000, prompt: "Check the deployment.",
      });
      now += 60_000;
      await previous.evaluateDueActions();
      const queueEntryId = actions.get(followUp.id)!.queueEntryId!;
      if (paused) {
        await first.registry.setQueuedTurnPaused({ queueEntryId, paused: true });
      }
      await first.registry.setThreadLock({ ...thread, locked: true }, operator);
      // A lock-held submission covers the waiting FIFO, including an
      // independently paused entry.
      const blocker = "lock-hold-for-test";
      await first.registry.submitHeldTurn({
        ...thread, queueEntryId: blocker, input: text("Other lock-held work"),
        holdReason: "This thread is locked. Unlock it to send.",
      });
      first.registry.cancelQueuedTurn(blocker);
      expect(actions.get(followUp.id)?.status).toBe("held");
      if (!paused) await first.registry.setThreadLock({ ...thread, locked: false }, operator);
      expect(actions.get(followUp.id)?.status).toBe(paused ? "held" : "queued");
      first.registry.beginQuietRestart();
      await emitCompletedTurn(first.registry, "codex", thread.threadId, "turn-1");
      first.registry.saveRestartContinuations([], now, true);
      expect(payloads().map((entry) => entry.id)).toEqual([queueEntryId]);
      previous.dispose();
      await first.registry.close();

      now += 60_000;
      const second = launch(store, "instance-b");
      if (paused) await second.registry.setThreadLock({ ...thread, locked: true }, operator);
      const next = scheduler(second.registry, "instance-b");
      expect(second.registry.getQueuedTurnsForThread(thread)).toEqual([
        expect.objectContaining({ queueEntryId, ...(paused ? { paused: true } : {}) }),
      ]);
      expect(actions.get(followUp.id)?.status).toBe(paused ? "held" : "queued");
      if (paused) {
        await expect(second.registry.setQueuedTurnPaused({ queueEntryId, paused: false }))
          .rejects.toThrow("This thread is locked");
        await second.registry.setThreadLock({ ...thread, locked: false }, operator);
        await next.evaluateDueActions();
        expect(second.registry.getQueuedTurnsForThread(thread)).toEqual([
          expect.objectContaining({ queueEntryId, paused: true }),
        ]);
        expect(second.codexClient.startTurnCallCount).toBe(0);
        await second.registry.setQueuedTurnPaused({ queueEntryId, paused: false });
      }
      second.registry.beginRestartContinuationDispatch();
      await vi.waitFor(() => expect(actions.get(followUp.id)?.status).toBe("started"));
      expect(second.codexClient.startTurnCallCount).toBe(1);
      expect(payloads()).toEqual([]);
    });

    it("claims unrelated restart work when a scheduled payload is unreadable", () => {
      const { db, store } = durableStore();
      const actions = new ScheduledThreadActionStore(db);
      const thread = { backend: "codex" as const, threadId: "manager" };
      const id = "scheduled-action:unreadable";
      const now = Date.now();
      actions.create({
        ...thread, id, kind: "turn", origin: "desktop", scheduledFor: now,
        displayText: "Scheduled prompt", turn: { input: text("Scheduled prompt") }, now,
      });
      db.raw.prepare("UPDATE scheduled_thread_actions SET payload_ref = ? WHERE action_id = ?").run("missing.json", id);
      const continuation = { ...thread, id: "unrelated-restart", input: text("Continue work"), createdAt: now };
      const pending = { ...thread, id: "unrelated-queued", kind: "queued" as const, input: text("Later"), createdAt: now };
      store.saveAll("instance-a", [
        { ...thread, id: `scheduled-turn:${id}`, kind: "queued", input: text("Scheduled prompt"), createdAt: now },
        continuation,
        pending,
      ]);
      expect(store.claimOrphaned("instance-b", () => [])).toEqual([pending, continuation]);
    });

    it("opens the gate when a continuation is discarded", async () => {
      const { rows, store } = durableStore();
      const first = launch(store, "instance-a");
      await startRunningTurn(first.registry, "busy");
      first.registry.saveRestartContinuations(first.registry.beginQuietRestart());
      await first.registry.close();

      const second = launch(store, "instance-b", ["instance-b"]);
      const [entry] = second.registry.getQueuedTurnsForThread({ backend: "codex", threadId: "busy" });
      expect(entry).toBeDefined();
      expect(second.registry.cancelQueuedTurn(entry!.queueEntryId)).toBe(true);
      expect(second.registry.isRestartGateClosed()).toBe(false);
      expect(rows()).toEqual([]);
      expect(second.codexClient.startTurnCallCount).toBe(0);
    });

    it("replays accepted steers through quiet shutdown without sending them again (generated)", async () => {
      await fc.assert(fc.asyncProperty(
        fc.constantFrom("pending", "completed", "completion-failed"), fc.string({ maxLength: 30 }),
        async (state, suffix) => {
          const codexClient = new MockBackendClient({ initializeResult: { methods: ["turn/steer"] } });
          const registry = createDesktopBackendRegistry({ codexClient,
            overlayStore: createOverlayStoreMock({ executionMode: "full-access" }), threadTitleGenerationService: null });
          const delivery = createDeferred<{ threadId: string; turnId: string }>();
          const steer = vi.spyOn(codexClient, "steerTurn").mockImplementation(async () => await delivery.promise);
          const host = registry as unknown as {
            readTurnCausalMessagingOrigin: () => Promise<AppServerThreadMessageOrigin | undefined>;
          };
          const read = vi.spyOn(host, "readTurnCausalMessagingOrigin").mockResolvedValue(undefined);
          if (state === "completion-failed") read.mockRejectedValueOnce(new Error("Origin read failed"));
          const request = { backend: "codex" as const, threadId: "thread-1", expectedTurnId: "turn-1",
            requestId: "accepted", input: text(`Steer ${suffix}`) };
          const origin = { kind: "messaging" as const };
          const first = registry.steerTurn(request, origin);
          try {
            await waitForCondition(() => steer.mock.calls.length === 1);
            if (state !== "pending") {
              delivery.resolve({ threadId: "thread-1", turnId: "turn-1" });
              if (state === "completion-failed") await expect(first).rejects.toThrow("Origin read failed");
              else await first;
            }
            registry.beginQuietRestart();
            const replay = registry.steerTurn(request, origin);
            delivery.resolve({ threadId: "thread-1", turnId: "turn-1" });
            await expect(replay).resolves.toMatchObject({ disposition: "steered", turnId: "turn-1" });
            await expect(registry.steerTurn({ ...request, input: text("Changed") }, origin)).rejects.toThrow("reused");
            await expect(registry.steerTurn({ ...request, requestId: "new" }, origin)).rejects.toThrow("this message was not accepted");
            expect(steer).toHaveBeenCalledOnce();
          } finally {
            delivery.resolve({ threadId: "thread-1", turnId: "turn-1" });
            await first.catch(() => undefined);
            await registry.close();
          }
        },
      ), { numRuns: 12, examples: [["pending", ""], ["completed", ""], ["completion-failed", ""]] });
    });

    it("refuses a messaging steer while shutdown admission is shut and lets the restart's own steer through", async () => {
      const { store } = durableStore();
      const { codexClient, registry } = launch(store, "instance-a");
      await startRunningTurn(registry, "busy");
      const [target] = registry.beginQuietRestart();
      expect(target).toBeDefined();

      await expect(registry.steerTurn(
        {
          backend: "codex",
          threadId: "busy",
          expectedTurnId: target!.turnId,
          requestId: "telegram-steer",
          input: text("From Telegram"),
        },
        { kind: "messaging" },
      )).rejects.toThrow("this message was not accepted");
      expect(codexClient.lastSteerTurnParams).toBeUndefined();
      expect(registry.getQueuedTurnsForThread({ backend: "codex", threadId: "busy" }))
        .toEqual([]);

      await expect(registry.steerTurnsForQuietRestart([target!])).resolves.toBe(1);
      expect(codexClient.lastSteerTurnParams).toMatchObject({
        threadId: "busy",
        input: [{ type: "text", text: QUIET_RESTART_STEER_TEXT }],
      });
    });

    it("carries queued messages across a restart behind the continuation, in queue order, paused ones still paused", async () => {
      const { payloads, store } = durableStore();
      const first = launch(store, "instance-a");
      await startRunningTurn(first.registry, "busy");
      // Each message gets its own time, so only the queue order can explain
      // the order they come back in.
      let clock = Date.now();
      const now = vi.spyOn(Date, "now").mockImplementation(() => clock++);
      onTestFinished(() => now.mockRestore());
      const queue = async (value: string) => {
        const result = await first.registry.submitTurn({ backend: "codex", threadId: "busy", input: text(value) });
        if (result.status !== "queued") throw new Error("expected a queued turn");
        return result.entry.id;
      };
      const one = await queue("Queued one");
      const two = await queue("Queued two");
      const three = await queue("Queued three");
      // The operator moves the newest to the front and pauses another.
      await first.registry.moveQueuedTurn({ queueEntryId: three, beforeQueueEntryId: one });
      await first.registry.setQueuedTurnPaused({ queueEntryId: two, paused: true });

      expect(first.registry.saveRestartContinuations(first.registry.beginQuietRestart())).toBe(1);
      // An edit after the save replaces the saved copy.
      first.registry.updateQueuedTurnInput(one, text("Queued one, edited"));
      expect(payloads().find((row) => row.id === one)?.input).toEqual(text("Queued one, edited"));
      await first.registry.close();
      now.mockRestore();

      const second = launch(store, "instance-b", ["instance-b"]);
      const restored = second.registry.getQueuedTurnsForThread({ backend: "codex", threadId: "busy" });
      expect(restored.map((entry) => entry.displayText)).toEqual([
        expect.stringContaining("PwrAgent restarted."),
        "Queued three",
        "Queued one, edited",
        "Queued two",
      ]);
      expect(restored.map((entry) => entry.queueEntryId).slice(1)).toEqual([three, one, two]);
      expect(restored.map((entry) => entry.paused ?? false)).toEqual([false, false, false, true]);

      second.registry.beginRestartContinuationDispatch();
      await vi.waitFor(() => expect(second.codexClient.startTurnCallCount).toBe(1));
      expect(second.codexClient.startTurnCalls[0]).toMatchObject({
        threadId: "busy",
        input: [{ type: "text", text: expect.stringContaining("PwrAgent restarted.") }],
      });
      // The queued messages wait for the continuation's turn, as on any thread.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(second.codexClient.startTurnCallCount).toBe(1);
      expect(payloads().map((row) => row.kind)).toEqual(["queued", "queued", "queued"]);

      // The operator resumes the paused one and moves it to the front: the
      // saved copies follow, so a second restart brings back this queue.
      const { writes } = await measureSqliteWrites(async () => {
        await second.registry.setQueuedTurnPaused({ queueEntryId: two, paused: false });
        await second.registry.moveQueuedTurn({ queueEntryId: two, beforeQueueEntryId: three });
      });
      expectSqliteWriteBudget({
        scenario: "restart-queued-refresh",
        note: "an operator pause and a reorder of restored queued messages: one commit each, only while saved messages wait (~8 KB). Per operator action after a restart, so a few a day.",
        writes,
      });
      const saved = payloads().sort((left, right) => (left.queued?.position ?? 0) - (right.queued?.position ?? 0));
      expect(saved.map((row) => [row.id, row.queued?.paused ?? false])).toEqual([
        [two, false],
        [three, false],
        [one, false],
      ]);
    });

    it("gives a discarded continuation no place in the stagger", async () => {
      const { store } = durableStore();
      const first = launch(store, "instance-a");
      await startRunningTurn(first.registry, "first");
      await startRunningTurn(first.registry, "second");
      first.registry.saveRestartContinuations(first.registry.beginQuietRestart());
      await first.registry.close();

      const second = launch(store, "instance-b", ["instance-b"], { batchSize: 1, intervalMs: 600_000 });
      const [discarded] = second.registry.getQueuedTurnsForThread({ backend: "codex", threadId: "first" });
      expect(second.registry.cancelQueuedTurn(discarded!.queueEntryId)).toBe(true);
      second.registry.beginRestartContinuationDispatch();
      // The remaining continuation takes the first slot, not the second, ten minutes on.
      await vi.waitFor(() => expect(second.codexClient.startTurnCallCount).toBe(1));
      expect(second.codexClient.startTurnCalls[0]).toMatchObject({ threadId: "second" });
    });

    it("reports the gate while it waits and opens it when the operator starts everything now", async () => {
      const { store } = durableStore();
      const first = launch(store, "instance-a");
      await startRunningTurn(first.registry, "busy");
      first.registry.saveRestartContinuations(first.registry.beginQuietRestart());
      expect(first.registry.getRestartGateStatus()).toEqual({ phase: "quieting" });
      // A quiet restart under way cannot be released.
      expect(first.registry.releaseRestartGate()).toEqual({ phase: "quieting" });
      await first.registry.close();

      const second = launch(store, "instance-b", ["instance-b"]);
      expect(second.registry.getRestartGateStatus()).toEqual({ phase: "resuming", waiting: 1 });
      await expect(second.registry.submitTurn({ backend: "codex", threadId: "elsewhere", input: text("Reply") }))
        .resolves.toMatchObject({ status: "queued" });
      const published: unknown[] = [];
      onTestFinished(second.registry.onRestartGateStatusChanged((status) => published.push(status)));

      expect(second.registry.releaseRestartGate()).toEqual({ phase: "open" });
      expect(published).toEqual([{ phase: "open" }]);
      await vi.waitFor(() => expect(second.codexClient.startTurnCallCount).toBe(2));
      // The continuation still goes first on its thread.
      expect(second.codexClient.startTurnCalls.map((call) => call.threadId).sort()).toEqual(["busy", "elsewhere"]);
    });

    it("leaves a live sibling instance's continuations with that instance", async () => {
      const { rows, store } = durableStore();
      const first = launch(store, "instance-a");
      await startRunningTurn(first.registry, "busy");
      first.registry.saveRestartContinuations(first.registry.beginQuietRestart());

      const sibling = launch(store, "instance-b", ["instance-a", "instance-b"]);
      expect(sibling.registry.isRestartGateClosed()).toBe(false);
      expect(rows()).toEqual([{ owner_instance_id: "instance-a" }]);
    });
  });

  it("publishes each lock change and keeps the original time and source when the note changes", async () => {
    const overlayStore = createOverlayStoreMock();
    const registry = createDesktopBackendRegistry({ codexClient: new MockBackendClient({}), overlayStore });
    onTestFinished(() => registry.close());
    const events: AgentEvent[] = [];
    const unsubscribe = registry.onEvent((event) => {
      if (event.notification.method === "thread/lock/updated") events.push(event);
    });
    onTestFinished(unsubscribe);
    // Each change also moves the thread out of or back into the Auto-fix election.
    const lockChanged = vi.fn(async () => {});
    registry.setThreadPrAutoDispatchHandler({
      preferenceChanged: vi.fn(),
      cancelPending: vi.fn(),
      sendPendingNow: vi.fn(),
      lockChanged,
    });
    const thread = { backend: "codex" as const, threadId: "parked" };

    const locked = await registry.setThreadLock({ ...thread, locked: true }, { source: "agent_tool" });
    expect(locked.lock).toMatchObject({ source: "agent_tool" });
    expect(locked.lock).not.toHaveProperty("note");
    const renoted = await registry.setThreadLock({ ...thread, locked: true, note: "  Parked for the repair.  " }, { source: "operator" });
    expect(renoted.lock).toEqual({ note: "Parked for the repair.", lockedAt: locked.lock!.lockedAt, source: "agent_tool" });
    // Locking again without a note keeps the note; an unchanged lock publishes nothing.
    await registry.setThreadLock({ ...thread, locked: true }, { source: "operator" });
    await registry.setThreadLock({ ...thread, locked: false }, { source: "operator" });
    await registry.setThreadLock({ ...thread, locked: false }, { source: "operator" });

    expect(events.map((event) => (event.notification.params as { lock?: unknown }).lock)).toEqual([
      locked.lock,
      renoted.lock,
      undefined,
    ]);
    expect(lockChanged.mock.calls).toEqual([
      [{ ...thread, locked: true }],
      [{ ...thread, locked: true }],
      [{ ...thread, locked: false }],
    ]);
    expect(await overlayStore.getThreadOverlayState(thread)).not.toHaveProperty("lock");
  });

  it("does not let correspondence status persistence failures alter the recipient FIFO", async () => {
    const correspondenceStore = new ThreadCorrespondenceStore();
    vi.spyOn(correspondenceStore, "update").mockImplementation(() => { throw new Error("Fixture disk failure"); });
    const registry = createDesktopBackendRegistry({ codexClient: new MockBackendClient({}), correspondenceStore, overlayStore: createOverlayStoreMock(), threadTitleGenerationService: null });
    onTestFinished(() => registry.close());
    await expect(registry.submitHeldTurn({
      backend: "codex", threadId: "recipient", queueEntryId: "held-durable", input: [{ type: "text", text: "Keep this message" }], holdReason: "Fixture hold",
      messageOrigin: { kind: "agent", sourceThread: { backend: "codex", threadId: "sender", messageId: "correspondence:fixture" } },
    })).resolves.toMatchObject({ status: "queued" });
    expect(registry.getQueuedTurnsSnapshot()[buildThreadIdentityKey("codex", "recipient")]).toHaveLength(1);
    expect(registry.cancelQueuedTurnWithDisposition("held-durable").cancelled).toBe(true);
  });

  it.each(["codex", "acp:grok"] as const)("reads the authoritative %s FIFO without changing ownership or order", async (backend) => {
    const registry = createDesktopBackendRegistry({ codexClient: new MockBackendClient({}), overlayStore: createOverlayStoreMock(), threadTitleGenerationService: null });
    onTestFinished(() => registry.close());
    const input: AppServerTurnInputItem[] = [{ type: "text", text: "First paragraph Ω\n\n" + "long ".repeat(200) }, { type: "file", name: "notes.txt", mimeType: "text/plain", data: "AQID" }];
    await registry.submitHeldTurn({ backend, threadId: "recipient", queueEntryId: "held-one", input, holdReason: "Fixture hold" });
    await registry.submitTurn({ backend, threadId: "recipient", queueEntryId: "held-two", input: [{ type: "text", text: "Next" }] });
    const content = await registry.readQueuedTurn({ backend, threadId: "recipient", queueEntryId: "held-one" });
    const ownedInput = [input[0], {
      type: "localFile", name: "notes.txt", mimeType: "text/plain", sizeBytes: 3,
      path: expect.stringContaining(path.join("thread-assets", encodeURIComponent(backend), "recipient")),
    }];
    expect(content.input).toEqual(ownedInput);
    const retainedFile = content.input[1];
    if (retainedFile?.type !== "localFile") throw new Error("Expected owned queued notes.");
    await expect(readFile(retainedFile.path)).resolves.toEqual(Buffer.from([1, 2, 3]));
    content.input.splice(0);
    expect((await registry.readQueuedTurn({ backend, threadId: "recipient", queueEntryId: "held-one" })).input).toEqual(ownedInput);
    expect(registry.getQueuedTurnsSnapshot()[buildThreadIdentityKey(backend, "recipient")]?.map((entry) => entry.queueEntryId)).toEqual(["held-one", "held-two"]);
  });

  it("publishes bounded incoming-work metadata for a direct handoff start without altering its prompt", async () => {
    const codexClient = new MockBackendClient({ initializeResult: { methods: ["turn/start"] } });
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore: createOverlayStoreMock(), threadTitleGenerationService: null });
    onTestFinished(() => registry.close());
    const events: AgentEvent[] = [];
    registry.onEvent((event) => { events.push(event); });
    const prompt = "Full handoff instructions. ".repeat(300) + "TAIL";
    const origin = { kind: "agent" as const, sourceThread: { backend: "codex" as const, threadId: "sender", title: "Sender" } };
    const turn = await registry.startTurn({ backend: "codex", threadId: "recipient", input: [{ type: "text", text: prompt }], messageOrigin: origin });
    expect(codexClient.startTurnCalls[0]?.input).toEqual([{ type: "text", text: prompt }]);
    expect(events).toContainEqual(expect.objectContaining({ notification: {
      method: "thread/incomingWork", params: {
        threadId: "recipient", turnId: turn.turnId, deliveryId: `start:${turn.turnId}`,
        incomingWork: { messages: [{ origin, preview: expect.stringMatching(/…$/u) }], omittedMessageCount: 0 },
      },
    } }));
    const notice = events.find((event) => event.notification.method === "thread/incomingWork");
    expect(JSON.stringify(notice)).not.toContain("TAIL");
    expect(JSON.stringify(notice).length).toBeLessThan(1000);
  });

  // PwrApps shipping thread, 2026-11-18: a monitor result started turn 1 and
  // three lane reports steered into it. A second monitor result 32 s later
  // waited for turn 1 to end and started turn 2, holding four more reports
  // behind it. Nine messages, two wakeups. They should have cost one.
  it("delivers monitor results and the agent reports around them in one turn", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start", "turn/steer", "thread/resume"] },
      startTurnResults: [{ threadId: "parent", turnId: "turn-1" }, { threadId: "parent", turnId: "turn-2" }],
    });
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore: createOverlayStoreMock(), threadTitleGenerationService: null });
    onTestFinished(() => registry.close());
    await discoverCodexBackendForTest(registry);
    const steers = vi.spyOn(codexClient, "steerTurn").mockImplementation(async (params) =>
      ({ threadId: params.threadId, turnId: params.expectedTurnId }));
    const textOf = (input: AppServerTurnInputItem[]) => input.flatMap((item) => item.type === "text" ? [item.text] : []).join("\n");
    const monitor = (task: string) => registry.submitTurn({ backend: "codex", threadId: "parent", origin: "manual",
      input: [{ type: "text", text: `Monitor finished: ${task}` }], messageOrigin: { kind: "sub-agent" } });
    const lane = (name: string) => registry.submitTurn({ backend: "codex", threadId: "parent",
      input: [{ type: "text", text: `${name} report` }],
      messageOrigin: { kind: "agent", sourceThread: { backend: "codex", threadId: name, title: name } } });
    const settle = async () => { for (let index = 0; index < 6; index++) await new Promise<void>((resolve) => setImmediate(resolve)); };

    const first = await monitor("Deploy production");
    expect(first.status).toBe("started");
    await registry.publishLocalEvent({ backend: "codex", notification: {
      method: "turn/started", params: { threadId: "parent", turnId: "turn-1", turn: { id: "turn-1" } },
    } });
    await Promise.all(["Lane D", "Lane A", "Lane C"].map(lane));
    await settle();
    // Later, while turn 1 still runs.
    await Promise.all([monitor("PR #109 checks"), ...["Lane A", "Lane B", "Lane C", "Lane D"].map(lane)]);
    await settle();

    expect(codexClient.startTurnCallCount).toBe(1);
    expect(registry.getQueuedTurnsSnapshot()[buildThreadIdentityKey("codex", "parent")]).toBeUndefined();
    expect(steers.mock.calls.map(([request]) => request.expectedTurnId)).toEqual(["turn-1", "turn-1"]);
    const [joined, second] = steers.mock.calls.map(([request]) => textOf(request.input));
    for (const report of ["Lane D report", "Lane A report", "Lane C report"]) expect(joined).toContain(report);
    expect(second).toContain("Monitor finished: PR #109 checks");
    for (const report of ["Lane A report", "Lane B report", "Lane C report", "Lane D report"]) expect(second).toContain(report);
    expect(second!.indexOf("Monitor finished: PR #109 checks")).toBeLessThan(second!.indexOf("Lane A report"));

    await codexClient.emit({ method: "turn/completed", params: {
      threadId: "parent", turnId: "turn-1", turn: { id: "turn-1", status: "completed", output: [] },
    } });
    await settle();
    expect(codexClient.startTurnCallCount).toBe(1);
  });

  it.each(["running", "idle"] as const)("lets Continue After and PR watch wakes share one delivery when the thread is %s", async (state) => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start", "turn/steer", "thread/resume"] },
      startTurnResults: [{ threadId: "parent", turnId: "wake-turn" }],
    });
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore: createOverlayStoreMock(), threadTitleGenerationService: null });
    onTestFinished(() => registry.close());
    await discoverCodexBackendForTest(registry);
    const steers = vi.spyOn(codexClient, "steerTurn").mockImplementation(async (params) =>
      ({ threadId: params.threadId, turnId: params.expectedTurnId }));
    if (state === "running") {
      await registry.publishLocalEvent({ backend: "codex", notification: {
        method: "turn/started", params: { threadId: "parent", turnId: "running-turn", turn: { id: "running-turn" } },
      } });
    }
    const wake = (text: string, messageOrigin: AppServerThreadMessageOrigin) => registry.submitTurnIfIdle({
      backend: "codex", threadId: "parent", origin: "automation", joinRunningTurn: true,
      input: [{ type: "text", text }], messageOrigin,
    });
    const results = await Promise.all([
      wake("Worker A finished", { kind: "pwragent", dependencyId: "dependency-a" }),
      wake("Worker B finished", { kind: "pwragent", dependencyId: "dependency-b" }),
      wake("Worker C finished", { kind: "pwragent", dependencyId: "dependency-c" }),
      wake("PR #12 checks passed", { kind: "pwragent", prAutomation: { kind: "watch", prKey: "github.com/o/r#12", prNumber: 12, headSha: "abc" } }),
    ]);
    for (let index = 0; index < 6; index++) await new Promise<void>((resolve) => setImmediate(resolve));
    expect(results.every((result) => result.status !== "busy")).toBe(true);
    const delivered = [
      ...(state === "idle" ? [codexClient.lastStartTurnParams?.input ?? []] : []),
      ...steers.mock.calls.map(([request]) => request.input),
    ].map((input) => input.flatMap((item) => item.type === "text" ? [item.text] : []).join("\n")).join("\n");
    for (const text of ["Worker A finished", "Worker B finished", "Worker C finished", "PR #12 checks passed"]) {
      expect(delivered).toContain(text);
    }
    // One wakeup: the running turn takes them all, or an idle thread starts
    // exactly one turn and the rest join it.
    expect(codexClient.startTurnCallCount).toBe(state === "idle" ? 1 : 0);
    expect(steers.mock.calls.length).toBeLessThanOrEqual(1);
    expect(registry.getQueuedTurnsSnapshot()[buildThreadIdentityKey("codex", "parent")]).toBeUndefined();
  });

  it("keeps cross-thread admissions immutable while a previous steer dispatches, then steers them together", async () => {
    const codexClient = new MockBackendClient({ initializeResult: { methods: ["turn/start", "turn/steer", "thread/resume"] } });
    const correspondenceStore = new ThreadCorrespondenceStore();
    const registry = createDesktopBackendRegistry({ codexClient, correspondenceStore, overlayStore: createOverlayStoreMock(), threadTitleGenerationService: null });
    onTestFinished(() => registry.close());
    const events: AgentEvent[] = [];
    registry.onEvent((event) => { events.push(event); });
    await discoverCodexBackendForTest(registry);
    await registry.publishLocalEvent({ backend: "codex", notification: {
      method: "turn/started", params: { threadId: "recipient", turnId: "active-recipient", turn: { id: "active-recipient" } },
    } });
    let release!: () => void;
    const dispatch = new Promise<void>((resolve) => { release = resolve; });
    const steers = vi.spyOn(codexClient, "steerTurn").mockImplementation(async (params) => {
      if (steers.mock.calls.length === 1) await dispatch;
      return { threadId: params.threadId, turnId: params.expectedTurnId };
    });
    await registry.submitTurn({ backend: "codex", threadId: "recipient", input: [{ type: "text", text: "Already dispatching" }],
      messageOrigin: { kind: "agent", sourceThread: { backend: "codex", threadId: "first" } },
    });
    await waitForCondition(() => steers.mock.calls.length === 1);
    const sends = await Promise.all(Array.from({ length: 20 }, async (_, index) => {
      const source = { backend: "codex" as const, threadId: `sender-${index}` };
      const input: AppServerTurnInputItem[] = [{ type: "text", text: `Evidence ${index}` }];
      correspondenceStore.record({ id: `message-${index}`, source, destination: { backend: "codex", threadId: "recipient" }, input, createdAt: 1_000 + index, state: "sending" });
      const messageOrigin = { kind: "agent" as const, sourceThread: { ...source, title: `Sender ${index}`, messageId: `message-${index}` } };
      return index % 2 === 0
        ? await registry.submitTurn({ backend: "codex", threadId: "recipient", input, messageOrigin })
        : await registry.controlActiveTurn({ operation: "steer", backend: "codex", threadId: "recipient", requestId: `request-${index}`, expectedTurnId: "active-recipient", input, messageOrigin });
    }));
    const snapshot = registry.getQueuedTurnsSnapshot()[buildThreadIdentityKey("codex", "recipient")];
    expect(snapshot).toHaveLength(20);
    expect(sends).toHaveLength(20);
    const waiting = await Promise.all(snapshot!.map(entry => registry.readQueuedTurn({ backend: "codex", threadId: "recipient", queueEntryId: entry.queueEntryId })));
    for (const queued of waiting) {
      const index = Number(queued.messageOrigin!.sourceThread!.threadId.slice("sender-".length));
      expect(queued.input).toEqual([{ type: "text", text: `Evidence ${index}` }]);
      expect(queued.messageOrigin?.sourceThread?.threadId).toBe(`sender-${index}`);
    }
    const queueEntryId = snapshot![waiting.findIndex(entry => entry.messageOrigin?.sourceThread?.threadId === "sender-7")]!.queueEntryId;
    const replacement = await registry.replaceQueuedAgentMessage({ backend: "codex", threadId: "recipient", queueEntryId,
      input: [{ type: "text", text: "Sender 7 consolidated evidence" }],
      messageOrigin: { kind: "agent", sourceThread: { backend: "codex", threadId: "sender-7" } },
    });
    expect(steers.mock.calls[0]![0].input).toEqual([{ type: "text", text: "Already dispatching" }]);
    release();
    // The twenty messages that waited behind the dispatching steer go out as
    // one steer. Each kept its own queue identity until then.
    await waitForCondition(() => steers.mock.calls.length === 2);
    await waitForCondition(() => registry.getQueuedTurnsSnapshot()[buildThreadIdentityKey("codex", "recipient")] === undefined);
    expect(codexClient.startTurnCallCount).toBe(0);
    const replacementStart = events.find((event) => event.notification.method === "thread/turnQueue/updated"
      && event.notification.params.queueEntryId === replacement.queueEntryId && event.notification.params.status === "started");
    expect(replacementStart).toBeDefined();
    const summary = (replacementStart!.notification.params as { incomingWork?: {
      messages: { origin: { sourceThread: { threadId: string; title: string } }; preview: string }[];
      omittedMessageCount: number;
    } }).incomingWork;
    expect(summary?.messages).toHaveLength(1);
    expect(summary?.omittedMessageCount).toBe(0);
    expect(summary?.messages[0]?.origin.sourceThread.threadId).toBe("sender-7");
    expect(summary?.messages[0]?.preview).toBe("Sender 7 consolidated evidence");
    const combined = steers.mock.calls[1]![0].input.flatMap((item) => item.type === "text" ? [item.text] : []).join("\n");
    let cursor = -1;
    for (const entry of waiting) {
      const text = entry.messageOrigin?.sourceThread?.threadId === "sender-7"
        ? "Sender 7 consolidated evidence"
        : entry.input.flatMap((item) => item.type === "text" ? [item.text] : []).join("\n");
      const at = combined.indexOf(text, cursor + 1);
      expect(at).toBeGreaterThan(cursor);
      cursor = at;
    }
    expect(combined).not.toContain("Evidence 7");
    for (let index = 0; index < 20; index += 1) {
      expect(correspondenceStore.message({ backend: "codex", threadId: `sender-${index}` }, `message-${index}`)?.text)
        .toContain(index === 7 ? "Cancelled" : "Receiving thread started work");
    }
    await registry.submitTurn({ backend: "codex", threadId: "recipient", queueEntryId: "distinct-turn", delivery: "new_turn",
      input: [{ type: "text", text: "Start separate work" }],
      messageOrigin: { kind: "agent", sourceThread: { backend: "codex", threadId: "sender-7" } },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(steers).toHaveBeenCalledTimes(2);
    expect((await registry.readQueuedTurn({ backend: "codex", threadId: "recipient", queueEntryId: "distinct-turn" })).input)
      .toEqual([{ type: "text", text: "Start separate work" }]);
    await codexClient.emit({
      method: "turn/completed", params: { threadId: "recipient", turnId: "active-recipient", turn: { id: "active-recipient", status: "completed", output: [] } },
    });
    await waitForCondition(() => codexClient.startTurnCallCount === 1);
  });

  it.each(["claude", "acp:kimi"] as const)("keeps queued %s messages independent of Codex even when it is available", async (backend) => {
    const codexClient = Object.assign(new MockBackendClient({}), {
      generateStructuredObject: vi.fn(async () => ({ status: "ok" as const, object: { title: "Unexpected Codex title" } })),
    });
    const overlayStore = createOverlayStoreMock();
    const recordHelper = vi.spyOn(overlayStore, "upsertThreadSubAgent");
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore, threadTitleGenerationService: null });
    onTestFinished(() => registry.close());
    await discoverCodexBackendForTest(registry);
    await registry.publishLocalEvent({ backend, notification: {
      method: "turn/started", params: { threadId: "recipient", turnId: "active", turn: { id: "active" } },
    } });
    const input = [{ type: "text" as const, text: "Docs child: the migration guide now covers the renamed config keys and the new default port." }];
    try {
      await registry.submitTurn({ backend, threadId: "recipient", queueEntryId: "long", delivery: "new_turn", input });
      await registry.queuedMessageTitlesIdle();

      const snapshot = registry.getQueuedTurnsSnapshot()[buildThreadIdentityKey(backend, "recipient")];
      expect(snapshot).toHaveLength(1);
      expect(snapshot?.[0]?.title).toBeUndefined();
      expect((await registry.readQueuedTurn({ backend, threadId: "recipient", queueEntryId: "long" })).input).toEqual(input);
      expect(codexClient.generateStructuredObject).not.toHaveBeenCalled();
      expect(recordHelper).not.toHaveBeenCalled();
    } finally {
      registry.cancelQueuedTurn("long");
      await emitCompletedTurn(registry, backend, "recipient");
    }
  });

  it("never titles a cross-thread message that steers straight into the running turn", async () => {
    const codexClient = new MockBackendClient({ initializeResult: { methods: ["turn/start", "turn/steer", "thread/resume"] } });
    const generate = vi.fn(async () => ({ status: "ok" as const, object: { title: "Nobody sees this" } }));
    Object.assign(codexClient, { generateStructuredObject: generate });
    const overlayStore = createOverlayStoreMock();
    const recordHelper = vi.spyOn(overlayStore, "upsertThreadSubAgent");
    const registry = createDesktopBackendRegistry({
      codexClient, overlayStore, threadTitleGenerationService: null, queuedMessageTitleSettleMs: 20,
    });
    onTestFinished(() => registry.close());
    await discoverCodexBackendForTest(registry);
    await registry.publishLocalEvent({ backend: "codex", notification: {
      method: "turn/started", params: { threadId: "recipient", turnId: "active-recipient", turn: { id: "active-recipient" } },
    } });
    const steers = vi.spyOn(codexClient, "steerTurn")
      .mockImplementation(async (params) => ({ threadId: params.threadId, turnId: params.expectedTurnId }));
    const text = "Scope correction: they meant PR56, not PR64. Retract my PR64 presentation-update request and hold the render.";

    await registry.submitTurn({ backend: "codex", threadId: "recipient", input: [{ type: "text", text }],
      messageOrigin: { kind: "agent", sourceThread: { backend: "codex", threadId: "director", title: "Image director" } },
    });
    await waitForCondition(() => steers.mock.calls.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 60));
    await registry.queuedMessageTitlesIdle();

    expect(registry.getQueuedTurnsSnapshot()[buildThreadIdentityKey("codex", "recipient")]).toBeUndefined();
    expect(generate).not.toHaveBeenCalled();
    expect(recordHelper).not.toHaveBeenCalled();
  });

  it("titles a waiting cross-thread message with its sender and recipient, and no execution tools", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
      threads: [{ id: "recipient", title: "Train artist", titleSource: "explicit" as const, source: "codex" as const, linkedDirectories: [] }],
    });
    const generate = vi.fn(async (_params: { prompt: string; disableExecution?: boolean }) =>
      ({ status: "ok" as const, object: { title: "Image director: hold PR64 render" } }));
    Object.assign(codexClient, { generateStructuredObject: generate });
    const registry = createDesktopBackendRegistry({
      codexClient, overlayStore: createOverlayStoreMock(), threadTitleGenerationService: null, queuedMessageTitleSettleMs: 0,
    });
    onTestFinished(() => registry.close());
    await discoverCodexBackendForTest(registry);
    await registry.listThreads({ backend: "codex" });
    await registry.publishLocalEvent({ backend: "codex", notification: {
      method: "turn/started", params: { threadId: "recipient", turnId: "active", turn: { id: "active" } },
    } });
    // A huge message is capped; who sent it must survive the cap.
    const text = `Hold the PR64 render. ${"Evidence line. ".repeat(1_000)}`;
    try {
      await registry.submitTurn({ backend: "codex", threadId: "recipient", queueEntryId: "from-director", delivery: "new_turn",
        input: [{ type: "text", text }],
        messageOrigin: { kind: "agent", sourceThread: { backend: "codex", threadId: "director", title: "Image director" } },
      });
      await registry.queuedMessageTitlesIdle();

      expect(generate).toHaveBeenCalledTimes(1);
      const params = generate.mock.calls[0]![0];
      expect(params.disableExecution).toBe(true);
      expect(params.prompt).toContain(JSON.stringify({ from: ["Image director"], to: "Train artist" }));
      expect(params.prompt.length).toBeLessThan(10_000);
      expect(registry.getQueuedTurnsSnapshot()[buildThreadIdentityKey("codex", "recipient")]?.[0]?.title)
        .toBe("Image director: hold PR64 render");
    } finally {
      registry.cancelQueuedTurn("from-director");
    }
  });

  it("titles a long queued message once and drops a title the input outgrew", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
      threads: [{ id: "recipient", title: "recipient", titleSource: "explicit" as const, source: "codex" as const, linkedDirectories: [] }],
    });
    const helperTurns: Array<{ prompt: string; resolve: (title: string) => void }> = [];
    (
      codexClient as unknown as {
        generateStructuredObject: (request: { prompt: string }) => Promise<unknown>;
      }
    ).generateStructuredObject = (request) => new Promise((resolve) => {
      helperTurns.push({ prompt: request.prompt, resolve: (title) => resolve({ status: "ok", object: { title } }) });
    });
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore: createOverlayStoreMock(), threadTitleGenerationService: null, queuedMessageTitleSettleMs: 0 });
    onTestFinished(() => registry.close());
    await discoverCodexBackendForTest(registry);
    const events: AgentEvent[] = [];
    registry.onEvent((event) => { events.push(event); });
    await registry.publishLocalEvent({ backend: "codex", notification: {
      method: "turn/started", params: { threadId: "recipient", turnId: "active", turn: { id: "active" } },
    } });
    const longText = "Docs child: the migration guide now covers the renamed config keys and the new default port.";
    await registry.submitTurn({ backend: "codex", threadId: "recipient", queueEntryId: "short", input: [{ type: "text", text: "bump the lint config" }] });
    await registry.submitTurn({ backend: "codex", threadId: "recipient", queueEntryId: "long", input: [{ type: "text", text: longText }] });
    const snapshot = () => registry.getQueuedTurnsSnapshot()[buildThreadIdentityKey("codex", "recipient")];

    await waitForCondition(() => helperTurns.length === 1);
    expect(helperTurns[0]!.prompt).toContain(JSON.stringify(longText));
    // The edit lands while the first helper turn is still out, so its title
    // names text the entry no longer holds.
    registry.updateQueuedTurnInput("long", [{ type: "text", text: `${longText}\nAlso moved the upgrade notes.` }]);
    helperTurns[0]!.resolve("Migration guide covers renamed keys.");
    await waitForCondition(() => helperTurns.length === 2);
    expect(snapshot()?.find((entry) => entry.queueEntryId === "long")?.title).toBeUndefined();
    helperTurns[1]!.resolve("Migration guide and upgrade notes");
    await registry.queuedMessageTitlesIdle();

    expect(helperTurns).toHaveLength(2);
    expect(snapshot()?.map((entry) => [entry.queueEntryId, entry.title])).toEqual([
      ["short", undefined],
      ["long", "Migration guide and upgrade notes"],
    ]);
    await waitForCondition(() => events.some((event) =>
      event.notification.method === "thread/turnQueue/updated"
      && event.notification.params.title !== undefined));
    const titled = events.filter((event) =>
      event.notification.method === "thread/turnQueue/updated"
      && event.notification.params.title !== undefined);
    expect(titled).toEqual([expect.objectContaining({
      backend: "codex",
      notification: {
        method: "thread/turnQueue/updated",
        params: expect.objectContaining({
          threadId: "recipient",
          queueEntryId: "long",
          status: "queued",
          title: "Migration guide and upgrade notes",
        }),
      },
    })]);
  });

  it("Retry updates sender correspondence when a waiting title completes during release publication", async () => {
    const codexClient = new MockBackendClient({ initializeResult: { methods: ["turn/start"] } });
    let completeTitle!: () => void;
    const pendingTitle = new Promise<{ status: "ok"; object: { title: string } }>((resolve) => {
      completeTitle = () => resolve({ status: "ok", object: { title: "Migration guide and upgrade notes" } });
    });
    const generate = vi.fn(async () => await pendingTitle);
    Object.assign(codexClient, { generateStructuredObject: generate });
    const correspondenceStore = new ThreadCorrespondenceStore();
    const registry = createDesktopBackendRegistry({
      codexClient, correspondenceStore, overlayStore: createOverlayStoreMock(),
      threadTitleGenerationService: null, queuedMessageTitleSettleMs: 0,
    });
    onTestFinished(async () => { completeTitle(); await registry.close(); });
    await discoverCodexBackendForTest(registry);
    await registry.publishLocalEvent({ backend: "codex", notification: {
      method: "turn/started", params: { threadId: "recipient", turnId: "previous", turn: { id: "previous" } },
    } });
    const source = { backend: "codex" as const, threadId: "sender" };
    for (const [id, text] of [["first", "Review the failure"], ["later", "The migration guide now covers all renamed configuration keys and the new default port."]] as const) {
      const input: AppServerTurnInputItem[] = [{ type: "text", text }];
      correspondenceStore.record({ id, source, destination: { backend: "codex", threadId: "recipient" }, input, createdAt: 1_000, state: "sending" });
      await registry.submitTurn({ backend: "codex", threadId: "recipient", queueEntryId: id, delivery: "new_turn", input,
        messageOrigin: { kind: "agent", sourceThread: { ...source, messageId: id } },
      });
    }
    await waitForCondition(() => generate.mock.calls.length > 0);
    await registry.publishLocalEvent({ backend: "codex", notification: {
      method: "turn/failed", params: { threadId: "recipient", turnId: "previous",
        turn: { id: "previous", status: "failed", error: { message: "Review this failure" } } },
    } });
    expect(correspondenceStore.message(source, "later")?.text).toContain("Held for retry");
    let completeDuringRelease = true;
    registry.onEvent(async event => {
      if (event.notification.method !== "thread/turnQueue/updated") return;
      const params = event.notification.params;
      if (completeDuringRelease && params.queueEntryId === "first" && params.status === "queued" && !params.manualReleaseRequired) {
        completeDuringRelease = false;
        completeTitle();
        await registry.queuedMessageTitlesIdle();
      }
    });
    expect(await registry.releaseQueuedTurnWithDisposition("first")).toMatchObject({ disposition: "started" });
    const waiting = registry.getQueuedTurnsForThread({ backend: "codex", threadId: "recipient" });
    expect(waiting).toMatchObject([{ queueEntryId: "later", title: "Migration guide and upgrade notes" }]);
    expect(waiting[0]?.manualReleaseRequired).not.toBe(true);
    expect(correspondenceStore.message(source, "later")?.text).toContain("Queued");
    expect(codexClient.startTurnCallCount).toBe(1);
  });

  it("records a failed queued-message title and skips a helper that never ran", async () => {
    const overlayStore = createOverlayStoreMock();
    const upsertSubAgentSpy = vi.spyOn(overlayStore, "upsertThreadSubAgent");
    const upsertUsageLineSpy = vi.spyOn(overlayStore, "upsertThreadUsageLine");
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
      threads: [{ id: "recipient", title: "recipient", titleSource: "explicit" as const, source: "codex" as const, linkedDirectories: [] }],
    });
    const results: unknown[] = [
      { status: "unavailable", reason: "codex_structured_generation_unavailable" },
      { status: "failed", reason: "helper turn timed out" },
    ];
    (
      codexClient as unknown as { generateStructuredObject: () => Promise<unknown> }
    ).generateStructuredObject = async () => results.shift();
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore, threadTitleGenerationService: null, queuedMessageTitleSettleMs: 0 });
    onTestFinished(() => registry.close());
    await discoverCodexBackendForTest(registry);
    await registry.publishLocalEvent({ backend: "codex", notification: {
      method: "turn/started", params: { threadId: "recipient", turnId: "active", turn: { id: "active" } },
    } });
    const longText = "Docs child: the migration guide now covers the renamed config keys and the new default port.";
    await registry.submitTurn({ backend: "codex", threadId: "recipient", queueEntryId: "unavailable", input: [{ type: "text", text: longText }] });
    await registry.queuedMessageTitlesIdle();
    expect(upsertSubAgentSpy).not.toHaveBeenCalled();

    await registry.submitTurn({ backend: "codex", threadId: "recipient", queueEntryId: "failed", input: [{ type: "text", text: `${longText} Again.` }] });
    await registry.queuedMessageTitlesIdle();
    expect(upsertSubAgentSpy.mock.calls.map(([call]) => call.subAgent)).toEqual([expect.objectContaining({
      monitorId: "system:queued-message-titles:codex:recipient",
      task: "Name queued messages",
      status: "failed",
      outcome: "failure",
      lastMessage: "Latest title failed: helper turn timed out",
    })]);
    expect(upsertUsageLineSpy).not.toHaveBeenCalled();
  });

  it("still titles a queued message whose start was refused and held", async () => {
    await fc.assert(fc.asyncProperty(fc.string({ maxLength: 20 }), async suffix => {
      const codexClient = new MockBackendClient({
        initializeResult: { methods: ["turn/start"] },
        startTurnErrors: [new Error("start refused")],
        threads: ["busy", "held"].map((id) => ({
          id, title: id, titleSource: "explicit" as const, source: "codex" as const, linkedDirectories: [],
        })),
      });
      const helperTurns: Array<{ prompt: string; resolve: (title: string) => void }> = [];
      (
        codexClient as unknown as {
          generateStructuredObject: (request: { prompt: string }) => Promise<unknown>;
        }
      ).generateStructuredObject = (request) => new Promise((resolve) => {
        helperTurns.push({ prompt: request.prompt, resolve: (title) => resolve({ status: "ok", object: { title } }) });
      });
      const registry = createDesktopBackendRegistry({ codexClient, overlayStore: createOverlayStoreMock(), threadTitleGenerationService: null, queuedMessageTitleSettleMs: 0 });
      try {
        await discoverCodexBackendForTest(registry);
        const events: AgentEvent[] = [];
        registry.onEvent((event) => { events.push(event); });
        for (const threadId of ["busy", "held"]) {
          await registry.publishLocalEvent({ backend: "codex", notification: {
            method: "turn/started", params: { threadId, turnId: `active-${threadId}`, turn: { id: `active-${threadId}` } },
          } });
        }
        const busyText = "Busy child: the release notes now list every renamed setting and its replacement key.";
        const heldText = `Held child: the import script skips archived rows and reports how many it left behind. ${suffix}`;
        await registry.submitTurn({ backend: "codex", threadId: "busy", queueEntryId: "busy-entry", input: [{ type: "text", text: busyText }] });
        await registry.submitTurn({ backend: "codex", threadId: "held", queueEntryId: "held-entry", input: [{ type: "text", text: heldText }] });
        await waitForCondition(() => helperTurns.length === 1);

        // The held thread's message is still waiting behind the busy one's helper
        // turn when its release is refused. It remains waiting through both
        // `held` and `blocked`, so neither event may cancel its title request.
        await codexClient.emit({
          method: "turn/completed", params: { threadId: "held", turnId: "active-held", turn: { id: "active-held", status: "completed", output: [] } },
        });
        await waitForCondition(() => events.some((event) =>
          event.notification.method === "thread/turnQueue/updated"
          && event.notification.params.status === "blocked"));
        helperTurns[0]!.resolve("Release notes list renamed settings");

        await waitForCondition(() => helperTurns.length === 2);
        expect(helperTurns[1]!.prompt).toContain(JSON.stringify(heldText.trim()));
        helperTurns[1]!.resolve("Import script skips archived rows");
        await registry.queuedMessageTitlesIdle();
        expect(
          registry.getQueuedTurnsSnapshot()[buildThreadIdentityKey("codex", "held")]
            ?.find((entry) => entry.queueEntryId === "held-entry")?.title,
        ).toBe("Import script skips archived rows");
      } finally { await registry.close(); }
    }), { numRuns: 8, examples: [[""]] });
  });

  it("replacement correspondence agrees with cancellation during its queued lifecycle publication", async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    await fc.assert(fc.asyncProperty(fc.string({ minLength: 1, maxLength: 40 }), fc.boolean(), async (suffix, defer) => {
      const correspondenceStore = new ThreadCorrespondenceStore();
      const codexClient = new MockBackendClient({ initializeResult: { methods: ["turn/start"] },
        threads: ["sender", "recipient"].map(id => ({ id, title: id, titleSource: "explicit" as const, source: "codex" as const, linkedDirectories: [] })),
      });
      const registry = createDesktopBackendRegistry({ codexClient, correspondenceStore, overlayStore: createOverlayStoreMock(), threadTitleGenerationService: null });
      try {
        for (const threadId of ["sender", "recipient"]) await registry.publishLocalEvent({ backend: "codex", notification: {
          method: "turn/started", params: { threadId, turnId: `active:${threadId}`, turn: { id: `active:${threadId}` } },
        } });
        const send = async (prompt: string, replaceQueueEntryId?: string) => {
          const response = await codexClient.emitRequest({ method: "item/tool/call", params: {
            threadId: "sender", turnId: "active:sender", callId: `review:${prompt}`, requestId: `review:${prompt}`,
            namespace: "pwragent", tool: "send_message_to_thread", arguments: { backend: "codex", threadId: "recipient", prompt,
              ...(replaceQueueEntryId ? { replaceQueueEntryId } : {}) },
          } } as AppServerPendingRequestNotification);
          expect(response).toMatchObject({ success: true });
          return JSON.parse((response as { contentItems: Array<{ text: string }> }).contentItems[0]!.text);
        };
        const first = await send("Original accepted evidence");
        let cancelled = false;
        registry.onEvent(async event => {
          if (event.notification.method === "thread/turnQueue/updated" && event.notification.params.status === "queued"
            && typeof event.notification.params.queueEntryId === "string" && event.notification.params.queueEntryId !== first.queueEntryId) {
            if (defer) await Promise.resolve();
            cancelled = registry.cancelQueuedTurn(event.notification.params.queueEntryId);
          }
        });
        const { result: replacement, writes } = await measureSqliteWrites(async () => {
          const result = await send(`Fresh evidence ${suffix}`, first.queueEntryId);
          await new Promise<void>(resolve => setImmediate(resolve));
          return result;
        });
        expectSqliteWriteBudget({ budgetFile: "desktop-replacement-review-write-budgets.json", scenario: "local-receipt-publication",
          note: "Actual local dynamic tool replacement and cancellation; correspondence uses the existing sidecar journal; setup excluded", writes });
        expect(cancelled).toBe(true);
        expect(registry.getQueuedTurnsSnapshot()[buildThreadIdentityKey("codex", "recipient")] ?? []).toEqual([]);
        const replay = correspondenceStore.appendToReplay({ backend: "codex", threadId: "sender" }, {
          entries: [], messages: [], pagination: { supportsPagination: false, hasPreviousPage: false },
        });
        expect(replay.messages).toHaveLength(2);
        expect(replay.messages[0]!.text).toContain("Original accepted evidence");
        expect(replay.messages[1]!.text).toContain(`Fresh evidence ${suffix}`);
        expect(replay.messages[1]!.text).toContain("Cancelled");
        expect(replay.messages[1]!.text).not.toContain("Queued");
        await expect(registry.readQueuedTurn({ backend: "codex", threadId: "recipient", queueEntryId: replacement.queueEntryId })).rejects.toThrow();
      } finally { await registry.close(); }
    }), { numRuns: 8, examples: [["!", false], ["!", true]] });
  });

  it("consolidates only the sender's queued message without adding a turn", async () => {
    const correspondenceStore = new ThreadCorrespondenceStore();
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
      threads: ["sender", "recipient"].map((id) => ({
        id, title: id, titleSource: "explicit" as const, source: "codex" as const, linkedDirectories: [],
      })),
    });
    const registry = createDesktopBackendRegistry({ codexClient, correspondenceStore, overlayStore: createOverlayStoreMock(), threadTitleGenerationService: null });
    onTestFinished(() => registry.close());
    const events: AgentEvent[] = [];
    registry.onEvent((event) => { events.push(event); });
    for (const threadId of ["sender", "recipient"]) {
      await registry.publishLocalEvent({ backend: "codex", notification: {
        method: "turn/started", params: { threadId, turnId: `active:${threadId}`, turn: { id: `active:${threadId}` } },
      } });
    }
    const send = async (prompt: string, replaceQueueEntryId?: string) => {
      const response = await codexClient.emitRequest({ method: "item/tool/call", params: {
        threadId: "sender", turnId: "active:sender", callId: `replace:${prompt}`, requestId: `replace:${prompt}`,
        namespace: "pwragent", tool: "send_message_to_thread",
        arguments: { backend: "codex", threadId: "recipient", prompt, ...(replaceQueueEntryId ? { replaceQueueEntryId } : {}) },
      } } as AppServerPendingRequestNotification);
      return { response, payload: JSON.parse((response as { contentItems: Array<{ text: string }> }).contentItems[0]!.text) };
    };
    const first = await send("Initial evidence");
    const queueEntryId = first.payload.queueEntryId as string;
    await registry.submitTurn({ backend: "codex", threadId: "recipient", input: [{ type: "text", text: "Operator message" }], queueEntryId: "operator-next" });
    const target = { backend: "codex" as const, threadId: "recipient", queueEntryId };
    const original = await registry.readQueuedTurn(target);
    const input = [{ type: "text" as const, text: "Unwanted overwrite" }];
    for (const sourceThread of [
      { backend: "codex" as const, threadId: "other" },
      { backend: "codex" as const, threadId: "sender", instanceId: "other-machine" },
    ]) {
      await expect(registry.replaceQueuedAgentMessage({ ...target, input, messageOrigin: { kind: "agent", sourceThread } })).rejects.toThrow("Only the sending thread");
    }
    await expect(registry.replaceQueuedAgentMessage({ ...target, queueEntryId: "operator-next", input, messageOrigin: original.messageOrigin })).rejects.toThrow("Only the sending thread");
    await expect(registry.replaceQueuedAgentMessage({ ...target, threadId: "sender", input, messageOrigin: original.messageOrigin })).rejects.toThrow("not found or already started");
    const replacement = await send("Complete consolidated findings", queueEntryId);
    expect(replacement.response).toMatchObject({ success: true });
    expect(replacement.payload).toMatchObject({ queueStatus: "queued" });
    const replacementId = replacement.payload.queueEntryId as string;
    expect(replacementId).not.toBe(queueEntryId);
    await expect(registry.readQueuedTurn(target)).rejects.toThrow();
    const updated = await registry.readQueuedTurn({ ...target, queueEntryId: replacementId });
    expect(updated.input).toEqual([{ type: "text", text: "Complete consolidated findings" }]);
    expect(updated.messageOrigin?.sourceThread).toMatchObject({ ...original.messageOrigin!.sourceThread, messageId: expect.any(String) });
    expect(updated.messageOrigin?.sourceThread?.messageId).not.toBe(original.messageOrigin?.sourceThread?.messageId);
    await waitForCondition(() => events.some((event) =>
      event.notification.method === "thread/turnQueue/updated"
      && event.notification.params.queueEntryId === replacementId));
    expect(events).toContainEqual(expect.objectContaining({
      backend: "codex",
      notification: {
        method: "thread/turnQueue/updated",
        params: expect.objectContaining({
          threadId: "recipient",
          queueEntryId: replacementId,
          status: "queued",
          displayText: "Complete consolidated findings",
        }),
      },
    }));
    expect(registry.getQueuedTurnsSnapshot()[buildThreadIdentityKey("codex", "recipient")]?.map((entry) => entry.queueEntryId)).toEqual([replacementId, "operator-next"]);
    const replay = correspondenceStore.appendToReplay({ backend: "codex", threadId: "sender" }, {
      entries: [], messages: [], pagination: { supportsPagination: false, hasPreviousPage: false },
    });
    expect(replay.messages).toHaveLength(2);
    expect(replay.messages[0]?.text).toContain("Initial evidence");
    expect(replay.messages[0]?.text).toContain("Cancelled");
    expect(replay.entries[0]?.turn?.id).toBe("active:sender");
    expect(events).toContainEqual(expect.objectContaining({ notification: {
      method: "item/completed",
      params: expect.objectContaining({
        threadId: "sender", turnId: "active:sender",
        item: expect.objectContaining({ id: replay.entries[0]?.id, createdAt: replay.entries[0]?.createdAt }),
      }),
    } }));
    expect(replay.messages[1]?.text).toContain("Complete consolidated findings");
    expect(replay.messages[1]?.text).not.toContain("Initial evidence");
    registry.cancelQueuedTurn(replacementId);
    expect((await send("Too late", queueEntryId)).response).toMatchObject({ success: false });
    expect(registry.getQueuedTurnsSnapshot()[buildThreadIdentityKey("codex", "recipient")]).toHaveLength(1);
  });

  it.each([
    { queueMode: "new_turn", turnId: "later-turn", rootTurnId: "later-root" },
    { queueMode: "new_turn", turnId: "later-turn", rootTurnId: undefined },
    { queueMode: "settings", turnId: "later-turn", rootTurnId: "later-root" },
    { queueMode: "settings", turnId: undefined, rootTurnId: undefined },
  ])("refreshes ungrouped replacement ancestry: $queueMode, $turnId, $rootTurnId", async ({ queueMode, turnId, rootTurnId }) => {
    const codexClient = new MockBackendClient({ initializeResult: { methods: ["turn/start"] } });
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore: createOverlayStoreMock(), threadTitleGenerationService: null });
    onTestFinished(() => registry.close());
    const target = { backend: "codex" as const, threadId: "recipient" };
    await registry.publishLocalEvent({ ...target, notification: {
      method: "turn/started", params: { threadId: target.threadId, turn: { id: "busy" } },
    } });
    const originalOrigin = { kind: "agent" as const, sourceThread: {
      backend: "codex" as const, threadId: "sender", messageId: "original-correspondence",
      turnId: "original-turn", rootTurnId: "original-root",
    } };
    await registry.submitTurn({ ...target, queueEntryId: "replacement",
      ...(queueMode === "new_turn" ? { delivery: "new_turn" as const } : { reasoningEffort: "high" }),
      input: [{ type: "text", text: "Original task" }], messageOrigin: originalOrigin,
    });
    const replacement = { ...target, queueEntryId: "replacement",
      input: [{ type: "text" as const, text: "Replacement task" }],
      messageOrigin: { ...originalOrigin, sourceThread: {
        ...originalOrigin.sourceThread, turnId, rootTurnId, messageId: "replacement-correspondence",
      } },
    };
    await expect(registry.replaceQueuedAgentMessage({ ...replacement, messageOrigin: {
      ...replacement.messageOrigin, sourceThread: { ...replacement.messageOrigin.sourceThread, instanceId: "other-instance" },
    } })).rejects.toThrow("Only the sending thread");
    expect((await registry.readQueuedTurn(replacement)).messageOrigin).toEqual(originalOrigin);
    const accepted = await registry.replaceQueuedAgentMessage(replacement);
    expect(accepted.queueEntryId).not.toBe(replacement.queueEntryId);
    await expect(registry.readQueuedTurn(replacement)).rejects.toThrow();
    const queued = await registry.readQueuedTurn({ ...replacement, queueEntryId: accepted.queueEntryId! });
    expect(queued.input).toEqual(replacement.input);
    expect(queued.messageOrigin).toEqual(replacement.messageOrigin);
    expect(codexClient.startTurnCalls).toHaveLength(0);
    await registry.publishLocalEvent({ ...target, notification: {
      method: "turn/completed", params: { threadId: target.threadId, turnId: "busy", turn: { id: "busy", status: "completed", output: [] } },
    } });
    await waitForCondition(() => codexClient.startTurnCalls.length === 1);
    expect(codexClient.lastStartTurnParams?.input).toEqual(replacement.input);
    expect(codexClient.lastStartTurnParams?.parentTurnId).toBe(turnId);
    expect(codexClient.lastStartTurnParams?.rootTurnId).toBe(rootTurnId);
    expect(codexClient.lastStartTurnParams?.approvalPolicy).toBe("on-request");
    if (queueMode === "settings") expect(codexClient.lastStartTurnParams?.reasoningEffort).toBe("high");
  });

  it("sends an operator-approved to-do request from an idle source through the existing queue", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
      threads: ["sender", "recipient"].map((id) => ({
        id, title: id, titleSource: "explicit" as const, source: "codex" as const, linkedDirectories: [],
      })),
    });
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore: createOverlayStoreMock(), threadTitleGenerationService: null });
    onTestFinished(() => registry.close());
    await registry.publishLocalEvent({ backend: "codex", notification: {
      method: "turn/started", params: { threadId: "recipient", turnId: "busy", turn: { id: "busy" } },
    } });
    const prompt = "Refresh #42.\n\nKeep the current worktree.";
    const todo = { id: "todo-7", title: "Refresh the PR" };
    await registry.sendThreadTodoMessage({ sourceBackend: "codex", sourceThreadId: "sender",
      target: { backend: "codex", threadId: "recipient" }, prompt, todo });
    const queued = registry.getQueuedTurnsSnapshot()[buildThreadIdentityKey("codex", "recipient")]!;
    expect(queued).toHaveLength(1);
    const content = await registry.readQueuedTurn({ backend: "codex", threadId: "recipient", queueEntryId: queued[0]!.queueEntryId });
    expect(content.input).toEqual([{ type: "text", text: prompt }]);
    // The raising thread and the card; the operator's click is no agent turn.
    expect(content.messageOrigin).toEqual({
      kind: "agent",
      sourceThread: {
        backend: "codex", threadId: "sender", title: "sender",
        messageId: expect.stringMatching(/^correspondence:/),
      },
      operatorApproved: true,
      threadTodo: todo,
    });
    expect(codexClient.startTurnCalls).toHaveLength(0);
    await expect(registry.sendThreadTodoMessage({ sourceBackend: "codex", sourceThreadId: "sender",
      target: { backend: "codex", threadId: "sender" }, prompt, todo })).rejects.toThrow(/another thread/);
  });

  it("carries a to-do request's card to a remote target", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
      threads: [{ id: "sender", title: "Sender", titleSource: "explicit" as const, source: "codex" as const, linkedDirectories: [] }],
    });
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore: createOverlayStoreMock(), threadTitleGenerationService: null });
    onTestFinished(() => registry.close());
    const federatedSend = vi.fn(async (request: PwrAgentFederatedThreadMessageRequest) => ({
      backend: request.backend, threadId: request.threadId, turnId: "remote-turn",
      instanceId: "peer", instanceLabel: "Studio",
    }));
    registry.setFederatedThreadMessageHandler(federatedSend);

    await registry.sendThreadTodoMessage({ sourceBackend: "codex", sourceThreadId: "sender",
      target: { backend: "codex", threadId: "remote-recipient", instanceId: "peer" },
      prompt: "Pick this up", todo: { id: "todo-8", title: "Hand it over" } });

    expect(federatedSend).toHaveBeenCalled();
    expect(federatedSend.mock.lastCall?.[0].messageOrigin).toEqual({
      kind: "agent",
      sourceThread: {
        backend: "codex", threadId: "sender", title: "Sender",
        messageId: expect.stringMatching(/^correspondence:/),
      },
      operatorApproved: true,
      threadTodo: { id: "todo-8", title: "Hand it over" },
    });
  });

  it("never lets an agent's own send claim a to-do card", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
      threads: [{ id: "sender", title: "Sender", titleSource: "explicit" as const, source: "codex" as const, linkedDirectories: [] }],
    });
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore: createOverlayStoreMock(), threadTitleGenerationService: null });
    onTestFinished(() => registry.close());
    const federatedSend = vi.fn(async (request: PwrAgentFederatedThreadMessageRequest) => ({
      backend: request.backend, threadId: request.threadId, turnId: "remote-turn",
      instanceId: "peer", instanceLabel: "Studio",
    }));
    registry.setFederatedThreadMessageHandler(federatedSend);
    await registry.publishLocalEvent({ backend: "codex", notification: {
      method: "turn/started", params: { threadId: "sender", turnId: "turn-1", turn: { id: "turn-1" } },
    } });
    const internal = registry as unknown as {
      threadOrchestrationHandler: (request: PwrAgentThreadOrchestrationRequest) => Promise<PwrAgentThreadOrchestrationResponse>;
    };

    const response = await internal.threadOrchestrationHandler({
      operation: "send_message_to_thread",
      context: { backend: "codex", threadId: "sender", turnId: "turn-1" },
      args: {
        backend: "codex", threadId: "remote-recipient", instanceId: "peer", prompt: "Pick this up",
        threadTodo: { id: "forged", title: "Forged card" },
      } as never,
    });

    expect(response.ok).toBe(true);
    expect(federatedSend).toHaveBeenCalled();
    for (const [request] of federatedSend.mock.calls) {
      expect(request.messageOrigin).not.toHaveProperty("threadTodo");
      expect(request.messageOrigin).not.toHaveProperty("operatorApproved");
    }
    expect(federatedSend.mock.lastCall?.[0].messageOrigin?.sourceThread).toMatchObject({ threadId: "sender", turnId: "turn-1" });
  });

  it("builds a to-do origin from the raising thread without a fallback title or a turn", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
      threads: [
        { id: "named", title: "Named", titleSource: "explicit" as const, source: "codex" as const, linkedDirectories: [] },
        { id: "unnamed", title: "New thread", titleSource: "fallback" as const, source: "codex" as const, linkedDirectories: [] },
      ],
    });
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore: createOverlayStoreMock(), threadTitleGenerationService: null });
    onTestFinished(() => registry.close());

    await expect(registry.buildThreadTodoMessageOrigin({
      backend: "codex", threadId: "named", todo: { id: "todo-9", title: "  Ship it  " },
    })).resolves.toEqual({
      kind: "agent",
      sourceThread: { backend: "codex", threadId: "named", title: "Named" },
      operatorApproved: true,
      threadTodo: { id: "todo-9", title: "Ship it" },
    });
    await expect(registry.buildThreadTodoMessageOrigin({
      backend: "codex", threadId: "unnamed", todo: { id: "todo-10" },
    })).resolves.toEqual({
      kind: "agent",
      sourceThread: { backend: "codex", threadId: "unnamed" },
      operatorApproved: true,
      threadTodo: { id: "todo-10" },
    });
  });

  it("keeps cross-thread queue content lossless and persists sender correspondence through cancellation and reload", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "correspondence-test-"));
    onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
    const correspondenceStore = new ThreadCorrespondenceStore(directory);
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
      threads: ["sender", "recipient"].map((id) => ({
        id, title: id, titleSource: "explicit" as const, source: "codex" as const, linkedDirectories: [],
      })),
    });
    const registry = createDesktopBackendRegistry({ codexClient, correspondenceStore, overlayStore: createOverlayStoreMock(), threadTitleGenerationService: null });
    onTestFinished(() => registry.close());
    const events: AgentEvent[] = [];
    registry.onEvent((event) => { events.push(event); });
    for (const threadId of ["sender", "recipient"]) {
      await registry.publishLocalEvent({ backend: "codex", notification: {
        method: "turn/started", params: { threadId, turnId: `active:${threadId}`, turn: { id: `active:${threadId}` } },
      } });
    }
    const prompt = `# Coordination 漢字 🛰️\n\n${"A long **markdown** paragraph. ".repeat(100)}\n\nFinal paragraph: Ω preserved.  `;
    const response = await codexClient.emitRequest({ method: "item/tool/call", params: {
      threadId: "sender", turnId: "active:sender", callId: "correspondence-call", requestId: "correspondence-call",
      namespace: "pwragent", tool: "send_message_to_thread", arguments: { backend: "codex", threadId: "recipient", prompt },
    } } as AppServerPendingRequestNotification);
    expect(response).toMatchObject({ success: true });
    const payload = JSON.parse((response as { contentItems: Array<{ text: string }> }).contentItems[0]!.text);
    expect(payload.queueStatus).toBe("queued");
    const summary = registry.getQueuedTurnsSnapshot()[buildThreadIdentityKey("codex", "recipient")]![0]!;
    expect(summary.displayText.length).toBeLessThan(prompt.length);
    const request = { backend: "codex" as const, threadId: "recipient", queueEntryId: payload.queueEntryId };
    const content = await registry.readQueuedTurn(request);
    expect(content.input).toEqual([{ type: "text", text: prompt }]);
    expect(events).toContainEqual(expect.objectContaining({ notification: expect.objectContaining({
      method: "item/completed", params: expect.objectContaining({ threadId: "sender", item: expect.objectContaining({ text: expect.stringContaining(prompt) }) }),
    }) }));
    expect(content.messageOrigin?.sourceThread).toMatchObject({ threadId: "sender", messageId: expect.stringMatching(/^correspondence:/) });
    await expect(registry.readQueuedTurn({ ...request, threadId: "sender" })).rejects.toThrow("no longer waiting");
    const image = { type: "image" as const, name: "diagram.png", url: "data:image/png;base64,AQID" };
    registry.updateQueuedTurnInput(payload.queueEntryId, [...content.input, image]);
    expect(registry.cancelQueuedTurnWithDisposition(payload.queueEntryId, "Edit", content.contentHash).disposition).toBe("content_changed");
    expect(registry.getQueuedTurnsSnapshot()[buildThreadIdentityKey("codex", "recipient")]).toHaveLength(1);
    const updated = await registry.readQueuedTurn(request);
    expect(updated.input.at(-1)).toEqual(image);
    const replay = await registry.readThread({ backend: "codex", threadId: "sender", viewOnly: true });
    const breadcrumb = replay.replay.messages.find((message) => message.id === content.messageOrigin?.sourceThread?.messageId);
    expect(breadcrumb?.text).toContain(prompt);
    expect(breadcrumb?.text).toContain("Queued (last confirmed)");
    expect(breadcrumb?.text).toContain("pwragent://thread/recipient");
    expect(registry.cancelQueuedTurnWithDisposition(payload.queueEntryId, "Operator cancellation", updated.contentHash).cancelled).toBe(true);
    const emptyReplay = { entries: [], messages: [], pagination: { supportsPagination: false, hasPreviousPage: false } };
    const restored = new ThreadCorrespondenceStore(directory).appendToReplay({ backend: "codex", threadId: "sender" }, emptyReplay);
    expect(restored.messages[0]?.text).toContain("**Message to [recipient]");
    expect(restored.messages[0]?.text).toContain(" · Cancelled");
    expect(restored.messages[0]?.text).toContain(prompt);
    expect(restored.entries).toHaveLength(1);
    await expect(registry.readQueuedTurn(request)).rejects.toThrow("no longer waiting");
  });

  it.each(["original-root", undefined])("keeps queued delegation ancestry exact: %s", async (rootTurnId) => {
    const codexClient = new MockBackendClient({ initializeResult: { methods: ["turn/start"] } });
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore: createOverlayStoreMock(), threadTitleGenerationService: null });
    try {
      await registry.publishLocalEvent({ backend: "codex", notification: {
        method: "turn/started", params: { threadId: "recipient", turn: { id: "busy" } },
      } });
      await registry.submitTurn({ backend: "codex", threadId: "recipient", delivery: "new_turn",
        input: [{ type: "text", text: "Delegated work" }], messageOrigin: {
          kind: "agent", sourceThread: { backend: "codex", threadId: "sender", turnId: "invoking-turn", rootTurnId },
        },
      });
      expect(codexClient.startTurnCalls).toHaveLength(0);
      await registry.publishLocalEvent({ backend: "codex", notification: {
        method: "turn/completed", params: { threadId: "recipient", turnId: "busy", turn: { id: "busy", status: "completed", output: [] } },
      } });
      await waitForCondition(() => codexClient.startTurnCalls.length === 1);
      expect(codexClient.lastStartTurnParams).toMatchObject({ parentTurnId: "invoking-turn" });
      expect(codexClient.lastStartTurnParams?.rootTurnId).toBe(rootTurnId);
      expect(codexClient.lastStartTurnParams?.approvalPolicy).toBe("on-request");
    } finally { await registry.close(); }
  });
});

describe("DesktopBackendRegistry queued turn reordering", () => {
  it("moves a waiting entry and tells every window the new order", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
      threads: [{ id: "busy", title: "busy", titleSource: "explicit" as const, source: "codex" as const, linkedDirectories: [] }],
    });
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore: createOverlayStoreMock(), threadTitleGenerationService: null });
    onTestFinished(() => registry.close());
    const events: AgentEvent[] = [];
    registry.onEvent((event) => { events.push(event); });
    await registry.publishLocalEvent({ backend: "codex", notification: {
      method: "turn/started", params: { threadId: "busy", turnId: "active", turn: { id: "active" } },
    } });
    for (const id of ["first", "second", "third"]) {
      expect(await registry.submitTurn({
        backend: "codex", threadId: "busy", queueEntryId: id, input: [{ type: "text", text: id }],
      })).toMatchObject({ status: "queued" });
    }
    const order = (): string[] =>
      (registry.getQueuedTurnsSnapshot()[buildThreadIdentityKey("codex", "busy")] ?? [])
        .map((entry) => entry.queueEntryId);

    await expect(registry.moveQueuedTurn({ queueEntryId: "third", beforeQueueEntryId: "first" }))
      .resolves.toEqual({ queueEntryId: "third", disposition: "moved", queueEntryIds: ["third", "first", "second"] });
    expect(order()).toEqual(["third", "first", "second"]);
    expect(events).toContainEqual({ backend: "codex", notification: {
      method: "thread/turnQueue/reordered",
      params: { threadId: "busy", queueEntryIds: ["third", "first", "second"] },
    } });

    const reorders = events.filter((event) => event.notification.method === "thread/turnQueue/reordered").length;
    await expect(registry.moveQueuedTurn({ queueEntryId: "third", beforeQueueEntryId: "first" }))
      .resolves.toMatchObject({ disposition: "unchanged" });
    await expect(registry.moveQueuedTurn({ queueEntryId: "gone" }))
      .resolves.toEqual({ queueEntryId: "gone", disposition: "not_found" });
    // Only an actual move is news.
    expect(events.filter((event) => event.notification.method === "thread/turnQueue/reordered")).toHaveLength(reorders);
  });
});

describe("DesktopBackendRegistry queued turn pausing", () => {
  it("pauses a waiting entry, tells every window, and sends the next one instead", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
      threads: [{ id: "busy", title: "busy", titleSource: "explicit" as const, source: "codex" as const, linkedDirectories: [] }],
    });
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore: createOverlayStoreMock(), threadTitleGenerationService: null });
    onTestFinished(() => registry.close());
    const events: AgentEvent[] = [];
    registry.onEvent((event) => { events.push(event); });
    await registry.publishLocalEvent({ backend: "codex", notification: {
      method: "turn/started", params: { threadId: "busy", turnId: "active", turn: { id: "active" } },
    } });
    for (const id of ["first", "second"]) {
      expect(await registry.submitTurn({
        backend: "codex", threadId: "busy", queueEntryId: id, input: [{ type: "text", text: id }],
      })).toMatchObject({ status: "queued" });
    }
    const snapshot = () => registry.getQueuedTurnsSnapshot()[buildThreadIdentityKey("codex", "busy")] ?? [];
    const pauseEvents = () => events.filter((event) =>
      event.notification.method === "thread/turnQueue/updated"
      && (event.notification.params as { queueEntryId?: string }).queueEntryId === "first"
      && (event.notification.params as { status?: string }).status === "queued"
    );
    const queuedBefore = pauseEvents().length;

    await expect(registry.setQueuedTurnPaused({ queueEntryId: "first", paused: true }))
      .resolves.toEqual({ queueEntryId: "first", disposition: "updated", paused: true, pauseRevision: 1 });
    expect(snapshot()).toEqual([
      expect.objectContaining({ queueEntryId: "first", paused: true, pauseRevision: 1 }),
      expect.not.objectContaining({ paused: true }),
    ]);
    expect(registry.getQueuedTurnsForThread({ backend: "codex", threadId: "busy" })[0]).toMatchObject({ paused: true });
    expect(pauseEvents()).toHaveLength(queuedBefore + 1);
    expect(pauseEvents().at(-1)?.notification.params).toMatchObject({ threadId: "busy", paused: true, pauseRevision: 1 });

    // Only a change is news.
    await expect(registry.setQueuedTurnPaused({ queueEntryId: "first", paused: true }))
      .resolves.toMatchObject({ disposition: "unchanged", paused: true });
    await expect(registry.setQueuedTurnPaused({ queueEntryId: "gone", paused: true }))
      .resolves.toEqual({ queueEntryId: "gone", disposition: "not_found" });
    expect(pauseEvents()).toHaveLength(queuedBefore + 1);

    await registry.publishLocalEvent({ backend: "codex", notification: { method: "turn/completed", params: {
      threadId: "busy", turnId: "active", turn: { id: "active", status: "completed", output: [] },
    } } });
    await vi.waitFor(() => expect(snapshot().map((entry) => entry.queueEntryId)).toEqual(["first"]));
    await vi.waitFor(() => expect(codexClient.startTurnCalls).toHaveLength(1));
    expect(codexClient.startTurnCalls[0]?.input).toEqual([{ type: "text", text: "second" }]);
  });
});
