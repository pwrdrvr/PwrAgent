import {
  mockArchiveWorktreePresence,
  expectedDir,
  createAgentOverlay,
  flushAsync,
  createDeferred,
  gitTestEnv,
  git,
  expectEventually,
  sampleGitWorkingState,
  activeWorkingStateThread,
  multiProjectThread,
  createOverlayStoreMock,
  MockBackendClient,
  createKimiAcpRegistry,
} from "./helpers/backend-registry-fixture";
import { createDesktopBackendRegistry, registryModules } from "../app-server/backend-registry-wiring";
import { traceUnbornWorkspace } from "./helpers/unborn-workspace-trace";
import { ClaudeSessionStore } from "../claude/claude-session-store";
import * as gitExecutable from "../app-server/git-executable";
import * as gitHeadBranch from "../app-server/git-head-branch";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  describe,
  expect,
  it,
  onTestFinished,
  vi,
  type MockInstance,
} from "vitest";
import { buildNavigationSnapshot } from "@pwragent/shared/navigation-state";
import type {
  AcpBackendId,
  AppServerBackendKind,
  AppServerNotification,
  AppServerPendingRequestNotification,
  AppServerThreadSummary,
  LinkedDirectorySummary,
} from "@pwragent/shared/contracts/normalized-app-server";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import type { PrSummary, ThreadOverlayState } from "@pwragent/shared/contracts/navigation";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import { BACKGROUND_WORKTREE_WORKING_STATE_BATCH_SIZE, WORKTREE_WORKING_STATE_CACHE_MAX_AGE_MS } from "../app-server/thread-working-state-refresh-policy";
import { GitDirectoryService } from "../app-server/git-directory-service";
import gitSubprocessBudgets from "./fixtures/git-subprocess-budgets.json";
import navigationListingBudgets from "./fixtures/navigation-listing-budgets.json";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";
import { GitWorkingStateService } from "../app-server/git-working-state-service";
import { WorktreeArchiveService } from "../app-server/worktree-archive-service";

describe("DesktopBackendRegistry", () => {
  it("supplies authoritative directory scope and withdraws it before asynchronous membership recording", async () => {
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      overlayStore: createOverlayStoreMock({ executionMode: "default" }),
    });
    const events: AgentEvent[] = [];
    const row: AgentEvent = { backend: "codex", notification: {
      method: "thread/backgroundTasks/updated", params: { threadId: "hidden", tasks: [] },
    } };
    const internal = registryModules(registry).threadArchiveCoordinator as unknown as {
      prepareArchiveReferenceChanges(...args: unknown[]): Promise<void> | undefined;
    };
    let finish!: () => void;
    let recording: ReturnType<typeof vi.spyOn> | undefined;
    registry.onEvent((event) => { events.push(event); });
    try {
      registry.navigationDirectoryScope.remember({ coverage: { state: "complete" },
        threads: [{ id: "hidden", source: "codex", title: "Hidden", titleSource: "explicit", linkedDirectories: [], inbox: { inInbox: false } }],
        directories: [{ key: "project", kind: "directory", label: "Project", threadKeys: ["codex:hidden"], needsAttentionCount: 0 }],
      }, registry.navigationDirectoryScope.checkpoint());
      await registry.publishLocalEvent(row);
      expect(events.at(-1)?.navigationDirectoryScope).toEqual({ version: 1, directoryKeys: ["project"] });
      const gate = new Promise<void>((resolve) => { finish = resolve; });
      recording = vi.spyOn(internal, "prepareArchiveReferenceChanges").mockReturnValueOnce(gate);
      const membership = registry.publishLocalEvent({ backend: "codex", notification: {
        method: "navigation/threadDirectories/updated", params: { reason: "selected-thread", threadIds: ["hidden"] },
      } });
      expect(registry.navigationDirectoryScope.forEvent(row)).toBeUndefined();
      expect(events).toHaveLength(1);
      finish(); await membership;
      await registry.publishLocalEvent(row);
      expect(events.at(-1)?.navigationDirectoryScope).toBeUndefined();
    } finally { finish?.(); recording?.mockRestore(); await registry.close(); }
  });

  it("refreshes only owner-known directory Git state for federation requests", async () => {
    const invalidateDirectoryStatus = vi.fn();
    const readDirectoryStatusEntries = vi.fn(
      (directories: Array<{ key: string }>) =>
        (async function* () {
          for (const directory of directories) {
            yield {
              directoryKey: directory.key,
              gitStatus: {
                currentBranch: "main",
                syncState: "in-sync" as const,
              },
            };
          }
        })(),
    );
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      overlayStore: createOverlayStoreMock(),
      gitDirectoryService: {
        invalidateDirectoryStatus,
        readDirectoryStatusEntries,
      } as never,
    });
    const events: AgentEvent[] = [];
    const writeDirectoryGitStatus = vi.fn(async () => undefined);
    registry.setDirectoryGitStatusWriter(writeDirectoryGitStatus);
    const unsubscribe = registry.onEvent((event) => {
      events.push(event);
    });
    registry.rememberCompleteNavigationSnapshot({
      backend: "all",
      directories: [
        {
          key: "directory:/owner/repo",
          kind: "directory",
          label: "repo",
          path: "/owner/repo",
          threadKeys: ["codex:thread-1"],
          needsAttentionCount: 0,
        },
      ],
      fetchedAt: 1_000,
      inboxThreadKeys: ["codex:thread-1"],
      launchpadDefaults: {
        backend: "codex",
        executionMode: "default",
      },
      threads: [],
      unchanged: false,
    });

    try {
      await expect(registry.refreshDirectoryGitStatuses({
        directoryKeys: [
          "directory:/owner/repo",
          "directory:/viewer/secret",
        ],
        force: true,
      })).resolves.toEqual({ scheduledCount: 1 });

      expect(invalidateDirectoryStatus).not.toHaveBeenCalled();
      expect(readDirectoryStatusEntries).toHaveBeenCalledExactlyOnceWith([
        expect.objectContaining({
          key: "directory:/owner/repo",
          path: "/owner/repo",
        }),
      ], { userAction: true, caller: "directory-status-rpc" });
      expect(writeDirectoryGitStatus).toHaveBeenCalledExactlyOnceWith({
        directory: expect.objectContaining({
          key: "directory:/owner/repo",
          path: "/owner/repo",
        }),
        directoryKey: "directory:/owner/repo",
        fetchedAt: expect.any(Number),
        gitStatus: {
          currentBranch: "main",
          syncState: "in-sync",
        },
      });
      expect(events).toEqual([]);
    } finally {
      unsubscribe();
      await registry.close();
    }
  });

  it("coalesces targeted directory refreshes while the first probe is pending", async () => {
    let finishProbe: (() => void) | undefined;
    const probeGate = new Promise<void>((resolve) => {
      finishProbe = resolve;
    });
    const readDirectoryStatusEntries = vi.fn(
      (directories: Array<{ key: string }>) =>
        (async function* () {
          await probeGate;
          yield {
            directoryKey: directories[0]!.key,
            gitStatus: {
              currentBranch: "main",
              syncState: "in-sync" as const,
            },
          };
        })(),
    );
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      overlayStore: createOverlayStoreMock(),
      gitDirectoryService: {
        invalidateDirectoryStatus: vi.fn(),
        readDirectoryStatusEntries,
      } as never,
    });
    const writeDirectoryGitStatus = vi.fn(async () => undefined);
    registry.setDirectoryGitStatusWriter(writeDirectoryGitStatus);
    registry.rememberCompleteNavigationSnapshot({
      backend: "all",
      directories: [
        {
          key: "directory:/owner/repo",
          kind: "directory",
          label: "repo",
          path: "/owner/repo",
          threadKeys: [],
          needsAttentionCount: 0,
        },
      ],
      fetchedAt: 1_000,
      inboxThreadKeys: [],
      launchpadDefaults: {
        backend: "codex",
        executionMode: "default",
      },
      threads: [],
      unchanged: false,
    });

    try {
      await expect(registry.refreshDirectoryGitStatuses({
        directoryKeys: ["directory:/owner/repo"],
        force: true,
      })).resolves.toEqual({ scheduledCount: 1 });
      await expect(registry.refreshDirectoryGitStatuses({
        directoryKeys: ["directory:/owner/repo"],
        force: true,
      })).resolves.toEqual({ scheduledCount: 0 });
      expect(writeDirectoryGitStatus).not.toHaveBeenCalled();

      finishProbe?.();
      await vi.waitFor(() => {
        expect(writeDirectoryGitStatus).toHaveBeenCalledOnce();
      });
    } finally {
      await registry.close();
    }
  });

  it("hydrates review working state from the shared navigation cache", async () => {
    const worktreePath = "/worktrees/PwrAgnt";
    const gitWorkingState = {
      dirtyFiles: 0,
      dirtyAdditions: 0,
      dirtyDeletions: 0,
      untrackedFiles: 0,
      unpushedCommits: 0,
      baseBranch: "main",
      baseAheadCommitCount: 16,
    };
    const writeThreadGitWorkingStateCacheEntry = vi.fn(async () => undefined);
    const overlayStore = {
      ...createOverlayStoreMock(),
      readThreadGitWorkingStateCache: vi.fn(async () => ({
        [worktreePath]: {
          worktreePath,
          fetchedAt: 1_000,
          gitWorkingState,
        },
      })),
      writeThreadGitWorkingStateCacheEntry,
    };
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      overlayStore,
    });
    const thread: AppServerThreadSummary = {
      id: "thread-1",
      title: "PwrAgent federation dogfood PR #735",
      titleSource: "explicit",
      source: "codex",
      projectKey: worktreePath,
      linkedDirectories: [
        {
          id: "pwragent",
          kind: "worktree",
          label: "PwrAgnt",
          path: "/repos/PwrAgnt",
          worktreePath,
        },
        {
          id: "pwrsnap",
          kind: "local",
          label: "PwrSnap",
          path: "/repos/PwrSnap",
        },
      ],
    };

    try {
      await expect(
        registry.hydrateThreadGitWorkingStates([thread]),
      ).resolves.toEqual([{ ...thread, gitWorkingState }]);

      const updatedState = { ...gitWorkingState, baseAheadCommitCount: 17 };
      await registry.rememberThreadGitWorkingStateCacheEntry({
        worktreePath,
        fetchedAt: 2_000,
        gitWorkingState: updatedState,
      });
      await expect(
        registry.hydrateThreadGitWorkingStates([thread]),
      ).resolves.toEqual([{ ...thread, gitWorkingState: updatedState }]);
      expect(writeThreadGitWorkingStateCacheEntry).toHaveBeenCalledWith({
        worktreePath,
        fetchedAt: 2_000,
        gitWorkingState: updatedState,
      });
    } finally {
      await registry.close();
    }
  });

  it("probes missing working state for a multi-project messaging review", async () => {
    const worktreePath = "/worktrees/PwrAgnt";
    const gitWorkingState = {
      dirtyFiles: 0,
      dirtyAdditions: 0,
      dirtyDeletions: 0,
      untrackedFiles: 0,
      unpushedCommits: 0,
      baseBranch: "main",
      baseAheadCommitCount: 16,
    };
    const readWorkingStateEntries = vi.fn(() =>
      (async function* () {
        yield { worktreePath, gitWorkingState };
      })(),
    );
    const overlayStore = {
      ...createOverlayStoreMock(),
      readThreadGitWorkingStateCache: vi.fn(async () => ({})),
      writeThreadGitWorkingStateCacheEntry: vi.fn(async () => undefined),
    };
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      gitWorkingStateService: {
        readWorkingStateEntries,
      } as unknown as GitWorkingStateService,
      overlayStore,
    });
    const thread: AppServerThreadSummary = {
      id: "thread-1",
      title: "PwrAgent federation dogfood PR #735",
      titleSource: "explicit",
      source: "codex",
      projectKey: worktreePath,
      linkedDirectories: [
        {
          id: "pwragent",
          kind: "worktree",
          label: "PwrAgnt",
          path: "/repos/PwrAgnt",
          worktreePath,
        },
        {
          id: "pwrsnap",
          kind: "local",
          label: "PwrSnap",
          path: "/repos/PwrSnap",
        },
      ],
    };

    try {
      await expect(
        registry.hydrateThreadGitWorkingStates(
          [thread],
          { probeMissing: true },
        ),
      ).resolves.toEqual([{ ...thread, gitWorkingState }]);
      expect(readWorkingStateEntries).toHaveBeenCalledWith(
        [worktreePath],
        {
          acceptedPushedCommitShasByWorktreePath: {
            [worktreePath]: [],
          },
        },
      );
      expect(overlayStore.writeThreadGitWorkingStateCacheEntry)
        .toHaveBeenCalledWith(expect.objectContaining({
          worktreePath,
          gitWorkingState,
        }));
    } finally {
      await registry.close();
    }
  });

  it("reprobes stale cached working state for a multi-project messaging review", async () => {
    const worktreePath = "/worktrees/PwrAgnt";
    const staleGitWorkingState = {
      dirtyFiles: 0,
      dirtyAdditions: 0,
      dirtyDeletions: 0,
      untrackedFiles: 0,
      unpushedCommits: 0,
      baseBranch: "main",
      baseAheadCommitCount: 1,
    };
    const freshGitWorkingState = {
      ...staleGitWorkingState,
      baseAheadCommitCount: 16,
    };
    const readWorkingStateEntries = vi.fn(() =>
      (async function* () {
        yield { worktreePath, gitWorkingState: freshGitWorkingState };
      })(),
    );
    const overlayStore = {
      ...createOverlayStoreMock(),
      readThreadGitWorkingStateCache: vi.fn(async () => ({
        [worktreePath]: {
          worktreePath,
          fetchedAt: Date.now() - 31_000,
          gitWorkingState: staleGitWorkingState,
        },
      })),
      writeThreadGitWorkingStateCacheEntry: vi.fn(async () => undefined),
    };
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      gitWorkingStateService: {
        readWorkingStateEntries,
      } as unknown as GitWorkingStateService,
      overlayStore,
    });
    const thread: AppServerThreadSummary = {
      id: "thread-1",
      title: "PwrAgent federation dogfood PR #735",
      titleSource: "explicit",
      source: "codex",
      projectKey: worktreePath,
      linkedDirectories: [
        {
          id: "pwragent",
          kind: "worktree",
          label: "PwrAgnt",
          path: "/repos/PwrAgnt",
          worktreePath,
        },
        {
          id: "pwrsnap",
          kind: "local",
          label: "PwrSnap",
          path: "/repos/PwrSnap",
        },
      ],
    };

    try {
      await expect(
        registry.hydrateThreadGitWorkingStates(
          [thread],
          { probeMissing: true },
        ),
      ).resolves.toEqual([{ ...thread, gitWorkingState: freshGitWorkingState }]);
      expect(readWorkingStateEntries).toHaveBeenCalledTimes(1);
    } finally {
      await registry.close();
    }
  });

  it.each(["open", "closed", "merged"] as const)("preserves published %s PR heads in review working-state probes", async (lifecycleState) => {
    const worktreePath = "/worktrees/PwrAgnt";
    const attachedCommitSha = "a".repeat(40);
    const detachedCommitSha = "b".repeat(40);
    const mergedPr = (params: {
      number: number;
      commitShas: string[];
    }): PrSummary => ({
      provider: "github.com",
      number: params.number,
      org: "pwrdrvr",
      repo: "PwrAgent",
      state: "passing",
      lifecycleState,
      headSha: params.commitShas[0],
      url: `https://github.com/pwrdrvr/PwrAgent/pull/${params.number}`,
    });
    const readWorkingStateEntries = vi.fn(() =>
      (async function* () {
        yield {
          worktreePath,
          gitWorkingState: {
            dirtyFiles: 0,
            dirtyAdditions: 0,
            dirtyDeletions: 0,
            untrackedFiles: 0,
            unpushedCommits: 0,
            baseBranch: "main",
            baseAheadCommitCount: 16,
          },
        };
      })(),
    );
    const overlayStore = {
      ...createOverlayStoreMock({
        overlays: {
          "codex:thread-1": {
            backend: "codex",
            threadId: "thread-1",
            extraLinkedDirectories: [],
            detachedPrs: [mergedPr({
              number: 734,
              commitShas: [detachedCommitSha],
            })],
          },
        },
      }),
      readThreadGitWorkingStateCache: vi.fn(async () => ({})),
      writeThreadGitWorkingStateCacheEntry: vi.fn(async () => undefined),
    };
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      gitWorkingStateService: {
        readWorkingStateEntries,
      } as unknown as GitWorkingStateService,
      overlayStore,
    });
    const thread: AppServerThreadSummary & { prs: PrSummary[] } = {
      id: "thread-1",
      title: "PwrAgent federation dogfood PR #735",
      titleSource: "explicit",
      source: "codex",
      projectKey: worktreePath,
      linkedDirectories: [
        {
          id: "pwragent",
          kind: "worktree",
          label: "PwrAgnt",
          path: "/repos/PwrAgnt",
          worktreePath,
        },
        {
          id: "pwrsnap",
          kind: "local",
          label: "PwrSnap",
          path: "/repos/PwrSnap",
        },
      ],
      prs: [mergedPr({ number: 735, commitShas: ["c".repeat(40)] })],
    };
    registry.setThreadPullRequestCanonicalizer(async (prs) =>
      prs.map((pr) => pr.number === 735
        ? { ...pr, headSha: attachedCommitSha }
        : pr),
    );

    try {
      await registry.hydrateThreadGitWorkingStates(
        [thread],
        { probeMissing: true },
      );
      expect(readWorkingStateEntries).toHaveBeenCalledWith(
        [worktreePath],
        {
          acceptedPushedCommitShasByWorktreePath: {
            [worktreePath]: [attachedCommitSha, detachedCommitSha],
          },
        },
      );
    } finally {
      await registry.close();
    }
  });

  it("does not start an automatic Git fleet for inactive history", async () => {
    const readWorkingStateEntries = vi.fn();
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      overlayStore: createOverlayStoreMock(),
      gitWorkingStateService: { readWorkingStateEntries } as unknown as GitWorkingStateService,
    });
    const threads = Array.from({ length: 500 }, (_, index) =>
      multiProjectThread({ worktreePath: `/worktrees/inactive-${index}` }));
    expect(await registry.refreshThreadGitWorkingStates(threads)).toEqual({ scheduledCount: 0 });
    expect(readWorkingStateEntries).not.toHaveBeenCalled();
    await registry.close();
  });

  it("schedules a stale working-state probe without awaiting the Git fleet", async () => {
    // A navigation serving path must answer from cache. Holding the snapshot
    // until the fleet returns is what put a Git probe on every messaging
    // command and on every remote viewer's snapshot.
    const worktreePath = "/worktrees/PwrAgnt";
    let releaseProbe: (() => void) | undefined;
    const probeReleased = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    const readWorkingStateEntries = vi.fn(() =>
      (async function* () {
        await probeReleased;
        yield { worktreePath, gitWorkingState: sampleGitWorkingState };
      })(),
    );
    const overlayStore = {
      ...createOverlayStoreMock(),
      readThreadGitWorkingStateCache: vi.fn(async () => ({})),
      writeThreadGitWorkingStateCacheEntry: vi.fn(async () => undefined),
    };
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      gitWorkingStateService: {
        readWorkingStateEntries,
      } as unknown as GitWorkingStateService,
      overlayStore,
    });

    try {
      await expect(
        registry.refreshThreadGitWorkingStates([
          activeWorkingStateThread({ worktreePath }),
        ]),
      ).resolves.toEqual({ scheduledCount: 1 });
      expect(overlayStore.writeThreadGitWorkingStateCacheEntry)
        .not.toHaveBeenCalled();

      releaseProbe?.();
      await expectEventually(
        async () =>
          overlayStore.writeThreadGitWorkingStateCacheEntry.mock.calls.length,
        1,
      );
    } finally {
      releaseProbe?.();
      await registry.close();
    }
  });

  it("queues one focused refresh behind an automatic probe for the same worktree", async () => {
    const worktreePath = "/worktrees/PwrAgnt";
    const firstAcceptedPushedCommitSha = "a".repeat(40);
    const latestAcceptedPushedCommitSha = "b".repeat(40);
    const automaticState = { ...sampleGitWorkingState, dirtyFiles: 1 };
    const focusedState = { ...sampleGitWorkingState, dirtyFiles: 2 };
    let releaseAutomaticProbe: (() => void) | undefined;
    const automaticProbeReleased = new Promise<void>((resolve) => {
      releaseAutomaticProbe = resolve;
    });
    let activeProbes = 0;
    let maxActiveProbes = 0;
    const readWorkingStateEntries = vi.fn((paths: string[]) =>
      (async function* () {
        const call = readWorkingStateEntries.mock.calls.length;
        activeProbes += 1;
        maxActiveProbes = Math.max(maxActiveProbes, activeProbes);
        try {
          if (call === 1) {
            await automaticProbeReleased;
          }
          yield {
            worktreePath: paths[0]!,
            gitWorkingState: call === 1 ? automaticState : focusedState,
          };
        } finally {
          activeProbes -= 1;
        }
      })(),
    );
    const overlayStore = {
      ...createOverlayStoreMock(),
      readThreadGitWorkingStateCache: vi.fn(async () => ({})),
      writeThreadGitWorkingStateCacheEntry: vi.fn(async () => undefined),
    };
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      gitWorkingStateService: {
        readWorkingStateEntries,
      } as unknown as GitWorkingStateService,
      overlayStore,
    });

    try {
      await expect(
        registry.refreshThreadGitWorkingStates([
          activeWorkingStateThread({ worktreePath }),
        ]),
      ).resolves.toEqual({ scheduledCount: 1 });
      await expectEventually(
        async () => readWorkingStateEntries.mock.calls.length,
        1,
      );

      expect(registry.scheduleWorktreeGitWorkingStateRefresh({
        worktreePath,
        acceptedPushedCommitShas: [firstAcceptedPushedCommitSha],
      })).toBe(true);
      expect(registry.scheduleWorktreeGitWorkingStateRefresh({
        worktreePath,
        acceptedPushedCommitShas: [latestAcceptedPushedCommitSha],
      })).toBe(false);
      expect(readWorkingStateEntries).toHaveBeenCalledTimes(1);

      releaseAutomaticProbe?.();
      await expectEventually(
        async () => readWorkingStateEntries.mock.calls.length,
        2,
      );
      await expectEventually(
        async () => overlayStore.writeThreadGitWorkingStateCacheEntry.mock.calls.length,
        2,
      );

      expect(maxActiveProbes).toBe(1);
      expect(readWorkingStateEntries.mock.calls[1]).toEqual([
        [worktreePath],
        {
          acceptedPushedCommitShasByWorktreePath: {
            [worktreePath]: [latestAcceptedPushedCommitSha],
          },
        },
      ]);
      expect(registry.getThreadGitWorkingStateCache().get(worktreePath))
        .toMatchObject({ gitWorkingState: focusedState });
    } finally {
      releaseAutomaticProbe?.();
      await registry.close();
    }
  });

  it("caps a background working-state round and rotates the oldest probe forward", async () => {
    // Navigation hands over a stable thread order. Without rotation the same
    // prefix would win every round and the tail would never converge.
    const readWorkingStateEntries = vi.fn((paths: string[]) =>
      (async function* () {
        for (const path of paths) {
          yield { worktreePath: path, gitWorkingState: sampleGitWorkingState };
        }
      })(),
    );
    const worktreePaths = Array.from(
      { length: BACKGROUND_WORKTREE_WORKING_STATE_BATCH_SIZE + 1 },
      (_unused, index) => `/worktrees/repo-${index}`,
    );
    const overlayStore = {
      ...createOverlayStoreMock(),
      readThreadGitWorkingStateCache: vi.fn(async () =>
        Object.fromEntries(worktreePaths.map((worktreePath, index) => [
          worktreePath,
          {
            worktreePath,
            gitWorkingState: sampleGitWorkingState,
            // All stale; the highest index was probed most recently.
            fetchedAt: 1_000 + index,
          },
        ])),
      ),
      writeThreadGitWorkingStateCacheEntry: vi.fn(async () => undefined),
    };
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      gitWorkingStateService: {
        readWorkingStateEntries,
      } as unknown as GitWorkingStateService,
      overlayStore,
    });

    try {
      await expect(
        registry.refreshThreadGitWorkingStates(
          // Reversed, so a naive prefix would take the freshest eight and
          // only rotation can produce the ascending expectation below.
          worktreePaths
            .map((worktreePath) => activeWorkingStateThread({ worktreePath }))
            .reverse(),
        ),
      ).resolves.toEqual({
        scheduledCount: BACKGROUND_WORKTREE_WORKING_STATE_BATCH_SIZE,
      });
      // The round is scheduled, not awaited, so the fleet call lands some
      // microtasks after the promise above settles.
      await expectEventually(
        async () => readWorkingStateEntries.mock.calls.length,
        1,
      );
      expect(readWorkingStateEntries).toHaveBeenCalledWith(
        worktreePaths.slice(0, BACKGROUND_WORKTREE_WORKING_STATE_BATCH_SIZE),
        expect.anything(),
      );
    } finally {
      await registry.close();
    }
  });

  it("leaves a fresh worktree alone for the rest of its window", async () => {
    // Freshness is the only gate on this lane. Without it every messaging
    // command and every federated viewer's poll runs a Git fleet again —
    // the exact cost the lane exists to remove.
    const worktreePath = "/worktrees/PwrAgnt";
    const readWorkingStateEntries = vi.fn((paths: string[]) =>
      (async function* () {
        for (const path of paths) {
          yield { worktreePath: path, gitWorkingState: sampleGitWorkingState };
        }
      })(),
    );
    const overlayStore = {
      ...createOverlayStoreMock(),
      readThreadGitWorkingStateCache: vi.fn(async () => ({
        [worktreePath]: {
          worktreePath,
          gitWorkingState: sampleGitWorkingState,
          fetchedAt: Date.now(),
        },
      })),
      writeThreadGitWorkingStateCacheEntry: vi.fn(async () => undefined),
    };
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      gitWorkingStateService: {
        readWorkingStateEntries,
      } as unknown as GitWorkingStateService,
      overlayStore,
    });

    try {
      await expect(
        registry.refreshThreadGitWorkingStates([
          activeWorkingStateThread({ worktreePath }),
        ]),
      ).resolves.toEqual({ scheduledCount: 0 });
      expect(readWorkingStateEntries).not.toHaveBeenCalled();
    } finally {
      await registry.close();
    }
  });

  it("keeps repeated navigation inside the automatic fleet-round budget", async () => {
    const worktreePath = "/worktrees/PwrAgnt";
    let releaseProbe: (() => void) | undefined;
    const probeReleased = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    const readWorkingStateEntries = vi.fn((paths: string[]) =>
      (async function* () {
        await probeReleased;
        for (const path of paths) {
          yield { worktreePath: path, gitWorkingState: sampleGitWorkingState };
        }
      })(),
    );
    const overlayStore = {
      ...createOverlayStoreMock(),
      readThreadGitWorkingStateCache: vi.fn(async () => ({})),
      writeThreadGitWorkingStateCacheEntry: vi.fn(async () => undefined),
    };
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      gitWorkingStateService: {
        readWorkingStateEntries,
      } as unknown as GitWorkingStateService,
      overlayStore,
    });
    const worktreePaths = Array.from(
      { length: gitSubprocessBudgets.automaticFleet.worktreeCount },
      (_unused, index) => `${worktreePath}-${index}`,
    );
    const threads = worktreePaths.map((path) =>
      activeWorkingStateThread({ worktreePath: path }),
    );
    expect(Math.ceil(
      worktreePaths.length / BACKGROUND_WORKTREE_WORKING_STATE_BATCH_SIZE,
    )).toBe(gitSubprocessBudgets.automaticFleet.baselineRoundsStarted);

    try {
      await expect(
        registry.refreshThreadGitWorkingStates(threads),
      ).resolves.toEqual({
        scheduledCount: BACKGROUND_WORKTREE_WORKING_STATE_BATCH_SIZE,
      });
      for (
        let request = 1;
        request < gitSubprocessBudgets.automaticFleet.navigationRequestsWhileInFlight;
        request += 1
      ) {
        await expect(
          registry.refreshThreadGitWorkingStates(threads),
        ).resolves.toEqual({ scheduledCount: 0 });
      }
      await expectEventually(
        async () => readWorkingStateEntries.mock.calls.length,
        gitSubprocessBudgets.automaticFleet.maxRoundsStarted,
      );
      expect(readWorkingStateEntries.mock.calls.map(([paths]) => paths))
        .toEqual([
          worktreePaths.slice(0, BACKGROUND_WORKTREE_WORKING_STATE_BATCH_SIZE),
        ]);
    } finally {
      releaseProbe?.();
      await registry.close();
    }
  });

  it("probes a worktree shared by many threads once, whichever registry lane asks", async () => {
    // Two dozen threads open in one checkout is an ordinary day, and every row
    // shows that checkout's +/- chips. Everything here that names a thread —
    // the fleet round, each thread's PR heads, the durable row, the
    // notification, a burst of turn completions — must collapse to the
    // worktree, or Git and sqlite cost scale with the thread count. The other
    // tests stub the service; this one runs the real service, its read cache,
    // and a real state database behind the registry.
    const budget = gitSubprocessBudgets.sharedWorktree;
    const sharedPath = "/worktrees/shared-checkout";
    const otherPath = "/worktrees/other-checkout";
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const temp = createTempStateDb("pwragent-shared-worktree-working-state-");
    const db = StateDb.open(temp.dbPath);
    onTestFinished(() => {
      db.close();
      removeTempStateDbDir(temp.tempDir);
      vi.unstubAllEnvs();
    });

    const gitCalls: Array<{ cwd: string; args: string[]; input?: string }> = [];
    let numstatGate: Promise<void> | undefined;
    let releaseNumstat: (() => void) | undefined;
    const runGit = async (
      cwd: string,
      args: string[],
      _env?: NodeJS.ProcessEnv,
      input?: string,
    ): Promise<string> => {
      gitCalls.push({ cwd, args, input });
      if (args.includes("--numstat")) {
        await numstatGate;
        return "5509\t0\tsrc/kernel.cu\n";
      }
      if (args.includes("status")) return " M src/kernel.cu\0";
      if (args[args.length - 1] === "remote") return "origin\n";
      if (args.includes("rev-list")) return "0\n";
      throw new Error(`unexpected git invocation: ${args.join(" ")}`);
    };
    const probesOf = (cwd: string): number =>
      gitCalls.filter((call) => call.cwd === cwd && call.args.includes("--numstat")).length;

    const prHeadShas = ["a", "b", "c"].map((digit) => digit.repeat(40));
    const publishedPr = (number: number, headSha: string): PrSummary => ({
      provider: "github.com",
      number,
      org: "pwrdrvr",
      repo: "PwrAgent",
      state: "passing",
      lifecycleState: "open",
      headSha,
      url: `https://github.com/pwrdrvr/PwrAgent/pull/${number}`,
    });
    const sharedThreads: Array<AppServerThreadSummary & { prs?: PrSummary[] }> =
      Array.from({ length: budget.threadsSharingWorktree }, (_unused, index) => ({
        ...activeWorkingStateThread({ worktreePath: sharedPath }),
        id: `thread-shared-${index}`,
        ...(prHeadShas[index]
          ? { prs: [publishedPr(index + 1, prHeadShas[index])] }
          : {}),
      }));
    // Last, so a selection that capped before deduplicating would fill the
    // batch with copies of the shared path and never reach it.
    const threads = [
      ...sharedThreads,
      { ...activeWorkingStateThread({ worktreePath: otherPath }), id: "thread-other" },
    ];

    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      gitWorkingStateService: new GitWorkingStateService({ runGit }),
      overlayStore: new SqliteOverlayStore(db),
    });
    const updatedPaths: string[] = [];
    const unsubscribe = registry.onEvent((event) => {
      if (event.notification.method === "navigation/threadGitWorkingState/updated") {
        updatedPaths.push(
          (event.notification.params as { worktreePath: string }).worktreePath,
        );
      }
    });

    try {
      const { writes } = await measureSqliteWrites(async () => {
        await expect(registry.refreshThreadGitWorkingStates(threads))
          .resolves.toEqual({ scheduledCount: 2 });
        await expectEventually(async () => updatedPaths.length, 2);
      });
      expectSqliteWriteBudget({ scenario: "shared-worktree-working-state-round", writes,
        note: "One automatic working-state round over 24 threads in one checkout plus 1 in another: one cache-row commit per probed worktree (2), never per thread (25). ~12.4 KB/commit; every probe commits even when unchanged, so the selected checkout's 60 s refresh is ~17.8 MB/day and the 30 s automatic floor caps a continuously browsed checkout at ~35.6 MB/day, the same for 1 or 24 threads sharing it" });

      expect(probesOf(sharedPath)).toBe(budget.probesPerRound);
      expect(probesOf(otherPath)).toBe(budget.probesPerRound);
      expect(gitCalls.filter((call) => call.cwd === sharedPath))
        .toHaveLength(budget.gitCommandsPerProbe);
      expect(updatedPaths.filter((path) => path === sharedPath)).toHaveLength(1);
      // Each thread's PR heads join the one probe instead of keying their own.
      expect(gitCalls
        .filter((call) => call.cwd === sharedPath && call.args.includes("rev-list"))
        .map((call) => call.input))
        .toEqual([`${prHeadShas.map((sha) => `^${sha}`).join("\n")}\n`]);

      const hydrated = await registry.hydrateThreadGitWorkingStates(threads);
      for (const thread of hydrated.slice(0, sharedThreads.length)) {
        expect(thread.gitWorkingState).toMatchObject({
          dirtyAdditions: 5509,
          dirtyDeletions: 0,
        });
      }
      // Every window, messaging command and federated viewer asks again.
      // Let the first round's bookkeeping settle so this measures freshness,
      // not the in-flight gate.
      await new Promise((resolve) => setTimeout(resolve, 0));
      for (let request = 0; request < budget.threadsSharingWorktree; request += 1) {
        await expect(registry.refreshThreadGitWorkingStates(threads))
          .resolves.toEqual({ scheduledCount: 0 });
      }
      expect(probesOf(sharedPath)).toBe(budget.probesPerRound);

      // Every thread finishes a turn. The first completion's probe is still
      // in Git when the rest arrive, the way a real burst lands. They fold
      // into one rerun, which must not be served from the pre-burst read.
      numstatGate = new Promise<void>((resolve) => {
        releaseNumstat = resolve;
      });
      registry.invalidateWorktreeWorkingState(sharedPath);
      expect(registry.scheduleWorktreeGitWorkingStateRefresh({
        worktreePath: sharedPath,
      })).toBe(true);
      await expectEventually(
        async () => probesOf(sharedPath),
        budget.probesPerRound + 1,
      );
      for (let request = 1; request < sharedThreads.length; request += 1) {
        registry.invalidateWorktreeWorkingState(sharedPath);
        expect(registry.scheduleWorktreeGitWorkingStateRefresh({
          worktreePath: sharedPath,
        })).toBe(false);
      }
      releaseNumstat?.();
      const afterBurst = budget.probesPerRound + budget.turnCompletionBurstProbes;
      await expectEventually(async () => probesOf(sharedPath), afterBurst);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(probesOf(sharedPath)).toBe(afterBurst);
      expect(probesOf(otherPath)).toBe(budget.probesPerRound);
      // Unchanged state publishes nothing, however many threads it serves.
      expect(updatedPaths.filter((path) => path === sharedPath)).toHaveLength(1);
    } finally {
      releaseNumstat?.();
      unsubscribe();
      await registry.close();
    }
  });

  it("re-probes a stale worktree that hydration already stamped", async () => {
    // The serving path hydrates from the cache and then schedules, so every
    // thread reaching the scheduler carries a `gitWorkingState`. Deciding
    // staleness from that field instead of from the cache entry's age makes
    // the probe inert the moment a worktree has any row: the operator commits
    // from a terminal and the chips never move again.
    const worktreePath = "/worktrees/PwrAgnt";
    const readWorkingStateEntries = vi.fn((paths: string[]) =>
      (async function* () {
        for (const path of paths) {
          yield { worktreePath: path, gitWorkingState: sampleGitWorkingState };
        }
      })(),
    );
    const overlayStore = {
      ...createOverlayStoreMock(),
      readThreadGitWorkingStateCache: vi.fn(async () => ({
        [worktreePath]: {
          worktreePath,
          gitWorkingState: sampleGitWorkingState,
          fetchedAt: Date.now() - WORKTREE_WORKING_STATE_CACHE_MAX_AGE_MS - 1,
        },
      })),
      writeThreadGitWorkingStateCacheEntry: vi.fn(async () => undefined),
    };
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      gitWorkingStateService: {
        readWorkingStateEntries,
      } as unknown as GitWorkingStateService,
      overlayStore,
    });
    const hydrated = await registry.hydrateThreadGitWorkingStates([
      activeWorkingStateThread({ worktreePath }),
    ]);

    try {
      expect(hydrated[0]?.gitWorkingState).toEqual(sampleGitWorkingState);
      await expect(
        registry.refreshThreadGitWorkingStates(hydrated),
      ).resolves.toEqual({ scheduledCount: 1 });
    } finally {
      await registry.close();
    }
  });

  it("schedules a single-directory thread the chips also need", async () => {
    // The multi-project narrowing belongs to the awaited review probe, which
    // uses working state to disambiguate a review target. The background lane
    // feeds the dirty/unpushed chips every thread shows, so inheriting that
    // filter would leave a federated viewer's ordinary threads frozen.
    const worktreePath = "/worktrees/PwrAgnt";
    const readWorkingStateEntries = vi.fn((paths: string[]) =>
      (async function* () {
        for (const path of paths) {
          yield { worktreePath: path, gitWorkingState: sampleGitWorkingState };
        }
      })(),
    );
    const overlayStore = {
      ...createOverlayStoreMock(),
      readThreadGitWorkingStateCache: vi.fn(async () => ({})),
      writeThreadGitWorkingStateCacheEntry: vi.fn(async () => undefined),
    };
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      gitWorkingStateService: {
        readWorkingStateEntries,
      } as unknown as GitWorkingStateService,
      overlayStore,
    });
    const singleDirectoryThread = (path: string): AppServerThreadSummary => {
      const thread = activeWorkingStateThread({ worktreePath: path });
      return {
        ...thread,
        linkedDirectories: thread.linkedDirectories.slice(0, 1),
      };
    };
    const reviewWorktreePath = "/worktrees/PwrSnap";

    try {
      await expect(
        registry.refreshThreadGitWorkingStates([
          singleDirectoryThread(worktreePath),
        ]),
      ).resolves.toEqual({ scheduledCount: 1 });

      // The awaited review probe keeps the narrowing: one workspace needs no
      // working state to disambiguate it.
      await registry.hydrateThreadGitWorkingStates(
        [singleDirectoryThread(reviewWorktreePath)],
        { probeMissing: true },
      );
      expect(readWorkingStateEntries.mock.calls.flatMap(([paths]) => paths))
        .not.toContain(reviewWorktreePath);
    } finally {
      await registry.close();
    }
  });

  it("publishes a background probe so already-open surfaces see it", async () => {
    // The durable cache alone only reaches the next full navigation snapshot.
    // Without this the lane's whole point — a federated viewer and a local
    // window converging at the same rate — held only for the viewer.
    const worktreePath = "/worktrees/PwrAgnt";
    const readWorkingStateEntries = vi.fn((paths: string[]) =>
      (async function* () {
        for (const path of paths) {
          yield { worktreePath: path, gitWorkingState: sampleGitWorkingState };
        }
      })(),
    );
    const overlayStore = {
      ...createOverlayStoreMock(),
      readThreadGitWorkingStateCache: vi.fn(async () => ({})),
      writeThreadGitWorkingStateCacheEntry: vi.fn(async () => undefined),
    };
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      gitWorkingStateService: {
        readWorkingStateEntries,
      } as unknown as GitWorkingStateService,
      overlayStore,
    });
    const workingStateEvents: AgentEvent[] = [];
    const unsubscribe = registry.onEvent((event) => {
      if (
        event.notification.method === "navigation/threadGitWorkingState/updated"
      ) {
        workingStateEvents.push(event);
      }
    });

    try {
      await registry.refreshThreadGitWorkingStates([
        activeWorkingStateThread({ worktreePath }),
      ]);
      await expectEventually(async () => workingStateEvents.length, 1);
      expect(workingStateEvents[0]?.notification.params).toEqual(
        expect.objectContaining({
          gitWorkingState: sampleGitWorkingState,
          worktreePath,
        }),
      );
    } finally {
      unsubscribe();
      await registry.close();
    }
  });

  it("does not publish navigation for unchanged Git probes", async () => {
    const registry = createDesktopBackendRegistry({ codexClient: new MockBackendClient({ threads: [] }), overlayStore: {
      ...createOverlayStoreMock(), readThreadGitWorkingStateCache: vi.fn(async () => ({})),
      writeThreadGitWorkingStateCacheEntry: vi.fn(async () => undefined),
    } });
    const events: AgentEvent[] = [];
    const unsubscribe = registry.onEvent((event) => { events.push(event); });
    try {
      for (let i = 0; i < 27; i++) await registry.rememberThreadGitWorkingStateCacheEntry({
        worktreePath: "/fixture/repo", fetchedAt: i, gitWorkingState: { ...sampleGitWorkingState },
      });
      expect(events.filter((event) => event.notification.method === "navigation/threadGitWorkingState/updated")).toHaveLength(1);
      await registry.rememberThreadGitWorkingStateCacheEntry({ worktreePath: "/fixture/repo", fetchedAt: 28 });
      expect(events.filter((event) => event.notification.method === "navigation/threadGitWorkingState/updated")).toHaveLength(2);
    } finally { unsubscribe(); await registry.close(); }
  });

  it("bypasses completed thread-list cache entries for forced navigation refreshes", async () => {
    const codexClient = new MockBackendClient({
      threads: [
        {
          id: "thread-codex",
          title: "Codex thread",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [],
        },
      ],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
    });

    await expect(
      registry.listThreads({
        backend: "codex",
        callerReason: "navigation-snapshot",
      }),
    ).resolves.toMatchObject([{ id: "thread-codex" }]);
    const initialReadCount = codexClient.listThreadsCallCount;

    codexClient.setThreads([
      {
        id: "thread-codex-new",
        title: "New Codex thread",
        titleSource: "explicit",
        source: "codex",
        linkedDirectories: [],
      },
    ]);

    await expect(
      registry.listThreads({
        backend: "codex",
        callerReason: "navigation-snapshot",
      }),
    ).resolves.toMatchObject([{ id: "thread-codex" }]);
    expect(codexClient.listThreadsCallCount).toBe(initialReadCount);

    await expect(
      registry.listThreads({
        backend: "codex",
        callerReason: "navigation-snapshot",
        forceRefresh: true,
      }),
    ).resolves.toMatchObject([{ id: "thread-codex-new" }]);

    expect(codexClient.listThreadsCallCount).toBeGreaterThan(initialReadCount);

    await registry.close();
  });

  it("keeps cheap navigation lists separate from directory-enriched thread lists", async () => {
    const codexClient = new MockBackendClient({
      threads: [
        {
          id: "thread-1",
          title: "Codex thread",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [],
        },
      ],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
    });

    await registry.listThreads({
      backend: "codex",
      callerReason: "startup-prewarm",
    });
    expect(codexClient.lastListThreadsParams).toMatchObject({
      enrichDirectories: false,
    });

    await registry.listThreads({
      backend: "codex",
      callerReason: "workspace-handoff",
      enrichDirectories: true,
    });

    expect(codexClient.listThreadsCallCount).toBe(2);
    expect(codexClient.lastListThreadsParams).toMatchObject({
      enrichDirectories: true,
    });

    await registry.close();
  });

  it("shares an in-flight enriched navigation listing with a summary-only title lookup", async () => {
    const budget = navigationListingBudgets["concurrent-enriched-navigation-and-title-lookup"];
    let release!: () => void;
    const listingGate = new Promise<void>((resolve) => { release = resolve; });
    const codexClient = new MockBackendClient({
      listThreadsDelay: listingGate,
      threads: [{
        id: "thread-1",
        title: "Current title",
        titleSource: "explicit",
        source: "codex",
        linkedDirectories: [],
      }],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
    });

    try {
      const navigation = registry.listThreads({
        backend: "codex",
        callerReason: "renderer-navigation-query",
        enrichDirectories: true,
      });
      await vi.waitFor(() => expect(codexClient.listThreadsCallCount).toBe(1));
      const title = registry.listThreads({
        backend: "codex",
        callerReason: "title-generation",
        enrichDirectories: false,
      });
      await new Promise((resolve) => setImmediate(resolve));
      release();

      const [navigationRows, titleRows] = await Promise.all([navigation, title]);
      expect(navigationRows[0]?.title).toBe("Current title");
      expect(titleRows[0]?.title).toBe("Current title");
      expect([navigation, title]).toHaveLength(budget.logicalRequests);
      expect(codexClient.listThreadsCallCount).toBe(budget.providerListings);
      expect(codexClient.lastListThreadsParams).toMatchObject({ enrichDirectories: true });

      await expect(registry.listThreads({
        backend: "codex",
        callerReason: "title-generation",
        enrichDirectories: false,
      })).resolves.toMatchObject([{ title: "Current title" }]);
      expect(codexClient.listThreadsCallCount).toBe(budget.providerListings);

      codexClient.setThreads([{
        id: "thread-1",
        title: "Later title",
        titleSource: "explicit",
        source: "codex",
        linkedDirectories: [],
      }]);
      await codexClient.emit({
        method: "thread/status/changed",
        params: { threadId: "thread-1", status: { type: "idle" } },
      });
      await expect(registry.listThreads({
        backend: "codex",
        callerReason: "title-generation",
        enrichDirectories: false,
      })).resolves.toMatchObject([{ title: "Later title" }]);
      expect(codexClient.listThreadsCallCount).toBe(budget.providerListings + 1);
    } finally {
      release();
      await registry.close();
    }
  });

  it("keeps the startup prewarm bounded to summary-only active pages", async () => {
    const codexClient = new MockBackendClient({
      threads: [
        {
          id: "thread-1",
          title: "Codex thread",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [],
        },
      ],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
    });

    await registry.listThreads({
      callerReason: "startup-prewarm",
      limit: 50,
      maxPages: 1,
      skipArchivedMetadataRefresh: true,
    });

    expect(codexClient.lastListThreadsParams).toMatchObject({
      enrichDirectories: false,
      limit: 50,
      maxPages: 1,
      skipArchivedMetadataRefresh: true,
    });
    expect(codexClient.lastListNativeSubAgentThreadsParams).toEqual({
      limit: 50,
    });
    expect(codexClient.readThreadCalls).toEqual([]);

    await registry.close();
  });

  it("deduplicates identical linked directories in thread summaries", async () => {
    const repoPath = "/Users/fixture-user/projects/PwrAgent";
    const firstWorktreePath = "/Users/fixture-user/.codex/worktrees/wt1/PwrAgent";
    const secondWorktreePath = "/Users/fixture-user/.codex/worktrees/wt2/PwrAgent";
    const codexClient = new MockBackendClient({
      threads: [
        {
          id: "thread-1",
          title: "Transient duplicate",
          titleSource: "explicit",
          source: "codex",
          projectKey: firstWorktreePath,
          createdAt: 1_000,
          updatedAt: 1_000,
          linkedDirectories: [
            {
              id: "repo-dir",
              label: "PwrAgent",
              path: expectedDir(repoPath),
              worktreePath: expectedDir(firstWorktreePath),
              kind: "worktree",
            },
            {
              id: "repo-dir-duplicate",
              label: "PwrAgent",
              path: expectedDir(repoPath),
              worktreePath: expectedDir(firstWorktreePath),
              kind: "worktree",
            },
            {
              id: "repo-dir-second-worktree",
              label: "PwrAgent other",
              path: expectedDir(repoPath),
              worktreePath: expectedDir(secondWorktreePath),
              kind: "worktree",
            },
          ],
        },
      ],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
    });

    const threads = await registry.listThreads({
      backend: "codex",
      callerReason: "thread-list",
    });

    expect(threads[0]?.linkedDirectories).toEqual([
      expect.objectContaining({
        path: expectedDir(repoPath),
        worktreePath: expectedDir(firstWorktreePath),
      }),
      expect.objectContaining({
        path: expectedDir(repoPath),
        worktreePath: expectedDir(secondWorktreePath),
      }),
    ]);

    await registry.close();
  });

  it.each(["source", "backfill", "selected-thread"] as const)(
    "preserves an attached sibling worktree during %s directory repair with SQLite",
    async (repair) => {
      const repositoryPath = expectedDir("/Users/fixture-user/projects/ProjectA");
      const primaryPath = expectedDir("/Users/fixture-user/.codex/worktrees/primary/ProjectA");
      const secondaryPath = expectedDir("/Users/fixture-user/.codex/worktrees/attached/ProjectA");
      const primary: LinkedDirectorySummary = {
        id: primaryPath, kind: "worktree", label: "ProjectA", path: repositoryPath, worktreePath: primaryPath,
      };
      // attach_thread_directory uses the repository ID, not the primary cwd ID.
      const attached: LinkedDirectorySummary = {
        id: repositoryPath, kind: "worktree", label: "ProjectA", path: repositoryPath,
        worktreePath: secondaryPath, gitBranch: "attached-branch",
      };
      const thread: AppServerThreadSummary = {
        id: "thread-1", title: "Attached worktree", titleSource: "explicit", source: "codex",
        projectKey: primaryPath, updatedAt: 1000,
        linkedDirectories: repair === "source" ? [primary] : [{
          id: primaryPath, kind: "local", label: "ProjectA", path: primaryPath,
        }],
      };
      const temp = createTempStateDb("pwragent-attached-worktree-reconcile-");
      const db = StateDb.open(temp.dbPath);
      const overlayStore = new SqliteOverlayStore(db);
      const identity = { backend: "codex" as const, threadId: thread.id };
      await overlayStore.addLinkedDirectory({ ...identity, directory: attached });
      const codexClient = new MockBackendClient({ threads: [thread] });
      const enrichThreadDirectories = vi.fn(async (threads: AppServerThreadSummary[]) =>
        threads.map((row) => ({ ...row, linkedDirectories: [primary] })));
      Object.assign(codexClient, { enrichThreadDirectories });
      const archiveWorktree = vi.fn(async (params: { worktreePath: string; repositoryPath: string }) => ({
        id: `snapshot:${params.worktreePath}`, backend: "codex", threadId: thread.id,
        worktreePath: params.worktreePath, repositoryPath: params.repositoryPath,
        snapshotRef: "refs/pwragent/snapshot", snapshotCommit: "abc123",
        createdAt: 1, archivedAt: 1, state: "archived", ignoredFilesExcluded: true,
      }));
      const registry = createDesktopBackendRegistry({
        codexClient, overlayStore,
        worktreeArchiveService: { archive: archiveWorktree } as unknown as WorktreeArchiveService,
      });
      try {
        await registry.listThreads({
          backend: "codex", enrichDirectories: false,
          callerReason: repair === "backfill" ? "directory-relationship-reconcile" : "thread-list",
        });
        if (repair === "selected-thread") {
          await registry.refreshThreadDirectoryRelationship(identity);
        }
        const overlay = await overlayStore.getThreadOverlayState(identity);
        expect(overlay?.extraLinkedDirectories).toEqual([primary, attached]);
        expect(overlay?.retainedWorktrees).toBeUndefined();
        expect(codexClient.lastUpdateThreadWorkspaceParams).toBeUndefined();

        // The archive projection and a reopened store must still own both
        // checkouts; an in-memory registry summary cannot establish this.
        expect((await overlayStore.getArchiveCleanupOverlayStates({
          backend: "codex", threadIds: [thread.id],
        }))[thread.id]?.extraLinkedDirectories).toEqual([primary, attached]);
        const replaceWorkspace = vi.spyOn(overlayStore, "replaceWorkspaceLinkedDirectory");
        await registry.listThreads({
          backend: "codex", enrichDirectories: false, forceRefresh: true,
          callerReason: "directory-relationship-reconcile",
        });
        await registry.refreshThreadDirectoryRelationship(identity);
        expect(replaceWorkspace).not.toHaveBeenCalled();
        await registry.publishLocalEvent({ backend: "codex", notification: {
          method: "turn/started",
          params: { threadId: thread.id, turnId: "move-turn", turn: { id: "move-turn" } },
        } });
        const moveResponse = await codexClient.emitRequest({
          method: "item/tool/call", params: {
            threadId: thread.id, turnId: "move-turn", callId: "implicit-move", requestId: "implicit-move",
            namespace: "pwragent", tool: "move_thread_workspace", arguments: {},
          },
        } as AppServerPendingRequestNotification);
        expect(moveResponse).toMatchObject({ success: true });
        const move = JSON.parse((moveResponse as { contentItems: Array<{ text: string }> }).contentItems[0]!.text);
        expect(move).toMatchObject({
          status: "queued", direction: "worktree-to-worktree", repositoryPath, sourcePath: primaryPath,
        });
        await registry.close();
        db.close();
        const reopenedDb = StateDb.open(temp.dbPath);
        try {
          const reopenedStore = new SqliteOverlayStore(reopenedDb);
          expect((await reopenedStore.getThreadOverlayState(identity))?.extraLinkedDirectories)
            .toEqual([primary, attached]);
          // The provider does not report the attachment. Archive must find it
          // solely through the persisted overlay, including after restart.
          const archiveClient = Object.assign(new MockBackendClient({
            threads: [{ ...thread, linkedDirectories: [primary] }],
          }), {
            listArchiveCleanupThreadsPage: vi.fn(async ({ archived }: { archived: boolean }) => ({
              threads: archived ? [{ ...thread, archived: true, linkedDirectories: [primary] }] : [],
            })),
          });
          await mockArchiveWorktreePresence([primaryPath, secondaryPath], (target) =>
            !archiveWorktree.mock.calls.some(([params]) => path.resolve(params.worktreePath) === path.resolve(target)));
          const archiveRegistry = createDesktopBackendRegistry({
            codexClient: archiveClient,
            overlayStore: reopenedStore,
            worktreeArchiveService: { archive: archiveWorktree } as unknown as WorktreeArchiveService,
          });
          try {
            const archived = await archiveRegistry.archiveThread(identity);
            expect(archiveClient.listArchiveCleanupThreadsPage).toHaveBeenCalled();
            expect(archived.cleanup).toEqual(expect.arrayContaining([
              expect.objectContaining({ worktreePath: primaryPath, removedWorktree: true }),
              expect.objectContaining({ worktreePath: secondaryPath, removedWorktree: true }),
            ]));
            expect(archiveWorktree.mock.calls.map(([params]) => params.worktreePath).sort())
              .toEqual([primaryPath, secondaryPath].sort());
          } finally {
            await archiveRegistry.close();
          }
        } finally {
          reopenedDb.close();
        }
      } finally {
        await registry.close();
        db.close();
        removeTempStateDbDir(temp.tempDir);
      }
    },
  );

  it("does not enrich inactive directory history for startup or navigation listings", async () => {
    const threads = Array.from({ length: 500 }, (_, index): AppServerThreadSummary => ({
      id: `cold-${index}`, source: "codex", title: `Cold ${index}`, titleSource: "explicit",
      projectKey: `/fixture/.codex/worktrees/${index}/repo`, linkedDirectories: [],
    }));
    const codexClient = new MockBackendClient({ threads });
    const enrichThreadDirectories = vi.fn(async (rows: AppServerThreadSummary[]) => rows);
    Object.assign(codexClient, { enrichThreadDirectories });
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore: createOverlayStoreMock() });
    for (const callerReason of ["startup-provider-refresh", "startup-prewarm", "navigation-snapshot", "thread-list"] as const) {
      await registry.listThreads({ backend: "codex", callerReason, forceRefresh: true });
      expect(codexClient.lastListThreadsParams?.enrichDirectories).toBe(false);
    }
    expect(enrichThreadDirectories).not.toHaveBeenCalled();
    await registry.readThread({ backend: "codex", threadId: "cold-10" });
    expect(enrichThreadDirectories).toHaveBeenCalledExactlyOnceWith([expect.objectContaining({ id: "cold-10" })], "selected-thread");
    await registry.publishLocalEvent({ backend: "codex", notification: {
      method: "turn/started", params: { threadId: "cold-20", turn: { id: "demand-turn", status: "inProgress", items: [] } },
    } } as AgentEvent);
    await flushAsync();
    expect(enrichThreadDirectories).toHaveBeenCalledTimes(2);
    expect(enrichThreadDirectories).toHaveBeenLastCalledWith([expect.objectContaining({ id: "cold-20" })], "selected-thread");

    await registry.close();
  });

  it("backfills Codex worktree parent directories so directory view shows one project", async () => {
    const projectA = "/Users/fixture-user/projects/ProjectA";
    const worktree1 = "/Users/fixture-user/.codex/worktrees/wt1/ProjectA";
    const worktree2 = "/Users/fixture-user/.codex/worktrees/wt2/ProjectA";
    const nestedWorktreeCwd = `${worktree2}/apps`;
    const cheapThreads: AppServerThreadSummary[] = [
      {
        id: "project-a-local",
        title: "ProjectA local",
        titleSource: "explicit",
        source: "codex",
        projectKey: projectA,
        createdAt: 3_000,
        updatedAt: 3_000,
        linkedDirectories: [
          {
            // The product resolves + forward-slashes the worktree threads'
            // directory paths during backfill, so the local thread must carry
            // the same normalized form for navigation grouping to collapse all
            // three threads under one directory. expectedDir is a no-op on POSIX.
            id: expectedDir(projectA),
            label: "ProjectA",
            path: expectedDir(projectA),
            kind: "local",
          },
        ],
      },
      {
        id: "project-a-worktree-1",
        title: "ProjectA worktree 1",
        titleSource: "explicit",
        source: "codex",
        projectKey: worktree1,
        createdAt: 2_000,
        updatedAt: 2_000,
        linkedDirectories: [
          {
            id: worktree1,
            label: "ProjectA",
            path: worktree1,
            kind: "local",
          },
        ],
      },
      {
        id: "project-a-worktree-2",
        title: "ProjectA worktree 2",
        titleSource: "explicit",
        source: "codex",
        projectKey: nestedWorktreeCwd,
        createdAt: 1_000,
        updatedAt: 1_000,
        linkedDirectories: [
          {
            id: nestedWorktreeCwd,
            label: "ProjectA",
            path: nestedWorktreeCwd,
            kind: "local",
          },
        ],
      },
    ];
    const enrichedByThreadId = new Map<string, AppServerThreadSummary>(
      cheapThreads.map((thread) => [
        thread.id,
        thread.projectKey === projectA
          ? thread
          : {
              ...thread,
              linkedDirectories: [
                {
                  id: projectA,
                  label: "ProjectA",
                  path: projectA,
                  worktreePath:
                    thread.id === "project-a-worktree-2"
                      ? worktree2
                      : thread.projectKey,
                  kind: "worktree" as const,
                },
              ],
            },
      ]),
    );
    const codexClient = new MockBackendClient({
      threads: cheapThreads,
    });
    const enrichmentStarted = createDeferred<void>();
    const enrichmentRelease = createDeferred<void>();
    const enrichThreadDirectories = vi.fn(
      async (threads: AppServerThreadSummary[]) => {
        enrichmentStarted.resolve();
        await enrichmentRelease.promise;
        return threads.map((thread) => enrichedByThreadId.get(thread.id) ?? thread);
      },
    );
    Object.assign(codexClient, { enrichThreadDirectories });
    const overlayStore = createOverlayStoreMock();
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
    });

    let listResolved = false;
    const listPromise = registry.listThreads({
      backend: "codex",
      callerReason: "directory-relationship-reconcile",
      enrichDirectories: false,
    });
    void listPromise.then(() => {
      listResolved = true;
    });

    await enrichmentStarted.promise;
    await flushAsync();
    expect(listResolved).toBe(false);
    enrichmentRelease.resolve();
    await listPromise;

    const overlaysByThreadId = await overlayStore.getThreadOverlayStates({
      backend: "codex",
      threadIds: cheapThreads.map((thread) => thread.id),
    });
    const overlayByThreadKey = Object.fromEntries(
      Object.entries(overlaysByThreadId).map(([threadId, overlay]) => [
        `codex:${threadId}`,
        overlay,
      ]),
    );
    const snapshot = buildNavigationSnapshot({
      backend: "codex",
      fetchedAt: 4_000,
      firstSnapshot: false,
      overlayByThreadKey,
      previousKnownThreadKeys: [],
      threads: cheapThreads,
      unchanged: false,
    });

    expect(enrichThreadDirectories).toHaveBeenCalledTimes(1);
    expect(enrichThreadDirectories).toHaveBeenCalledWith(expect.any(Array), "missing-worktree-backfill");
    expect(
      overlaysByThreadId["project-a-worktree-2"]?.extraLinkedDirectories[0],
    ).toMatchObject({
      id: expectedDir(nestedWorktreeCwd),
      path: expectedDir(projectA),
      worktreePath: expectedDir(worktree2),
      kind: "worktree",
    });
    expect(snapshot.directories).toEqual([
      expect.objectContaining({
        key: `directory:${expectedDir(projectA)}`,
        label: "ProjectA",
        path: expectedDir(projectA),
        threadKeys: [
          "codex:project-a-local",
          "codex:project-a-worktree-1",
          "codex:project-a-worktree-2",
        ],
      }),
    ]);

    await registry.listThreads({
      backend: "codex",
      callerReason: "directory-relationship-reconcile",
      enrichDirectories: false,
      filter: "force-new-cache-key",
    });

    expect(enrichThreadDirectories).toHaveBeenCalledTimes(1);

    await registry.close();
  });

  it("does not let non-backfilling cheap list cache suppress navigation backfill", async () => {
    const projectA = "/Users/fixture-user/projects/ProjectA";
    const worktreePath = "/Users/fixture-user/.codex/profiles/work/worktrees/wt1/ProjectA";
    const cheapThread: AppServerThreadSummary = {
      id: "thread-1",
      title: "ProjectA worktree",
      titleSource: "explicit",
      source: "codex",
      projectKey: worktreePath,
      createdAt: 1_000,
      updatedAt: 1_000,
      linkedDirectories: [
        {
          id: worktreePath,
          label: "ProjectA",
          path: worktreePath,
          kind: "local",
        },
      ],
    };
    const codexClient = new MockBackendClient({
      threads: [cheapThread],
    });
    const enrichThreadDirectories = vi.fn(
      async (threads: AppServerThreadSummary[]) =>
        threads.map((thread) => ({
          ...thread,
          linkedDirectories: [
            {
              id: projectA,
              label: "ProjectA",
              path: projectA,
              worktreePath,
              kind: "worktree" as const,
            },
          ],
        })),
    );
    Object.assign(codexClient, { enrichThreadDirectories });
    const overlayStore = createOverlayStoreMock();
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
    });

    await registry.listThreads({
      backend: "codex",
      callerReason: "branch-drift",
    });
    expect(enrichThreadDirectories).not.toHaveBeenCalled();

    await registry.listThreads({
      backend: "codex",
      callerReason: "directory-relationship-reconcile",
      enrichDirectories: false,
    });

    expect(codexClient.listThreadsCallCount).toBe(2);
    expect(enrichThreadDirectories).toHaveBeenCalledTimes(1);
    await expect(
      overlayStore.getThreadOverlayState({ backend: "codex", threadId: "thread-1" }),
    ).resolves.toMatchObject({
      extraLinkedDirectories: [
        expect.objectContaining({
          id: expectedDir(worktreePath),
          path: expectedDir(projectA),
          worktreePath: expectedDir(worktreePath),
          kind: "worktree",
        }),
      ],
    });

    await registry.close();
  });

  it("skips Codex directory backfill when the overlay owns a handoff workspace", async () => {
    const projectA = "/Users/fixture-user/projects/ProjectA";
    // The provider still reports the pre-handoff worktree. That directory was
    // removed when the workspace moved to a freshly hashed worktree, so
    // enrichment resolves nothing from it and reports no linked directories.
    const staleWorktreePath = "/Users/fixture-user/.codex/worktrees/mse9d2vb/ProjectA";
    const handoffWorktreePath = "/Users/fixture-user/.codex/worktrees/msf1iq9n/ProjectA";
    const codexClient = new MockBackendClient({
      threads: [
        {
          id: "thread-1",
          title: "ProjectA worktree",
          titleSource: "explicit",
          source: "codex",
          projectKey: staleWorktreePath,
          createdAt: 1_000,
          updatedAt: 1_000,
          linkedDirectories: [],
        },
      ],
    });
    // No implementation: the assertion below is that this is never invoked,
    // so any body would be unreachable.
    const enrichThreadDirectories = vi.fn();
    Object.assign(codexClient, { enrichThreadDirectories });
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-1": {
          backend: "codex",
          threadId: "thread-1",
          executionMode: "default",
          extraLinkedDirectories: [
            {
              id: "pwragent-handoff:codex:thread-1",
              label: "ProjectA",
              path: projectA,
              worktreePath: handoffWorktreePath,
              kind: "worktree",
            },
          ],
        },
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
    });

    await registry.listThreads({
      backend: "codex",
      callerReason: "startup-prewarm",
    });

    // The handoff overlay is the authoritative workspace selection, so the
    // repair gate refuses this thread no matter what enrichment returns.
    // Enriching it anyway cannot change stored state; it only spends a probe
    // on a removed path and logs a missing-relationship warning for a thread
    // whose directory the overlay already records correctly.
    expect(enrichThreadDirectories).not.toHaveBeenCalled();
    await expect(
      overlayStore.getThreadOverlayState({ backend: "codex", threadId: "thread-1" }),
    ).resolves.toMatchObject({
      extraLinkedDirectories: [
        expect.objectContaining({
          id: "pwragent-handoff:codex:thread-1",
          worktreePath: handoffWorktreePath,
        }),
      ],
    });

    // Skipping backfill must not disturb the workspace sync that carries the
    // handoff to the provider — that is what migrates the stale projectKey.
    await vi.waitFor(() => {
      expect(codexClient.lastUpdateThreadWorkspaceParams).toEqual({
        threadId: "thread-1",
        cwd: handoffWorktreePath,
      });
    });

    await registry.close();
  });

  it("keeps aggregate list cache sensitive to Codex directory backfill", async () => {
    const worktreePath = "/Users/fixture-user/.codex/worktrees/wt1/ProjectA";
    const codexClient = new MockBackendClient({
      threads: [
        {
          id: "thread-1",
          title: "ProjectA worktree",
          titleSource: "explicit",
          source: "codex",
          projectKey: worktreePath,
          createdAt: 1_000,
          updatedAt: 1_000,
          linkedDirectories: [],
        },
      ],
    });
    const enrichThreadDirectories = vi.fn(
      async (threads: AppServerThreadSummary[]) => threads,
    );
    Object.assign(codexClient, { enrichThreadDirectories });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
    });

    await registry.listThreads({
      callerReason: "messaging-routes-settings",
      enrichDirectories: false,
    });
    expect(enrichThreadDirectories).not.toHaveBeenCalled();

    await registry.listThreads({
      callerReason: "directory-relationship-reconcile",
      enrichDirectories: false,
    });

    expect(codexClient.listThreadsCallCount).toBe(2);
    expect(enrichThreadDirectories).toHaveBeenCalledTimes(1);
    await registry.close();
  });

  it("lets fresh Codex local metadata replace stale overlay worktree relationships", async () => {
    const projectA = "/Users/fixture-user/projects/ProjectA";
    const staleWorktreePath =
      "/Users/fixture-user/.codex/profiles/work/worktrees/wt1/ProjectA";
    const localThread: AppServerThreadSummary = {
      id: "thread-1",
      title: "ProjectA local",
      titleSource: "explicit",
      source: "codex",
      projectKey: projectA,
      createdAt: 1_000,
      updatedAt: 1_000,
      linkedDirectories: [
        {
          id: projectA,
          label: "ProjectA",
          path: projectA,
          kind: "local",
        },
      ],
    };
    const codexClient = new MockBackendClient({
      threads: [localThread],
    });
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-1": {
          backend: "codex",
          threadId: "thread-1",
          executionMode: "default",
          extraLinkedDirectories: [
            {
              id: staleWorktreePath,
              label: "ProjectA",
              path: projectA,
              worktreePath: staleWorktreePath,
              kind: "worktree",
            },
          ],
        },
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
    });

    await registry.listThreads({
      backend: "codex",
      callerReason: "startup-prewarm",
    });

    await expect(
      overlayStore.getThreadOverlayState({ backend: "codex", threadId: "thread-1" }),
    ).resolves.toMatchObject({
      extraLinkedDirectories: [
        {
          id: expectedDir(projectA),
          label: "ProjectA",
          path: expectedDir(projectA),
          kind: "local",
        },
      ],
    });

    await registry.close();
  });

  it("preserves legacy handoff overlays while synchronizing stale local Codex metadata", async () => {
    const projectA = "/Users/fixture-user/projects/ProjectA";
    const handoffWorktreePath = "/Users/fixture-user/projects/ProjectA/.worktrees/thread-1";
    const localThread: AppServerThreadSummary = {
      id: "thread-1",
      title: "ProjectA local",
      titleSource: "explicit",
      source: "codex",
      projectKey: projectA,
      createdAt: 1_000,
      updatedAt: 1_000,
      linkedDirectories: [
        {
          id: projectA,
          label: "ProjectA",
          path: projectA,
          kind: "local",
        },
      ],
    };
    const codexClient = new MockBackendClient({
      threads: [localThread],
    });
    const handoffDirectory: ThreadOverlayState["extraLinkedDirectories"][number] = {
      id: "pwragent-handoff:codex:thread-1",
      label: "ProjectA",
      path: projectA,
      worktreePath: handoffWorktreePath,
      kind: "worktree",
    };
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-1": {
          backend: "codex",
          threadId: "thread-1",
          executionMode: "default",
          extraLinkedDirectories: [handoffDirectory],
        },
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
    });

    await registry.listThreads({
      backend: "codex",
      callerReason: "startup-prewarm",
    });

    await vi.waitFor(() => {
      expect(codexClient.lastUpdateThreadWorkspaceParams).toEqual({
        threadId: "thread-1",
        cwd: handoffWorktreePath,
      });
    });

    await expect(
      overlayStore.getThreadOverlayState({ backend: "codex", threadId: "thread-1" }),
    ).resolves.toMatchObject({
      extraLinkedDirectories: [handoffDirectory],
    });

    await registry.close();
  });

  it("preserves legacy handoff overlays while synchronizing stale worktree Codex metadata", async () => {
    const projectA = "/Users/fixture-user/projects/ProjectA";
    const codexWorktreePath =
      "/Users/fixture-user/.codex/profiles/work/worktrees/original/ProjectA";
    const handoffWorktreePath = "/Users/fixture-user/projects/ProjectA/.worktrees/thread-1";
    const worktreeThread: AppServerThreadSummary = {
      id: "thread-1",
      title: "ProjectA worktree",
      titleSource: "explicit",
      source: "codex",
      projectKey: codexWorktreePath,
      createdAt: 1_000,
      updatedAt: 1_000,
      linkedDirectories: [
        {
          id: projectA,
          label: "ProjectA",
          path: projectA,
          worktreePath: codexWorktreePath,
          kind: "worktree",
        },
      ],
    };
    const codexClient = new MockBackendClient({
      threads: [worktreeThread],
    });
    const handoffDirectory: ThreadOverlayState["extraLinkedDirectories"][number] = {
      id: "pwragent-handoff:codex:thread-1",
      label: "ProjectA",
      path: projectA,
      worktreePath: handoffWorktreePath,
      kind: "worktree",
    };
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-1": {
          backend: "codex",
          threadId: "thread-1",
          executionMode: "default",
          extraLinkedDirectories: [handoffDirectory],
        },
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
    });

    await registry.listThreads({
      backend: "codex",
      callerReason: "startup-prewarm",
    });

    await vi.waitFor(() => {
      expect(codexClient.lastUpdateThreadWorkspaceParams).toEqual({
        threadId: "thread-1",
        cwd: handoffWorktreePath,
      });
    });

    await expect(
      overlayStore.getThreadOverlayState({ backend: "codex", threadId: "thread-1" }),
    ).resolves.toMatchObject({
      extraLinkedDirectories: [handoffDirectory],
    });

    await registry.close();
  });

  it("does not backfill stale Codex worktree metadata over a legacy handoff overlay", async () => {
    const projectA = "/Users/fixture-user/projects/ProjectA";
    const codexWorktreePath =
      "/Users/fixture-user/.codex/profiles/work/worktrees/original/ProjectA";
    const handoffWorktreePath = "/Users/fixture-user/projects/ProjectA/.worktrees/thread-1";
    const cheapThread: AppServerThreadSummary = {
      id: "thread-1",
      title: "ProjectA worktree",
      titleSource: "explicit",
      source: "codex",
      projectKey: codexWorktreePath,
      createdAt: 1_000,
      updatedAt: 1_000,
      linkedDirectories: [
        {
          id: codexWorktreePath,
          label: "ProjectA",
          path: codexWorktreePath,
          kind: "local",
        },
      ],
    };
    const codexClient = new MockBackendClient({
      threads: [cheapThread],
    });
    const enrichThreadDirectories = vi.fn(
      async (threads: AppServerThreadSummary[]) =>
        threads.map((thread) => ({
          ...thread,
          linkedDirectories: [
            {
              id: projectA,
              label: "ProjectA",
              path: projectA,
              worktreePath: codexWorktreePath,
              kind: "worktree" as const,
            },
          ],
        })),
    );
    Object.assign(codexClient, { enrichThreadDirectories });
    const handoffDirectory: ThreadOverlayState["extraLinkedDirectories"][number] = {
      id: "pwragent-handoff:codex:thread-1",
      label: "ProjectA",
      path: projectA,
      worktreePath: handoffWorktreePath,
      kind: "worktree",
    };
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-1": {
          backend: "codex",
          threadId: "thread-1",
          executionMode: "default",
          extraLinkedDirectories: [handoffDirectory],
        },
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
    });

    await registry.listThreads({
      backend: "codex",
      callerReason: "startup-prewarm",
    });

    // This used to enrich and then discard the result at the repair gate. The
    // gate refuses every handoff-overlay thread, so the candidate filter now
    // skips the probe outright — same guarantee below, without spending a git
    // probe on the provider's stale worktree or logging a missing-relationship
    // warning when that worktree has since been removed.
    expect(enrichThreadDirectories).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(codexClient.lastUpdateThreadWorkspaceParams).toEqual({
        threadId: "thread-1",
        cwd: handoffWorktreePath,
      });
    });
    await expect(
      overlayStore.getThreadOverlayState({ backend: "codex", threadId: "thread-1" }),
    ).resolves.toMatchObject({
      extraLinkedDirectories: [handoffDirectory],
    });

    await registry.close();
  });

  it("retains a handoff overlay after Codex acknowledges the same workspace", async () => {
    const projectA = "/Users/fixture-user/projects/ProjectA";
    const handoffWorktreePath = "/Users/fixture-user/projects/ProjectA/.worktrees/thread-1";
    const worktreeThread: AppServerThreadSummary = {
      id: "thread-1",
      title: "ProjectA worktree",
      titleSource: "explicit",
      source: "codex",
      projectKey: handoffWorktreePath,
      createdAt: 1_000,
      updatedAt: 1_000,
      linkedDirectories: [
        {
          id: projectA,
          label: "ProjectA",
          path: projectA,
          worktreePath: handoffWorktreePath,
          kind: "worktree",
        },
      ],
    };
    const codexClient = new MockBackendClient({ threads: [worktreeThread] });
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-1": {
          backend: "codex",
          threadId: "thread-1",
          executionMode: "default",
          extraLinkedDirectories: [
            {
              id: "pwragent-handoff:codex:thread-1",
              label: "ProjectA",
              path: projectA,
              worktreePath: handoffWorktreePath,
              kind: "worktree",
            },
          ],
        },
      },
    });
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore });

    await registry.listThreads({
      backend: "codex",
      callerReason: "startup-prewarm",
    });

    expect(codexClient.lastUpdateThreadWorkspaceParams).toBeUndefined();
    await expect(
      overlayStore.getThreadOverlayState({ backend: "codex", threadId: "thread-1" }),
    ).resolves.toMatchObject({
      extraLinkedDirectories: [
        {
          id: "pwragent-handoff:codex:thread-1",
          label: "ProjectA",
          path: projectA,
          worktreePath: handoffWorktreePath,
          kind: "worktree",
        },
      ],
    });

    await registry.close();
  });

  it("keeps an acknowledged handoff worktree authoritative when native review restores stale local metadata", async () => {
    const projectA = "/Users/fixture-user/projects/ProjectA";
    const handoffWorktreePath = "/Users/fixture-user/.codex/worktrees/thread-1/ProjectA";
    const handoffDirectory: ThreadOverlayState["extraLinkedDirectories"][number] = {
      id: "pwragent-handoff:codex:thread-1",
      label: "ProjectA",
      path: projectA,
      worktreePath: handoffWorktreePath,
      kind: "worktree",
    };
    const worktreeThread: AppServerThreadSummary = {
      id: "thread-1",
      title: "ProjectA worktree",
      titleSource: "explicit",
      source: "codex",
      projectKey: handoffWorktreePath,
      createdAt: 1_000,
      updatedAt: 1_000,
      linkedDirectories: [
        {
          id: projectA,
          label: "ProjectA",
          path: projectA,
          worktreePath: handoffWorktreePath,
          kind: "worktree",
        },
      ],
    };
    const localThread: AppServerThreadSummary = {
      ...worktreeThread,
      projectKey: projectA,
      updatedAt: 2_000,
      linkedDirectories: [
        {
          id: projectA,
          label: "ProjectA",
          path: projectA,
          kind: "local",
        },
      ],
    };
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["review/start"] },
      threads: [worktreeThread],
    });
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-1": {
          backend: "codex",
          threadId: "thread-1",
          executionMode: "default",
          extraLinkedDirectories: [handoffDirectory],
        },
      },
    });
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore });

    await registry.listThreads({
      backend: "codex",
      callerReason: "startup-prewarm",
    });
    await registry.startReview({
      backend: "codex",
      threadId: "thread-1",
      target: { type: "baseBranch", branch: "main" },
    });

    expect(codexClient.lastStartReviewParams).toMatchObject({
      threadId: "thread-1",
      cwd: handoffWorktreePath,
    });

    codexClient.setThreads([localThread]);
    await registry.listThreads({
      backend: "codex",
      callerReason: "navigation-snapshot",
      forceRefresh: true,
    });

    await vi.waitFor(() => {
      expect(codexClient.lastUpdateThreadWorkspaceParams).toEqual({
        threadId: "thread-1",
        cwd: handoffWorktreePath,
      });
    });
    await expect(
      overlayStore.getThreadOverlayState({ backend: "codex", threadId: "thread-1" }),
    ).resolves.toMatchObject({
      extraLinkedDirectories: [handoffDirectory],
    });

    await registry.close();
  });

  it("repairs a selected Codex worktree thread with a single-thread directory enrichment", async () => {
    const projectA = "/Users/example/ProjectA";
    const worktreePath = "/Users/example/.codex/worktrees/worktree-1/ProjectA";
    const nestedWorktreeCwd = `${worktreePath}/apps/desktop`;
    const cheapThread: AppServerThreadSummary = {
      id: "thread-1",
      title: "ProjectA worktree",
      titleSource: "explicit",
      source: "codex",
      projectKey: nestedWorktreeCwd,
      createdAt: 1_000,
      updatedAt: 2_000,
      linkedDirectories: [
        {
          id: nestedWorktreeCwd,
          label: "desktop",
          path: nestedWorktreeCwd,
          kind: "local",
        },
      ],
    };
    const codexClient = new MockBackendClient({
      threads: [cheapThread],
    });
    const enrichThreadDirectories = vi.fn(
      async (threads: AppServerThreadSummary[]) =>
        threads.map((thread) => ({
          ...thread,
          linkedDirectories: [
            {
              id: projectA,
              label: "ProjectA",
              path: projectA,
              worktreePath,
              kind: "worktree" as const,
            },
          ],
        })),
    );
    Object.assign(codexClient, { enrichThreadDirectories });
    const overlayStore = createOverlayStoreMock();
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
    });
    const events: AgentEvent[] = [];
    const unsubscribe = registry.onEvent((event) => {
      events.push(event);
    });

    await registry.readThread({
      backend: "codex",
      threadId: "thread-1",
      viewOnly: true,
    });

    expect(enrichThreadDirectories).not.toHaveBeenCalled();
    await expect(
      overlayStore.getThreadOverlayState({ backend: "codex", threadId: "thread-1" }),
    ).resolves.toBeUndefined();
    expect(events).toHaveLength(0);

    await registry.readThread({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(enrichThreadDirectories).toHaveBeenCalledTimes(1);
    expect(enrichThreadDirectories).toHaveBeenCalledWith([cheapThread], "selected-thread");
    await expect(
      overlayStore.getThreadOverlayState({ backend: "codex", threadId: "thread-1" }),
    ).resolves.toMatchObject({
      extraLinkedDirectories: [
        expect.objectContaining({
          id: expectedDir(nestedWorktreeCwd),
          path: expectedDir(projectA),
          worktreePath: expectedDir(worktreePath),
          kind: "worktree",
        }),
      ],
    });
    expect(events).toContainEqual({
      backend: "codex",
      notification: {
        method: "navigation/threadDirectories/updated",
        params: {
          reason: "selected-thread",
          threadIds: ["thread-1"],
        },
      },
    });

    unsubscribe();
    await registry.close();
  });

  it("does not expand selected-thread repairs into a full-history reconcile", async () => {
    const projectA = "/Users/example/ProjectA";
    const makeCheapThread = (index: number): AppServerThreadSummary => {
      const projectKey = `/Users/example/.codex/worktrees/worktree-${index}/ProjectA`;
      return {
        id: `thread-${index}`,
        title: `ProjectA worktree ${index}`,
        titleSource: "explicit",
        source: "codex",
        projectKey,
        createdAt: 1_000 + index,
        updatedAt: 2_000 + index,
        linkedDirectories: [
          {
            id: projectKey,
            label: `worktree-${index}`,
            path: projectKey,
            kind: "local",
          },
        ],
      };
    };
    const cheapThreads = [1, 2, 3, 4, 5].map(makeCheapThread);
    const codexClient = new MockBackendClient({
      threads: cheapThreads,
    });
    const enrichThreadDirectories = vi.fn(
      async (threads: AppServerThreadSummary[]) =>
        threads.map((thread) => ({
          ...thread,
          linkedDirectories: [
            {
              id: projectA,
              label: "ProjectA",
              path: projectA,
              worktreePath: thread.projectKey,
              kind: "worktree" as const,
            },
          ],
        })),
    );
    Object.assign(codexClient, { enrichThreadDirectories });
    const overlayStore = createOverlayStoreMock();
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
    });
    const events: AgentEvent[] = [];
    const unsubscribe = registry.onEvent((event) => {
      events.push(event);
    });

    await registry.readThread({ backend: "codex", threadId: "thread-1" });
    await registry.readThread({ backend: "codex", threadId: "thread-2" });
    const fullReconcileCalls = () =>
      enrichThreadDirectories.mock.calls.filter(([threads]) => threads.length > 1);
    expect(fullReconcileCalls()).toHaveLength(0);
    await registry.readThread({ backend: "codex", threadId: "thread-3" });

    await flushAsync();
    expect(fullReconcileCalls()).toHaveLength(0);
    expect(enrichThreadDirectories).toHaveBeenCalledTimes(3);

    const lateThread = makeCheapThread(6);
    codexClient.setThreads([...cheapThreads, lateThread]);
    await registry.readThread({ backend: "codex", threadId: "thread-6" });
    await flushAsync();

    expect(fullReconcileCalls()).toHaveLength(0);

    unsubscribe();
    await registry.close();
  });

  it.each(["feature/metadata", "HEAD"])("initializes same-worktree thread metadata from Git branch %s", async (branch) => {
    // This oracle needs real Git, but not the host's PATH launcher. The first
    // /usr/bin/git launch on macOS can spend the case's budget in toolchain
    // startup before Git runs. Use the same owned runner as the branch reader.
    const fixtureGit = async (cwd: string, args: string[]): Promise<string> => {
      const result = await gitExecutable.runGitCommand(cwd, args, {
        env: gitTestEnv,
        ownProcessTree: true,
      });
      return result.stdout.trim();
    };
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-launchpad-metadata-"));
    const repo = path.join(root, "app");
    const worktree = path.join(root, "worktree", "app");
    await mkdir(repo, { recursive: true });
    await fixtureGit(repo, ["init", "-b", "main"]);
    await fixtureGit(repo, ["commit", "--allow-empty", "-m", "init"]);
    // Both checkouts point at the same commit; only their symbolic HEAD differs.
    await fixtureGit(repo, branch === "HEAD"
      ? ["worktree", "add", "--detach", worktree, "main"]
      : ["worktree", "add", "-b", branch, worktree, "main"]);
    // Git owns the expected branch and commit identity, including detached
    // HEAD. Equal commit IDs must not make the primary checkout's main win.
    const [expectedBranch, primaryCommit, worktreeCommit] = await Promise.all([
      fixtureGit(worktree, ["rev-parse", "--abbrev-ref", "HEAD"]),
      fixtureGit(repo, ["rev-parse", "HEAD"]),
      fixtureGit(worktree, ["rev-parse", "HEAD"]),
    ]);
    expect(expectedBranch).toBe(branch);
    expect(worktreeCommit).toBe(primaryCommit);
    const overlayStore = createOverlayStoreMock();

    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start", "thread/metadata/update"] },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
    });

    try {
      await registry.materializeDirectoryLaunchpad({
        directoryKey: "subthread:codex:thread-parent:same-worktree",
        launchpad: {
          directoryKey: "subthread:codex:thread-parent:same-worktree",
          directoryKind: "directory",
          directoryLabel: "app",
          directoryPath: worktree,
          parentThreadId: "thread-parent",
          parentThreadBackend: "codex",
          backend: "codex",
          executionMode: "default",
          prompt: "",
          workMode: "local",
          model: "gpt-5.5",
          reasoningEffort: "high",
          createdAt: 1_000,
          updatedAt: 2_000,
        },
      });

      expect(codexClient.lastUpdateThreadMetadataParams).toEqual({
        threadId: "thread-1",
        gitInfo: {
          branch: expectedBranch,
        },
      });
      expect(await registry.checkThreadBranchDrift({
        backend: "codex",
        threadId: "thread-1",
        expectedBranch,
      })).toMatchObject({
        expectedBranch,
        observedBranch: expectedBranch,
        drifted: false,
      });
      expect(await overlayStore.getThreadOverlayState({
        backend: "codex",
        threadId: "thread-1",
      })).toMatchObject({ observedGitBranch: expectedBranch });
    } finally {
      await registry.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("records Codex owner metadata when materializing a worktree launchpad", async () => {
    const repoPath = "/repo/app";
    const worktreePath = "/repo/app/.worktrees/thread-1/app";
    const recordCodexWorktreeOwnerThread = vi.fn(async () => {});
    const overlayStore = createOverlayStoreMock();
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start"] },
      threads: [
        {
          id: "thread-1",
          title: "Worktree thread",
          titleSource: "derived",
          source: "codex",
          linkedDirectories: [
            {
              id: repoPath,
              kind: "worktree",
              label: "app",
              path: repoPath,
              worktreePath,
            },
          ],
        },
      ],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
      gitDirectoryService: {
        prepareLaunchpadWorkspace: vi.fn(async () => ({
          cwd: worktreePath,
          repositoryPath: repoPath,
          workMode: "worktree" as const,
        })),
        recordCodexWorktreeOwnerThread,
      } as never,
    });

    const response = await registry.materializeDirectoryLaunchpad({
      directoryKey: "directory:/repo/app",
      launchpad: {
        directoryKey: "directory:/repo/app",
        directoryKind: "directory",
        directoryLabel: "app",
        directoryPath: "/repo/app",
        backend: "codex",
        executionMode: "default",
        prompt: "",
        workMode: "worktree",
        model: "gpt-5.5",
        reasoningEffort: "high",
        createdAt: 1_000,
        updatedAt: 2_000,
      },
    });

    expect(recordCodexWorktreeOwnerThread).toHaveBeenCalledWith({
      worktreePath,
      threadId: "thread-1",
    });
    expect(response.linkedDirectory).toEqual({
      id: expectedDir(repoPath),
      kind: "worktree",
      label: "app",
      path: expectedDir(repoPath),
      worktreePath: expectedDir(worktreePath),
    });

    await registry.readThread({ backend: "codex", threadId: "thread-1" });
    const [listedThread] = await registry.listThreads({
      backend: "codex",
      callerReason: "navigation-snapshot",
      forceRefresh: true,
    });
    expect(listedThread.linkedDirectories).toEqual([
      {
        id: repoPath,
        kind: "worktree",
        label: "app",
        path: repoPath,
        worktreePath,
      },
    ]);
    await expect(
      overlayStore.getThreadOverlayState({
        backend: "codex",
        threadId: "thread-1",
      }),
    ).resolves.toMatchObject({
      extraLinkedDirectories: [
        {
          id: expectedDir(repoPath),
          kind: "worktree",
          label: "app",
          path: expectedDir(repoPath),
          worktreePath: expectedDir(worktreePath),
        },
      ],
    });

    await registry.close();
  });

  it("acknowledges and persists an equivalent requested repository identity", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-repo-alias-"));
    const repositoryPath = path.join(root, "repository");
    const requestedRepositoryPath = path.join(root, "requested-repository");
    const worktreePath = path.join(root, "worktree");
    const movedWorktreePath = path.join(root, "moved-worktree");
    await mkdir(repositoryPath, { recursive: true });
    await mkdir(worktreePath, { recursive: true });
    await mkdir(movedWorktreePath, { recursive: true });
    await symlink(
      repositoryPath,
      requestedRepositoryPath,
      process.platform === "win32" ? "junction" : "dir",
    );

    const providerThread = (providerWorktreePath: string): AppServerThreadSummary => ({
      id: "thread-1",
      source: "codex",
      title: "Repository thread",
      titleSource: "derived",
      projectKey: providerWorktreePath,
      linkedDirectories: [
        {
          id: expectedDir(repositoryPath),
          kind: "worktree",
          label: "repository",
          path: expectedDir(repositoryPath),
          worktreePath: expectedDir(providerWorktreePath),
        },
      ],
    });
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start"] },
    });
    const overlayStore = createOverlayStoreMock();
    const gitDirectoryService = {
      prepareLaunchpadWorkspace: vi.fn(async () => ({
        cwd: worktreePath,
        repositoryPath,
        workMode: "worktree" as const,
      })),
      recordCodexWorktreeOwnerThread: vi.fn(async () => {}),
    } as never;
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
      gitDirectoryService,
    });
    let restartedRegistry: DesktopBackendRegistry | undefined;

    try {
      const response = await registry.materializeDirectoryLaunchpad({
        directoryKey: `directory:${requestedRepositoryPath}`,
        launchpad: {
          directoryKey: `directory:${requestedRepositoryPath}`,
          directoryKind: "directory",
          directoryLabel: "repository",
          directoryPath: requestedRepositoryPath,
          backend: "codex",
          executionMode: "default",
          prompt: "",
          workMode: "worktree",
          createdAt: 1_000,
          updatedAt: 2_000,
        },
      });

      expect(response.linkedDirectory).toMatchObject({
        kind: "worktree",
        path: expectedDir(requestedRepositoryPath),
        worktreePath: expectedDir(worktreePath),
      });

      codexClient.setThreads([providerThread(worktreePath)]);
      await registry.listThreads({
        backend: "codex",
        callerReason: "navigation-snapshot",
        forceRefresh: true,
      });
      await expect(
        overlayStore.getThreadOverlayState({
          backend: "codex",
          threadId: "thread-1",
        }),
      ).resolves.toMatchObject({
        extraLinkedDirectories: [
          expect.objectContaining({
            path: expectedDir(requestedRepositoryPath),
            worktreePath: expectedDir(worktreePath),
          }),
        ],
      });

      restartedRegistry = createDesktopBackendRegistry({
        codexClient: new MockBackendClient({
          initializeResult: { methods: ["thread/start"] },
          threads: [providerThread(worktreePath)],
        }),
        overlayStore,
        gitDirectoryService,
      });
      await restartedRegistry.listThreads({
        backend: "codex",
        callerReason: "navigation-snapshot",
        forceRefresh: true,
      });
      await expect(
        overlayStore.getThreadOverlayState({
          backend: "codex",
          threadId: "thread-1",
        }),
      ).resolves.toMatchObject({
        extraLinkedDirectories: [
          expect.objectContaining({
            path: expectedDir(requestedRepositoryPath),
            worktreePath: expectedDir(worktreePath),
          }),
        ],
      });

      codexClient.setThreads([providerThread(movedWorktreePath)]);
      const [movedThread] = await registry.listThreads({
        backend: "codex",
        callerReason: "navigation-snapshot",
        forceRefresh: true,
      });
      expect(movedThread.linkedDirectories[0]?.worktreePath).toBe(
        expectedDir(movedWorktreePath),
      );
    } finally {
      await restartedRegistry?.close();
      await registry.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("reports detached HEAD as the expected branch for new worktree forks", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-fork-branch-"));
    const repoPath = path.join(root, "repo");
    const worktreePath = path.join(root, "worktree");
    await mkdir(repoPath, { recursive: true });
    await git(repoPath, ["init", "-b", "main"]);
    await writeFile(path.join(repoPath, "README.md"), "hello\n", "utf8");
    await git(repoPath, ["add", "README.md"]);
    await git(repoPath, ["commit", "-m", "initial"]);
    await git(repoPath, ["worktree", "add", "--detach", worktreePath, "main"]);

    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/fork"] },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      gitDirectoryService: {
        prepareLaunchpadWorkspace: vi.fn(async () => ({
          cwd: worktreePath,
          repositoryPath: repoPath,
          workMode: "worktree" as const,
        })),
        recordCodexWorktreeOwnerThread: vi.fn(async () => {}),
      } as never,
    });

    try {
      const response = await registry.forkThread({
        backend: "codex",
        sourceThreadId: "thread-parent",
        parentThreadId: "thread-parent",
        executionMode: "default",
        directoryKind: "directory",
        directoryLabel: "repo",
        directoryPath: repoPath,
        branchName: "main",
        workMode: "worktree",
      });

      expect(response).toMatchObject({
        gitBranch: "HEAD",
        observedGitBranch: "HEAD",
      });
      expect(codexClient.lastUpdateThreadMetadataParams).toEqual({
        threadId: "thread-fork",
        gitInfo: {
          branch: "HEAD",
        },
      });
    } finally {
      await registry.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("describes unborn Git workspaces and gates worktrees on available refs", async () => {
    const trace = traceUnbornWorkspace();
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-handoff-unborn-"));
    trace.setRoot(root);
    const repoPath = path.join(root, "repo");
    const remotePath = path.join(root, "origin.git");
    const unpublishedBaseReason =
      "Worktrees are unavailable because this repository has no published base branch yet. Create the initial commit in the Local checkout and publish the default branch. Worktrees will be enabled once a remote base branch is available.";
    let ownedGitLaunch: MockInstance<typeof gitExecutable.runGitCommand> | undefined;
    try {
      trace.phase("initialize-repositories");
      await git(root, ["init", "--bare", "-b", "main", remotePath]);
      await mkdir(repoPath, { recursive: true });
      await git(repoPath, ["init", "-b", "main"]);
      await git(repoPath, ["remote", "add", "origin", remotePath]);
      await git(repoPath, ["config", "branch.main.remote", "origin"]);
      await git(repoPath, ["config", "branch.main.merge", "refs/heads/main"]);
      expect(await git(repoPath, ["status", "--short", "--branch"])).toContain(
        "No commits yet on main...origin/main [gone]",
      );

      const linkedDirectory = {
        id: expectedDir(repoPath),
        kind: "local" as const,
        label: "repo",
        path: expectedDir(repoPath),
      };
      const codexClient = new MockBackendClient({
        initializeResult: { methods: ["thread/start", "thread/list", "turn/start"] },
        threads: [
          {
            id: "ordinary-thread",
            title: "Parent Thread",
            titleSource: "explicit",
            source: "codex",
            linkedDirectories: [linkedDirectory],
            updatedAt: 1000,
          },
        ],
      });
      const registry = createDesktopBackendRegistry({
        codexClient,
        gitDirectoryService: new GitDirectoryService({
          resolveWorktreeStorage: () => "in-repo",
        }),
        overlayStore: createOverlayStoreMock({
          overlays: {
            "codex:ordinary-thread": {
              backend: "codex",
              threadId: "ordinary-thread",
              executionMode: "full-access",
              extraLinkedDirectories: [linkedDirectory],
            },
          },
        }),
        threadTitleGenerationService: null,
      });
      trace.phase("publish-active-turn");
      await registry.publishLocalEvent({
        backend: "codex",
        notification: {
          method: "turn/started",
          params: {
            threadId: "ordinary-thread",
            turnId: "turn-1",
            turn: { id: "turn-1" },
          },
        },
      });

      trace.phase("unborn-project-local-handoff");
      const projectLocalResponse = await codexClient.emitRequest({
        method: "item/tool/call",
        params: {
          threadId: "ordinary-thread",
          turnId: "turn-1",
          callId: "call-project-local",
          requestId: "call-project-local",
          namespace: "pwragent",
          tool: "handoff_task",
          arguments: {
            task: "Initialize the repository.",
            title: "Initial commit",
            workspaceMode: "project_local",
          },
        },
      } as AppServerPendingRequestNotification);

      expect(projectLocalResponse).toMatchObject({ success: true });
      const projectLocalPayload = JSON.parse(
        (projectLocalResponse as { contentItems: Array<{ text: string }> })
          .contentItems[0]!.text,
      );
      expect(projectLocalPayload.workspace).toMatchObject({
        mode: "project_local",
        cwd: expectedDir(repoPath),
        branch: "main",
        git: {
          kind: "git_local",
          repositoryState: "unborn",
          worktreeCreationAvailable: false,
          unavailableReason: unpublishedBaseReason,
        },
      });
      const prompt =
        codexClient.lastStartTurnParams?.input[0]?.type === "text"
          ? codexClient.lastStartTurnParams.input[0].text
          : "";
      expect(prompt).not.toContain("- Git:");
      expect(prompt).not.toContain(unpublishedBaseReason);
      const projectLocalStartParams = codexClient.lastStartThreadParams;

      trace.phase("reject-unborn-worktree");
      const worktreeResponse = await codexClient.emitRequest({
        method: "item/tool/call",
        params: {
          threadId: "ordinary-thread",
          turnId: "turn-1",
          callId: "call-worktree",
          requestId: "call-worktree",
          namespace: "pwragent",
          tool: "handoff_task",
          arguments: {
            task: "Work in an isolated checkout.",
            title: "Isolated work",
            workspaceMode: "new_worktree",
          },
        },
      } as AppServerPendingRequestNotification);

      expect(worktreeResponse).toMatchObject({ success: false });
      const worktreePayload = JSON.parse(
        (worktreeResponse as { contentItems: Array<{ text: string }> })
          .contentItems[0]!.text,
      );
      expect(worktreePayload).toMatchObject({
        code: "unsupported_workspace",
        message: unpublishedBaseReason,
        data: {
          workspace: {
            branch: "main",
            git: {
              kind: "git_local",
              repositoryState: "unborn",
              worktreeCreationAvailable: false,
              unavailableReason: unpublishedBaseReason,
            },
          },
        },
      });
      expect(codexClient.lastStartThreadParams).toBe(projectLocalStartParams);

      trace.phase("create-remote-base");
      // The gate reads local refs only, so write the remote-tracking ref a
      // fetch would leave. Each command is one Git process. A seed commit,
      // push, and fetch cost about ten Git for Windows processes, which took
      // 8.9s of this test's 15s budget on a stalled Windows runner. Git knows
      // its empty tree without storing it.
      const emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
      const baseCommit = await git(repoPath, ["commit-tree", emptyTree, "-m", "initial"]);
      await git(repoPath, ["update-ref", "refs/remotes/origin/main", baseCommit]);
      expect(await git(repoPath, ["status", "--short", "--branch"])).toContain(
        "No commits yet on main...origin/main",
      );

      trace.phase("fetched-project-local-handoff");
      const fetchedProjectLocalResponse = await codexClient.emitRequest({
        method: "item/tool/call",
        params: {
          threadId: "ordinary-thread",
          turnId: "turn-1",
          callId: "call-project-local-fetched",
          requestId: "call-project-local-fetched",
          namespace: "pwragent",
          tool: "handoff_task",
          arguments: {
            task: "Inspect the fetched base.",
            title: "Fetched base",
            workspaceMode: "project_local",
          },
        },
      } as AppServerPendingRequestNotification);

      expect(fetchedProjectLocalResponse).toMatchObject({ success: true });
      const fetchedProjectLocalPayload = JSON.parse(
        (fetchedProjectLocalResponse as { contentItems: Array<{ text: string }> })
          .contentItems[0]!.text,
      );
      expect(fetchedProjectLocalPayload.workspace).toMatchObject({
        mode: "project_local",
        cwd: expectedDir(repoPath),
        branch: "main",
        git: {
          kind: "git_local",
          repositoryState: "unborn",
          worktreeCreationAvailable: true,
        },
      });
      expect(fetchedProjectLocalPayload.workspace.git).not.toHaveProperty(
        "unavailableReason",
      );

      trace.phase("fetched-worktree-handoff");
      ownedGitLaunch = vi.spyOn(gitExecutable, "runGitCommand");
      const remoteWorktreeResponse = await codexClient.emitRequest({
        method: "item/tool/call",
        params: {
          threadId: "ordinary-thread",
          turnId: "turn-1",
          callId: "call-worktree-fetched",
          requestId: "call-worktree-fetched",
          namespace: "pwragent",
          tool: "handoff_task",
          arguments: {
            task: "Work from the fetched base.",
            title: "Fetched worktree",
            workspaceMode: "new_worktree",
            branchName: "origin/main",
          },
        },
      } as AppServerPendingRequestNotification);

      expect(remoteWorktreeResponse).toMatchObject({ success: true });
      const createdWorktree = codexClient.lastStartThreadParams?.cwd;
      expect(createdWorktree).toBeDefined();
      expect(createdWorktree).not.toBe(expectedDir(repoPath));
      // The worktree is detached at origin/main. Its branch reads must come
      // from HEAD, not an owned Git process: on Windows that is a PowerShell
      // Job host, 0.6-1.3s per launch on a hosted runner.
      expect(
        ownedGitLaunch.mock.calls.filter(([, , options]) => options?.ownProcessTree),
      ).toEqual([]);
      trace.phase("verify-worktree-head");
      expect(await git(createdWorktree!, ["rev-parse", "HEAD"])).toBe(
        await git(repoPath, ["rev-parse", "origin/main"]),
      );

      trace.phase("registry-close");
      await registry.close();
    } finally {
      ownedGitLaunch?.mockRestore();
      trace.phase("filesystem-cleanup");
      await rm(root, { recursive: true, force: true });
      trace.phase("finished");
    }
  }, 15_000);

  it("lets an agent attach a managed worktree directory to the current thread", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list"] },
    });
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:agent-thread": {
          ...createAgentOverlay(),
          executionMode: "full-access",
        },
      },
    });
    const prepareLaunchpadWorkspace = vi.fn(async () => ({
      cwd: "/worktrees/agent-kit",
      repositoryPath: "/repo/agent-kit",
      rollback: vi.fn(async () => undefined),
      workMode: "worktree" as const,
    }));
    const recordCodexWorktreeOwnerThread = vi.fn(async () => undefined);
    const registry = createDesktopBackendRegistry({
      codexClient,
      gitDirectoryService: {
        prepareLaunchpadWorkspace,
        recordCodexWorktreeOwnerThread,
        resolvePrimaryWorkspacePath: vi.fn(async () => "/repo/agent-kit"),
      } as never,
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

    let fenced = false;
    // attach_thread_directory takes the archive coordinator's workspace fence.
    const withThreadWorkspaceMutation = vi.spyOn(registryModules(registry).threadArchiveCoordinator, "withThreadWorkspaceMutation")
      .mockImplementation(async (_identity, work) => {
        fenced = true;
        try { return await work(); } finally { fenced = false; }
      });
    let fencedAtFirstOverlayRead: boolean | undefined;
    const readOverlay = overlayStore.getThreadOverlayState.bind(overlayStore);
    vi.spyOn(overlayStore, "getThreadOverlayState").mockImplementation(async (identity) => {
      fencedAtFirstOverlayRead ??= fenced;
      return await readOverlay(identity);
    });

    const response = await codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "agent-thread",
        turnId: "turn-1",
        callId: "call-1",
        requestId: "call-1",
        namespace: "pwragent",
        tool: "attach_thread_directory",
        arguments: {
          path: "/repo/agent-kit",
          workspaceMode: "new_worktree",
          branchName: "origin/main",
        },
      },
    } as AppServerPendingRequestNotification);

    expect(response).toMatchObject({ success: true });
    expect(fencedAtFirstOverlayRead).toBe(true);
    expect(withThreadWorkspaceMutation).toHaveBeenCalledWith({ backend: "codex", threadId: "agent-thread" }, expect.any(Function), ["/repo/agent-kit"]);
    expect(prepareLaunchpadWorkspace).toHaveBeenCalledWith({
      backend: "codex",
      branchName: "origin/main",
      directoryKind: "directory",
      directoryLabel: "agent-kit",
      directoryPath: "/repo/agent-kit",
      workMode: "worktree",
      worktreeBranchMode: "detached",
    });
    expect(recordCodexWorktreeOwnerThread).toHaveBeenCalledWith({
      threadId: "agent-thread",
      worktreePath: "/worktrees/agent-kit",
    });
    const payload = JSON.parse(
      (response as { contentItems: Array<{ text: string }> }).contentItems[0]!.text,
    );
    expect(payload).toMatchObject({
      backend: "codex",
      threadId: "agent-thread",
      workspaceMode: "new_worktree",
      directory: {
        kind: "worktree",
        label: "agent-kit",
        path: expectedDir("/repo/agent-kit"),
        worktreePath: expectedDir("/worktrees/agent-kit"),
      },
    });
    const overlay = await overlayStore.getThreadOverlayState({
      backend: "codex",
      threadId: "agent-thread",
    });
    expect(overlay?.extraLinkedDirectories).toEqual([
      expect.objectContaining({
        kind: "worktree",
        path: expectedDir("/repo/agent-kit"),
        worktreePath: expectedDir("/worktrees/agent-kit"),
      }),
    ]);

    await registry.close();
  });

  it("records the observed branch on an attached managed worktree", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-attach-worktree-"));
    const repoPath = path.join(root, "kube-manifests");
    const worktreePath = path.join(root, "worktrees", "kube-manifests");
    await mkdir(repoPath, { recursive: true });
    try {
      await git(repoPath, ["init", "-b", "master"]);
    } catch {
      await git(repoPath, ["init"]);
      await git(repoPath, ["checkout", "-b", "master"]);
    }
    await writeFile(path.join(repoPath, "README.md"), "kube manifests\n", "utf8");
    await git(repoPath, ["add", "README.md"]);
    await git(repoPath, ["commit", "-m", "initial"]);
    await mkdir(path.dirname(worktreePath), { recursive: true });
    await git(repoPath, [
      "worktree",
      "add",
      "-b",
      "fix/channelsv2-live-pods",
      worktreePath,
      "master",
    ]);

    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list"] },
    });
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:agent-thread": {
          ...createAgentOverlay(),
          executionMode: "full-access",
          gitBranch: "HEAD",
          observedGitBranch: "HEAD",
        },
      },
    });
    const prepareLaunchpadWorkspace = vi.fn(async () => ({
      cwd: worktreePath,
      repositoryPath: repoPath,
      rollback: vi.fn(async () => undefined),
      workMode: "worktree" as const,
    }));
    const recordCodexWorktreeOwnerThread = vi.fn(async () => undefined);
    const registry = createDesktopBackendRegistry({
      codexClient,
      gitDirectoryService: {
        prepareLaunchpadWorkspace,
        recordCodexWorktreeOwnerThread,
        resolvePrimaryWorkspacePath: vi.fn(async () => repoPath),
      } as never,
      overlayStore,
    });
    const events: AgentEvent[] = [];
    const unsubscribe = registry.onEvent((event) => {
      events.push(event);
    });
    try {
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
          tool: "attach_thread_directory",
          arguments: {
            path: repoPath,
            workspaceMode: "new_worktree",
            branchName: "master",
            worktreeBranchMode: "attached",
          },
        },
      } as AppServerPendingRequestNotification);

      expect(response).toMatchObject({ success: true });
      const payload = JSON.parse(
        (response as { contentItems: Array<{ text: string }> }).contentItems[0]!.text,
      );
      expect(payload).toMatchObject({
        branch: "fix/channelsv2-live-pods",
      });
      const overlay = await overlayStore.getThreadOverlayState({
        backend: "codex",
        threadId: "agent-thread",
      });
      expect(overlay).toMatchObject({
        gitBranch: "HEAD",
        observedGitBranch: "HEAD",
      });
      expect(overlay?.extraLinkedDirectories).toEqual([
        expect.objectContaining({
          gitBranch: "fix/channelsv2-live-pods",
          kind: "worktree",
          path: expectedDir(repoPath),
          worktreePath: expectedDir(worktreePath),
        }),
      ]);
      expect(
        events.some(
          (event) =>
            event.notification.method === "thread/branch/updated" &&
            event.notification.params.threadId === "agent-thread" &&
            event.notification.params.branch === "fix/channelsv2-live-pods",
        ),
      ).toBe(false);
    } finally {
      unsubscribe();
      await registry.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("requires confirmation before attaching an untrusted directory in Default Access", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list"] },
    });
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:agent-thread": createAgentOverlay(),
      },
    });
    const prepareLaunchpadWorkspace = vi.fn(async () => ({
      cwd: "/worktrees/agent-kit",
      repositoryPath: "/repo/agent-kit",
      rollback: vi.fn(async () => undefined),
      workMode: "worktree" as const,
    }));
    const registry = createDesktopBackendRegistry({
      codexClient,
      gitDirectoryService: {
        prepareLaunchpadWorkspace,
        resolvePrimaryWorkspacePath: vi.fn(async () => "/repo/agent-kit"),
      } as never,
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

    const events: AgentEvent[] = [];
    const unsubscribe = registry.onEvent((event) => {
      events.push(event);
    });
    const responsePromise = codexClient.emitRequest({
      method: "item/tool/call",
      params: {
        threadId: "agent-thread",
        turnId: "turn-1",
        callId: "call-1",
        requestId: "call-1",
        namespace: "pwragent",
        tool: "attach_thread_directory",
        arguments: {
          path: "/repo/agent-kit",
          workspaceMode: "new_worktree",
        },
      },
    } as AppServerPendingRequestNotification);

    await vi.waitFor(() => {
      expect(
        events.find(
          (event) =>
            event.notification.method === "item/tool/requestUserInput" &&
            event.notification.params.threadId === "agent-thread",
        ),
      ).toBeDefined();
    });
    expect(prepareLaunchpadWorkspace).not.toHaveBeenCalled();
    const inputRequest = events.find(
      (event): event is AgentEvent & {
        notification: Extract<
          AppServerNotification,
          { method: "item/tool/requestUserInput" }
        >;
      } =>
        event.notification.method === "item/tool/requestUserInput" &&
        event.notification.params.threadId === "agent-thread",
    )!.notification;
    expect(inputRequest.params.questions).toEqual([
      expect.objectContaining({
        id: "trust_directory",
        question: expect.stringContaining(expectedDir("/repo/agent-kit")),
      }),
    ]);
    await registry.submitServerRequest({
      backend: "codex",
      threadId: "agent-thread",
      turnId: "turn-1",
      requestId: inputRequest.params.requestId,
      response: {
        answers: {
          trust_directory: {
            answers: ["Cancel attachment"],
          },
        },
      },
    });

    const response = await responsePromise;

    expect(response).toMatchObject({
      success: false,
      contentItems: [
        {
          type: "inputText",
          text: expect.stringContaining("forbidden"),
        },
      ],
    });
    expect(prepareLaunchpadWorkspace).not.toHaveBeenCalled();
    const overlay = await overlayStore.getThreadOverlayState({
      backend: "codex",
      threadId: "agent-thread",
    });
    expect(overlay?.extraLinkedDirectories).toEqual([]);
    unsubscribe();
    await registry.close();
  });

  it("rolls back a managed worktree when owner recording fails", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list"] },
    });
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:agent-thread": {
          ...createAgentOverlay(),
          executionMode: "full-access",
        },
      },
    });
    const rollback = vi.fn(async () => undefined);
    const prepareLaunchpadWorkspace = vi.fn(async () => ({
      cwd: "/worktrees/agent-kit",
      repositoryPath: "/repo/agent-kit",
      rollback,
      workMode: "worktree" as const,
    }));
    const recordCodexWorktreeOwnerThread = vi.fn(async () => undefined);
    const registry = createDesktopBackendRegistry({
      codexClient,
      gitDirectoryService: {
        prepareLaunchpadWorkspace,
        recordCodexWorktreeOwnerThread,
        resolvePrimaryWorkspacePath: vi.fn(async () => "/repo/agent-kit"),
      } as never,
      overlayStore,
    });
    vi.spyOn(
      registry as unknown as {
        recordCodexWorktreeOwnerThread: (params: {
          backend: AppServerBackendKind | `acp:${string}`;
          threadId: string;
          worktreePath?: string;
        }) => Promise<void>;
      },
      "recordCodexWorktreeOwnerThread",
    ).mockRejectedValueOnce(new Error("state db unavailable"));
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
        tool: "attach_thread_directory",
        arguments: {
          path: "/repo/agent-kit",
          workspaceMode: "new_worktree",
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
              code: "internal_error",
              message: "state db unavailable",
            },
            null,
            2,
          ),
        },
      ],
    });
    expect(rollback).toHaveBeenCalledTimes(1);
    const overlay = await overlayStore.getThreadOverlayState({
      backend: "codex",
      threadId: "agent-thread",
    });
    expect(overlay?.extraLinkedDirectories).toEqual([]);

    await registry.close();
  });

  it("keeps future turns in the primary cwd when a secondary directory is attached", async () => {
    const secondaryDirectory = {
      id: expectedDir("/repo/agent-kit"),
      kind: "local" as const,
      label: "agent-kit",
      path: expectedDir("/repo/agent-kit"),
    };
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list", "turn/start"] },
      threads: [
        {
          id: "agent-thread",
          title: "Cross repo work",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [
            {
              id: expectedDir("/repo/pwragent"),
              kind: "worktree",
              label: "PwrAgent",
              path: expectedDir("/repo/pwragent"),
              worktreePath: expectedDir("/repo/pwragent-wt"),
            },
          ],
          updatedAt: 2000,
        },
      ],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock({
        overlays: {
          "codex:agent-thread": {
            ...createAgentOverlay(),
            extraLinkedDirectories: [secondaryDirectory],
          },
        },
      }),
    });

    await registry.startTurn({
      backend: "codex",
      threadId: "agent-thread",
      input: [{ type: "text", text: "Continue in the primary project." }],
    });
    expect(codexClient.lastStartTurnParams).toMatchObject({
      threadId: "agent-thread",
      cwd: expectedDir("/repo/pwragent-wt"),
    });

    await registry.close();
  });

  it("lets an agent detach a secondary directory from the current thread", async () => {
    const secondaryDirectory = {
      id: expectedDir("/repo/agent-kit"),
      kind: "local" as const,
      label: "agent-kit",
      path: expectedDir("/repo/agent-kit"),
    };
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list", "turn/start"] },
      threads: [
        {
          id: "agent-thread",
          title: "Cross repo work",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [
            {
              id: expectedDir("/repo/pwragent"),
              kind: "worktree",
              label: "PwrAgent",
              path: expectedDir("/repo/pwragent"),
              worktreePath: expectedDir("/repo/pwragent-wt"),
            },
          ],
          updatedAt: 2000,
        },
      ],
    });
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:agent-thread": {
          ...createAgentOverlay(),
          extraLinkedDirectories: [secondaryDirectory],
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
        tool: "detach_thread_directory",
        arguments: {
          path: "/repo/agent-kit",
        },
      },
    } as AppServerPendingRequestNotification);

    expect(response).toMatchObject({ success: true });
    const payload = JSON.parse(
      (response as { contentItems: Array<{ text: string }> }).contentItems[0]!.text,
    );
    expect(payload).toMatchObject({
      backend: "codex",
      threadId: "agent-thread",
      detachedDirectory: {
        label: "agent-kit",
        path: expectedDir("/repo/agent-kit"),
      },
      directories: [],
    });
    const overlay = await overlayStore.getThreadOverlayState({
      backend: "codex",
      threadId: "agent-thread",
    });
    expect(overlay?.extraLinkedDirectories).toEqual([]);

    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/completed",
        params: {
          threadId: "agent-thread",
          turnId: "turn-1",
          turn: {
            id: "turn-1",
            status: "completed",
            output: [],
          },
        },
      },
    });

    await registry.startTurn({
      backend: "codex",
      threadId: "agent-thread",
      input: [{ type: "text", text: "Continue in the remaining project." }],
    });
    expect(codexClient.lastStartTurnParams).toMatchObject({
      threadId: "agent-thread",
      cwd: expectedDir("/repo/pwragent-wt"),
    });

    await registry.close();
  });

  it("rejects detaching the last linked directory through the dynamic tool", async () => {
    const onlyDirectory = {
      id: expectedDir("/repo/agent-kit"),
      kind: "local" as const,
      label: "agent-kit",
      path: expectedDir("/repo/agent-kit"),
    };
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list"] },
      threads: [
        {
          id: "agent-thread",
          title: "Directory-less work",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [],
          updatedAt: 2000,
        },
      ],
    });
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:agent-thread": {
          ...createAgentOverlay(),
          extraLinkedDirectories: [onlyDirectory],
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
        tool: "detach_thread_directory",
        arguments: {
          path: "/repo/agent-kit",
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
              code: "forbidden",
              message: "Cannot detach the last linked directory from a thread.",
            },
            null,
            2,
          ),
        },
      ],
    });
    const overlay = await overlayStore.getThreadOverlayState({
      backend: "codex",
      threadId: "agent-thread",
    });
    expect(overlay?.extraLinkedDirectories).toEqual([onlyDirectory]);

    await registry.close();
  });

  it("rejects detaching the primary runtime directory through the dynamic tool", async () => {
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
        tool: "detach_thread_directory",
        arguments: {
          path: "/repo/pwragent",
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
              code: "forbidden",
              message:
                "Only secondary directories attached to this thread can be detached.",
            },
            null,
            2,
          ),
        },
      ],
    });

    await registry.close();
  });

  it("notifies listeners when branch drift repair updates only the expected branch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-registry-drift-repair-"));
    const repoPath = path.join(root, "PwrAgnt");

    try {
      await mkdir(repoPath, { recursive: true });
      await git(repoPath, ["init", "-b", "main"]);
      await writeFile(path.join(repoPath, "README.md"), "base\n", "utf8");
      await git(repoPath, ["add", "README.md"]);
      await git(repoPath, ["commit", "-m", "initial"]);

      const thread: AppServerThreadSummary = {
        id: "thread-1",
        title: "Moved thread",
        titleSource: "explicit",
        linkedDirectories: [],
        source: "codex",
        gitBranch: "HEAD",
        observedGitBranch: "main",
        updatedAt: 2,
      };
      const overlayStore = createOverlayStoreMock({
        overlays: {
          "codex:thread-1": {
            backend: "codex",
            threadId: "thread-1",
            executionMode: "full-access",
            gitBranch: "HEAD",
            observedGitBranch: "main",
            extraLinkedDirectories: [
              {
                id: "pwragent-handoff:codex:thread-1",
                kind: "local",
                label: "PwrAgnt",
                path: repoPath,
              },
            ],
          },
        },
      });
      const codexClient = new MockBackendClient({
        initializeResult: { methods: ["thread/list", "thread/metadata/update"] },
        threads: [thread],
      });
      const registry = createDesktopBackendRegistry({
        codexClient,
        overlayStore,
      });
      const events: AgentEvent[] = [];
      const unsubscribe = registry.onEvent((event) => {
        events.push(event);
      });

      try {
        const response = await registry.checkThreadBranchDrift({
          backend: "codex",
          expectedBranch: "HEAD",
          threadId: "thread-1",
        });

        expect(response).toMatchObject({
          expectedBranch: "main",
          observedBranch: "main",
          drifted: false,
        });
        await expect(
          overlayStore.getThreadOverlayState({ backend: "codex", threadId: "thread-1" }),
        ).resolves.toMatchObject({
          gitBranch: "main",
          observedGitBranch: "main",
        });
        expect(events).toContainEqual({
          backend: "codex",
          notification: {
            method: "thread/branch/updated",
            params: {
              threadId: "thread-1",
              branch: "main",
            },
          },
        });
      } finally {
        unsubscribe();
        await registry.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("uses an observed handoff branch as expected when legacy overlay state has no gitBranch", async () => {
    const thread: AppServerThreadSummary = {
      id: "thread-1",
      title: "Moved thread",
      titleSource: "explicit",
      linkedDirectories: [
        {
          id: "directory:/repo/app",
          label: "app",
          path: "/repo/app",
          kind: "local",
        },
      ],
      source: "codex",
      gitBranch: "fix/context-rail-slide-reflow",
      observedGitBranch: "feat/thread-workspace-handoff-plan",
      updatedAt: 2,
    };
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-1": {
          backend: "codex",
          threadId: "thread-1",
          executionMode: "full-access",
          observedGitBranch: "feat/thread-workspace-handoff-plan",
          extraLinkedDirectories: [
            {
              id: "pwragent-handoff:codex:thread-1",
              kind: "worktree",
              label: "app",
              path: "/repo/app",
              worktreePath: "/repo/app/.worktrees/app-feature",
            },
          ],
        },
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/list"] },
        threads: [thread],
      }),
      overlayStore,
    });

    const response = await registry.checkThreadBranchDrift({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(response).toMatchObject({
      expectedBranch: "feat/thread-workspace-handoff-plan",
      observedBranch: "feat/thread-workspace-handoff-plan",
      drifted: false,
    });

    await registry.close();
  });

  it("preserves the renderer expected branch when a fresh thread list reports a new branch", async () => {
    const thread: AppServerThreadSummary = {
      id: "thread-1",
      title: "Moved thread",
      titleSource: "explicit",
      linkedDirectories: [],
      source: "codex",
      gitBranch: "fix/steering-composer-navigation",
      observedGitBranch: "fix/steering-composer-navigation",
      updatedAt: 2,
    };
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-1": {
          backend: "codex",
          threadId: "thread-1",
          executionMode: "full-access",
          observedGitBranch: "fix/queued-composer-navigation",
          extraLinkedDirectories: [],
        },
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/list"] },
        threads: [thread],
      }),
      overlayStore,
    });

    const response = await registry.checkThreadBranchDrift({
      backend: "codex",
      expectedBranch: "fix/queued-composer-navigation",
      threadId: "thread-1",
    });

    expect(response).toMatchObject({
      expectedBranch: "fix/queued-composer-navigation",
      observedBranch: "fix/steering-composer-navigation",
      drifted: true,
    });
    await expect(
      overlayStore.getThreadOverlayState({ backend: "codex", threadId: "thread-1" }),
    ).resolves.toMatchObject({
      gitBranch: "fix/queued-composer-navigation",
      observedGitBranch: "fix/steering-composer-navigation",
    });

    await registry.close();
  });

  it("uses a concurrently adopted expected branch when a stale drift check finishes", async () => {
    const adoptedBranch = "fix/queued-turn-release";
    const thread: AppServerThreadSummary = {
      id: "thread-1",
      title: "Moved thread",
      titleSource: "explicit",
      linkedDirectories: [],
      source: "codex",
      gitBranch: "HEAD",
      observedGitBranch: adoptedBranch,
      updatedAt: 2,
    };
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-1": {
          backend: "codex",
          threadId: "thread-1",
          executionMode: "full-access",
          gitBranch: "HEAD",
          observedGitBranch: "HEAD",
          extraLinkedDirectories: [],
        },
      },
    });
    vi.spyOn(overlayStore, "setThreadObservedBranch").mockResolvedValue({
      backend: "codex",
      threadId: "thread-1",
      executionMode: "full-access",
      gitBranch: adoptedBranch,
      observedGitBranch: adoptedBranch,
      extraLinkedDirectories: [],
    });
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/list"] },
        threads: [thread],
      }),
      overlayStore,
    });

    const response = await registry.checkThreadBranchDrift({
      backend: "codex",
      expectedBranch: "HEAD",
      threadId: "thread-1",
    });

    expect(response).toMatchObject({
      expectedBranch: adoptedBranch,
      observedBranch: adoptedBranch,
      drifted: false,
    });

    await registry.close();
  });

  it("uses concurrent branch adoption when an unchanged drift observation skips persistence", async () => {
    const identity = { backend: "codex" as const, threadId: "thread-1" };
    const previousBranch = "feature/previous";
    const adoptedBranch = "fix/adopted";
    const thread: AppServerThreadSummary = {
      id: identity.threadId, source: identity.backend, title: "Concurrent branch adoption",
      titleSource: "explicit", linkedDirectories: [],
      gitBranch: previousBranch, observedGitBranch: adoptedBranch,
    };
    const overlayStore = createOverlayStoreMock({ overlays: {
      "codex:thread-1": {
        ...identity, executionMode: "default", extraLinkedDirectories: [],
        gitBranch: previousBranch, observedGitBranch: adoptedBranch,
      },
    } });
    const setThreadObservedBranch = vi.spyOn(overlayStore, "setThreadObservedBranch");
    const lookupStarted = createDeferred<void>();
    const releaseLookup = createDeferred<void>();
    const client = new MockBackendClient({ threads: [thread], listThreadsDelay: releaseLookup.promise });
    const listThreads = client.listThreads.bind(client);
    vi.spyOn(client, "listThreads").mockImplementation(async (...args) => {
      lookupStarted.resolve();
      return await listThreads(...args);
    });
    const registry = createDesktopBackendRegistry({ codexClient: client, overlayStore });
    try {
      const response = registry.checkThreadBranchDrift({ ...identity, expectedBranch: previousBranch });
      await lookupStarted.promise;
      await overlayStore.setThreadExpectedBranch({ ...identity, branch: adoptedBranch });
      releaseLookup.resolve();

      await expect(response).resolves.toMatchObject({
        expectedBranch: adoptedBranch, observedBranch: adoptedBranch, drifted: false,
      });
      expect(setThreadObservedBranch).not.toHaveBeenCalled();
      expect(await overlayStore.getThreadOverlayState(identity)).toMatchObject({
        gitBranch: adoptedBranch, observedGitBranch: adoptedBranch,
      });
    } finally {
      releaseLookup.resolve();
      await registry.close();
    }
  });

  it("does not persist branch drift after registry shutdown starts", async () => {
    let releaseListThreads!: () => void;
    const listThreadsDelay = new Promise<void>((resolve) => {
      releaseListThreads = resolve;
    });
    const thread: AppServerThreadSummary = {
      id: "thread-1",
      title: "Moved thread",
      titleSource: "explicit",
      linkedDirectories: [],
      source: "codex",
      gitBranch: "fix/steering-composer-navigation",
      observedGitBranch: "fix/steering-composer-navigation",
      updatedAt: 2,
    };
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-1": {
          backend: "codex",
          threadId: "thread-1",
          executionMode: "full-access",
          observedGitBranch: "fix/queued-composer-navigation",
          extraLinkedDirectories: [],
        },
      },
    });
    const setThreadObservedBranch = vi.spyOn(overlayStore, "setThreadObservedBranch");
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/list"] },
        threads: [thread],
        listThreadsDelay,
      }),
      overlayStore,
    });

    const responsePromise = registry.checkThreadBranchDrift({
      backend: "codex",
      expectedBranch: "fix/queued-composer-navigation",
      threadId: "thread-1",
    });
    await Promise.resolve();

    const closePromise = registry.close();
    releaseListThreads();

    await expect(responsePromise).resolves.toMatchObject({
      expectedBranch: "fix/queued-composer-navigation",
      observedBranch: "fix/steering-composer-navigation",
      drifted: true,
    });
    expect(setThreadObservedBranch).not.toHaveBeenCalled();

    await closePromise;
  });

  describe.each([
    "claude", "acp:gemini", "acp:grok", "acp:kimi", "acp:qwen", "acp:registry-fixture",
  ] as const)("%s Git branch monitoring", (backend) => {
    async function fixture(initialBranch: string, observedOnly = false) {
      const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-provider-branch-"));
      const repo = path.join(root, "repo");
      const cwd = path.join(root, ".pwragent", "worktrees", "fixture", "repo");
      await mkdir(repo, { recursive: true });
      await git(repo, ["init", "-b", "main"]);
      await git(repo, ["commit", "--allow-empty", "-m", "init"]);
      await git(repo, ["worktree", "add", "--detach", cwd]);
      if (initialBranch !== "HEAD") await git(cwd, ["switch", "-c", initialBranch]);
      const threadId = "a1111111-1111-4111-8111-111111111111";
      const directory: LinkedDirectorySummary = {
        id: repo, path: repo, worktreePath: cwd, label: "repo", kind: "worktree",
      };
      const identity = { backend, threadId };
      const overlayStore = createOverlayStoreMock({ overlays: {
        [`${backend}:${threadId}`]: {
          ...identity, executionMode: "default", gitBranch: observedOnly ? undefined : initialBranch,
          observedGitBranch: initialBranch, extraLinkedDirectories: [directory],
        },
      } });
      let registry: DesktopBackendRegistry;
      if (backend === "claude") {
        const store = new ClaudeSessionStore(path.join(root, "sessions"));
        await store.save({ cwd, thread: {
          id: threadId, source: backend, title: "Branch fixture", titleSource: "explicit",
          projectKey: cwd, linkedDirectories: [directory],
        } });
        registry = createDesktopBackendRegistry({
          codexClient: new MockBackendClient({ threads: [] }), overlayStore,
          claudeBackendOptions: { store },
        });
      } else {
        ({ registry } = createKimiAcpRegistry({
          acpBackendId: backend, sessionId: threadId, overlayStore,
          sessions: [{ backendId: backend, sessionId: threadId, cwd, title: "Branch fixture",
            createdAt: 1_000, updatedAt: 2_000, executionMode: "default", status: "idle" }],
        }));
      }
      onTestFinished(async () => {
        await registry.close();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      });
      return { registry, overlayStore, identity, cwd };
    }

    it.each(["turn/completed", "turn/failed", "turn/cancelled", "thread/status/changed"] as const)(
      "adopts a branch created from detached HEAD before publishing %s",
      async (method) => {
        const { registry, overlayStore, identity, cwd } = await fixture("HEAD");
        const events: string[] = [];
        let overlayAtBoundary: ThreadOverlayState | undefined;
        registry.onEvent(async (event) => {
          events.push(event.notification.method);
          if (event.notification.method === method) {
            overlayAtBoundary = await overlayStore.getThreadOverlayState(identity);
          }
        });
        await registry.publishLocalEvent({ backend, notification: {
          method: "turn/started", params: { threadId: identity.threadId, turnId: "turn-branch",
            turn: { id: "turn-branch", status: "in_progress" } },
        } });
        await git(cwd, ["switch", "-c", "fix/provider-branch"]);
        await registry.publishLocalEvent({ backend, notification: method === "thread/status/changed"
          ? { method, params: { threadId: identity.threadId, status: { type: "idle" } } }
          : { method, params: { threadId: identity.threadId, turnId: "turn-branch",
              turn: { id: "turn-branch", status: "completed", output: [], error: { message: "Fixture failure" } } } },
        } as AgentEvent);
        expect(overlayAtBoundary).toMatchObject({
          gitBranch: "fix/provider-branch", observedGitBranch: "fix/provider-branch",
        });
        expect(events).toContain("thread/branch/updated");
      },
    );

    it.each(["HEAD", "feature/original", "observed-only HEAD"])("refreshes an external branch change from %s on hover", async (storedBranch) => {
      const initialBranch = storedBranch === "observed-only HEAD" ? "HEAD" : storedBranch;
      const { registry, overlayStore, identity, cwd } = await fixture(initialBranch, storedBranch === "observed-only HEAD");
      const events: AgentEvent[] = [];
      registry.onEvent((event) => { events.push(event); });
      await registry.listThreads({ backend });
      await git(cwd, ["switch", "-c", "fix/external-branch"]);
      await registry.refreshThreadDirectoryRelationship(identity);
      expect(await overlayStore.getThreadOverlayState(identity)).toMatchObject({
        gitBranch: initialBranch === "HEAD" ? "fix/external-branch" : initialBranch,
        observedGitBranch: "fix/external-branch",
      });
      expect(events).toEqual(expect.arrayContaining([expect.objectContaining({
        backend, notification: expect.objectContaining({ method: "navigation/threadDirectories/updated" }),
      })]));
      events.length = 0;
      await registry.refreshThreadDirectoryRelationship(identity);
      expect(events).toEqual([]);
    });

    it("does not publish an unchanged observation with no expected branch", async () => {
      const { registry, identity } = await fixture("feature/original", true);
      const events: AgentEvent[] = [];
      registry.onEvent((event) => { events.push(event); });
      await registry.refreshThreadDirectoryRelationship(identity);
      expect(events).toEqual([]);
    });

    it("does not adopt an unowned terminal event", async () => {
      const { registry, overlayStore, identity, cwd } = await fixture("HEAD");
      await git(cwd, ["switch", "-c", "fix/stale-terminal"]);
      await registry.publishLocalEvent({ backend, notification: {
        method: "turn/completed", params: { threadId: identity.threadId, turnId: "stale",
          turn: { id: "stale", status: "completed", output: [] } },
      } });
      expect(await overlayStore.getThreadOverlayState(identity)).toMatchObject({
        gitBranch: "HEAD", observedGitBranch: "HEAD",
      });
    });

    if (backend === "claude") {
      it("ignores a stale terminal while another Claude turn owns the workspace", async () => {
        const { registry, overlayStore, identity, cwd } = await fixture("HEAD");
        await registry.publishLocalEvent({ backend, notification: {
          method: "turn/started", params: { threadId: identity.threadId, turnId: "current",
            turn: { id: "current", status: "in_progress" } },
        } });
        await git(cwd, ["switch", "-c", "fix/current-turn"]);
        for (const turnId of ["stale", "current"]) {
          await registry.publishLocalEvent({ backend, notification: {
            method: "turn/completed", params: { threadId: identity.threadId, turnId,
              turn: { id: turnId, status: "completed", output: [] } },
          } });
          expect((await overlayStore.getThreadOverlayState(identity))?.gitBranch)
            .toBe(turnId === "stale" ? "HEAD" : "fix/current-turn");
        }
      });
    }
  });

  it.each(["scratch", "unborn", "detached worktree"] as const)(
    "settles the %s branch probe to Git's answer before publishing turn completion",
    async (layout) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-branch-oracle-"));
      let cwd = root;
      if (layout !== "scratch") {
        await git(root, ["init", "-b", "main"]);
        if (layout === "detached worktree") {
          const commit = await git(root, ["commit-tree", "4b825dc642cb6eb9a060e54bf8d69288fbee4904", "-m", "seed"]);
          await git(root, ["update-ref", "refs/remotes/origin/main", commit]);
          cwd = path.join(root, "linked");
          await git(root, ["worktree", "add", "--detach", cwd, "origin/main"]);
        }
      }
      // Git owns discovery and HEAD. A failed abbreviation is either an
      // unborn repository or a directory outside any repository.
      const oracle = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])
        .then((branch) => ({ branch }), () =>
          git(cwd, ["rev-parse", "--git-dir"])
            .then(() => ({}), () => gitHeadBranch.NOT_A_GIT_REPOSITORY));
      const identity = { backend: "codex" as const, threadId: "branch-oracle" };
      const client = new MockBackendClient({ threads: [{
        id: identity.threadId, source: "codex", title: "Branch oracle", titleSource: "explicit",
        linkedDirectories: [{ id: cwd, path: cwd, label: "fixture", kind: "local" }],
      }] });
      const registry = createDesktopBackendRegistry({
        codexClient: client, overlayStore: createOverlayStoreMock(),
        agentToolMcpServer: null, pdfToolMcpServer: null,
      });
      const probeRead = createDeferred<void>();
      const releaseProbe = createDeferred<void>();
      const settled: Array<Awaited<ReturnType<typeof gitHeadBranch.probeCurrentGitBranch>>> = [];
      const probe = gitHeadBranch.probeCurrentGitBranch;
      const branchProbe = vi.spyOn(gitHeadBranch, "probeCurrentGitBranch").mockImplementation(async (...args) => {
        const result = await probe(...args);
        probeRead.resolve();
        await releaseProbe.promise;
        settled.push(result);
        return result;
      });
      const gitLaunch = vi.spyOn(gitExecutable, "runGitCommand");
      let atTerminal: typeof settled = [];
      let terminalPublished = false;
      let terminal: Promise<void> | undefined;
      registry.onEvent((event) => {
        if (event.notification.method === "turn/completed") {
          terminalPublished = true;
          atTerminal = [...settled];
        }
      });
      try {
        await client.emit({ method: "turn/started", params: {
          threadId: identity.threadId, turnId: "turn-oracle", turn: { id: "turn-oracle" },
        } });
        terminal = client.emit({ method: "turn/completed", params: {
          threadId: identity.threadId, turn: { id: "turn-oracle", status: "completed", output: [] },
        } } as unknown as AppServerNotification);
        await probeRead.promise;
        expect(terminalPublished).toBe(false);
        releaseProbe.resolve();
        await terminal;
        // Completion is a readiness boundary: listeners see a settled proof,
        // and ordinary metadata never needs the owned Git fallback.
        expect(atTerminal).toEqual([oracle]);
        expect(branchProbe).toHaveBeenCalledWith(cwd, expect.any(AbortSignal));
        expect(gitLaunch.mock.calls.filter(([, , options]) => options?.ownProcessTree)).toEqual([]);
      } finally {
        releaseProbe.resolve();
        await terminal;
        await registry.close();
        branchProbe.mockRestore();
        gitLaunch.mockRestore();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.each(["no PATH Git", "missing selected Git", "not a repository"] as const)(
    "checks branch drift and delivers a terminal event with %s",
    async (scenario) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-branch-probe-"));
      if (scenario !== "not a repository") {
        await git(root, ["init", "-b", "feature/current"]);
        await git(root, ["commit", "--allow-empty", "-m", "init"]);
      }
      const thread: AppServerThreadSummary = {
        id: "thread-branch", source: "codex", title: "Branch probe",
        titleSource: "explicit", gitBranch: "feature/previous", observedGitBranch: "feature/previous",
        linkedDirectories: [{ id: root, path: root, label: "repo", kind: "local" }],
      };
      const identity = { backend: "codex" as const, threadId: thread.id };
      const overlayStore = createOverlayStoreMock({ overlays: {
        "codex:thread-branch": { ...identity, executionMode: "default", extraLinkedDirectories: [],
          gitBranch: "feature/previous", observedGitBranch: "feature/previous" },
      } });
      const client = new MockBackendClient({ threads: [thread] });
      const registry = createDesktopBackendRegistry({ codexClient: client, overlayStore });
      const methods: string[] = [];
      registry.onEvent((event) => { methods.push(event.notification.method); });
      try {
        vi.stubEnv("PWRAGENT_GIT_PATH", scenario === "missing selected Git" ? path.join(root, "missing-git") : "");
        // The default must work even when no system Git can be resolved.
        vi.stubEnv("PATH", "");
        const expectedBranch = scenario === "no PATH Git" ? "feature/current" : "feature/previous";
        await expect(registry.checkThreadBranchDrift(identity)).resolves.toMatchObject({
          observedBranch: expectedBranch, drifted: scenario === "no PATH Git",
        });
        await client.emit({ method: "turn/started", params: {
          threadId: thread.id, turnId: "turn-branch", turn: { id: "turn-branch", status: "in_progress" },
        } });
        await client.emit({ method: "turn/completed", params: {
          threadId: thread.id, turn: { id: "turn-branch", status: "completed", output: [] },
        } } as unknown as AppServerNotification);
        expect(methods).toContain("turn/completed");
        expect(await overlayStore.getThreadOverlayState(identity)).toMatchObject({
          gitBranch: expectedBranch, observedGitBranch: expectedBranch,
        });
      } finally {
        vi.unstubAllEnvs();
        await registry.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("aborts an active-turn branch probe when shutdown starts", async () => {
    const thread: AppServerThreadSummary = {
      id: "thread-branch", source: "codex", title: "Branch probe", titleSource: "explicit",
      linkedDirectories: [{ id: "fixture", path: os.tmpdir(), label: "repo", kind: "local" }],
    };
    const client = new MockBackendClient({ threads: [thread] });
    const overlayStore = createOverlayStoreMock();
    const registry = createDesktopBackendRegistry({ codexClient: client, overlayStore });
    const probeStarted = createDeferred<AbortSignal>();
    const releaseProbe = createDeferred<{ stdout: string; stderr: string }>();
    // An unproven layout reads its branch through the owned Git process.
    const unproven = vi.spyOn(gitHeadBranch, "probeCurrentGitBranch").mockResolvedValue(undefined);
    const branchProbe = vi.spyOn(gitExecutable, "runGitCommand").mockImplementation((_cwd, _args, options) => {
      const signal = options!.signal!;
      probeStarted.resolve(signal);
      signal.addEventListener("abort", () => releaseProbe.reject(signal.reason), { once: true });
      return releaseProbe.promise;
    });
    const setExpectedBranch = vi.spyOn(overlayStore, "setThreadExpectedBranch");
    const methods: string[] = [];
    registry.onEvent((event) => { methods.push(event.notification.method); });
    let terminal: Promise<void> | undefined;
    try {
      await client.emit({ method: "turn/started", params: {
        threadId: thread.id, turnId: "turn-branch", turn: { id: "turn-branch", status: "in_progress" },
      } });
      terminal = client.emit({ method: "turn/completed", params: {
        threadId: thread.id, turn: { id: "turn-branch", status: "completed", output: [] },
      } } as unknown as AppServerNotification);
      await vi.waitFor(() => expect(branchProbe).toHaveBeenCalled());
      const signal = await probeStarted.promise;
      await registry.stopRunningTurnsForShutdown({ timeoutMs: 1_000 });
      expect(signal.aborted).toBe(true);
      await terminal;
      expect(methods).toContain("turn/completed");
      expect(setExpectedBranch).not.toHaveBeenCalled();
    } finally {
      releaseProbe.resolve({ stdout: "feature/late", stderr: "" });
      await terminal;
      branchProbe.mockRestore();
      unproven.mockRestore();
      await registry.close();
    }
  });

  it("adopts a named branch change from an active turn before notifying listeners", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-active-turn-branch-"));
    const repo = path.join(root, "app");
    await mkdir(repo, { recursive: true });
    await git(repo, ["init", "-b", "feature/old"]);
    await git(repo, ["commit", "--allow-empty", "-m", "init"]);

    const thread: AppServerThreadSummary = {
      id: "thread-branch",
      title: "Active branch turn",
      titleSource: "explicit",
      linkedDirectories: [
        {
          id: `directory:${repo}`,
          label: "app",
          path: repo,
          kind: "local",
        },
      ],
      source: "codex",
      gitBranch: "feature/old",
      observedGitBranch: "feature/old",
      updatedAt: 2,
    };
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-branch": {
          backend: "codex",
          threadId: "thread-branch",
          executionMode: "default",
          gitBranch: "feature/old",
          observedGitBranch: "feature/old",
          extraLinkedDirectories: [],
        },
      },
    });
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list", "thread/metadata/update"] },
      threads: [thread],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
    });

    let overlayDuringTerminalEvent: ThreadOverlayState | undefined;
    const eventMethods: string[] = [];
    registry.onEvent(async (event) => {
      eventMethods.push(event.notification.method);
      if (event.notification.method !== "turn/completed") {
        return;
      }
      overlayDuringTerminalEvent =
        await overlayStore.getThreadOverlayState({
          backend: "codex",
          threadId: "thread-branch",
        });
    });

    try {
      await codexClient.emit({
        method: "turn/started",
        params: {
          threadId: "thread-branch",
          turnId: "turn-branch",
          turn: {
            id: "turn-branch",
            status: "in_progress",
          },
        },
      });
      await git(repo, ["switch", "-c", "fix/queued-review-release"]);

      await codexClient.emit(
        {
          method: "turn/completed",
          params: {
            threadId: "thread-branch",
            turn: {
              id: "turn-branch",
              status: "completed",
              output: [],
            },
          },
        } as unknown as AppServerNotification,
      );

      expect(overlayDuringTerminalEvent).toMatchObject({
        gitBranch: "fix/queued-review-release",
        observedGitBranch: "fix/queued-review-release",
      });
      expect(eventMethods).toEqual([
        "turn/started",
        "thread/branch/updated",
        "turn/completed",
      ]);
      expect(codexClient.lastUpdateThreadMetadataParams).toEqual({
        threadId: "thread-branch",
        gitInfo: {
          branch: "fix/queued-review-release",
        },
      });
    } finally {
      await registry.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it.each(["terminal", "idle"] as const)(
    "adopts a named branch change from an ACP turn at the %s boundary",
    async (boundary) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-acp-turn-branch-"));
      const repo = path.join(root, "app");
      await mkdir(repo, { recursive: true });
      await git(repo, ["init", "-b", "feature/old"]);
      await git(repo, ["commit", "--allow-empty", "-m", "init"]);

      const acpBackendId = "acp:kimi" as AcpBackendId;
      const overlayStore = createOverlayStoreMock({
        overlays: {
          "acp:kimi:thread-branch": {
            backend: acpBackendId,
            threadId: "thread-branch",
            executionMode: "default",
            gitBranch: "feature/old",
            observedGitBranch: "feature/old",
            extraLinkedDirectories: [],
          },
        },
      });
      const codexClient = new MockBackendClient({ threads: [] });
      const { registry } = createKimiAcpRegistry({
        acpBackendId,
        codexClient,
        sessionId: "thread-branch",
        sessions: [
          {
            backendId: acpBackendId,
            sessionId: "thread-branch",
            title: "Active ACP branch turn",
            cwd: repo,
            createdAt: 1_000,
            updatedAt: 2_000,
            executionMode: "default",
            status: "idle",
          },
        ],
        overlayStore,
      });
      const eventMethods: string[] = [];
      const unsubscribe = registry.onEvent((event) => {
        eventMethods.push(event.notification.method);
      });

      try {
        await registry.publishLocalEvent({
          backend: acpBackendId,
          notification: {
            method: "turn/started",
            params: {
              threadId: "thread-branch",
              turnId: "pending:started-turn",
              turn: {
                id: "pending:started-turn",
                status: "in_progress",
              },
            },
          },
        });
        await git(repo, ["switch", "-c", "fix/acp-branch-adoption"]);

        if (boundary === "terminal") {
          await registry.publishLocalEvent({
            backend: acpBackendId,
            notification: {
              method: "turn/completed",
              params: {
                threadId: "thread-branch",
                turnId: "pending:terminal-turn",
                turn: {
                  id: "pending:terminal-turn",
                  status: "completed",
                  output: [],
                },
              },
            },
          });
        } else {
          await registry.publishLocalEvent({
            backend: acpBackendId,
            notification: {
              method: "thread/status/changed",
              params: {
                threadId: "thread-branch",
                status: { type: "idle" },
              },
            },
          });
        }

        await expect(
          overlayStore.getThreadOverlayState({
            backend: acpBackendId,
            threadId: "thread-branch",
          }),
        ).resolves.toMatchObject({
          gitBranch: "fix/acp-branch-adoption",
          observedGitBranch: "fix/acp-branch-adoption",
        });
        expect(eventMethods).toEqual([
          "turn/started",
          "thread/branch/updated",
          boundary === "terminal" ? "turn/completed" : "thread/status/changed",
        ]);
        expect(codexClient.lastUpdateThreadMetadataParams).toBeUndefined();
      } finally {
        unsubscribe();
        await registry.close();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    },
  );

  it("does not adopt an ACP branch change from a terminal event without a known active turn", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-acp-stale-turn-branch-"));
    const repo = path.join(root, "app");
    await mkdir(repo, { recursive: true });
    await git(repo, ["init", "-b", "main"]);
    await git(repo, ["commit", "--allow-empty", "-m", "init"]);
    await git(repo, ["switch", "--detach", "HEAD"]);

    const acpBackendId = "acp:grok" as AcpBackendId;
    const sessionId = "grok-session-stale-turn";
    const overlayStore = createOverlayStoreMock({
      overlays: {
        [`${acpBackendId}:${sessionId}`]: {
          backend: acpBackendId,
          threadId: sessionId,
          executionMode: "full-access",
          gitBranch: "HEAD",
          observedGitBranch: "HEAD",
          extraLinkedDirectories: [],
        },
      },
    });
    const { registry } = createKimiAcpRegistry({
      acpBackendId,
      sessionId,
      overlayStore,
    });
    const eventMethods: string[] = [];
    registry.onEvent((event) => {
      eventMethods.push(event.notification.method);
    });

    try {
      await registry.startThread({
        backend: acpBackendId,
        cwd: repo,
        executionMode: "full-access",
      });
      await git(repo, ["switch", "-c", "fix/grok-stale-turn"]);

      // No startTurn: a stale terminal notification for a turn the registry
      // never saw start must not rewrite the thread's expected branch.
      await (registry as unknown as { emit(event: AgentEvent): Promise<void> }).emit({
        backend: acpBackendId,
        notification: {
          method: "turn/completed",
          params: {
            threadId: sessionId,
            turnId: `pending:${sessionId}:999`,
            turn: {
              id: `pending:${sessionId}:999`,
              status: "completed",
              completedAt: 1002,
              output: [{ type: "text", text: "Done" }],
            },
          },
        },
      });

      await expect(
        overlayStore.getThreadOverlayState({
          backend: acpBackendId,
          threadId: sessionId,
        }),
      ).resolves.toMatchObject({
        gitBranch: "HEAD",
        observedGitBranch: "HEAD",
      });
      expect(eventMethods).not.toContain("thread/branch/updated");
    } finally {
      await registry.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("notifies listeners when the renderer adopts a new expected branch", async () => {
    const overlayStore = createOverlayStoreMock();
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/metadata/update"] },
      }),
      overlayStore,
    });
    const events: AgentEvent[] = [];
    const unsubscribe = registry.onEvent((event) => {
      events.push(event);
    });

    try {
      await registry.updateThreadExpectedBranch({
        backend: "codex",
        threadId: "thread-branch",
        branch: "fix/new-branch",
      });

      expect(events).toContainEqual({
        backend: "codex",
        notification: {
          method: "thread/branch/updated",
          params: {
            threadId: "thread-branch",
            branch: "fix/new-branch",
          },
        },
      });
    } finally {
      unsubscribe();
      await registry.close();
    }
  });

  it("does not persist a retained branch drift pair when expected branch is HEAD", async () => {
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-head": {
          backend: "codex",
          threadId: "thread-head",
          gitBranch: "HEAD",
          extraLinkedDirectories: [],
        },
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/list"] },
      }),
      overlayStore,
    });

    const response = await registry.retainThreadBranchDrift({
      backend: "codex",
      threadId: "thread-head",
      expectedBranch: "HEAD",
      observedBranch: "feature/foo",
    });

    // Response still echoes the request so the renderer can update its
    // dialog state, but no pair is persisted.
    expect(response.expectedBranch).toBe("HEAD");
    const overlay = await overlayStore.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-head",
    });
    expect(overlay?.retainedBranchDriftPairs ?? []).toEqual([]);

    // Sanity: a non-HEAD pair still persists.
    await registry.retainThreadBranchDrift({
      backend: "codex",
      threadId: "thread-head",
      expectedBranch: "feature/old",
      observedBranch: "feature/new",
    });
    const overlayAfter = await overlayStore.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-head",
    });
    expect(overlayAfter?.retainedBranchDriftPairs).toHaveLength(1);

    await registry.close();
  });

  it("flags drift when a thread is still detached at HEAD after a turn", async () => {
    const thread: AppServerThreadSummary = {
      id: "thread-archived",
      title: "Detached after work",
      titleSource: "explicit",
      linkedDirectories: [
        {
          id: "directory:/repo/app",
          label: "app",
          path: "/repo/app",
          kind: "local",
        },
      ],
      source: "codex",
      gitBranch: "feature/work-from-archive",
      observedGitBranch: "HEAD",
      updatedAt: 2,
    };
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-archived": {
          backend: "codex",
          threadId: "thread-archived",
          gitBranch: "feature/work-from-archive",
          observedGitBranch: "HEAD",
          extraLinkedDirectories: [],
        },
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/list"] },
        threads: [thread],
      }),
      overlayStore,
    });

    const response = await registry.checkThreadBranchDrift({
      backend: "codex",
      threadId: "thread-archived",
    });

    expect(response).toMatchObject({
      expectedBranch: "feature/work-from-archive",
      observedBranch: "HEAD",
      drifted: true,
    });

    await registry.close();
  });
});

describe("real-repo git test environment", () => {
  // Without this guard the hardening above is invisible: the suite would keep
  // passing on a machine whose global gitconfig happens to supply an identity,
  // and would only break on a runner that does not. Both halves are asserted
  // from a repo built exactly the way every other real-repo test builds one.
  it("authors commits from the environment and reads no ambient config", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-git-env-guard-"));
    try {
      await git(root, ["init", "-b", "main"]);
    } catch {
      await git(root, ["init"]);
      await git(root, ["checkout", "-b", "main"]);
    }
    await writeFile(path.join(root, "README.md"), "guard\n", "utf8");
    await git(root, ["add", "README.md"]);
    await git(root, ["commit", "-m", "initial"]);

    // No `git config user.*` ran for this repo, so the commit is proof that
    // GIT_AUTHOR_*/GIT_COMMITTER_* carried the identity on their own.
    expect(
      await git(root, ["log", "-1", "--format=%an|%ae|%cn|%ce"]),
    ).toBe(
      "PwrAgent Tests|tests@pwragent.local|PwrAgent Tests|tests@pwragent.local",
    );

    // `--list` folds system + global + local together, so an empty result for
    // these prefixes means the runner's gitconfig never reached the repo. A
    // leaked `credential.*` is the one that matters most: it is what turns a
    // git spawn into a process waiting on a prompt nobody can answer.
    const effectiveConfig = await git(root, ["config", "--list"]);
    expect(
      effectiveConfig
        .split(/\r?\n/)
        .filter((entry) => /^(user\.|credential\.|commit\.gpgsign=)/.test(entry)),
    ).toEqual([]);
  });
});
