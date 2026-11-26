import {
  createAgentOverlay,
  nonRepositoryCwd,
  git,
  createOverlayStoreMock,
  TEST_TASK_MONITOR_MODELS,
  MockBackendClient,
  callRegistryMcpTool,
  discoverCodexBackendForTest,
} from "./helpers/backend-registry-fixture";
import { createDesktopBackendRegistry } from "../app-server/backend-registry-wiring";
import fc from "fast-check";
import { threadLockRefusalMessage } from "@pwragent/shared/thread-lock";
import {
  DEFAULT_PROJECT_FORGE_AUTOMATION,
  type ProjectForgeAutomation,
} from "@pwragent/shared/project-forge-automation";
import { getProjectForgeAutomationIndex, resetProjectForgeAutomationIndexForTests } from "../app-server/project-forge-automation-index";
import {
  mkdir,
  mkdtemp,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import type {
  AppServerPendingRequestNotification,
  AppServerThreadSummary,
} from "@pwragent/shared/contracts/normalized-app-server";
import type { AttachThreadPullRequestToolArgs } from "@pwragent/shared/contracts/thread-tools";
import type { PrSummary } from "@pwragent/shared/contracts/navigation";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import { StateDb } from "../state/state-db";
import { ProjectHeldWakeupStore } from "../state/project-held-wakeup-store";
import { TaskMonitorWakeStore } from "@pwragent/sqlite-storage/task-monitor-wake-store";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";
import type { ThreadSearchService } from "../thread-search/thread-search-service";

describe("DesktopBackendRegistry", () => {
  describe("project Forge Automation", () => {
    const PROJECT = "directory:/Users/fixture/src/openclaw";
    const paused: ProjectForgeAutomation = { ...DEFAULT_PROJECT_FORGE_AUTOMATION, paused: true, pausedAt: 1_000 };
    const pauseProject = (
      automation: ProjectForgeAutomation = paused,
      projectPath = "/Users/fixture/src/openclaw",
    ): void => {
      onTestFinished(() => resetProjectForgeAutomationIndexForTests());
      const index = getProjectForgeAutomationIndex();
      const key = `directory:${projectPath}`;
      index.set(key, automation);
      index.rememberDirectories([{
        key,
        kind: "directory",
        label: "openclaw",
        path: projectPath,
        threadKeys: ["codex:parked"],
        needsAttentionCount: 0,
      }]);
    };
    const wake = (project = getProjectForgeAutomationIndex().resolveThread({ backend: "codex", threadId: "parked" })!) => ({
      project,
      queueEntryId: "task-monitor:nightly",
      backend: "codex" as const,
      threadId: "parked",
      input: [{ type: "text" as const, text: "Monitor finished" }],
      origin: "manual" as const,
      source: "monitor" as const,
      summary: "Monitor finished: \"Watch the nightly run\"",
    });

    it("refuses an agent's message into a paused project, never the operator's or a messaging app's", async () => {
      pauseProject();
      const registry = createDesktopBackendRegistry({ codexClient: new MockBackendClient({}), overlayStore: createOverlayStoreMock() });
      onTestFinished(() => registry.close());
      const target = { backend: "codex" as const, threadId: "parked" };

      expect(() => registry.assertProjectAcceptsThreadMessage({
        ...target,
        messageOrigin: { kind: "agent", sourceThread: { backend: "codex", threadId: "orchestrator" } },
      })).toThrow(/openclaw, where forge activity is paused/);
      expect(() => registry.assertProjectAcceptsThreadMessage({ ...target, messageOrigin: { kind: "messaging" } }))
        .not.toThrow();
      // A to-do card's send is the operator's, even routed as an agent message.
      expect(() => registry.assertProjectAcceptsThreadMessage({
        ...target,
        messageOrigin: { kind: "agent", operatorApproved: true, sourceThread: { backend: "codex", threadId: "orchestrator" } },
      })).not.toThrow();
      expect(() => registry.assertProjectAcceptsThreadMessage(target)).not.toThrow();
      expect(registry.projectPausedThreadMessageRefusal({ backend: "codex", threadId: "elsewhere" })).toBeUndefined();
      for (const signal of [undefined, new AbortController().signal]) {
        await expect(registry.requestStackLayerWork({ backend: "codex", threadId: "orchestrator" },
          target, "Resolve local edits", "fixture-stack", signal)).rejects.toThrow(/openclaw, where forge activity is paused/);
      }

      await expect(registry.controlActiveTurn({
        ...target,
        operation: "steer",
        requestId: "steer-1",
        input: [{ type: "text", text: "Rebase now" }],
        messageOrigin: { kind: "agent", sourceThread: { backend: "codex", threadId: "orchestrator" } },
      })).resolves.toMatchObject({ ok: false, error: { code: "project_paused" } });
    });

    it("lets messages through when the paused project does not refuse them", () => {
      pauseProject({ ...paused, refuseThreadMessages: false });
      const registry = createDesktopBackendRegistry({ codexClient: new MockBackendClient({}), overlayStore: createOverlayStoreMock() });
      onTestFinished(() => registry.close());
      expect(registry.projectPausedThreadMessageRefusal({ backend: "codex", threadId: "parked" })).toBeUndefined();
    });

    it("withdraws only stack settlement input when its operation is cancelled", async () => {
      const owner = { backend: "codex" as const, threadId: "layer" };
      const actor = { backend: "codex" as const, threadId: "lead" };
      const registry = createDesktopBackendRegistry({ codexClient: new MockBackendClient({ threads: [{
        id: owner.threadId, title: "Layer", source: "codex", titleSource: "explicit", linkedDirectories: [],
      }] }), overlayStore: createOverlayStoreMock() });
      const release = registry.holdStackThread(owner, "fixture-hold");
      onTestFinished(async () => { await registry.close(); release(); });
      const unrelated = await registry.submitTurn({ ...owner, delivery: "new_turn", input: [{ type: "text", text: "Independent work" }] });
      expect(unrelated.status).toBe("queued");
      const abort = new AbortController();
      const pending = registry.requestStackLayerWork(actor, owner, "Settle overlapping edits", "fixture-stack", abort.signal);
      const observed = pending.catch((error: unknown) => error);
      await vi.waitFor(() => expect(registry.getQueuedTurnsForThread(owner)).toHaveLength(2));
      abort.abort(new Error("Fixture operation cancelled"));
      expect(await observed).toMatchObject({ message: "Fixture operation cancelled" });
      expect(registry.getQueuedTurnsForThread(owner).map(({ queueEntryId }) => queueEntryId)).toEqual([unrelated.entry.id]);
    });

    it("holds a wake-up without blocking the operator, lists it, and sends it on request", async () => {
      pauseProject();
      const codexClient = new MockBackendClient({});
      const registry = createDesktopBackendRegistry({ codexClient, overlayStore: createOverlayStoreMock() });
      onTestFinished(() => registry.close());

      await expect(registry.deliverProjectPausedWakeup(wake())).resolves.toMatchObject({
        status: "queued",
        entry: { id: "task-monitor:nightly", paused: true },
      });
      expect(registry.listProjectHeldWakeups(PROJECT)).toEqual([expect.objectContaining({
        entryId: "task-monitor:nightly",
        backend: "codex",
        threadId: "parked",
        source: "monitor",
        summary: "Monitor finished: \"Watch the nightly run\"",
      })]);
      expect(registry.getQueuedTurnsForThread({ backend: "codex", threadId: "parked" })[0])
        .toMatchObject({ paused: true, holdReason: expect.stringContaining("openclaw is paused") });
      expect(codexClient.startTurnCallCount).toBe(0);

      await expect(registry.resolveProjectHeldWakeups({
        directoryKey: PROJECT,
        resolutions: [
          { entryId: "task-monitor:nightly", backend: "codex", threadId: "parked", action: "send" },
          { entryId: "missing", backend: "codex", threadId: "parked", action: "discard" },
        ],
      })).resolves.toEqual({ results: [
        { entryId: "task-monitor:nightly", status: "sent" },
        { entryId: "missing", status: "not_found" },
      ] });
      await vi.waitFor(() => expect(codexClient.startTurnCallCount).toBe(1));
      expect(registry.listProjectHeldWakeups(PROJECT)).toEqual([]);
    });

    it("starts the operator's own message past a held wake-up, and discards the wake on request", async () => {
      pauseProject();
      const codexClient = new MockBackendClient({});
      const registry = createDesktopBackendRegistry({ codexClient, overlayStore: createOverlayStoreMock() });
      onTestFinished(() => registry.close());
      await registry.deliverProjectPausedWakeup(wake());

      await expect(registry.submitTurn({
        backend: "codex",
        threadId: "parked",
        input: [{ type: "text", text: "Operator reply" }],
      })).resolves.toMatchObject({ status: "started" });

      await expect(registry.resolveProjectHeldWakeups({
        directoryKey: PROJECT,
        resolutions: [{ entryId: "task-monitor:nightly", backend: "codex", threadId: "parked", action: "discard" }],
      })).resolves.toEqual({ results: [{ entryId: "task-monitor:nightly", status: "discarded" }] });
      expect(registry.listProjectHeldWakeups(PROJECT)).toEqual([]);
      expect(codexClient.startTurnCallCount).toBe(1);
    });

    it("discards a wake-up by policy and leaves a note in the thread", async () => {
      pauseProject({ ...paused, wakeupPolicy: "discard" });
      const codexClient = new MockBackendClient({});
      const registry = createDesktopBackendRegistry({ codexClient, overlayStore: createOverlayStoreMock() });
      onTestFinished(() => registry.close());

      await expect(registry.deliverProjectPausedWakeup(wake())).resolves.toEqual({ status: "discarded" });

      expect(registry.getQueuedTurnsForThread({ backend: "codex", threadId: "parked" })).toEqual([]);
      expect(codexClient.startTurnCallCount).toBe(0);
      expect(JSON.stringify(codexClient.injectedThreadItems)).toContain(
        "because forge activity in openclaw is paused",
      );
    });

    it("refuses an agent's steer_thread into the paused project and still lets it stop the turn", async () => {
      pauseProject();
      const codexClient = new MockBackendClient({
        interruptEndsTurn: true,
        initializeResult: { methods: ["thread/resume", "turn/interrupt", "turn/steer"] },
        threads: [{
          id: "parked",
          title: "parked",
          titleSource: "fallback",
          source: "codex",
          linkedDirectories: [],
        }],
      });
      const registry = createDesktopBackendRegistry({
        codexClient,
        overlayStore: createOverlayStoreMock(),
        threadTitleGenerationService: null,
      });
      onTestFinished(() => registry.close());
      await discoverCodexBackendForTest(registry);
      for (const [threadId, turnId] of [["parked", "parked-turn"], ["orchestrator", "orchestrator-turn"]] as const) {
        await registry.publishLocalEvent({
          backend: "codex",
          notification: { method: "turn/started", params: { threadId, turnId, turn: { id: turnId } } },
        });
      }
      const callFromOrchestrator = async (tool: "steer_thread" | "stop_thread", args: Record<string, unknown>) =>
        await callRegistryMcpTool({
          registry,
          backend: "codex",
          threadId: "orchestrator",
          turnId: "orchestrator-turn",
          tool,
          args: { backend: "codex", threadId: "parked", ...args },
        });

      await expect(callFromOrchestrator("steer_thread", {
        requestId: "steer-paused",
        expectedTurnId: "parked-turn",
        prompt: "Rebase onto main now.",
      })).resolves.toMatchObject({
        isError: true,
        structuredContent: {
          code: "project_paused",
          message: expect.stringContaining("openclaw, where forge activity is paused"),
        },
      });
      expect(codexClient.lastSteerTurnParams).toBeUndefined();
      expect(codexClient.startTurnCallCount).toBe(0);

      // Stopping starts nothing, so the pause allows it.
      await expect(callFromOrchestrator("stop_thread", { requestId: "stop-paused", expectedTurnId: "parked-turn" })).resolves.toMatchObject({
        structuredContent: { threadId: "parked", turnId: "parked-turn", disposition: "interrupted" },
      });
      expect(codexClient.interruptTurnCallCount).toBe(1);

      // A steer into the now idle thread would start a turn; it is refused too.
      await expect(callFromOrchestrator("steer_thread", {
        requestId: "steer-idle-paused",
        prompt: "Rebase onto main now.",
      })).resolves.toMatchObject({ isError: true, structuredContent: { code: "project_paused" } });
      expect(codexClient.startTurnCallCount).toBe(0);
    });

    it("refuses a handoff into the paused project from another thread, and allows one from inside it", async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-paused-handoff-"));
      onTestFinished(() => rm(root, { recursive: true, force: true }));
      const packagePath = path.join(root, "packages", "core");
      await mkdir(packagePath, { recursive: true });
      pauseProject(paused, root);
      const codexClient = new MockBackendClient({
        initializeResult: { methods: ["thread/start", "thread/list", "turn/start"] },
      });
      const registry = createDesktopBackendRegistry({
        codexClient,
        // Full access, so the allowed handoff does not wait on an approval for the new path.
        overlayStore: createOverlayStoreMock({
          overlays: {
            "codex:parked": { backend: "codex", threadId: "parked", executionMode: "full-access", extraLinkedDirectories: [] },
          },
        }),
        threadTitleGenerationService: null,
      });
      onTestFinished(() => registry.close());
      for (const threadId of ["orchestrator", "parked"]) {
        await registry.publishLocalEvent({
          backend: "codex",
          notification: {
            method: "turn/started",
            params: { threadId, turnId: `${threadId}-turn`, turn: { id: `${threadId}-turn` } },
          },
        });
      }
      const handoffFrom = async (threadId: string) => await callRegistryMcpTool({
        registry,
        backend: "codex",
        threadId,
        turnId: `${threadId}-turn`,
        tool: "handoff_task",
        // A folder inside the project counts as the project.
        args: { task: "Rebase the release branch.", title: "Rebase", workspaceMode: "project_local", cwd: packagePath },
      });

      await expect(handoffFrom("orchestrator")).resolves.toMatchObject({
        isError: true,
        structuredContent: {
          code: "project_paused",
          message: expect.stringContaining("openclaw, where forge activity is paused"),
        },
      });
      expect(codexClient.lastStartThreadParams).toBeUndefined();

      // A thread already in the project is the work the operator is driving.
      const inside = await handoffFrom("parked");
      expect(inside).toMatchObject({ structuredContent: { groupedUnderThreadId: "parked" } });
      expect(codexClient.lastStartThreadParams?.cwd).toBe(packagePath);
    });

    describe("a monitor finishing into a paused parent", () => {
      const runMonitor = async (options: { lockParent?: boolean } = {}) => {
        const codexClient = new MockBackendClient({
          initializeResult: { methods: ["turn/start"] },
          models: TEST_TASK_MONITOR_MODELS,
          startThreadResult: { threadId: "monitor-thread" },
        });
        const registry = createDesktopBackendRegistry({ codexClient, overlayStore: createOverlayStoreMock() });
        onTestFinished(() => registry.close());
        const turnEvent = async (method: "turn/started" | "turn/completed") =>
          await registry.publishLocalEvent({
            backend: "codex",
            notification: {
              method,
              params: {
                threadId: "parked",
                turnId: "parent-turn",
                turn: method === "turn/started"
                  ? { id: "parent-turn" }
                  : { id: "parent-turn", status: "completed", output: [] },
              },
            },
          } as AgentEvent);
        const toolCall = async (threadId: string, tool: string, args: Record<string, unknown>) => {
          const response = await codexClient.emitRequest({
            method: "item/tool/call",
            params: {
              threadId,
              turnId: threadId === "parked" ? "parent-turn" : "turn-1",
              callId: `call-${tool}`,
              requestId: `call-${tool}`,
              namespace: "pwragent_task_monitors",
              tool,
              arguments: args,
            },
          } as AppServerPendingRequestNotification);
          return {
            response,
            payload: JSON.parse(
              (response as { contentItems: Array<{ text: string }> }).contentItems[0]?.text ?? "{}",
            ) as Record<string, unknown>,
          };
        };
        await turnEvent("turn/started");
        const { payload: created } = await toolCall("parked", "create_monitor_delegation", { task: "Watch the nightly run" });
        await turnEvent("turn/completed");
        const lock = options.lockParent
          ? (await registry.setThreadLock({
              backend: "codex",
              threadId: "parked",
              locked: true,
              note: "Worktree handed to the repair thread.",
            }, { source: "operator" })).lock
          : undefined;
        const { response, payload: completed } = await toolCall("monitor-thread", "complete_monitoring", {
          monitorId: created.monitorId,
          outcome: "success",
          summary: "The nightly run finished.",
        });
        expect(response).toMatchObject({ success: true });
        return { codexClient, registry, monitorId: created.monitorId as string, completed, lock };
      };

      it("holds the result as a project-held wake-up under the hold policy", async () => {
        pauseProject();
        const { codexClient, registry, monitorId, completed } = await runMonitor();

        expect(completed).toMatchObject({ parentTurn: { status: "queued" } });
        expect(registry.listProjectHeldWakeups(PROJECT)).toEqual([expect.objectContaining({
          entryId: `task-monitor:wake:${monitorId}`,
          threadId: "parked",
          source: "monitor",
          summary: "Monitor finished: \"Watch the nightly run\"",
        })]);
        // Only the monitor's own turn has started.
        expect(codexClient.startTurnCallCount).toBe(1);
      });

      it("drops the result and leaves a note under the discard policy", async () => {
        pauseProject({ ...paused, wakeupPolicy: "discard" });
        const { codexClient, registry, completed } = await runMonitor();

        expect(completed).not.toHaveProperty("parentTurn");
        expect(registry.getQueuedTurnsForThread({ backend: "codex", threadId: "parked" })).toEqual([]);
        expect(codexClient.startTurnCallCount).toBe(1);
        expect(JSON.stringify(codexClient.injectedThreadItems)).toContain(
          "because forge activity in openclaw is paused",
        );
      });

      it("lets the parent's Lock hold the result, and delivers it on unlock", async () => {
        pauseProject({ ...paused, wakeupPolicy: "discard" });
        const { codexClient, registry, completed, lock } = await runMonitor({ lockParent: true });

        expect(completed).toMatchObject({ parentTurn: { status: "queued", position: 1 } });
        expect(registry.getQueuedTurnsForThread({ backend: "codex", threadId: "parked" })).toEqual([
          expect.objectContaining({ holdReason: threadLockRefusalMessage(lock!) }),
        ]);
        expect(registry.listProjectHeldWakeups(PROJECT)).toEqual([]);
        expect(codexClient.startTurnCallCount).toBe(1);

        await registry.setThreadLock({ backend: "codex", threadId: "parked", locked: false }, { source: "operator" });
        await expect.poll(() => codexClient.startTurnCallCount).toBe(2);
        expect(codexClient.lastStartTurnParams).toMatchObject({
          threadId: "parked",
          input: [{ type: "text", text: expect.stringContaining("The nightly run finished.") }],
        });
      });
    });

    describe("across a restart", () => {
      // The monitor and the dependency are consumed when the wake is held,
      // so the durable row is the only copy a restart can bring back.
      const durableStore = () => {
        vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
        const temp = createTempStateDb("pwragent-project-held-wakeups-");
        const db = StateDb.open(temp.dbPath);
        onTestFinished(() => {
          db.close();
          removeTempStateDbDir(temp.tempDir);
          vi.unstubAllEnvs();
        });
        const rows = () => db.raw.prepare(
          "SELECT entry_id, owner_instance_id FROM project_held_wakeups",
        ).all() as { entry_id: string; owner_instance_id: string }[];
        return { db, rows, store: new ProjectHeldWakeupStore(db.raw, { processId: 4_242, processAlive: () => false }) };
      };
      const launch = (store: ProjectHeldWakeupStore, instanceId: string, live: string[] = [], taskMonitorWakeStore?: TaskMonitorWakeStore) => {
        const codexClient = new MockBackendClient({});
        const registry = createDesktopBackendRegistry({
          codexClient,
          overlayStore: createOverlayStoreMock(),
          projectHeldWakeupStore: store,
          taskMonitorWakeStore,
          runtimeInstanceId: instanceId,
          resolveLiveProfileRuntimeInstanceIds: () => live,
        });
        onTestFinished(() => registry.close());
        return { codexClient, registry };
      };
      const resolve = (registry: DesktopBackendRegistry, action: "send" | "discard") =>
        registry.resolveProjectHeldWakeups({
          directoryKey: PROJECT,
          resolutions: [{ entryId: "task-monitor:nightly", backend: "codex", threadId: "parked", action }],
        });

      it.each([false, true])("retires a tripped monitor's restored hold without sending it (rearm %s)", async (rearm) => {
        pauseProject();
        const { db, rows, store } = durableStore();
        const guard = new TaskMonitorWakeStore(db.raw);
        const parent = { backend: "codex", threadId: "parked" } as const;
        const first = launch(store, "instance-a", [], guard);
        expect(guard.reserve({ ...parent, monitorId: "nightly" }, 0)).toBe("admitted");
        await first.registry.deliverProjectPausedWakeup({ ...wake(), messageOrigin: {
          kind: "sub-agent", subAgent: { kind: "monitor", monitorId: "nightly", task: "Watch release", outcome: "success", summary: "Finished" },
        } });
        for (const monitorId of ["other-1", "other-2"]) {
          expect(guard.reserve({ ...parent, monitorId }, 0)).toBe("admitted");
        }
        expect(guard.reserve({ ...parent, monitorId: "overflow" }, 0)).toBe("review");
        const review = guard.claimReview(parent);
        if (typeof review === "string") throw new Error(`Expected a claimed review, received ${review}`);
        expect(guard.settleReview(parent, review, "loop")).toBe(true);
        await first.registry.close();

        const second = launch(store, "instance-b", ["instance-b"], guard);
        expect(second.registry.listProjectHeldWakeups(PROJECT)).toHaveLength(1);
        if (rearm) {
          expect(second.registry.rearmTaskMonitorWakes(parent)).toBe(true);
          await expect(resolve(second.registry, "send")).resolves.toMatchObject({ results: [{ status: "not_found" }] });
        } else {
          await expect(resolve(second.registry, "send")).resolves.toMatchObject({ results: [{
            status: "suppressed", error: expect.stringContaining("Job Monitor wake suppressed"),
          }] });
        }
        await vi.waitFor(() => expect(rows()).toEqual([]));
        expect(second.codexClient.startTurnCallCount).toBe(0);
      });

      it("holds the wake-up again after a restart, and Send starts it and drops the durable copy", async () => {
        pauseProject();
        const { rows, store } = durableStore();
        const { writes } = await measureSqliteWrites(async () => {
          const first = launch(store, "instance-a");
          await first.registry.deliverProjectPausedWakeup(wake());
          expect(rows()).toEqual([{ entry_id: "task-monitor:nightly", owner_instance_id: "instance-a" }]);
          await first.registry.close();

          const second = launch(store, "instance-b", ["instance-b"]);
          expect(rows()).toEqual([{ entry_id: "task-monitor:nightly", owner_instance_id: "instance-b" }]);
          expect(second.registry.listProjectHeldWakeups(PROJECT)).toEqual([expect.objectContaining({
            entryId: "task-monitor:nightly",
            backend: "codex",
            threadId: "parked",
            source: "monitor",
            summary: "Monitor finished: \"Watch the nightly run\"",
          })]);
          expect(second.registry.getQueuedTurnsForThread({ backend: "codex", threadId: "parked" })[0])
            .toMatchObject({ paused: true, holdReason: expect.stringContaining("openclaw is paused") });
          expect(second.codexClient.startTurnCallCount).toBe(0);

          await expect(resolve(second.registry, "send")).resolves.toEqual({ results: [
            { entryId: "task-monitor:nightly", status: "sent" },
          ] });
          await vi.waitFor(() => expect(second.codexClient.startTurnCallCount).toBe(1));
          expect(JSON.stringify(second.codexClient.startTurnCalls[0])).toContain("Monitor finished");
          await vi.waitFor(() => expect(rows()).toEqual([]));
          expect(second.registry.listProjectHeldWakeups(PROJECT)).toEqual([]);
        });
        expectSqliteWriteBudget({
          scenario: "project-held-wakeup-restart-send",
          note: "one held wake-up through a restart and Send: one hold insert, one startup claim, one delete when its turn starts. ~20 KB per cycle; holds are rare, so even 20 cycles/day is ~0.4 MB/day. Idle and per-turn writes are 0.",
          writes,
        });
      });

      it("discards a restored wake-up and removes its durable copy", async () => {
        pauseProject();
        const { rows, store } = durableStore();
        const { writes } = await measureSqliteWrites(async () => {
          const first = launch(store, "instance-a");
          await first.registry.deliverProjectPausedWakeup(wake());
          await first.registry.close();

          const second = launch(store, "instance-b", ["instance-b"]);
          expect(second.registry.listProjectHeldWakeups(PROJECT)).toHaveLength(1);
          await expect(resolve(second.registry, "discard")).resolves.toEqual({ results: [
            { entryId: "task-monitor:nightly", status: "discarded" },
          ] });
          expect(rows()).toEqual([]);
          expect(second.registry.listProjectHeldWakeups(PROJECT)).toEqual([]);
          expect(second.codexClient.startTurnCallCount).toBe(0);
        });
        expectSqliteWriteBudget({
          scenario: "project-held-wakeup-restart-discard",
          note: "one held wake-up through a restart and Discard: one hold insert, one startup claim, one delete. ~20 KB per cycle; holds are rare, so even 20 cycles/day is ~0.4 MB/day. Idle and per-turn writes are 0.",
          writes,
        });

        // Nothing is left for a later launch to hold.
        const third = launch(store, "instance-c", ["instance-c"]);
        expect(third.registry.listProjectHeldWakeups(PROJECT)).toEqual([]);
      });

      it("leaves a live sibling instance's held wake-up with that instance", async () => {
        pauseProject();
        const { rows, store } = durableStore();
        const first = launch(store, "instance-a");
        await first.registry.deliverProjectPausedWakeup(wake());

        const sibling = launch(store, "instance-b", ["instance-a", "instance-b"]);
        expect(sibling.registry.listProjectHeldWakeups(PROJECT)).toEqual([]);
        expect(rows()).toEqual([{ entry_id: "task-monitor:nightly", owner_instance_id: "instance-a" }]);
        expect(first.registry.listProjectHeldWakeups(PROJECT)).toHaveLength(1);
      });

      const checkSentWakeupPauseHistory = async (
        storage: ReturnType<typeof durableStore>,
        batches: readonly (readonly boolean[])[],
      ) => {
        const { rows, store } = storage;
        const first = launch(store, "instance-a");
        let second: ReturnType<typeof launch> | undefined;
        try {
          await first.registry.deliverProjectPausedWakeup(wake());
          await first.registry.submitTurn({ backend: "codex", threadId: "parked", input: [{ type: "text", text: "Operator reply" }] });
          await expect(resolve(first.registry, "send")).resolves.toEqual({ results: [{ entryId: "task-monitor:nightly", status: "sent" }] });
          expect(rows()).toHaveLength(1);
          const request = { backend: "codex" as const, threadId: "parked", queueEntryId: "task-monitor:nightly" };
          const accepted = await first.registry.readQueuedTurn(request);
          const events: AgentEvent[] = [];
          first.registry.onEvent(event => { events.push(event); });
          let paused = false;
          let durable = true;
          const { writes } = await measureSqliteWrites(async () => {
            for (const batch of batches) {
              const expected = batch.map(value => {
                const disposition = paused === value ? "unchanged" : "updated";
                if (disposition === "updated" && value) durable = false;
                paused = value;
                return { disposition, paused: value };
              });
              const results = await Promise.all(batch.map(value => first.registry.setQueuedTurnPaused({ queueEntryId: request.queueEntryId, paused: value })));
              expect(results).toMatchObject(expected);
              // An effective Pause permanently retires project durability,
              // even when a concurrent Resume is the final visible state.
              expect(rows()).toHaveLength(durable ? 1 : 0);
              const live = first.registry.getQueuedTurnsForThread(request)[0]!;
              expect(Boolean(live.paused)).toBe(paused);
              const last = events.flatMap(event => event.notification.method === "thread/turnQueue/updated"
                && event.notification.params.queueEntryId === request.queueEntryId ? [event.notification.params] : []).at(-1);
              if (last) {
                expect(Boolean(last.paused)).toBe(Boolean(live.paused));
                expect(last.pauseRevision ?? 0).toBe(live.pauseRevision ?? 0);
              }
              expect(await first.registry.readQueuedTurn(request)).toEqual(accepted);
              expect(first.codexClient.startTurnCallCount).toBe(1);
            }
          });
          expect(writes.commits).toBe(durable ? 0 : 1);
          await first.registry.close();
          second = launch(store, "instance-b", ["instance-b"]);
          expect(second.registry.listProjectHeldWakeups(PROJECT)).toHaveLength(durable ? 1 : 0);
          expect(second.registry.getQueuedTurnsForThread(request)).toHaveLength(durable ? 1 : 0);
          expect(second.codexClient.startTurnCallCount).toBe(0);
          return writes;
        } finally {
          store.remove("task-monitor:nightly");
          await first.registry.close();
          await second?.registry.close();
        }
      };

      it("models completed sent-wake-up pauses independently of the latest concurrent control", async () => {
        pauseProject();
        const storage = durableStore();
        await fc.assert(fc.asyncProperty(fc.array(fc.array(fc.boolean(), { minLength: 1, maxLength: 4 }), { maxLength: 5 }),
          batches => checkSentWakeupPauseHistory(storage, batches).then(() => {})));
      });

      it("does not resurrect a sent wake-up after concurrent Pause then Resume", async () => {
        pauseProject();
        await checkSentWakeupPauseHistory(durableStore(), [[true, false]]);
      });

      it("budgets completed sent-wake-up Pause cleanup across concurrent Resume", async () => {
        pauseProject();
        const writes = await checkSentWakeupPauseHistory(durableStore(), [[true, false], [true, false]]);
        expectSqliteWriteBudget({ budgetFile: "desktop-queue-pause-wakeup-write-budgets.json", scenario: "completed-pause-cleanup",
          note: "Two concurrent Pause/Resume pairs for a sent wake-up behind an active turn; setup/admission and restart excluded. One existing durable-row delete, then no further writes.", writes });
      });

      it("drops the durable copy when the operator pauses a sent wake-up again", async () => {
        pauseProject();
        const { rows, store } = durableStore();
        const first = launch(store, "instance-a");
        await first.registry.deliverProjectPausedWakeup(wake());
        // The operator's own turn keeps the thread busy, so Send waits.
        await expect(first.registry.submitTurn({
          backend: "codex",
          threadId: "parked",
          input: [{ type: "text", text: "Operator reply" }],
        })).resolves.toMatchObject({ status: "started" });
        await expect(resolve(first.registry, "send")).resolves.toEqual({ results: [
          { entryId: "task-monitor:nightly", status: "sent" },
        ] });
        expect(rows()).toHaveLength(1);

        await first.registry.setQueuedTurnPaused({ queueEntryId: "task-monitor:nightly", paused: true });
        expect(rows()).toEqual([]);
        await first.registry.close();

        const second = launch(store, "instance-b", ["instance-b"]);
        expect(second.registry.listProjectHeldWakeups(PROJECT)).toEqual([]);
      });

      it("keeps an operator's edit to a held wake-up across a restart", async () => {
        pauseProject();
        const { store } = durableStore();
        const first = launch(store, "instance-a");
        await first.registry.deliverProjectPausedWakeup(wake());
        first.registry.updateQueuedTurnInput("task-monitor:nightly", [{ type: "text", text: "Edited wake" }]);
        await first.registry.close();

        const second = launch(store, "instance-b", ["instance-b"]);
        expect(second.registry.getQueuedTurnsForThread({ backend: "codex", threadId: "parked" })[0])
          .toMatchObject({ displayText: "Edited wake", paused: true });
      });
    });
  });

  it.each(["open", "merged"] as const)("authorizes federated commit reads using the published %s PR head", async (lifecycleState) => {
    const worktreePath = "/worktrees/PwrAgnt";
    const attachedCommitSha = "a".repeat(40);
    const detachedCommitSha = "b".repeat(40);
    const mergedPr = (number: number, commitSha: string): PrSummary => ({
      provider: "github.com",
      number,
      org: "pwrdrvr",
      repo: "PwrAgent",
      state: "merged",
      lifecycleState: "merged",
      commitShas: [commitSha],
      url: `https://github.com/pwrdrvr/PwrAgent/pull/${number}`,
    });
    const thread: AppServerThreadSummary = {
      id: "thread-1",
      title: "Federated unpublished work",
      titleSource: "explicit",
      source: "codex",
      projectKey: worktreePath,
      linkedDirectories: [],
    };
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [thread] }),
      overlayStore: createOverlayStoreMock({
        overlays: {
          "codex:thread-1": {
            backend: "codex",
            threadId: "thread-1",
            extraLinkedDirectories: [],
            prs: [{
              ...mergedPr(735, attachedCommitSha),
              state: "unknown",
              lifecycleState: "open",
            }],
            detachedPrs: [mergedPr(734, detachedCommitSha)],
          },
        },
      }),
    });
    registry.setThreadPullRequestCanonicalizer(async (prs) =>
      prs.map((pr) => pr.number === 735
        ? { ...pr, state: "passing", lifecycleState, headSha: attachedCommitSha, commitShas: [] }
        : pr),
    );

    try {
      await expect(registry.resolveThreadWorktreeGitReadContext({
        backend: "codex",
        threadId: "thread-1",
        worktreePath,
      })).resolves.toEqual({
        worktreePath,
        acceptedPushedCommitShas: [attachedCommitSha, detachedCommitSha],
      });
      await expect(registry.resolveThreadWorktreeGitReadContext({
        backend: "codex",
        threadId: "thread-1",
        worktreePath: "/outside/repo",
      })).resolves.toBeUndefined();
    } finally {
      await registry.close();
    }
  });

  it("hands one PR's Auto-fix switch to its handler and leaves the thread's preference alone", async () => {
    const preferenceChanged = vi.fn(async () => undefined);
    const pullRequestChanged = vi.fn(async () => undefined);
    const overlayStore = createOverlayStoreMock();
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      overlayStore,
    });
    const events: string[] = [];
    registry.onEvent((event) => { events.push(event.notification.method); });
    registry.setThreadPrAutoDispatchHandler({
      preferenceChanged,
      pullRequestChanged,
      cancelPending: vi.fn(async () => true),
      sendPendingNow: vi.fn(async () => true),
    });
    try {
      const request = { backend: "codex" as const, threadId: "thread-1", enabled: false, prKey: "github.com/upstream/app#7" };
      await expect(registry.setThreadPrAutoDispatch(request)).resolves.toEqual(request);
      expect(pullRequestChanged).toHaveBeenCalledWith({
        backend: "codex", threadId: "thread-1", prKey: "github.com/upstream/app#7", enabled: false,
      });
      expect(preferenceChanged).not.toHaveBeenCalled();
      expect(events).not.toContain("thread/prAutoDispatch/updated");
      expect((await overlayStore.getThreadOverlayState({ backend: "codex", threadId: "thread-1" }))?.prAutoDispatchEnabled)
        .toBeUndefined();
      // Without a handler for it, the request fails rather than toggling the thread.
      registry.setThreadPrAutoDispatchHandler({
        preferenceChanged,
        cancelPending: vi.fn(async () => true),
        sendPendingNow: vi.fn(async () => true),
      });
      await expect(registry.setThreadPrAutoDispatch(request)).rejects.toThrow("Auto-fix for one pull request");
      expect(preferenceChanged).not.toHaveBeenCalled();
    } finally {
      await registry.close();
    }
  });

  it("evaluates the current PR state when auto-fix is enabled", async () => {
    const preferenceChanged = vi.fn(async () => undefined);
    const sendPendingNow = vi.fn(async () => true);
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      overlayStore: createOverlayStoreMock(),
    });
    registry.setThreadPrAutoDispatchHandler({
      preferenceChanged,
      cancelPending: vi.fn(async () => true),
      sendPendingNow,
    });

    try {
      await registry.setThreadPrAutoDispatch({
        backend: "codex",
        threadId: "thread-1",
        enabled: true,
      });
      expect(preferenceChanged).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        enabled: true,
        previouslyEnabled: false,
      });
      // A repeat reports that Auto-fix was already on, so it resets nothing.
      await registry.setThreadPrAutoDispatch({
        backend: "codex",
        threadId: "thread-1",
        enabled: true,
      });
      expect(preferenceChanged).toHaveBeenLastCalledWith({
        backend: "codex",
        threadId: "thread-1",
        enabled: true,
        previouslyEnabled: true,
      });
      await expect(registry.sendThreadPrAutoDispatchNow({
        backend: "codex",
        threadId: "thread-1",
        fingerprint: "fingerprint-1",
      })).resolves.toEqual({
        backend: "codex",
        threadId: "thread-1",
        fingerprint: "fingerprint-1",
        accepted: true,
      });
      expect(sendPendingNow).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        fingerprint: "fingerprint-1",
      });
    } finally {
      await registry.close();
    }
  });

  it("coalesces bulk Auto-fix PR preferences before coordinator evaluation", async () => {
    const overlayStore = createOverlayStoreMock();
    const preferenceChanged = vi.fn(async () => undefined);
    const preferencesChanged = vi.fn(async () => undefined);
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      overlayStore,
    });
    registry.setThreadPrAutoDispatchHandler({
      preferenceChanged,
      preferencesChanged,
      cancelPending: vi.fn(async () => true),
      sendPendingNow: vi.fn(async () => true),
    });

    try {
      await registry.setThreadPrAutoDispatchBatch([
        { backend: "codex", threadId: "thread-1", enabled: true },
        { backend: "codex", threadId: "thread-2", enabled: true },
      ]);

      expect(preferenceChanged).not.toHaveBeenCalled();
      expect(preferencesChanged).toHaveBeenCalledTimes(1);
      expect(preferencesChanged).toHaveBeenCalledWith([
        { backend: "codex", threadId: "thread-1", enabled: true, previouslyEnabled: false },
        { backend: "codex", threadId: "thread-2", enabled: true, previouslyEnabled: false },
      ]);
      await expect(overlayStore.getThreadOverlayState({
        backend: "codex",
        threadId: "thread-1",
      })).resolves.toMatchObject({ prAutoDispatchEnabled: true });
      await expect(overlayStore.getThreadOverlayState({
        backend: "codex",
        threadId: "thread-2",
      })).resolves.toMatchObject({ prAutoDispatchEnabled: true });
    } finally {
      await registry.close();
    }
  });

  it("seeds Auto-fix PR for new threads from the configured default", async () => {
    const defaultOverlayStore = createOverlayStoreMock();
    const defaultRegistry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      overlayStore: defaultOverlayStore,
    });
    const disabledOverlayStore = createOverlayStoreMock();
    const disabledRegistry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      overlayStore: disabledOverlayStore,
      resolveDefaultPrAutoDispatchEnabled: () => false,
    });

    try {
      await defaultRegistry.startThread({
        backend: "codex",
        cwd: nonRepositoryCwd,
      });
      expect(
        (await defaultOverlayStore.getThreadOverlayState({
          backend: "codex",
          threadId: "thread-1",
        }))?.prAutoDispatchEnabled,
      ).toBe(true);

      await disabledRegistry.startThread({
        backend: "codex",
        cwd: nonRepositoryCwd,
      });
      expect(
        (await disabledOverlayStore.getThreadOverlayState({
          backend: "codex",
          threadId: "thread-1",
        }))?.prAutoDispatchEnabled,
      ).toBe(false);
    } finally {
      await Promise.all([defaultRegistry.close(), disabledRegistry.close()]);
    }
  });

  it("projects canonical PR statuses into both Agent inspection endpoints", async () => {
    const stalePr = {
      provider: "github.com",
      org: "pwrdrvr",
      repo: "PwrAgent",
      number: 1132,
      title: "Fix agent inspection",
      state: "passing" as const,
      checkState: "passing" as const,
      lifecycleState: "open" as const,
      reviewState: "ready_for_review" as const,
      mergeState: "mergeable" as const,
      url: "https://github.com/pwrdrvr/PwrAgent/pull/1132",
    };
    const mergedPr = {
      ...stalePr,
      lifecycleState: "merged" as const,
      mergeState: "unknown" as const,
    };
    const manualPr = {
      ...stalePr,
      repo: "PwrGit",
      number: 77,
      title: "Manual attachment",
      url: "https://github.com/pwrdrvr/PwrGit/pull/77",
    };
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list", "thread/read"] },
      threads: [
        {
          id: "thread-1",
          title: "Fix Agent PR status projection",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [],
          updatedAt: 2_000,
        },
      ],
      replay: {
        entries: [],
        messages: [],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
        threadStatus: "idle",
      },
    });
    const search = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: 2_000,
      filters: { backend: "all" as const, includeArchived: false },
      contentMode: "metadata" as const,
      semanticMode: "disabled" as const,
      searchedScopes: ["metadata"] as const,
      unavailableScopes: [],
      results: [
        {
          backend: "codex" as const,
          threadId: "thread-1",
          identityKey: "codex:thread-1",
          title: "Fix Agent PR status projection",
          updatedAt: 2_000,
          linkedDirectories: [],
          source: "codex" as const,
          score: 1,
          confidence: "high" as const,
          matchReasons: [{ kind: "metadata_match" as const }],
          snippets: [],
        },
      ],
      truncated: false,
    }));
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock({
        overlays: {
          "codex:agent-thread": createAgentOverlay(),
          "codex:thread-1": {
            backend: "codex",
            threadId: "thread-1",
            executionMode: "default",
            extraLinkedDirectories: [],
            prs: [stalePr, manualPr],
          },
        },
      }),
      threadSearchService: { search } as unknown as ThreadSearchService,
    });
    registry.setThreadPullRequestCanonicalizer(async (prs) =>
      prs.map((pr) => pr.number === mergedPr.number ? mergedPr : pr),
    );
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "agent-thread",
          turnId: "turn-1",
          turn: { id: "turn-1" },
        },
      },
    });
    const searchResponse = await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "agent-thread",
        turnId: "turn-1",
        callId: "call-search",
        requestId: "call-search",
        namespace: "pwragent",
        tool: "search_threads",
        arguments: {},
      },
    } as AppServerPendingRequestNotification);
    const statusResponse = await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "agent-thread",
        turnId: "turn-1",
        callId: "call-status",
        requestId: "call-status",
        namespace: "pwragent",
        tool: "get_thread_status",
        arguments: {
          backend: "codex",
          threadId: "thread-1",
        },
      },
    } as AppServerPendingRequestNotification);

    const searchPayload = JSON.parse(
      (searchResponse as { contentItems: Array<{ text: string }> })
        .contentItems[0]!.text,
    );
    const statusPayload = JSON.parse(
      (statusResponse as { contentItems: Array<{ text: string }> })
        .contentItems[0]!.text,
    );
    expect(searchPayload.threads[0].pullRequests[0]).toMatchObject({
      number: 1132,
      lifecycleState: "merged",
    });
    expect(searchPayload.threads[0].pullRequests[1]).toMatchObject({
      number: 77,
      lifecycleState: "open",
    });
    expect(statusPayload.thread.pullRequests[0]).toMatchObject({
      number: 1132,
      lifecycleState: "merged",
    });
    expect(statusPayload.thread.pullRequests[1]).toMatchObject({
      number: 77,
      lifecycleState: "open",
    });

    await registry.close();
  });

  it("lets an agent attach an explicit PR reference to a thread", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list"] },
      threads: [
        {
          id: "target-thread",
          title: "Cross repo work",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [],
          updatedAt: 2000,
        },
      ],
    });
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:agent-thread": createAgentOverlay(),
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
    });
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "agent-thread",
          turnId: "turn-1",
          turn: { id: "turn-1" },
        },
      },
    });

    const response = await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "agent-thread",
        turnId: "turn-1",
        callId: "call-1",
        requestId: "call-1",
        namespace: "pwragent",
        tool: "attach_thread_pull_request",
        arguments: {
          backend: "codex",
          threadId: "target-thread",
          url: "https://ghe.example.test/PwrDrvr/AgentKit/pull/456",
          title: "Cross repo PR",
        },
      },
    } as AppServerPendingRequestNotification);

    expect(response).toMatchObject({ success: true });
    const payload = JSON.parse(
      (response as { contentItems: Array<{ text: string }> }).contentItems[0]!.text,
    );
    expect(payload).toMatchObject({
      pullRequestReference: {
        backend: "codex",
        threadId: "target-thread",
        pr: {
          provider: "ghe.example.test",
          org: "PwrDrvr",
          repo: "AgentKit",
          number: 456,
          title: "Cross repo PR",
          url: "https://ghe.example.test/PwrDrvr/AgentKit/pull/456",
        },
        prs: [
          {
            provider: "ghe.example.test",
            org: "PwrDrvr",
            repo: "AgentKit",
            number: 456,
          },
        ],
      },
    });

    await registry.close();
  });

  async function attachRenamedRepositoryPullRequest(params: {
    resolver?: (request: { url: string; cwd?: string }) => Promise<
      { provider: string; org: string; repo: string; url: string } | undefined
    >;
    arguments: Record<string, unknown>;
  }) {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list"] },
      threads: [
        {
          id: "target-thread",
          title: "Renamed repository work",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [],
          updatedAt: 2000,
        },
      ],
    });
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:agent-thread": createAgentOverlay(),
        "codex:target-thread": {
          backend: "codex",
          threadId: "target-thread",
          executionMode: "default",
          extraLinkedDirectories: [],
          prs: [
            {
              provider: "github.com",
              org: "pwrdrvr",
              repo: "PwrAgent",
              number: 3179,
              title: "Found by the branch lookup",
              state: "passing",
              checkState: "passing",
              lifecycleState: "open",
              reviewState: "ready_for_review",
              mergeState: "unknown",
              url: "https://github.com/pwrdrvr/PwrAgent/pull/3179",
            },
          ],
        },
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
    });
    const resolver = params.resolver ? vi.fn(params.resolver) : undefined;
    if (resolver) registry.setPullRequestReferenceResolver(resolver);
    const events: AgentEvent[] = [];
    registry.onEvent((event) => {
      events.push(event);
    });
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "agent-thread",
          turnId: "turn-1",
          turn: { id: "turn-1" },
        },
      },
    });
    const response = await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "agent-thread",
        turnId: "turn-1",
        callId: "call-1",
        requestId: "call-1",
        namespace: "pwragent",
        tool: "attach_thread_pull_request",
        arguments: {
          backend: "codex",
          threadId: "target-thread",
          ...params.arguments,
        },
      },
    } as AppServerPendingRequestNotification);
    const overlay = await overlayStore.getThreadOverlayState({
      backend: "codex",
      threadId: "target-thread",
    });
    const published = events.flatMap((event) =>
      event.notification.method === "thread/pullRequests/updated"
        ? [(event.notification.params as { prs: PrSummary[] }).prs]
        : []
    );
    await registry.close();
    return { overlay, published, resolver, response };
  }

  it("stores a pre-rename PR URL under the forge's canonical repository", async () => {
    // GitHub redirects a renamed repository's old name and answers with the
    // new one. The attach must store the forge's identity, not the typed one,
    // or the same PR shows as two chips.
    const { overlay, published, resolver, response } = await attachRenamedRepositoryPullRequest({
      resolver: async () => ({
        provider: "github.com",
        org: "pwrdrvr",
        repo: "PwrAgent",
        url: "https://github.com/pwrdrvr/PwrAgent/pull/3179",
      }),
      arguments: { url: "https://github.com/pwrdrvr/PwrAgnt/pull/3179" },
    });

    expect(response).toMatchObject({ success: true });
    expect(overlay?.prs?.map((pr) => pr.url)).toEqual([
      "https://github.com/pwrdrvr/PwrAgent/pull/3179",
    ]);
    expect(overlay?.prs?.[0]).toMatchObject({
      org: "pwrdrvr",
      repo: "PwrAgent",
      number: 3179,
      url: "https://github.com/pwrdrvr/PwrAgent/pull/3179",
    });
    expect(published).toHaveLength(1);
    expect(published[0]).toHaveLength(1);
    expect(published[0]![0]).toMatchObject({
      repo: "PwrAgent",
      url: "https://github.com/pwrdrvr/PwrAgent/pull/3179",
    });
    expect(resolver).toHaveBeenCalledWith(expect.objectContaining({
      url: "https://github.com/pwrdrvr/PwrAgnt/pull/3179",
    }));
  });

  it("keeps the typed PR identity when the forge cannot resolve it", async () => {
    const { overlay, response } = await attachRenamedRepositoryPullRequest({
      resolver: async () => undefined,
      arguments: { url: "https://github.com/pwrdrvr/OtherRepo/pull/42" },
    });

    expect(response).toMatchObject({ success: true });
    expect(overlay?.prs?.map((pr) => pr.url)).toEqual([
      "https://github.com/pwrdrvr/PwrAgent/pull/3179",
      "https://github.com/pwrdrvr/OtherRepo/pull/42",
    ]);
    expect(overlay?.prs?.[1]).toMatchObject({ org: "pwrdrvr", repo: "OtherRepo", number: 42 });
  });

  it("accepts explicit repo fields that differ from the URL only by letter case", async () => {
    const { overlay, response } = await attachRenamedRepositoryPullRequest({
      arguments: {
        url: "https://github.com/pwrdrvr/PwrAgent/pull/3179",
        org: "PWRDRVR",
        repo: "pwragent",
      },
    });

    expect(response).toMatchObject({ success: true });
    expect(overlay?.prs).toHaveLength(1);
    expect(overlay?.prs?.[0]).toMatchObject({
      org: "pwrdrvr",
      repo: "PwrAgent",
      url: "https://github.com/pwrdrvr/PwrAgent/pull/3179",
    });
  });

  it("defaults PR reference attachment to the invoking thread", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list"] },
      threads: [
        {
          id: "agent-thread",
          title: "Current work",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [],
          updatedAt: 2000,
        },
      ],
    });
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:agent-thread": createAgentOverlay(),
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
    });
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "agent-thread",
          turnId: "turn-1",
          turn: { id: "turn-1" },
        },
      },
    });

    const response = await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "agent-thread",
        turnId: "turn-1",
        callId: "call-1",
        requestId: "call-1",
        namespace: "pwragent",
        tool: "attach_thread_pull_request",
        arguments: {
          url: "https://github.com/pwrdrvr/PwrAgent/pull/904",
        },
      },
    } as AppServerPendingRequestNotification);

    expect(response).toMatchObject({ success: true });
    const payload = JSON.parse(
      (response as { contentItems: Array<{ text: string }> }).contentItems[0]!.text,
    );
    expect(payload.pullRequestReference).toMatchObject({
      backend: "codex",
      threadId: "agent-thread",
      pr: {
        provider: "github.com",
        org: "pwrdrvr",
        repo: "PwrAgent",
        number: 904,
        url: "https://github.com/pwrdrvr/PwrAgent/pull/904",
      },
    });
    const overlay = await overlayStore.getThreadOverlayState({
      backend: "codex",
      threadId: "agent-thread",
    });
    expect(overlay?.prs).toEqual([
      expect.objectContaining({
        provider: "github.com",
        org: "pwrdrvr",
        repo: "PwrAgent",
        number: 904,
      }),
    ]);

    await registry.close();
  });

  it("rejects explicit PR references with malformed URLs", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list"] },
      threads: [
        {
          id: "target-thread",
          title: "Cross repo work",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [],
          updatedAt: 2000,
        },
      ],
    });
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:agent-thread": createAgentOverlay(),
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
    });
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "agent-thread",
          turnId: "turn-1",
          turn: { id: "turn-1" },
        },
      },
    });

    const response = await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "agent-thread",
        turnId: "turn-1",
        callId: "call-1",
        requestId: "call-1",
        namespace: "pwragent",
        tool: "attach_thread_pull_request",
        arguments: {
          backend: "codex",
          threadId: "target-thread",
          provider: "github.com",
          org: "pwrdrvr",
          repo: "PwrAgent",
          number: 904,
          url: "not a pull request URL",
        },
      },
    } as AppServerPendingRequestNotification);

    expect(response).toEqual({
      success: false,
      contentItems: [
        {
          type: "inputText",
          text: JSON.stringify(
            {
              code: "invalid_arguments",
              message:
                "url must look like a GitHub/GHE /pull/<number> URL or a GitLab /merge_requests/<number> URL.",
            },
            null,
            2,
          ),
        },
      ],
    });
    const overlay = await overlayStore.getThreadOverlayState({
      backend: "codex",
      threadId: "target-thread",
    });
    expect(overlay?.prs).toBeUndefined();

    await registry.close();
  });

  it("rejects explicit PR references whose URL conflicts with identity fields", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list"] },
      threads: [
        {
          id: "target-thread",
          title: "Cross repo work",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [],
          updatedAt: 2000,
        },
      ],
    });
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:agent-thread": createAgentOverlay(),
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
    });
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "agent-thread",
          turnId: "turn-1",
          turn: { id: "turn-1" },
        },
      },
    });

    const cases: Array<{
      conflict: string;
      args: Partial<AttachThreadPullRequestToolArgs>;
    }> = [
      { conflict: "number", args: { number: 905 } },
      { conflict: "provider", args: { provider: "ghe.example.test" } },
      { conflict: "org", args: { org: "other-org" } },
      { conflict: "repo", args: { repo: "OtherRepo" } },
    ];
    for (const [index, testCase] of cases.entries()) {
      const response = await codexClient.emitRequest({
        method: "item/tool/call",
        params: {
          threadId: "agent-thread",
          turnId: "turn-1",
          callId: `call-${index + 1}`,
          requestId: `call-${index + 1}`,
          namespace: "pwragent",
          tool: "attach_thread_pull_request",
          arguments: {
            backend: "codex",
            threadId: "target-thread",
            url: "https://github.com/pwrdrvr/PwrAgent/pull/904",
            ...testCase.args,
          },
        },
      } as AppServerPendingRequestNotification);

      expect(response).toEqual({
        success: false,
        contentItems: [
          {
            type: "inputText",
            text: JSON.stringify(
              {
                code: "invalid_arguments",
                message: `url conflicts with explicit ${testCase.conflict}. Provide matching PR identity fields or omit the conflicting fields.`,
              },
              null,
              2,
            ),
          },
        ],
      });
    }
    const overlay = await overlayStore.getThreadOverlayState({
      backend: "codex",
      threadId: "target-thread",
    });
    expect(overlay?.prs).toBeUndefined();

    await registry.close();
  });

  it("lets an agent attach a bare PR number when the thread has one PR repo", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list"] },
      threads: [
        {
          id: "target-thread",
          title: "Durable PR refs",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [],
          updatedAt: 2000,
        },
      ],
    });
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:agent-thread": createAgentOverlay(),
        "codex:target-thread": {
          backend: "codex",
          threadId: "target-thread",
          executionMode: "default",
          extraLinkedDirectories: [],
          prs: [
            {
              provider: "github.com",
              org: "pwrdrvr",
              repo: "PwrAgent",
              number: 123,
              title: "Earlier PR",
              state: "passing",
              checkState: "passing",
              lifecycleState: "open",
              reviewState: "ready_for_review",
              mergeState: "unknown",
              url: "https://github.com/pwrdrvr/PwrAgent/pull/123",
            },
          ],
        },
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
    });
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "agent-thread",
          turnId: "turn-1",
          turn: { id: "turn-1" },
        },
      },
    });

    const response = await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "agent-thread",
        turnId: "turn-1",
        callId: "call-1",
        requestId: "call-1",
        namespace: "pwragent",
        tool: "attach_thread_pull_request",
        arguments: {
          backend: "codex",
          threadId: "target-thread",
          number: 789,
        },
      },
    } as AppServerPendingRequestNotification);

    expect(response).toMatchObject({ success: true });
    const payload = JSON.parse(
      (response as { contentItems: Array<{ text: string }> }).contentItems[0]!.text,
    );
    expect(payload.pullRequestReference.pr).toMatchObject({
      provider: "github.com",
      org: "pwrdrvr",
      repo: "PwrAgent",
      number: 789,
      url: "https://github.com/pwrdrvr/PwrAgent/pull/789",
    });
    expect(payload.pullRequestReference.prs.map(
      (pr: { number: number }) => pr.number,
    )).toEqual([123, 789]);

    await registry.close();
  });

  async function attachBarePullRequestNumberAcrossCheckouts(params: {
    remotes: string[];
    resolver?: (request: { url: string; cwd?: string }) => Promise<
      { provider: string; org: string; repo: string; url: string } | undefined
    >;
  }) {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-renamed-remotes-"));
    try {
      const linkedDirectories = [];
      for (const [index, remote] of params.remotes.entries()) {
        const checkout = path.join(root, `checkout-${index}`);
        await mkdir(checkout, { recursive: true });
        await git(checkout, ["init", "-b", "main"]);
        await git(checkout, ["remote", "add", "origin", remote]);
        linkedDirectories.push({
          id: checkout,
          kind: "local" as const,
          label: `checkout-${index}`,
          path: checkout,
        });
      }
      const codexClient = new MockBackendClient({
        initializeResult: { methods: ["thread/list"] },
        threads: [
          {
            id: "target-thread",
            title: "Checkouts from before and after a rename",
            titleSource: "explicit",
            source: "codex",
            linkedDirectories,
            updatedAt: 2000,
          },
        ],
      });
      const overlayStore = createOverlayStoreMock({
        overlays: {
          "codex:agent-thread": createAgentOverlay(),
        },
      });
      const registry = createDesktopBackendRegistry({
        codexClient,
        overlayStore,
      });
      try {
        const resolver = params.resolver ? vi.fn(params.resolver) : undefined;
        if (resolver) registry.setPullRequestReferenceResolver(resolver);
        await registry.publishLocalEvent({
          backend: "codex",
          notification: {
            method: "turn/started",
            params: {
              threadId: "agent-thread",
              turnId: "turn-1",
              turn: { id: "turn-1" },
            },
          },
        });
        const response = await codexClient.emitRequest({
          method: "item/tool/call",
          params: {
            threadId: "agent-thread",
            turnId: "turn-1",
            callId: "call-1",
            requestId: "call-1",
            namespace: "pwragent",
            tool: "attach_thread_pull_request",
            arguments: {
              backend: "codex",
              threadId: "target-thread",
              number: 3179,
            },
          },
        } as AppServerPendingRequestNotification);
        const overlay = await overlayStore.getThreadOverlayState({
          backend: "codex",
          threadId: "target-thread",
        });
        return { overlay, resolver, response };
      } finally {
        await registry.close();
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }

  it("attaches a bare PR number when checkouts name a renamed repository both ways", async () => {
    // One checkout was cloned before pwrdrvr/PwrAgnt became pwrdrvr/PwrAgent.
    // GitHub answers the old name with the new one, so the two remotes are
    // one repository, not an ambiguity.
    const { overlay, resolver, response } = await attachBarePullRequestNumberAcrossCheckouts({
      remotes: [
        "git@github.com:pwrdrvr/PwrAgnt.git",
        "https://github.com/pwrdrvr/PwrAgent.git",
      ],
      resolver: async ({ url }) => {
        const parsed = /\/pull\/(\d+)$/.exec(url);
        return {
          provider: "github.com",
          org: "pwrdrvr",
          repo: "PwrAgent",
          url: `https://github.com/pwrdrvr/PwrAgent/pull/${parsed?.[1]}`,
        };
      },
    });

    expect(response).toMatchObject({ success: true });
    expect(overlay?.prs).toHaveLength(1);
    expect(overlay?.prs?.[0]).toMatchObject({
      provider: "github.com",
      org: "pwrdrvr",
      repo: "PwrAgent",
      number: 3179,
      url: "https://github.com/pwrdrvr/PwrAgent/pull/3179",
    });
    // One question per inferred name; the attach does not ask again.
    expect(resolver?.mock.calls.map(([request]) => request.url).sort()).toEqual([
      "https://github.com/pwrdrvr/PwrAgent/pull/3179",
      "https://github.com/pwrdrvr/PwrAgnt/pull/3179",
    ]);
  });

  it("attaches a bare PR number when checkout remotes differ only by letter case", async () => {
    const { overlay, response } = await attachBarePullRequestNumberAcrossCheckouts({
      remotes: [
        "https://github.com/pwrdrvr/pwragent.git",
        "https://github.com/pwrdrvr/PwrAgent.git",
      ],
    });

    expect(response).toMatchObject({ success: true });
    expect(overlay?.prs).toHaveLength(1);
    expect(overlay?.prs?.[0]).toMatchObject({ number: 3179 });
    expect(overlay?.prs?.[0]?.repo.toLowerCase()).toBe("pwragent");
  });

  it("still refuses a bare PR number when the forge names two repositories", async () => {
    const { overlay, resolver, response } = await attachBarePullRequestNumberAcrossCheckouts({
      remotes: [
        "https://github.com/pwrdrvr/PwrAgent.git",
        "https://github.com/pwrdrvr/PwrGit.git",
      ],
      // Each repository has its own #3179.
      resolver: async ({ url }) => {
        const parsed = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)$/.exec(url);
        return parsed
          ? { provider: "github.com", org: parsed[1]!, repo: parsed[2]!, url }
          : undefined;
      },
    });

    expect(response).toMatchObject({ success: false });
    expect(JSON.stringify(response)).toContain("multiple inferable repositories");
    expect(overlay?.prs).toBeUndefined();
    expect(resolver).toHaveBeenCalledTimes(2);
  });

  it("routes user-invoked PR status checks through the registered handler", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list"] },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock({
        overlays: {
          "codex:agent-thread": createAgentOverlay(),
        },
      }),
    });
    const handler = vi.fn(async (args) => ({
      ok: true as const,
      data: {
        pullRequestStatus: {
          backend: args.backend ?? "codex",
          threadId: args.threadId ?? "target-thread",
          provider: args.provider ?? "github.com",
          prs: [],
          ghAvailable: true,
          refreshStarted: true,
          lastStatusCheckAt: 1_000,
          lastStatusCheckAgeMs: 250,
          requestedAt: 1_250,
          branch: args.branch ?? "main",
          directoryPaths: args.directoryPaths ?? ["/repo"],
          prAutomation: {
            backgroundPollingEnabled: true,
            autoFixAllowed: true,
            autoFixEnabled: true,
            autoFixActive: true,
            guidance: "End the turn and let PwrAgent watch the PR.",
          },
        },
      },
    }));
    registry.setThreadPullRequestStatusToolHandler(handler);
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "agent-thread",
          turnId: "turn-1",
          turn: { id: "turn-1" },
        },
      },
    });

    const response = await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "agent-thread",
        turnId: "turn-1",
        callId: "call-1",
        requestId: "call-1",
        namespace: "pwragent",
        tool: "check_thread_pull_request_status",
        arguments: {
          backend: "codex",
          threadId: "target-thread",
          branch: "feature/pr",
          directoryPaths: ["/repo"],
        },
      },
    } as AppServerPendingRequestNotification);

    expect(response).toMatchObject({ success: true });
    const payload = JSON.parse(
      (response as { contentItems: Array<{ text: string }> }).contentItems[0]!.text,
    );
    expect(payload).toMatchObject({
      pullRequestStatus: {
        backend: "codex",
        threadId: "target-thread",
        ghAvailable: true,
        refreshStarted: true,
        lastStatusCheckAt: 1_000,
        lastStatusCheckAgeMs: 250,
        requestedAt: 1_250,
        branch: "feature/pr",
        directoryPaths: ["/repo"],
      },
    });
    expect(handler).toHaveBeenCalledWith(
      {
        backend: "codex",
        threadId: "target-thread",
        branch: "feature/pr",
        directoryPaths: ["/repo"],
      },
      {
        backend: "codex",
        threadId: "agent-thread",
      },
    );

    await registry.close();
  });

  it("defaults user-invoked PR status checks to the invoking thread", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list"] },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock({
        overlays: {
          "codex:agent-thread": createAgentOverlay(),
        },
      }),
    });
    const handler = vi.fn(async (args) => ({
      ok: true as const,
      data: {
        pullRequestStatus: {
          backend: args.backend ?? "codex",
          threadId: args.threadId ?? "agent-thread",
          provider: args.provider ?? "github.com",
          prs: [],
          ghAvailable: true,
          refreshStarted: false,
          requestedAt: 1_250,
          branch: args.branch ?? "HEAD",
          directoryPaths: args.directoryPaths ?? [],
          prAutomation: {
            backgroundPollingEnabled: true,
            autoFixAllowed: true,
            autoFixEnabled: false,
            autoFixActive: false,
            guidance: "Use a one-shot PR watch.",
          },
        },
      },
    }));
    registry.setThreadPullRequestStatusToolHandler(handler);
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "agent-thread",
          turnId: "turn-1",
          turn: { id: "turn-1" },
        },
      },
    });

    const response = await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "agent-thread",
        turnId: "turn-1",
        callId: "call-1",
        requestId: "call-1",
        namespace: "pwragent",
        tool: "check_thread_pull_request_status",
        arguments: {
          branch: "feature/pr",
        },
      },
    } as AppServerPendingRequestNotification);

    expect(handler).toHaveBeenCalledWith(
      {
        backend: "codex",
        threadId: "agent-thread",
        branch: "feature/pr",
      },
      {
        backend: "codex",
        threadId: "agent-thread",
      },
    );
    expect(response).toMatchObject({ success: true });
    const payload = JSON.parse(
      (response as { contentItems: Array<{ text: string }> }).contentItems[0]!.text,
    );
    expect(payload.pullRequestStatus).toMatchObject({
      backend: "codex",
      threadId: "agent-thread",
      branch: "feature/pr",
    });

    await registry.close();
  });

  it("routes one-shot PR watches with invoking thread defaults", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list"] },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock({
        overlays: {
          "codex:agent-thread": createAgentOverlay(),
        },
      }),
    });
    const handler = vi.fn(async (args) => ({
      ok: true as const,
      data: {
        pullRequestWatch: {
          coveredByAutoFix: ["failure" as const],
          prAutomation: {
            backgroundPollingEnabled: true,
            autoFixAllowed: true,
            autoFixEnabled: true,
            autoFixActive: true,
            guidance: "End the turn.",
          },
          watch: {
            watchId: "watch-1",
            backend: args.backend ?? "codex",
            threadId: args.threadId ?? "agent-thread",
            prKey: "github.com/pwrdrvr/pwragent#1105",
            prUrl: args.url ?? "https://github.com/pwrdrvr/PwrAgent/pull/1105",
            prNumber: 1105,
            headSha: "a".repeat(40),
            notifyOn: ["success" as const],
            createdAt: 1_000,
            failureHandledByAutoFix: true,
          },
          armed: true,
          reason: "armed" as const,
          message: "Watching PR #1105 at aaaaaaa for the next success.",
        },
      },
    }));
    registry.setThreadPullRequestWatchToolHandler(handler);
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "agent-thread",
          turnId: "turn-1",
          turn: { id: "turn-1" },
        },
      },
    });

    const response = await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "agent-thread",
        turnId: "turn-1",
        callId: "call-watch-1",
        requestId: "call-watch-1",
        namespace: "pwragent",
        tool: "watch_thread_pull_request",
        arguments: {
          url: "https://github.com/pwrdrvr/PwrAgent/pull/1105",
        },
      },
    } as AppServerPendingRequestNotification);

    // A turn the local operator started carries no messaging contact.
    expect(handler).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "agent-thread",
      url: "https://github.com/pwrdrvr/PwrAgent/pull/1105",
    }, {});
    expect(response).toMatchObject({ success: true });

    await registry.close();
  });
});
