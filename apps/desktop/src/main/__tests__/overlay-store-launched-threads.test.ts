import { rmSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import {
  MAX_LAUNCHED_THREAD_LOG_ENTRIES,
  type ThreadLaunchedThread,
} from "@pwragent/shared/contracts/navigation";
import { navigationQueryEventRequiresRefresh } from "@pwragent/shared/navigation-query-events";
import { createDesktopBackendRegistry } from "../app-server/backend-registry-wiring";
import { createFederationAgentToolsHandler } from "../federation/federation-agent-tools-service";
import type { DesktopFederationRuntime } from "../federation/federation-runtime";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { MockBackendClient } from "./helpers/backend-registry-fixture";
import { createTempStateDb } from "./sqlite-test-utils";

let stateDb: StateDb;
let store: SqliteOverlayStore;
let tempDir: string;

beforeEach(() => {
  const fixture = createTempStateDb("pwragent-launched-threads-test-");
  tempDir = fixture.tempDir;
  stateDb = StateDb.open(fixture.dbPath);
  store = new SqliteOverlayStore(stateDb);
});

afterEach(() => {
  stateDb.close();
  rmSync(tempDir, { recursive: true, force: true });
});

function makeLaunch(
  overrides: Partial<ThreadLaunchedThread> & Pick<ThreadLaunchedThread, "id">,
): ThreadLaunchedThread {
  return {
    source: "handoff_task",
    occurredAt: 2_000,
    title: "Investigate cache invalidation",
    projectLabel: "atlas-auth",
    startedThread: {
      backend: "codex",
      threadId: `child-${overrides.id}`,
    },
    seedMode: "clean",
    groupingMode: "subthread",
    workspaceMode: "new_worktree",
    ...overrides,
  };
}

describe("SqliteOverlayStore - launchedThreadLog", () => {
  it("persists, deduplicates by id, orders chronologically, strips from listing reads, caps oldest-first, and clears on rewind", async () => {
    await store.appendLaunchedThread({
      backend: "codex",
      threadId: "parent-1",
      launch: makeLaunch({ id: "h-2", occurredAt: 3_000, title: "Second" }),
    });
    await store.appendLaunchedThread({
      backend: "codex",
      threadId: "parent-1",
      launch: makeLaunch({ id: "h-1", occurredAt: 1_000, title: "First" }),
    });
    // Re-appending the same id updates in place without duplicating.
    await store.appendLaunchedThread({
      backend: "codex",
      threadId: "parent-1",
      launch: makeLaunch({ id: "h-1", occurredAt: 1_000, title: "First updated" }),
    });

    // Listing overlay reads strip transcript logs to stay compact.
    const listing = await store.getThreadListingOverlayStates({
      backend: "codex",
      threadIds: ["parent-1"],
    });
    expect(listing["parent-1"]?.launchedThreadLog).toBeUndefined();

    // Reopen SQLite handle and verify full persistence + order.
    stateDb.close();
    const reopenedDb = StateDb.open(path.join(tempDir, "state.db"));
    stateDb = reopenedDb;
    store = new SqliteOverlayStore(reopenedDb);

    const overlay = await store.getThreadOverlayState({
      backend: "codex",
      threadId: "parent-1",
    });
    expect(overlay?.launchedThreadLog?.map((entry) => [entry.id, entry.title])).toEqual([
      ["h-1", "First updated"],
      ["h-2", "Second"],
    ]);

    // Exceeding MAX_LAUNCHED_THREAD_LOG_ENTRIES evicts oldest entries first.
    for (let index = 0; index < MAX_LAUNCHED_THREAD_LOG_ENTRIES + 5; index += 1) {
      await store.appendLaunchedThread({
        backend: "codex",
        threadId: "parent-cap",
        launch: makeLaunch({
          id: `cap-${index}`,
          occurredAt: 10_000 + index,
          title: `Cap ${index}`,
        }),
      });
    }
    const capped = await store.getThreadOverlayState({
      backend: "codex",
      threadId: "parent-cap",
    });
    expect(capped?.launchedThreadLog).toHaveLength(MAX_LAUNCHED_THREAD_LOG_ENTRIES);
    expect(capped?.launchedThreadLog?.[0]?.id).toBe("cap-5");
    expect(capped?.launchedThreadLog?.[MAX_LAUNCHED_THREAD_LOG_ENTRIES - 1]?.id).toBe(
      `cap-${MAX_LAUNCHED_THREAD_LOG_ENTRIES + 4}`,
    );

    // Rewind clears supplemental transcript history including launchedThreadLog.
    await store.appendThreadRewind({
      backend: "codex",
      threadId: "parent-1",
      rewind: {
        id: "rewind-1",
        occurredAt: 5_000,
        removedTurnCount: 1,
      },
    });
    const afterRewind = await store.getThreadOverlayState({
      backend: "codex",
      threadId: "parent-1",
    });
    expect(afterRewind?.launchedThreadLog).toBeUndefined();
  });
});

describe("create_instance_thread launchedThreadLog recording", () => {
  function buildFederationCase(options?: {
    operatorApproved?: boolean;
    resolveMessageOrigin?: () => { kind: "pwragent" };
  }) {
    const appendLaunchedThread = vi.fn<
      (params: {
        backend: string;
        threadId: string;
        launch: ThreadLaunchedThread;
      }) => Promise<void>
    >(async () => undefined);
    const onLaunchedThreadRecorded = vi.fn(async () => undefined);
    const materializeDirectoryLaunchpad = vi.fn(async () => ({
      backend: "claude" as const,
      threadId: "remote-child-7",
      executionMode: "default" as const,
      workMode: "worktree" as const,
      turnId: "turn-9",
    }));
    const remoteTarget = { scope: "remote" as const, instanceId: "peer-m3" };
    const runtime = {
      health: vi.fn(async () => ({
        enabled: true,
        instanceId: "local-m5",
        instanceLabel: "M5 Max",
        peers: [
          {
            id: "peer-m3",
            label: "M3 Studio",
            role: "client",
            status: "connected",
            capabilities: ["thread_navigation"],
          },
        ],
      })),
      localBackend: vi.fn(() => ({
        getNavigationQueryPage: vi.fn(),
        getNavigationLaunchpadConfig: vi.fn(),
        materializeDirectoryLaunchpad: vi.fn(),
        getNavigationSelectedDetail: vi.fn(),
      })),
      remoteBackend: vi.fn(() => ({
        materializeDirectoryLaunchpad,
      })),
      remoteNavigationQueryPage: vi.fn(async () => ({
        protocol: 2,
        ownerEpoch: "owner",
        generation: "fixture",
        countsRevision: "rev",
        entries: [],
        directories: [{ key: "dir:/repo/atlas", label: "atlas", path: "/repo/atlas" }],
        complete: true,
      })),
      remoteNavigationLaunchpadConfig: vi.fn(async () => ({
        protocol: 2,
        revision: "config",
        directoryKey: "dir:/repo/atlas",
        defaults: { backend: "claude", executionMode: "default", workMode: "worktree" },
      })),
      mountCreatedThreadOnTurnViewers: vi.fn(async () => undefined),
      resolveRemoteTarget: vi.fn(() => remoteTarget),
    } as unknown as DesktopFederationRuntime;

    const handler = createFederationAgentToolsHandler({
      runtime: () => runtime,
      collectHostInfo: async () => ({
        hostname: "m5-max",
        platform: "darwin",
        arch: "arm64",
        cpuCount: 16,
        totalMemoryBytes: 64 * 1024 * 1024 * 1024,
      }),
      targetStore: {
        listRemoteThreadTargets: vi.fn(async () => []),
        rememberRemoteThreadTarget: vi.fn(async (params) => ({
          ...params,
          observedAt: params.observedAt ?? 1_000,
        })),
        appendLaunchedThread,
      },
      onLaunchedThreadRecorded,
      resolveCallerExecutionMode: () => "default",
      ...(options?.operatorApproved ? { operatorApproved: true } : {}),
      ...(options?.resolveMessageOrigin ? { resolveMessageOrigin: options.resolveMessageOrigin } : {}),
    });

    return {
      appendLaunchedThread,
      onLaunchedThreadRecorded,
      invoke: () =>
        handler({
          operation: "create_instance_thread",
          context: {
            backend: "codex",
            threadId: "parent-thread-1",
            turnId: "turn-1",
          },
          args: {
            instanceId: "peer-m3",
            projectKey: "dir:/repo/atlas",
            input: "Audit webhook retry metrics and add bounds.",
          },
        }),
    };
  }

  it("records compact launchedThreadLog metadata (never prompt text) and emits notification for agent calls", async () => {
    const scenario = buildFederationCase();
    const response = await scenario.invoke();
    expect(response).toMatchObject({ ok: true });
    expect(scenario.appendLaunchedThread).toHaveBeenCalledTimes(1);
    const recordedCall = scenario.appendLaunchedThread.mock.calls[0]?.[0];
    expect(recordedCall).toBeDefined();
    expect(recordedCall).toMatchObject({
      backend: "codex",
      threadId: "parent-thread-1",
      launch: {
        source: "create_instance_thread",
        projectLabel: "atlas",
        startedThread: {
          backend: "claude",
          threadId: "remote-child-7",
          instanceId: "peer-m3",
          instanceLabel: "M3 Studio",
        },
      },
    });
    // Prompt text must never be persisted into SQLite threads.payload.
    expect("prompt" in (recordedCall!.launch as Record<string, unknown>)).toBe(false);
    expect(scenario.onLaunchedThreadRecorded).toHaveBeenCalledTimes(1);
  });

  it("skips launchedThreadLog recording for operator to-do dispatch and ephemeral Star Map intake", async () => {
    const todoDispatch = buildFederationCase({ operatorApproved: true });
    expect(await todoDispatch.invoke()).toMatchObject({ ok: true });
    expect(todoDispatch.appendLaunchedThread).not.toHaveBeenCalled();
    expect(todoDispatch.onLaunchedThreadRecorded).not.toHaveBeenCalled();

    const intake = buildFederationCase({
      resolveMessageOrigin: () => ({ kind: "pwragent" }),
    });
    expect(await intake.invoke()).toMatchObject({ ok: true });
    expect(intake.appendLaunchedThread).not.toHaveBeenCalled();
    expect(intake.onLaunchedThreadRecorded).not.toHaveBeenCalled();
  });
});

describe("handoff_task launchedThreadLog persistence and event scoping", () => {
  it("persists compact metadata via backend-registry wiring, emits thread/launchedThreads/updated, and does not trigger ROW_CHANGE_METHODS", async () => {
    expect(navigationQueryEventRequiresRefresh("thread/launchedThreads/updated")).toBe(false);

    const codexClient = new MockBackendClient({
      threads: [
        {
          id: "handoff-parent-1",
          title: "Parent thread",
          titleSource: "explicit",
          source: "codex",
          updatedAt: 1_000,
          linkedDirectories: [],
        },
      ],
      startThreadResult: { threadId: "handoff-child-1" },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: store,
      threadTitleGenerationService: null,
    });
    onTestFinished(() => registry.close());

    const launchedEvents: AgentEvent[] = [];
    registry.onEvent((event) => {
      if (event.notification.method === "thread/launchedThreads/updated") {
        launchedEvents.push(event);
      }
    });

    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "handoff-parent-1",
          turnId: "turn-live-1",
          turn: { id: "turn-live-1" },
        },
      },
    });

    const result = await registry.handoffResearchWorker(
      {
        operation: "handoff_task",
        context: {
          backend: "codex",
          threadId: "handoff-parent-1",
          turnId: "turn-live-1",
          callId: "call-handoff-1",
        },
        args: {
          task: "Full secret prompt that must stay out of threads.payload.",
          title: "Verify cache bounds",
          workspaceMode: "none",
          groupingMode: "none",
          messagingAttachment: "none",
        },
      },
      () => {},
    );

    expect(result).toMatchObject({
      ok: true,
      data: { threadId: "handoff-child-1" },
    });

    const overlay = await store.getThreadOverlayState({
      backend: "codex",
      threadId: "handoff-parent-1",
    });
    expect(overlay?.launchedThreadLog).toHaveLength(1);
    const recorded = overlay?.launchedThreadLog?.[0] as Record<string, unknown>;
    expect(recorded).toMatchObject({
      id: "handoff:codex:handoff-parent-1:turn-live-1:call-handoff-1",
      source: "handoff_task",
      title: "Verify cache bounds",
      seedMode: "clean",
      groupingMode: "none",
      workspaceMode: "none",
      startedThread: {
        backend: "codex",
        threadId: "handoff-child-1",
      },
    });
    expect("prompt" in recorded).toBe(false);

    expect(launchedEvents).toHaveLength(1);
    expect(launchedEvents[0]).toMatchObject({
      backend: "codex",
      notification: {
        method: "thread/launchedThreads/updated",
        params: {
          threadId: "handoff-parent-1",
          launchId: "handoff:codex:handoff-parent-1:turn-live-1:call-handoff-1",
        },
      },
    });
  });

  it("records turnStartFailure and swallows appendLaunchedThread errors without failing the handoff", async () => {
    const codexClient = new MockBackendClient({
      threads: [
        {
          id: "handoff-parent-err",
          title: "Parent thread",
          titleSource: "explicit",
          source: "codex",
          updatedAt: 1_000,
          linkedDirectories: [],
        },
      ],
      startThreadResult: { threadId: "handoff-child-err" },
    });
    vi.spyOn(codexClient, "startTurn").mockRejectedValueOnce(new Error("initial turn rejected"));
    const appendSpy = vi
      .spyOn(store, "appendLaunchedThread")
      .mockRejectedValueOnce(new Error("sqlite busy"));

    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: store,
      threadTitleGenerationService: null,
    });
    onTestFinished(() => registry.close());

    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "handoff-parent-err",
          turnId: "turn-live-2",
          turn: { id: "turn-live-2" },
        },
      },
    });

    const result = await registry.handoffResearchWorker(
      {
        operation: "handoff_task",
        context: {
          backend: "codex",
          threadId: "handoff-parent-err",
          turnId: "turn-live-2",
          callId: "call-handoff-2",
        },
        args: {
          task: "Check fallback behavior",
          title: "Fallback check",
          workspaceMode: "none",
          groupingMode: "none",
          messagingAttachment: "none",
        },
      },
      () => {},
    );

    expect(result).toMatchObject({
      ok: true,
      data: {
        threadId: "handoff-child-err",
        turnStartFailure: { phase: "turn", message: "initial turn rejected" },
      },
    });
    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: "codex",
        threadId: "handoff-parent-err",
        launch: expect.objectContaining({
          turnStartFailure: "initial turn rejected",
        }),
      }),
    );
  });
});
