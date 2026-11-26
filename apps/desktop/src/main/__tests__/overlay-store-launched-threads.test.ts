import { rmSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_LAUNCHED_THREAD_LOG_ENTRIES,
  type ThreadLaunchedThread,
} from "@pwragent/shared/contracts/navigation";
import { createFederationAgentToolsHandler } from "../federation/federation-agent-tools-service";
import type { DesktopFederationRuntime } from "../federation/federation-runtime";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
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
    prompt: "Check signing key TTL behavior.",
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
    const appendLaunchedThread = vi.fn(async () => undefined);
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

  it("records a launchedThreadLog entry and emits notification for agent calls", async () => {
    const scenario = buildFederationCase();
    const response = await scenario.invoke();
    expect(response).toMatchObject({ ok: true });
    expect(scenario.appendLaunchedThread).toHaveBeenCalledTimes(1);
    expect(scenario.appendLaunchedThread).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: "codex",
        threadId: "parent-thread-1",
        launch: expect.objectContaining({
          source: "create_instance_thread",
          projectLabel: "atlas",
          prompt: "Audit webhook retry metrics and add bounds.",
          startedThread: expect.objectContaining({
            backend: "claude",
            threadId: "remote-child-7",
            instanceId: "peer-m3",
            instanceLabel: "M3 Studio",
          }),
        }),
      }),
    );
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
