import fc from "fast-check";
import { expect, it, vi } from "vitest";
import type { AppServerPendingRequestNotification } from "@pwragent/shared/contracts/normalized-app-server";
import { createDesktopBackendRegistry, registryModules } from "../app-server/backend-registry-wiring";
import { buildTaskMonitorDynamicToolSpecs } from "../app-server/task-monitor-codex-tools";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import {
  createOverlayStoreMock,
  emitCompletedTurn,
  emitStartedTurn,
  MockBackendClient,
  pwragentDynamicTools,
} from "./helpers/backend-registry-fixture";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

const firstParent = { backend: "codex", threadId: "first-parent" } as const;
const secondParent = { backend: "codex", threadId: "second-parent" } as const;

it("keeps monitor progress and completion in the compatibility specs when creation is off", () => {
  expect(buildTaskMonitorDynamicToolSpecs("parent", false)).toEqual([]);
  expect(pwragentDynamicTools(buildTaskMonitorDynamicToolSpecs("all", true)).map(({ name }) => name))
    .toEqual(["create_monitor_delegation", "inject_progress", "complete_monitoring"]);
  expect(pwragentDynamicTools(buildTaskMonitorDynamicToolSpecs("all", false)).map(({ name }) => name))
    .toEqual(["inject_progress", "complete_monitoring"]);
});

it("keeps tool discovery and creation in sync with toggles and turn boundaries", async () => {
  const codexClient = new MockBackendClient({});
  let enabled = true;
  let turnNumber = 0;
  let callNumber = 0;
  const overlayStore = createOverlayStoreMock();
  const registry = createDesktopBackendRegistry({
    codexClient,
    overlayStore: {
      ...overlayStore,
      setThreadJobMonitorCreation: ({ enabled: value }) => { enabled = value; },
      getThreadOverlayState: async ({ backend, threadId }) => ({
        backend, threadId, executionMode: "default", extraLinkedDirectories: [],
        jobMonitorCreationEnabled: enabled ? undefined : false,
      }),
    },
  });
  const admit = vi.spyOn(registryModules(registry).subAgentMonitorService, "handleAgentTaskMonitorRequest")
    .mockResolvedValue({
      ok: true, operation: "create_monitor_delegation", data: {
        monitorId: "monitor-fixture", parentThreadId: firstParent.threadId,
        preferredModel: "fixture", preferredReasoningEffort: "low", pollIntervalSeconds: 30,
        heartbeatIntervalSeconds: 30, startupTimeoutSeconds: 20, startedByPwrAgent: true,
        startupConfirmed: true, parentShouldPoll: false, completionWakesParentByDefault: true,
        parentAgentGuidance: "Fixture", prompt: "Watch the fixture build.",
      },
    });
  const toggle = (value: boolean) => registry.setThreadJobMonitorCreation({ threadId: firstParent.threadId, enabled: value });
  try {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.oneof(
        fc.boolean().map((value) => ({ kind: "toggle" as const, value })),
        fc.constant({ kind: "next-turn" } as const),
      ), { maxLength: 8 }),
      fc.boolean(),
      async (operations, initiallyEnabled) => {
        await toggle(initiallyEnabled);
        let turnId = `turn-${++turnNumber}`;
        await emitStartedTurn(registry, "codex", firstParent.threadId, turnId);
        let saved = initiallyEnabled;
        let allowed = initiallyEnabled;
        try {
          const call = async (namespace: string, tool: string, args: Record<string, unknown>) => {
            const id = `call-${++callNumber}`;
            return await codexClient.emitRequest({
              method: "item/tool/call",
              params: { threadId: firstParent.threadId, turnId, callId: id, requestId: id, namespace, tool, arguments: args },
            } as AppServerPendingRequestNotification) as { success: boolean; contentItems: Array<{ text: string }> };
          };
          const assertGate = async () => {
            const discovery = await call("pwragent", "tool_search", { query: "create_monitor_delegation" });
            expect(discovery.success).toBe(true);
            const tools = JSON.parse(discovery.contentItems[0].text).tools as Array<{ name: string }>;
            expect(tools.some(({ name }) => name === "create_monitor_delegation")).toBe(allowed);
            for (const namespace of ["pwragent", "pwragent_task_monitors"]) {
              admit.mockClear();
              const result = await call(namespace, "create_monitor_delegation", { task: "Watch the fixture build." });
              expect(result.success).toBe(allowed);
              expect(admit).toHaveBeenCalledTimes(allowed ? 1 : 0);
            }
          };
          await assertGate();
          for (const operation of operations) {
            if (operation.kind === "toggle") {
              saved = operation.value;
              allowed &&= saved;
              await toggle(saved);
            } else {
              await emitCompletedTurn(registry, "codex", firstParent.threadId, turnId);
              turnId = `turn-${++turnNumber}`;
              await emitStartedTurn(registry, "codex", firstParent.threadId, turnId);
              allowed = saved;
            }
            await assertGate();
          }
        } finally {
          await emitCompletedTurn(registry, "codex", firstParent.threadId, turnId);
        }
      },
    ), { numRuns: 25, examples: [
      [[{ kind: "toggle", value: true }, { kind: "next-turn" }], false],
      [[{ kind: "toggle", value: false }, { kind: "toggle", value: true }, { kind: "next-turn" }], true],
    ] });
  } finally {
    await registry.close();
  }
});

it("reopens with creation off and blocks stale tool calls and discovery until re-enabled", async () => {
  const { dbPath, tempDir } = createTempStateDb("pwragent-job-monitor-creation-");
  const initialDb = StateDb.open(dbPath);
  try {
    const store = new SqliteOverlayStore(initialDb);
    await store.setThreadMonitorJobSuggestions({ ...firstParent, enabled: true });
    store.setThreadJobMonitorCreation({ ...firstParent, enabled: false });
  } finally {
    initialDb.close();
  }
  const db = StateDb.open(dbPath);
  const store = new SqliteOverlayStore(db);
  const codexClient = new MockBackendClient({});
  const registry = createDesktopBackendRegistry({
    codexClient,
    overlayStore: {
      ...createOverlayStoreMock(),
      getThreadOverlayState: (identity) => store.getThreadOverlayState(identity),
      setThreadJobMonitorCreation: (params) => store.setThreadJobMonitorCreation(params),
    },
  });
  let turnId = "current-turn";
  let callNumber = 0;
  const call = async (namespace: string, tool: string, args: Record<string, unknown>) => {
    const id = `request-${++callNumber}`;
    return await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: firstParent.threadId, turnId, callId: id,
        requestId: id, namespace, tool, arguments: args,
      },
    } as AppServerPendingRequestNotification) as { success: boolean; contentItems: Array<{ text: string }> };
  };
  try {
    expect(await store.getThreadOverlayState(firstParent)).toMatchObject({
      jobMonitorCreationEnabled: false, monitorJobSuggestionsEnabled: true,
    });
    expect((await store.getThreadOverlayState(secondParent))?.jobMonitorCreationEnabled).toBeUndefined();
    await emitStartedTurn(registry, "codex", firstParent.threadId, "current-turn");
    const search = () => call("pwragent", "tool_search", { query: "create_monitor_delegation" });
    const hidden = await search();
    expect(hidden.success).toBe(true);
    expect(JSON.parse(hidden.contentItems[0].text).tools).not.toContainEqual(
      expect.objectContaining({ name: "create_monitor_delegation" }),
    );
    for (const namespace of ["pwragent", "pwragent_task_monitors"]) {
      const result = await call(namespace, "create_monitor_delegation", { task: "Watch the fixture build." });
      expect(result.success).toBe(false);
      expect(result.contentItems[0].text).toContain("Job Monitors are off for this thread.");
    }
    expect(codexClient.lastStartThreadParams).toBeUndefined();
    await registry.setThreadJobMonitorCreation({ threadId: firstParent.threadId, enabled: true });
    expect((await store.getThreadOverlayState(firstParent))?.jobMonitorCreationEnabled).toBeUndefined();
    await emitCompletedTurn(registry, "codex", firstParent.threadId, turnId);
    turnId = "next-turn";
    await emitStartedTurn(registry, "codex", firstParent.threadId, turnId);
    const restored = await search();
    expect(JSON.parse(restored.contentItems[0].text).tools).toContainEqual(
      expect.objectContaining({ name: "create_monitor_delegation" }),
    );
  } finally {
    await registry.close();
    db.close();
    removeTempStateDbDir(tempDir);
  }
});

it.each(["event first", "response first"] as const)("keeps creation deferred through pending turn admission (%s)", async (order) => {
  const codexClient = new MockBackendClient({
    serverCapabilities: { codeModeOutputReducer: { protocolVersion: 1, dynamicToolsResumeField: "dynamicTools" } },
  });
  let saved = false;
  const submitted = Promise.withResolvers<Parameters<MockBackendClient["startTurn"]>[0]>();
  const accepted = Promise.withResolvers<Awaited<ReturnType<MockBackendClient["startTurn"]>>>();
  vi.spyOn(codexClient, "startTurn").mockImplementationOnce((params) => {
    submitted.resolve(params);
    return accepted.promise;
  });
  const registry = createDesktopBackendRegistry({
    codexClient,
    overlayStore: {
      ...createOverlayStoreMock(),
      setThreadJobMonitorCreation: ({ enabled }) => { saved = enabled; },
      getThreadOverlayState: async ({ backend, threadId }) => ({
        backend, threadId, executionMode: "default", extraLinkedDirectories: [],
        jobMonitorCreationEnabled: saved ? undefined : false,
      }),
    },
  });
  const turn = { threadId: firstParent.threadId, turnId: "admitted-turn" };
  const starting = registry.startTurn({ ...firstParent, input: [{ type: "text", text: "Continue." }] });
  try {
    const specs = pwragentDynamicTools((await submitted.promise).dynamicTools);
    expect(specs.some(({ name }) => name === "create_monitor_delegation")).toBe(false);
    await registry.setThreadJobMonitorCreation({ threadId: firstParent.threadId, enabled: true });
    if (order === "response first") {
      accepted.resolve(turn);
      await starting;
    }
    await emitStartedTurn(registry, "codex", turn.threadId, turn.turnId);
    const result = await codexClient.emitRequest({
      method: "item/tool/call",
      params: { ...turn, callId: "create", requestId: "create", namespace: "pwragent",
        tool: "create_monitor_delegation", arguments: { task: "Watch the fixture build." } },
    } as AppServerPendingRequestNotification);
    expect(result).toMatchObject({ success: false, contentItems: [
      expect.objectContaining({ text: expect.stringContaining("Job Monitors will be available from the next turn.") }),
    ] });
  } finally {
    accepted.resolve(turn);
    await starting;
    await emitCompletedTurn(registry, "codex", turn.threadId, turn.turnId);
    await registry.close();
  }
});

it("takes the next Codex turn's monitor creation tool from that thread's saved setting", async () => {
  await fc.assert(fc.asyncProperty(
    fc.array(fc.record({
      threadId: fc.constantFrom("first-parent", "second-parent"),
      enabled: fc.option(fc.boolean(), { nil: undefined }),
    }), { minLength: 2, maxLength: 4 }),
    async (changes) => {
      const codexClient = new MockBackendClient({
        serverCapabilities: { codeModeOutputReducer: { protocolVersion: 1, dynamicToolsResumeField: "dynamicTools" } },
        startTurnResults: changes.flatMap((_, index) => [firstParent, secondParent].map(({ threadId }) => ({
          threadId, turnId: `${threadId}-turn-${index}`,
        }))),
      });
      const saved = new Map<string, boolean | undefined>();
      const registry = createDesktopBackendRegistry({
        codexClient,
        overlayStore: {
          ...createOverlayStoreMock(),
          getThreadOverlayState: async ({ backend, threadId }) => ({
            backend, threadId, executionMode: "default", extraLinkedDirectories: [],
            jobMonitorCreationEnabled: saved.get(threadId),
          }),
        },
      });
      try {
        for (const { threadId, enabled } of changes) {
          saved.set(threadId, enabled);
          for (const parent of ["first-parent", "second-parent"]) {
            const turn = await registry.startTurn({
              backend: "codex", threadId: parent, input: [{ type: "text", text: "Continue." }],
            });
            const tools = pwragentDynamicTools(codexClient.lastStartTurnParams?.dynamicTools);
            expect(tools.some(({ name }) => name === "create_monitor_delegation")).toBe(saved.get(parent) !== false);
            expect(tools.some(({ name }) => name === "cancel_monitor_delegation")).toBe(true);
            expect(tools.some(({ name }) => name === "manage_thread_dependencies")).toBe(true);
            await emitCompletedTurn(registry, "codex", parent, turn.turnId);
          }
        }
      } finally {
        await registry.close();
      }
    },
  ), { numRuns: 25 });
});
