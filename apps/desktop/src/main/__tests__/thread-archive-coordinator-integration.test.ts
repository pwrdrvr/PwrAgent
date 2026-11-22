import {
  mainLoggerMock,
  mockArchiveWorktreePresence,
  flushAsync,
  createDeferred,
  git,
  pathExists,
  waitForCondition,
  createOverlayStoreMock,
  MockBackendClient,
  createMessagingArchiveCleanupStoreMock,
  createMessagingArchiveCleanerMock,
  createAcpAgentStoreMock,
  createAcpSessionStoreMock,
  createKimiAgentRecord,
  createKimiAcpRegistry,
} from "./helpers/backend-registry-fixture";
import { createDesktopBackendRegistry, registryModules } from "../app-server/backend-registry-wiring";
import { ClaudeSessionStore } from "../claude/claude-session-store";
import type { ClaudeBackend } from "../claude/claude-backend";
import { DEFAULT_THREAD_ARCHIVE_POLICY } from "@pwragent/shared/thread-archive-policy";
import { stageTurnInputAttachment } from "../app-server/turn-input-attachment-files";
import { resolveActiveProfilePath } from "../profile";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
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
} from "vitest";
import { buildThreadIdentityKey } from "@pwragent/shared/contracts/navigation";
import type {
  AcpBackendId,
  AppServerBackendKind,
  AppServerNotification,
  AppServerThreadSummary,
  LinkedDirectorySummary,
  WorktreeSnapshotSummary,
} from "@pwragent/shared/contracts/normalized-app-server";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import type {
  NavigationSnapshot,
  NavigationLaunchpadDraft,
  ThreadOverlayState,
} from "@pwragent/shared/contracts/navigation";
import { CODEX_MISSING_THREAD_EVALUATION_DELAY_MS } from "../app-server/backend-registry-runtime-helpers";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import { ARCHIVE_CLEANUP_PAUSE_MS } from "../app-server/archive-cleanup-queue";
import { CodexAppServerClient } from "../codex-app-server/desktop-client";
import { ArchiveCleanupTransport } from "./fixtures/archive-cleanup-transport";
import { type CodexEnvironmentCommandRunner } from "../app-server/codex-environment-runtime";
import navigationListingBudgets from "./fixtures/navigation-listing-budgets.json";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { openInMemoryStateDb } from "./sqlite-test-utils";
import { WorktreeArchiveService } from "../app-server/worktree-archive-service";
import { GitWorkspaceHandoffService } from "../app-server/git-workspace-handoff-service";
import type { AcpSessionMetadata } from "@pwragent/owner-core/acp-storage";
import { AcpSessionStore } from "../storage/acp-session-store";

describe("DesktopBackendRegistry", () => {
  it("lists active and archived PwrAgent Claude threads for checkout maintenance", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-claude-registry-"));
    const claudeStore = new ClaudeSessionStore(path.join(root, "sessions"));
    const registry = createDesktopBackendRegistry({
      codexClient: Object.assign(new MockBackendClient({}), {
        listArchiveCleanupThreadsPage: vi.fn(async () => ({ threads: [], nextCursor: undefined })),
      }),
      overlayStore: createOverlayStoreMock(),
      pdfToolMcpServer: null,
      claudeBackendOptions: {
        store: claudeStore,
        getSessionInfo: vi.fn().mockResolvedValue(undefined),
        inspectInstallation: async () => ({ executable: "/fixture/claude", authStatus: "signed-in" }),
        discoverModels: async () => [],
      },
    });
    try {
      const { threadId } = await registry.startThread({ backend: "claude", cwd: root, executionMode: "default" });
      const claude = (await registry.listAutoArchiveCandidates()).find(({ thread }) => thread.source === "claude");
      expect(claude?.thread.id).toBe(threadId);
      // The run's recheck reads the same store, not the Codex client.
      const refreshed = await registry.refreshArchiveCandidate(claude!);
      expect(refreshed.thread).toMatchObject({ id: threadId, source: "claude", projectKey: root });
      // The provider's persisted archive is the oracle, not navigation state.
      const session = await claudeStore.read(threadId);
      session.thread.archivedAt = Date.now();
      await claudeStore.save(session);
      const archived = (await registry.listAutoArchiveCandidates()).find(({ thread }) => thread.id === threadId);
      expect(archived?.thread.archivedAt).toBe(session.thread.archivedAt);
    } finally {
      await registry.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("checks service thread membership without trusting error-tolerant navigation inventory", async () => {
    const thread: AppServerThreadSummary = { id: "service-thread", title: "Preview", titleSource: "explicit", source: "codex", linkedDirectories: [] };
    const client = new MockBackendClient({ threads: [thread] });
    const registry = createDesktopBackendRegistry({ codexClient: client, overlayStore: createOverlayStoreMock() });
    onTestFinished(() => registry.close());
    const list = vi.spyOn(client, "listThreads").mockRejectedValue(new Error("Provider temporarily unavailable"));
    const target = { backend: "codex" as const, threadId: thread.id };
    // The ordinary navigation path swallows the error and caches an empty list.
    await expect(registry.listThreads({ backend: "codex", callerReason: "federation-services" })).resolves.toEqual([]);
    await expect(registry.isThreadActiveForService(target)).rejects.toThrow("Provider temporarily unavailable");
    list.mockResolvedValue([thread]);
    await expect(registry.isThreadActiveForService(target)).resolves.toBe(true);
    expect(list).toHaveBeenLastCalledWith({ archived: false, enrichDirectories: false,
      skipArchivedMetadataRefresh: true, requireComplete: true }, { callerReason: "federation-services" });
    list.mockResolvedValue([]);
    const descendants = vi.spyOn(client, "listNativeSubAgentThreads").mockRejectedValue(new Error("Descendant discovery incomplete"));
    await expect(registry.isThreadActiveForService(target)).rejects.toThrow("Descendant discovery incomplete");
    descendants.mockResolvedValue([thread]);
    await expect(registry.isThreadActiveForService(target)).resolves.toBe(true);
    descendants.mockResolvedValue([]);
    await expect(registry.isThreadActiveForService(target)).resolves.toBe(false);
    list.mockResolvedValue([{ ...thread, archivedAt: 1000 }]);
    await expect(registry.isThreadActiveForService(target)).resolves.toBe(false);
  });

  it("archives a handoff source without cleaning its worktree", async () => {
    const thread: AppServerThreadSummary = {
      id: "handoff-source", title: "Source", titleSource: "explicit", source: "codex", updatedAt: 1000,
      linkedDirectories: [{ id: "worktree", kind: "worktree", label: "repo", path: "/repo", worktreePath: "/.codex/worktrees/handoff/repo" }],
    };
    const client = new MockBackendClient({ threads: [thread] });
    const archive = vi.fn();
    const registry = createDesktopBackendRegistry({ codexClient: client, overlayStore: createOverlayStoreMock(), worktreeArchiveService: { archive } as never });
    onTestFinished(() => registry.close());
    const result = await registry.archiveThread({ backend: "codex", threadId: thread.id, preserveWorktrees: true });
    expect(client.lastArchiveThreadParams).toEqual({ threadId: thread.id });
    expect(archive).not.toHaveBeenCalled();
    expect(result.cleanup).toEqual([]);
  });

  it.each([true, false])("propagates retention evidence failures for archived=%s", async (archived) => {
    const codexClient = new MockBackendClient({ threads: [] });
    vi.spyOn(codexClient, "listThreads").mockRejectedValue(new Error("Provider unavailable"));
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore: createOverlayStoreMock() });
    try {
      await expect(registry.listThreads({ archived, forceRefresh: true, callerReason: "archive-cleanup" })).rejects.toThrow("Provider unavailable");
    } finally { await registry.close(); }
  });

  it("archives and restores persisted ACP sessions locally", async () => {
    const acpBackendId = "acp:gemini" as AcpBackendId;
    const sessions: AcpSessionMetadata[] = [
      {
        backendId: acpBackendId,
        sessionId: "session-1",
        title: "Gemini ACP Thread",
        cwd: "/repo/project",
        createdAt: 1000,
        updatedAt: 3000,
        executionMode: "default",
        status: "idle",
      },
    ];
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      overlayStore: createOverlayStoreMock(),
      acpAgentStore: createAcpAgentStoreMock([
        {
          backendId: acpBackendId,
          registryId: "gemini",
          name: "Gemini CLI",
          distributionKind: "local",
          distributionSource: "gemini --acp --skip-trust",
          installStatus: "installed",
          authStatus: "not-required",
          verificationStatus: "not-applicable",
          allowlistRuleId: "local-gemini-cli",
          installedAt: 1000,
          updatedAt: 2000,
        },
      ]),
      acpSessionStore: createAcpSessionStoreMock(sessions),
    });

    await expect(
      registry.archiveThread({
        backend: acpBackendId,
        threadId: "session-1",
      }),
    ).resolves.toMatchObject({
      backend: acpBackendId,
      threadId: "session-1",
      cleanup: [],
    });
    await expect(
      registry.listThreads({ backend: acpBackendId }),
    ).resolves.toEqual([]);
    await expect(
      registry.listThreads({ backend: acpBackendId, archived: true }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "session-1",
        archivedAt: expect.any(Number),
      }),
    ]);

    await expect(
      registry.restoreThread({
        backend: acpBackendId,
        threadId: "session-1",
      }),
    ).resolves.toMatchObject({
      backend: acpBackendId,
      threadId: "session-1",
      worktrees: [],
    });
    await expect(
      registry.listThreads({ backend: acpBackendId }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "session-1",
        archivedAt: undefined,
      }),
    ]);

    await registry.close();
  });

  it("does not run archive cleanup from partial Codex lists", async () => {
    const codexClient = new MockBackendClient({
      archivedThreads: [
        {
          id: "thread-codex",
          title: "Archived Codex thread",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [],
          archivedAt: 2_000,
        },
      ],
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

    await registry.listThreads({
      backend: "codex",
      callerReason: "navigation-snapshot",
    });
    codexClient.setThreads([
      {
        id: "thread-codex-new",
        title: "New Codex thread",
        titleSource: "explicit",
        source: "codex",
        linkedDirectories: [],
      },
    ]);

    await registry.listThreads({
      backend: "codex",
      callerReason: "startup-prewarm",
      forceRefresh: true,
      limit: 50,
      maxPages: 1,
      skipArchivedMetadataRefresh: true,
    });
    await Promise.resolve();

    expect(codexClient.lastListThreadsParams).toMatchObject({
      enrichDirectories: false,
      limit: 50,
      maxPages: 1,
      skipArchivedMetadataRefresh: true,
    });
    expect(codexClient.listThreadsCalls).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          params: expect.objectContaining({ archived: true }),
        }),
      ]),
    );

    await registry.close();
  });

  it.each([
    ["preparing", "worktree"], ["setup", "worktree"], ["creating", "worktree"], ["setup", "local"],
  ] as const)("cancels a startup operation during %s in %s mode without a late first turn", async (phase, workMode) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-startup-cancel-"));
    await mkdir(path.join(root, ".codex", "environments"), { recursive: true });
    await writeFile(path.join(root, ".codex", "environments", "env.toml"), 'version = 1\nname = "Env"\n[setup]\nscript = "install"\n');
    let ready!: () => void;
    const reachedPhase = new Promise<void>((resolve) => { ready = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const worktreePath = path.join(root, "owned-worktree");
    await mkdir(path.join(worktreePath, "node_modules"), { recursive: true });
    await writeFile(path.join(worktreePath, "node_modules", "installed.txt"), "partial installation");
    let runnerExited = false;
    const rollback = vi.fn(async () => {
      if (phase === "setup") expect(runnerExited).toBe(true);
      await rm(worktreePath, { recursive: true, force: true });
    });
    const prepareLaunchpadWorkspace = vi.fn(async () => {
      if (phase === "preparing") { ready(); await gate; }
      return { cwd: worktreePath, repositoryPath: root, workMode, rollback: workMode === "worktree" ? rollback : undefined };
    });
    let setupSignal: AbortSignal | undefined;
    const commandRunner: CodexEnvironmentCommandRunner = async (params) => {
      setupSignal = params.signal;
      params.onProgress?.({ phase: "stdout", chunk: "installing", at: Date.now() });
      if (phase === "setup") { ready(); await gate; }
      // Deliberately return success after cancellation, emulating a runner
      // whose last successful exit races the AbortSignal.
      runnerExited = true;
      return { exitCode: 0, output: "installed", durationMs: 10 };
    };
    const overlayStore = createOverlayStoreMock();
    const launchpad: NavigationLaunchpadDraft = {
      directoryKey: `directory:${root}`, directoryKind: "directory", directoryLabel: "Fixture",
      directoryPath: root, backend: "codex", executionMode: "default", workMode,
      prompt: "Keep this submitted task", codexEnvironmentId: "env", codexEnvironmentExecutionTarget: "local",
      createdAt: 1, updatedAt: 1,
    };
    await overlayStore.upsertDirectoryLaunchpad(launchpad);
    const registry = createDesktopBackendRegistry({ codexClient: new MockBackendClient({}), overlayStore,
      codexEnvironmentCommandRunner: commandRunner, threadTitleGenerationService: null, pdfToolMcpServer: null,
      gitDirectoryService: { prepareLaunchpadWorkspace } as never });
    const start = vi.spyOn(registry, "startThread").mockImplementation(async () => {
      ready();
      await gate;
      return { backend: "codex", threadId: "late-empty-thread", executionMode: "default" };
    });
    const turn = vi.spyOn(registry, "startTurn");
    // The directory service reaches archive through its host, which
    // delegates to the archive coordinator.
    const archive = vi.spyOn(registryModules(registry).threadArchiveCoordinator, "archiveThread")
      .mockResolvedValue({ backend: "codex", threadId: "late-empty-thread", archivedAt: 1, cleanup: [] });
    let outcome: Promise<unknown> | undefined;
    try {
      const running = registry.materializeDirectoryLaunchpad({ operationId: "cancel-race", submittedAt: 100,
        directoryKey: launchpad.directoryKey, launchpad, releaseLaunchpadOnSubmit: true,
        input: [{ type: "text", text: launchpad.prompt }] });
      outcome = running.catch((error: unknown) => error);
      await reachedPhase;
      const before = await registry.manageLaunchpadCreation({ operationId: "cancel-race", action: "read" });
      expect(before.operation).toMatchObject({ phase, backend: "codex", submittedAt: 100 });
      if (phase !== "preparing") expect(before.operation?.setupProgress).toMatchObject({
        output: expect.stringContaining(phase === "setup" ? "installing" : "installed"), startedAt: expect.any(Number),
      });
      expect((await registry.manageLaunchpadCreation({ operationId: "cancel-race", action: "cancel" })).cancellationAccepted).toBe(true);
      if (phase !== "preparing") expect(setupSignal?.aborted).toBe(true);
      release();
      await expect(outcome).resolves.toMatchObject({ name: "LaunchpadCreationCancelledError" });
      expect(turn).not.toHaveBeenCalled();
      expect(start).toHaveBeenCalledTimes(phase === "creating" ? 1 : 0);
      expect(archive).toHaveBeenCalledTimes(phase === "creating" ? 1 : 0);
      expect(rollback).toHaveBeenCalledTimes(phase === "creating" || workMode === "local" ? 0 : 1);
      if (phase === "creating" || workMode === "local") {
        // Existing paths and thread-owned paths never belong to rollback.
        expect(await readFile(path.join(worktreePath, "node_modules", "installed.txt"), "utf8")).toBe("partial installation");
      } else {
        await expect(stat(worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
      }
      expect(await readFile(path.join(root, ".codex", "environments", "env.toml"), "utf8")).toContain("Env");
      expect(await overlayStore.getDirectoryLaunchpad({ directoryKey: launchpad.directoryKey })).toMatchObject({ prompt: launchpad.prompt });
      expect((await registry.manageLaunchpadCreation({ operationId: "cancel-race", action: "read" })).operation?.phase).toBe("cancelled");
    } finally {
      release();
      await outcome;
      await registry.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it.each([false, true])("preserves a borrowed worktree whose ownership marker belongs to an archived ACP thread (lookup fails: %s)", async (lookupFails) => {
    const worktreePath = "/claude-worktrees/demo/borrowed";
    const codexClient = new MockBackendClient({
      threads: [{
        id: "codex-user", title: "Archive me", titleSource: "explicit", source: "codex", updatedAt: 1000,
        linkedDirectories: [{ id: "provider-directory", kind: "worktree", label: "demo", path: "/repo/demo", worktreePath }],
      }],
      archivedThreads: [],
    });
    const archive = vi.fn();
    await mockArchiveWorktreePresence([worktreePath]);
    const { registry } = createKimiAcpRegistry({
      codexClient,
      sessions: [{
        backendId: "acp:kimi", sessionId: "archived-adopter", title: "Adopted worktree",
        cwd: worktreePath, createdAt: 1, updatedAt: 2, archivedAt: 3, executionMode: "default", status: "idle",
      }],
      overlayStore: createOverlayStoreMock({ overlays: {
        "acp:kimi:archived-adopter": {
          backend: "acp:kimi", threadId: "archived-adopter", extraLinkedDirectories: [{
            id: "pwragent-handoff:acp:kimi:archived-adopter", kind: "worktree", label: "demo",
            path: "/repo/demo", worktreePath, worktreeOwnership: "external",
          }],
        },
      } }),
      worktreeArchiveService: { archive } as never,
    });
    onTestFinished(() => registry.close());
    if (lookupFails) {
      const listThreads = registry.listThreads.bind(registry);
      vi.spyOn(registry, "listThreads").mockImplementation(async (params) => {
        if (params?.archived && !params.backend) throw new Error("fixture archived backend unavailable");
        return await listThreads(params);
      });
    }
    const result = await registry.archiveThread({ backend: "codex", threadId: "codex-user" });
    expect(codexClient.lastArchiveThreadParams).toEqual({ threadId: "codex-user" });
    expect(archive).not.toHaveBeenCalled();
    expect(result.cleanup).toEqual([expect.objectContaining({
      ...(lookupFails ? {} : { worktreePath }),
      removedWorktree: false,
      skippedReason: expect.stringContaining(lookupFails ? "fixture archived backend unavailable" : "Externally managed"),
    })]);
  });

  it("snapshots and removes linked worktrees when archiving a thread", async () => {
    const thread: AppServerThreadSummary = {
      id: "thread-1",
      title: "Archive me",
      titleSource: "explicit",
      linkedDirectories: [
        {
          id: "directory:/repo/app",
          label: "app",
          path: "/repo/app",
          kind: "worktree",
          worktreePath: "/repo/.worktrees/archive-me",
        },
      ],
      source: "codex",
      gitBranch: "codex/archive-me",
      updatedAt: 2,
    };
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list", "thread/archive"] },
      threads: [thread],
    });
    const archiveWorktree = vi.fn(async () => ({
      id: "snapshot-1",
      backend: "codex" as const,
      threadId: "thread-1",
      worktreePath: "/repo/.worktrees/archive-me",
      repositoryPath: "/repo/app",
      snapshotRef: "refs/codex/snapshots/snapshot-1",
      snapshotCommit: "abc123",
      sourceBranch: "codex/archive-me",
      sourceHead: "def456",
      createdAt: 1000,
      archivedAt: 1000,
      state: "archived" as const,
      ignoredFilesExcluded: true,
    }));
    await mockArchiveWorktreePresence(["/repo/.worktrees/archive-me"], () => archiveWorktree.mock.calls.length === 0);
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      worktreeArchiveService: {
        archive: archiveWorktree,
      } as unknown as WorktreeArchiveService,
    });

    const response = await registry.archiveThread({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(codexClient.lastArchiveThreadParams).toEqual({ threadId: "thread-1" });
    expect(archiveWorktree).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      worktreePath: "/repo/.worktrees/archive-me",
      repositoryPath: "/repo/app",
    });
    expect(response).toEqual({
      backend: "codex",
      threadId: "thread-1",
      archivedAt: expect.any(Number),
      cleanup: [
        {
          worktreePath: "/repo/.worktrees/archive-me",
          branch: "codex/archive-me",
          removedWorktree: true,
          deletedBranch: false,
        },
      ],
      threadTitle: "Archive me",
    });

    await registry.close();
  });

  it("skips worktree cleanup when another active thread still uses the same worktree", async () => {
    const parentThread: AppServerThreadSummary = {
      id: "019e79f9-7ff1-7f31-9a67-f92435a1c9fa",
      title: "Parent thread",
      titleSource: "explicit",
      linkedDirectories: [
        {
          id: "directory:/repo/app",
          label: "app",
          path: "/repo/app",
          kind: "worktree",
          worktreePath: "/repo/.worktrees/shared",
        },
      ],
      source: "codex",
      gitBranch: "codex/parent",
      updatedAt: 1,
    };
    const forkedThread: AppServerThreadSummary = {
      id: "019e7f4d-6fbb-75f1-8cc9-cc78f7ccc844",
      title: "Forked thread",
      titleSource: "explicit",
      linkedDirectories: [
        {
          id: "directory:/repo/app",
          label: "app",
          path: "/repo/app",
          kind: "worktree",
          worktreePath: "/repo/.worktrees/shared",
        },
      ],
      source: "codex",
      gitBranch: "codex/parent",
      updatedAt: 2,
    };
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list", "thread/archive"] },
      threads: [parentThread, forkedThread],
    });
    const archiveWorktree = vi.fn();
    await mockArchiveWorktreePresence(["/repo/.worktrees/shared"]);
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      worktreeArchiveService: {
        archive: archiveWorktree,
      } as unknown as WorktreeArchiveService,
    });

    const response = await registry.archiveThread({
      backend: "codex",
      threadId: "019e7f4d-6fbb-75f1-8cc9-cc78f7ccc844",
    });

    expect(codexClient.lastArchiveThreadParams).toEqual({
      threadId: "019e7f4d-6fbb-75f1-8cc9-cc78f7ccc844",
    });
    expect(archiveWorktree).not.toHaveBeenCalled();
    expect(response.cleanup).toEqual([
      {
        worktreePath: "/repo/.worktrees/shared",
        branch: "codex/parent",
        removedWorktree: false,
        deletedBranch: false,
        skippedReason:
          "Worktree is still used by another active thread: 019e79f9-7ff1-7f31-9a67-f92435a1c9fa.",
        blockingThreads: [{ backend: "codex", threadId: "019e79f9-7ff1-7f31-9a67-f92435a1c9fa", title: "Parent thread" }],
      },
    ]);

    await registry.close();
  });

  it.each(["expired", "fresh", "unobserved", "disabled", "active", "pinned", "Agent", "external", "unreadable", "failed-delete", "shared-ref", "missing"])(
    "applies archived Claude retention through its own store: %s", async (scenario) => {
      const day = 86_400_000;
      const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-claude-retention-"));
      const store = new ClaudeSessionStore(path.join(root, "sessions"));
      const id = "a3333333-3333-4333-8333-333333333333";
      const cwd = scenario === "external" ? "/fixture/operator-checkout" : "/fixture/.pwragent/worktrees/retention/repo";
      const thread: AppServerThreadSummary = { id, title: "Claude archive", titleSource: "explicit", source: "claude",
        threadStatus: "idle", linkedDirectories: [], projectKey: cwd, updatedAt: Date.now() - 40 * day,
        ...(scenario === "active" ? {} : { archivedAt: Date.now() - 31 * day }),
      };
      const snapshot: WorktreeSnapshotSummary = { id: "retention-snapshot", backend: "claude", threadId: id,
        worktreePath: cwd, repositoryPath: "/fixture/repo", snapshotRef: "refs/pwragent/snapshots/retention",
        snapshotCommit: "abc", createdAt: 1, state: "archived", ignoredFilesExcluded: true };
      const overlay: ThreadOverlayState = { backend: "claude", threadId: id, extraLinkedDirectories: [],
        archiveRetentionStartedAt: scenario === "unobserved" ? undefined : Date.now() - (scenario === "fresh" ? 29 : 31) * day,
        worktreeSnapshots: [snapshot],
        ...(scenario === "pinned" ? { pinnedRank: "a" } : {}),
        ...(scenario === "Agent" ? { agent: {} as never } : {}),
      };
      let states = [overlay];
      if (scenario === "shared-ref") states.push({ ...overlay, backend: "codex", threadId: "retained", archiveRetentionStartedAt: undefined });
      const overlays = Object.fromEntries(states.map((state) => [buildThreadIdentityKey(state.backend, state.threadId), state]));
      const history = path.join(root, "sessions", `${id}.jsonl`);
      const metadata = path.join(root, "sessions", `${id}.json`);
      const backup = path.join(store.rewindBackupDirectory(id), "before.txt");
      const image = path.join(root, "sessions", "images", id, "image.png");
      const deletion = vi.spyOn(store, "delete");
      const deleteSnapshot = vi.fn(async () => {
        await expect(stat(metadata)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(stat(history)).rejects.toMatchObject({ code: "ENOENT" });
      });
      const overlayStore = Object.assign(createOverlayStoreMock({ overlays }), {
        listThreadArchiveStates: vi.fn(async () => states),
        // A superset is allowed: the sweep matches fields itself.
        listThreadArchiveStatesFor: vi.fn(async (_threads: ThreadOverlayState[], _refs: string[]) => states),
        observeArchivedThreads: vi.fn(async (records: Array<{ backend: AppServerBackendKind; threadId: string }>, now: number) => {
          for (const record of records) {
            const state = states.find((state) => state.backend === record.backend && state.threadId === record.threadId);
            if (state) state.archiveRetentionStartedAt ??= now;
          }
        }),
        forgetThreadArchiveStates: vi.fn(async (victims: ThreadOverlayState[]) => {
          states = states.filter((state) => !victims.includes(state));
        }),
      });
      const codex = Object.assign(new MockBackendClient({ threads: [] }), {
        deleteThread: vi.fn(async () => ({ threadId: id })),
        readThreadSummary: vi.fn(async () => { throw new Error(`Thread not found: ${id}`); }),
      });
      const registry = createDesktopBackendRegistry({ codexClient: codex, overlayStore, claudeBackendOptions: { store },
        worktreeArchiveService: { deleteSnapshot } as unknown as WorktreeArchiveService,
        getThreadArchivePolicy: () => ({ ...DEFAULT_THREAD_ARCHIVE_POLICY, retentionDays: scenario === "disabled" ? 0 : 30 }),
      });
      try {
        await store.save({ cwd, thread });
        await store.append(id, [{ type: "message", id: "message", role: "user", text: "Fixture history" }]);
        for (const file of [backup, image]) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, "fixture"); }
        if (scenario === "unreadable") await writeFile(metadata, "invalid metadata");
        if (scenario === "missing") await rm(metadata);
        if (scenario === "failed-delete") deletion.mockRejectedValue(new Error("Fixture store unavailable"));
        await registry.sweepInactiveThreads();
        const removed = ["expired", "shared-ref", "missing"].includes(scenario);
        expect(deletion).toHaveBeenCalledTimes(removed || scenario === "failed-delete" ? 1 : 0);
        expect(codex.deleteThread).not.toHaveBeenCalled();
        expect(codex.readThreadSummary).not.toHaveBeenCalled();
        expect(deleteSnapshot).toHaveBeenCalledTimes(removed && scenario !== "shared-ref" ? 1 : 0);
        expect(overlayStore.forgetThreadArchiveStates).toHaveBeenCalledTimes(removed ? 1 : 0);
        // Cleanup re-reads only the victim and the states sharing its ref.
        expect(overlayStore.listThreadArchiveStatesFor).toHaveBeenCalledTimes(removed ? 1 : 0);
        if (removed) expect(overlayStore.listThreadArchiveStatesFor).toHaveBeenCalledWith([overlay], [snapshot.snapshotRef]);
        for (const file of [history, backup, image]) {
          if (removed) await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
          else await expect(stat(file)).resolves.toBeDefined();
        }
        if (scenario === "unobserved") expect(overlay.archiveRetentionStartedAt).toBeGreaterThan(Date.now() - day);
      } finally { await registry.close(); await rm(root, { recursive: true, force: true }); }
    },
  );

  it.each(["restore", "view", "policy", "live"])("revalidates Claude retention at deletion: %s", async (action) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-claude-retention-race-"));
    const store = new ClaudeSessionStore(root);
    const id = "b3333333-3333-4333-8333-333333333333";
    const cwd = "/fixture/.pwragent/worktrees/retention/repo";
    const overlay: ThreadOverlayState = { backend: "claude", threadId: id, extraLinkedDirectories: [], archiveRetentionStartedAt: 1 };
    const overlayStore = Object.assign(createOverlayStoreMock({ overlays: { [`claude:${id}`]: overlay } }), {
      listThreadArchiveStates: async () => [overlay], observeArchivedThreads: vi.fn(async () => {}), forgetThreadArchiveStates: vi.fn(async () => {}),
    });
    const policy = { ...DEFAULT_THREAD_ARCHIVE_POLICY, retentionDays: 30 };
    const registry = createDesktopBackendRegistry({ codexClient: new MockBackendClient({}), overlayStore,
      claudeBackendOptions: { store }, getThreadArchivePolicy: () => ({ ...policy }) });
    let mutation: Promise<void> | undefined;
    const deletion = vi.spyOn(store, "delete");
    const backend = (registry as unknown as { claudeBackend: ClaudeBackend }).claudeBackend;
    const originalRead = backend.readThreadSummary.bind(backend);
    vi.spyOn(backend, "readThreadSummary").mockImplementation(async (threadId) => {
      if (action === "restore") {
        const session = await store.read(threadId);
        session.thread.archivedAt = undefined;
        await store.save(session);
      }
      if (action === "live") vi.spyOn(backend, "hasLiveSession").mockReturnValue(true);
      if (action === "policy") policy.retentionDays = 0;
      if (action === "view") mutation = registry.withThreadLifecycleMutation({ backend: "claude", threadId: id }, async () => {});
      return await originalRead(threadId);
    });
    try {
      await store.save({ cwd, thread: { id, source: "claude", title: "Archive", titleSource: "explicit", linkedDirectories: [], archivedAt: 1 } });
      await registry.sweepInactiveThreads();
      await mutation;
      expect(deletion).not.toHaveBeenCalled();
      expect(overlayStore.forgetThreadArchiveStates).not.toHaveBeenCalled();
    } finally { await registry.close(); await rm(root, { recursive: true, force: true }); }
  });

  it.each([true, false])("cleans every deleted descendant before forgetting family archive states: provider success=%s", async (succeeds) => {
    const day = 86_400_000;
    const family: AppServerThreadSummary[] = ["family-root", "family-child", "family-grandchild"].map((id, index, ids) => ({
      id, title: id, titleSource: "explicit", source: "codex", threadStatus: "notLoaded", linkedDirectories: [],
      updatedAt: Date.now() - 40 * day, archivedAt: Date.now() - 31 * day,
      ...(index > 0 ? { codexNativeSubAgent: { parentThreadId: ids[index - 1]! } } : {}),
    }));
    let states: ThreadOverlayState[] = family.map((thread) => ({ backend: "codex", threadId: thread.id, extraLinkedDirectories: [], archiveRetentionStartedAt: Date.now() - 31 * day }));
    const overlays = Object.fromEntries(states.map((state) => [buildThreadIdentityKey(state.backend, state.threadId), state]));
    const assets: string[] = [];
    const previews: string[] = [];
    for (const thread of family) {
      const asset = await stageTurnInputAttachment({ type: "localImage", name: "image.png", data: Buffer.from([1, 2, 3]) }, { backend: thread.source, threadId: thread.id });
      assets.push(asset.path);
      const preview = resolveActiveProfilePath(`state/thread-images/codex/${thread.id}/preview.png`);
      await mkdir(path.dirname(preview), { recursive: true });
      await writeFile(preview, Buffer.from([1, 2, 3]));
      previews.push(preview);
    }
    const overlayStore = Object.assign(createOverlayStoreMock({ overlays }), {
      listThreadArchiveStates: vi.fn(async () => states), observeArchivedThreads: vi.fn(async () => {}),
      forgetThreadArchiveStates: vi.fn(async () => {
        for (const asset of [...assets, ...previews]) await expect(stat(asset)).rejects.toMatchObject({ code: "ENOENT" });
        states = [];
      }),
    });
    const client = Object.assign(new MockBackendClient({ threads: [], archivedThreads: [family[0]!] }), {
      deleteThread: vi.fn(async () => {
        if (!succeeds) throw new Error("Fixture provider deletion failed.");
        return { threadId: family[0]!.id };
      }),
      readThreadSummary: vi.fn(async (id: string) => family.find((thread) => thread.id === id)!),
    });
    vi.spyOn(client, "listNativeSubAgentThreads").mockImplementation(async (params) => (params as { archived?: boolean })?.archived ? family.slice(1) : []);
    const registry = createDesktopBackendRegistry({ codexClient: client, overlayStore,
      getThreadArchivePolicy: () => ({ ...DEFAULT_THREAD_ARCHIVE_POLICY, retentionDays: 30 }),
    });
    try {
      await registry.sweepInactiveThreads();
      expect(client.deleteThread).toHaveBeenCalledExactlyOnceWith({ threadId: family[0]!.id });
      if (succeeds) {
        for (const asset of [...assets, ...previews]) await expect(stat(asset)).rejects.toMatchObject({ code: "ENOENT" });
        expect(states).toEqual([]);
      } else {
        for (const asset of [...assets, ...previews]) await expect(readFile(asset)).resolves.toEqual(Buffer.from([1, 2, 3]));
        expect(overlayStore.forgetThreadArchiveStates).not.toHaveBeenCalled();
      }
    } finally { await registry.close(); }
  });

  it.each(["delete", "pin", "view", "restore", "activity", "policy"])("revalidates expired archive deletion at the provider boundary: %s", async (action) => {
    const day = 86_400_000;
    const thread: AppServerThreadSummary = {
      id: "expired", title: "Expired archive", titleSource: "explicit", source: "codex",
      threadStatus: "notLoaded", linkedDirectories: [], updatedAt: Date.now() - 40 * day,
      archivedAt: Date.now() - 31 * day,
    };
    const overlay: ThreadOverlayState = {
      backend: "codex", threadId: thread.id, extraLinkedDirectories: [],
      archiveRetentionStartedAt: Date.now() - 31 * day,
    };
    let states = [overlay];
    const overlayStore = Object.assign(createOverlayStoreMock({ overlays: { "codex:expired": overlay } }), {
      listThreadArchiveStates: vi.fn(async () => states),
      observeArchivedThreads: vi.fn(async () => {}),
      forgetThreadArchiveStates: vi.fn(async () => { states = []; }),
    });
    const policy = { ...DEFAULT_THREAD_ARCHIVE_POLICY, retentionDays: 30 };
    let mutation: Promise<void> | undefined;
    let registry!: DesktopBackendRegistry;
    const deleteThread = vi.fn(async () => ({ threadId: thread.id }));
    const client = Object.assign(new MockBackendClient({ threads: [], archivedThreads: [thread] }), {
      deleteThread,
      readThreadSummary: vi.fn(async () => {
        if (["pin", "view", "restore"].includes(action)) {
          mutation = registry.withThreadLifecycleMutation({ backend: "codex", threadId: thread.id }, async () => {});
        }
        if (action === "policy") policy.retentionDays = 0;
        return action === "activity" ? { ...thread, threadStatus: "active" as const, updatedAt: Date.now() } : thread;
      }),
    });
    registry = createDesktopBackendRegistry({ codexClient: client, overlayStore, getThreadArchivePolicy: () => ({ ...policy }) });
    try {
      await registry.sweepInactiveThreads();
      await mutation;
      if (action === "delete") {
        expect(deleteThread).toHaveBeenCalledExactlyOnceWith({ threadId: thread.id });
        expect(overlayStore.forgetThreadArchiveStates).toHaveBeenCalledTimes(1);
      } else {
        expect(deleteThread).not.toHaveBeenCalled();
        expect(overlayStore.forgetThreadArchiveStates).not.toHaveBeenCalled();
      }
    } finally { await registry.close(); }
  });

  it("protects a thread appearing in both active and archived inventories", async () => {
    const thread: AppServerThreadSummary = {
      id: "moving", title: "Moving thread", titleSource: "explicit", source: "codex",
      threadStatus: "idle", linkedDirectories: [], updatedAt: Date.now() - 40 * 86_400_000,
    };
    const overlay = { backend: "codex" as const, threadId: thread.id, extraLinkedDirectories: [], archiveRetentionStartedAt: 1 };
    const deleteThread = vi.fn(async () => ({ threadId: thread.id }));
    const client = Object.assign(new MockBackendClient({ threads: [{ ...thread, archivedAt: 1 }], archivedThreads: [thread] }), { deleteThread });
    const overlayStore = Object.assign(createOverlayStoreMock({ overlays: { "codex:moving": overlay } }), {
      listThreadArchiveStates: async () => [overlay], observeArchivedThreads: vi.fn(async () => {}), forgetThreadArchiveStates: vi.fn(async () => {}),
    });
    const registry = createDesktopBackendRegistry({ codexClient: client, overlayStore,
      getThreadArchivePolicy: () => ({ ...DEFAULT_THREAD_ARCHIVE_POLICY, retentionDays: 30 }) });
    try { await registry.sweepInactiveThreads(); expect(deleteThread).not.toHaveBeenCalled(); }
    finally { await registry.close(); }
  });

  it("never archives a stale thread in a day of hourly sweeps, and writes nothing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-hourly-sweep-"));
    const metricsEnv = process.env[SQLITE_WRITE_METRICS_ENV];
    process.env[SQLITE_WRITE_METRICS_ENV] = "1";
    const db = StateDb.open(path.join(root, "state.db"));
    const sessionStore = new AcpSessionStore(db);
    const staleAt = Date.now() - 400 * 24 * 60 * 60_000;
    sessionStore.upsertSession({ backendId: "acp:kimi", sessionId: "old-idle", title: "Old idle", createdAt: staleAt, updatedAt: staleAt, executionMode: "default", status: "idle" });
    const thread: AppServerThreadSummary = {
      id: "stale-thread", title: "Old thread", titleSource: "explicit", source: "codex",
      threadStatus: "notLoaded", linkedDirectories: [], updatedAt: staleAt,
    };
    const client = Object.assign(new MockBackendClient({ threads: [thread] }), { readThreadSummary: vi.fn(async () => thread) });
    const archive = vi.spyOn(client, "archiveThread");
    // An old config.toml can still hold the retired switch; it archives nothing.
    const registry = createDesktopBackendRegistry({
      getThreadArchivePolicy: () => ({ ...DEFAULT_THREAD_ARCHIVE_POLICY, mode: "age", inactivityDays: 1, enabled: true } as typeof DEFAULT_THREAD_ARCHIVE_POLICY),
      codexClient: client,
      overlayStore: new SqliteOverlayStore(db), messagingStore: null,
      acpAgentStore: createAcpAgentStoreMock([createKimiAgentRecord()]),
      acpSessionStore: sessionStore,
    });
    try {
      const { writes } = await measureSqliteWrites(async () => {
        for (let hour = 0; hour < 24; hour++) await registry.sweepInactiveThreads();
      });
      expect(archive).not.toHaveBeenCalled();
      expect(sessionStore.getSession("acp:kimi", "old-idle")?.archivedAt).toBeUndefined();
      expectSqliteWriteBudget({ scenario: "hourly-sweep-idle-day", note: "24 hourly sweeps over a stale Codex thread and a stale ACP session with nothing to hibernate or delete. The sweep archives nothing, so it commits nothing.", writes });
    } finally {
      await registry.close();
      db.close();
      if (metricsEnv === undefined) delete process.env[SQLITE_WRITE_METRICS_ENV];
      else process.env[SQLITE_WRITE_METRICS_ENV] = metricsEnv;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("skips worktree cleanup when an active same-worktree child is recorded as local", async () => {
    const parentThread: AppServerThreadSummary = {
      id: "thread-parent",
      title: "Parent thread",
      titleSource: "explicit",
      linkedDirectories: [
        {
          id: "directory:/repo/app",
          label: "app",
          path: "/repo/app",
          kind: "worktree",
          worktreePath: "/repo/.worktrees/shared",
        },
      ],
      source: "codex",
      gitBranch: "codex/parent",
      updatedAt: 1,
    };
    const childThread: AppServerThreadSummary = {
      id: "thread-child",
      title: "Child thread",
      titleSource: "explicit",
      linkedDirectories: [
        {
          id: "directory:/repo/.worktrees/shared",
          label: "app",
          path: "/repo/.worktrees/shared",
          kind: "local",
        },
      ],
      source: "codex",
      gitBranch: "codex/parent",
      updatedAt: 2,
    };
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list", "thread/archive"] },
      threads: [parentThread, childThread],
    });
    const archiveWorktree = vi.fn();
    await mockArchiveWorktreePresence(["/repo/.worktrees/shared"]);
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      worktreeArchiveService: {
        archive: archiveWorktree,
      } as unknown as WorktreeArchiveService,
    });

    const response = await registry.archiveThread({
      backend: "codex",
      threadId: "thread-parent",
    });

    expect(archiveWorktree).not.toHaveBeenCalled();
    expect(response.cleanup).toEqual([
      {
        worktreePath: "/repo/.worktrees/shared",
        branch: "codex/parent",
        removedWorktree: false,
        deletedBranch: false,
        skippedReason:
          "Worktree is still used by another active thread: thread-child.",
        blockingThreads: [{ backend: "codex", threadId: "thread-child", title: "Child thread" }],
      },
    ]);

    await registry.close();
  });

  it("skips Codex parent worktree cleanup while an active ACP child shares it", async () => {
    const worktreePath = "/repo/.worktrees/shared";
    const parentThread: AppServerThreadSummary = {
      id: "codex-parent",
      title: "Codex parent",
      titleSource: "explicit",
      linkedDirectories: [
        {
          id: "directory:/repo/app",
          label: "app",
          path: "/repo/app",
          kind: "worktree",
          worktreePath,
        },
      ],
      source: "codex",
      gitBranch: "codex/parent",
      updatedAt: 1,
    };
    const childSession: AcpSessionMetadata = {
      backendId: "acp:kimi" as AcpBackendId,
      sessionId: "kimi-child",
      title: "Kimi child",
      cwd: worktreePath,
      createdAt: 2,
      updatedAt: 2,
      executionMode: "default",
      status: "idle",
    };
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list", "thread/archive"] },
      threads: [parentThread],
    });
    const archiveWorktree = vi.fn(async () => ({
      id: "snapshot-1",
      backend: "codex" as const,
      threadId: "codex-parent",
      worktreePath,
      repositoryPath: "/repo/app",
      snapshotRef: "refs/pwragent/snapshots/snapshot-1",
      snapshotCommit: "abc123",
      sourceBranch: "codex/parent",
      sourceHead: "def456",
      createdAt: 1000,
      archivedAt: 1000,
      state: "archived" as const,
      ignoredFilesExcluded: true,
    }));
    await mockArchiveWorktreePresence([worktreePath]);
    const { registry } = createKimiAcpRegistry({
      codexClient,
      sessions: [childSession],
      worktreeArchiveService: {
        archive: archiveWorktree,
      } as unknown as WorktreeArchiveService,
    });

    const response = await registry.archiveThread({
      backend: "codex",
      threadId: "codex-parent",
    });

    expect(archiveWorktree).not.toHaveBeenCalled();
    expect(response.cleanup).toEqual([
      {
        worktreePath,
        branch: "codex/parent",
        removedWorktree: false,
        deletedBranch: false,
        skippedReason:
          "Worktree is still used by another active thread: kimi-child.",
        blockingThreads: [{ backend: "acp:kimi", threadId: "kimi-child", title: "Kimi child" }],
      },
    ]);

    await registry.close();
  });

  it("skips Codex worktree cleanup while an active Claude thread runs in it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-claude-worktree-"));
    const worktreePath = "/repo/.worktrees/shared";
    const worktree: LinkedDirectorySummary = {
      id: "directory:/repo/app", label: "app", path: "/repo/app", kind: "worktree", worktreePath,
    };
    const codexThread: AppServerThreadSummary = {
      id: "codex-parent", title: "Codex parent", titleSource: "explicit", linkedDirectories: [worktree],
      source: "codex", gitBranch: "codex/parent", updatedAt: 1,
    };
    const claudeId = "6a1d2c3b-4e5f-4a7b-8c9d-0e1f2a3b4c5d";
    const store = new ClaudeSessionStore(path.join(root, "sessions"));
    // Saved the way a Claude thread started in a folder is: a local cwd.
    await store.save({ cwd: worktreePath, thread: {
      id: claudeId, title: "Claude user", titleSource: "explicit", source: "claude", updatedAt: 2,
      linkedDirectories: [{ id: worktreePath, kind: "local", label: "shared", path: worktreePath }],
    } });
    const archiveWorktree = vi.fn();
    const acpWorktreeRepositoryResolver = vi.fn(async (cwd: string) => cwd === worktreePath ? worktree : undefined);
    const codexClient = Object.assign(new MockBackendClient({
      initializeResult: { methods: ["thread/list", "thread/archive"] },
      threads: [codexThread],
    }), {
      // The shipped Codex client uses the paged inventory, not the aggregate listing.
      listArchiveCleanupThreadsPage: vi.fn(async ({ archived }: { archived: boolean }) => ({
        threads: archived ? [{ ...codexThread, archived: true }] : [],
      })),
    });
    await mockArchiveWorktreePresence([worktreePath]);
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      pdfToolMcpServer: null,
      worktreeArchiveService: { archive: archiveWorktree } as unknown as WorktreeArchiveService,
      acpWorktreeRepositoryResolver,
      claudeBackendOptions: {
        store,
        inspectInstallation: async () => ({ executable: "/fixture/claude", authStatus: "signed-in" }),
        discoverModels: async () => [],
      },
    });
    try {
      const response = await registry.archiveThread({ backend: "codex", threadId: "codex-parent" });
      expect(codexClient.listArchiveCleanupThreadsPage).toHaveBeenCalled();
      expect(archiveWorktree).not.toHaveBeenCalled();
      expect(response.cleanup).toEqual([expect.objectContaining({
        worktreePath, removedWorktree: false,
        skippedReason: `Worktree is still used by another active thread: ${claudeId}.`,
      })]);
    } finally {
      await registry.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a grandchild in its original tray when three siblings are archived", async () => {
    const db = openInMemoryStateDb();
    const overlayStore = new SqliteOverlayStore(db);
    const ids = ["root", "before", "archive-a", "survivor", "archive-b", "archive-c", "after"];
    let threads: AppServerThreadSummary[] = ids.map((id, index) => ({
      id, title: id, titleSource: "explicit", linkedDirectories: [], source: "codex",
      createdAt: index, updatedAt: index,
    }));
    for (const id of ["before", "archive-a", "archive-b", "archive-c", "after"]) {
      await overlayStore.setThreadParent({ backend: "codex", threadId: id, parentThreadId: "root" });
    }
    await overlayStore.setThreadParent({ backend: "codex", threadId: "survivor", parentThreadId: "archive-a" });
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list", "thread/archive"] }, threads,
    });
    const archived: string[] = [];
    vi.spyOn(codexClient, "archiveThread").mockImplementation(async ({ threadId }) => {
      archived.push(threadId);
      threads = threads.filter((thread) => thread.id !== threadId);
      codexClient.setThreads(threads);
      return { threadId };
    });
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore });
    // The tray must survive the foreground mutation, even while expensive
    // worktree cleanup has not reached its child-ungrouping stage.
    const cleanup = vi.spyOn(registryModules(registry).threadArchiveCoordinator as unknown as {
      ungroupChildrenOfArchivedThread(params: unknown): Promise<void>;
    }, "ungroupChildrenOfArchivedThread").mockResolvedValue();
    try {
      for (const threadId of ["archive-a", "archive-b", "archive-c"]) {
        await registry.archiveThread({ backend: "codex", threadId, backgroundCleanup: true });
      }
      expect(archived).toEqual(["archive-a", "archive-b", "archive-c"]);
      expect(await overlayStore.getThreadOverlayState({ backend: "codex", threadId: "survivor" }))
        .toMatchObject({ parentThreadId: "root", parentThreadBackend: "codex" });
      expect((await overlayStore.getThreadOverlayState({ backend: "codex", threadId: "root" }))?.subthreadOrder)
        .toEqual(["before", "survivor", "after"]);
      expect((await overlayStore.getThreadOverlayState({ backend: "codex", threadId: "survivor" }))?.archiveRetentionStartedAt)
        .toBeUndefined();
    } finally {
      cleanup.mockRestore();
      await registry.close();
      db.close();
    }
  });

  it.each(["claude", "acp:gemini"] as const)(
    "keeps restored %s ancestors and children eligible for archive promotion", async (backend) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-restore-promotion-"));
      const db = openInMemoryStateDb();
      const overlayStore = new SqliteOverlayStore(db);
      const store = new ClaudeSessionStore(path.join(root, "sessions"));
      const ancestor = "0f7b3c1e-2d4a-4e5f-9a6b-7c8d9e0f1a2b";
      const survivor = "6a1d2c3b-4e5f-4a7b-8c9d-0e1f2a3b4c5d";
      const restoredIds = [ancestor, survivor];
      for (const id of restoredIds) {
        if (backend === "claude") await store.save({ cwd: root, thread: {
          id, title: id, titleSource: "explicit", linkedDirectories: [], source: backend,
          updatedAt: 1, archivedAt: 1000,
        } });
        await overlayStore.observeArchivedThreads([{ backend, threadId: id }], 1000);
      }
      const codexClient = new MockBackendClient({
        threads: [{ id: "nested", title: "nested", titleSource: "explicit", linkedDirectories: [],
          source: "codex", updatedAt: 1 }],
      });
      const registry = createDesktopBackendRegistry({
        codexClient, overlayStore,
        claudeBackendOptions: { store, inspectInstallation: async () => ({ executable: "/fixture/claude", authStatus: "signed-in" }),
          discoverModels: async () => [] },
        acpSessionStore: createAcpSessionStoreMock(backend === "claude" ? [] : restoredIds.map((sessionId) => ({
          backendId: backend, sessionId, title: sessionId, createdAt: 1, updatedAt: 1,
          executionMode: "default", status: "idle", archivedAt: 1000,
        }))),
      });
      const markersAtNotification: Array<number | undefined> = [];
      const unsubscribe = registry.onEvent(async (event) => {
        if (event.notification.method === "thread/unarchived") {
          markersAtNotification.push((await overlayStore.getThreadOverlayState({
            backend: event.backend, threadId: event.notification.params.threadId,
          }))?.archiveRetentionStartedAt);
        }
      });
      // Keep cleanup from masking the foreground promotion result.
      const cleanup = vi.spyOn(registryModules(registry).threadArchiveCoordinator as unknown as {
        ungroupChildrenOfArchivedThread(params: unknown): Promise<void>;
      }, "ungroupChildrenOfArchivedThread").mockResolvedValue();
      try {
        for (const threadId of restoredIds) await registry.restoreThread({ backend, threadId });
        await overlayStore.setThreadParent({ backend, threadId: ancestor, parentThreadId: "root", parentThreadBackend: "codex" });
        for (const threadId of ["before", "nested", "after"]) {
          await overlayStore.setThreadParent({ backend: "codex", threadId, parentThreadId: ancestor, parentThreadBackend: backend });
        }
        await overlayStore.setThreadParent({ backend, threadId: survivor, parentThreadId: "nested", parentThreadBackend: "codex" });
        await registry.archiveThread({ backend: "codex", threadId: "nested", backgroundCleanup: true });
        expect(await overlayStore.getThreadOverlayState({ backend, threadId: survivor }))
          .toMatchObject({ parentThreadId: ancestor, parentThreadBackend: backend });
        expect((await overlayStore.getThreadOverlayState({ backend, threadId: ancestor }))?.subthreadOrder)
          .toEqual(["before", survivor, "after"]);
        expect(markersAtNotification).toEqual([undefined, undefined]);
        for (const threadId of restoredIds) {
          const state = await overlayStore.getThreadOverlayState({ backend, threadId });
          expect(state?.archiveRetentionStartedAt).toBeUndefined();
          expect(state?.archiveTombstonedAt).toBeUndefined();
          expect(state?.archiveRestoredAt).toEqual(expect.any(Number));
        }
        await overlayStore.observeArchivedThreads([{ backend, threadId: "missing" }], 1000);
        await expect(registry.restoreThread({ backend, threadId: "missing" })).rejects.toThrow();
        expect((await overlayStore.getThreadOverlayState({ backend, threadId: "missing" }))?.archiveRetentionStartedAt).toBe(1000);
      } finally {
        unsubscribe();
        cleanup.mockRestore();
        await registry.close();
        db.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("clears archive markers before publishing a provider restore notification", async () => {
    const db = openInMemoryStateDb();
    const overlayStore = new SqliteOverlayStore(db);
    const identity = { backend: "codex" as const, threadId: "restored" };
    await overlayStore.observeArchivedThreads([identity], 1000);
    await overlayStore.setThreadArchiveTombstone({ ...identity, archivedAt: 1000 });
    const codexClient = new MockBackendClient({ threads: [] });
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore });
    const observations: Array<ThreadOverlayState | undefined> = [];
    const unsubscribe = registry.onEvent(async (event) => {
      if (event.notification.method === "thread/unarchived") observations.push(await overlayStore.getThreadOverlayState(identity));
    });
    try {
      await codexClient.emit({ method: "thread/unarchived", params: { threadId: identity.threadId } });
      expect(observations).toHaveLength(1);
      expect(observations[0]?.archiveRetentionStartedAt).toBeUndefined();
      expect(observations[0]?.archiveTombstonedAt).toBeUndefined();
      expect(observations[0]?.archiveRestoredAt).toEqual(expect.any(Number));
      await overlayStore.observeArchivedThreads([identity], Date.now() + 1);
      expect((await overlayStore.getThreadOverlayState(identity))?.archiveRetentionStartedAt).toEqual(expect.any(Number));
    } finally {
      unsubscribe();
      await registry.close();
      db.close();
    }
  });

  it("ungroups active child threads when archiving only the parent", async () => {
    const parentThread: AppServerThreadSummary = {
      id: "thread-parent",
      title: "Parent thread",
      titleSource: "explicit",
      linkedDirectories: [],
      source: "codex",
      updatedAt: 1,
    };
    const childThread: AppServerThreadSummary = {
      id: "thread-child",
      title: "Child thread",
      titleSource: "explicit",
      linkedDirectories: [],
      source: "codex",
      updatedAt: 2,
    };
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-child": {
          backend: "codex",
          threadId: "thread-child",
          executionMode: "default",
          extraLinkedDirectories: [],
          parentThreadId: "thread-parent",
        },
      },
    });
    const setThreadParent = vi.spyOn(overlayStore, "setThreadParent");
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list", "thread/archive"] },
      threads: [parentThread, childThread],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
      worktreeArchiveService: {
        archive: vi.fn(),
      } as unknown as WorktreeArchiveService,
    });

    await registry.archiveThread({
      backend: "codex",
      threadId: "thread-parent",
    });

    expect(setThreadParent).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-child",
      parentThreadId: undefined,
      expectedParent: { threadId: "thread-parent", backend: "codex", instanceId: undefined },
    });

    await registry.close();
  });

  it("ungroups legacy cross-provider ACP children when archiving a Codex parent", async () => {
    const parentThread: AppServerThreadSummary = {
      id: "codex-parent",
      title: "Codex parent",
      titleSource: "explicit",
      linkedDirectories: [],
      source: "codex",
      updatedAt: 1,
    };
    const childSession: AcpSessionMetadata = {
      backendId: "acp:kimi" as AcpBackendId,
      sessionId: "kimi-child",
      title: "Kimi child",
      createdAt: 2,
      updatedAt: 2,
      executionMode: "default",
      status: "idle",
    };
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "acp:kimi:kimi-child": {
          backend: "acp:kimi",
          threadId: "kimi-child",
          executionMode: "default",
          extraLinkedDirectories: [],
          parentThreadId: "codex-parent",
        },
      },
    });
    const setThreadParent = vi.spyOn(overlayStore, "setThreadParent");
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list", "thread/archive"] },
      threads: [parentThread],
    });
    const { registry } = createKimiAcpRegistry({
      codexClient,
      overlayStore,
      sessions: [childSession],
    });

    await registry.archiveThread({
      backend: "codex",
      threadId: "codex-parent",
    });

    expect(setThreadParent).toHaveBeenCalledWith({
      backend: "acp:kimi",
      threadId: "kimi-child",
      parentThreadId: undefined,
      expectedParent: { threadId: "codex-parent", backend: "acp:kimi", instanceId: undefined },
    });

    await registry.close();
  });

  it("ungroups active Codex children when archiving an ACP parent", async () => {
    const parentSession: AcpSessionMetadata = {
      backendId: "acp:kimi" as AcpBackendId,
      sessionId: "kimi-parent",
      title: "Kimi parent",
      createdAt: 1,
      updatedAt: 1,
      executionMode: "default",
      status: "idle",
    };
    const childThread: AppServerThreadSummary = {
      id: "codex-child",
      title: "Codex child",
      titleSource: "explicit",
      linkedDirectories: [],
      source: "codex",
      updatedAt: 2,
    };
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:codex-child": {
          backend: "codex",
          threadId: "codex-child",
          executionMode: "default",
          extraLinkedDirectories: [],
          parentThreadId: "kimi-parent",
          parentThreadBackend: "acp:kimi",
        },
      },
    });
    const setThreadParent = vi.spyOn(overlayStore, "setThreadParent");
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list"] },
      threads: [childThread],
    });
    const { registry } = createKimiAcpRegistry({
      codexClient,
      overlayStore,
      sessions: [parentSession],
    });

    await registry.archiveThread({
      backend: "acp:kimi",
      threadId: "kimi-parent",
    });

    expect(setThreadParent).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "codex-child",
      parentThreadId: undefined,
      expectedParent: { threadId: "kimi-parent", backend: "acp:kimi", instanceId: undefined },
    });

    await registry.close();
  });

  it("records the archive and ungroups active children when archiving a Claude parent", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-claude-archive-"));
    const parentId = "0f7b3c1e-2d4a-4e5f-9a6b-7c8d9e0f1a2b";
    const store = new ClaudeSessionStore(path.join(root, "sessions"));
    await store.save({ cwd: root, thread: {
      id: parentId, title: "Claude parent", titleSource: "explicit", linkedDirectories: [], source: "claude", updatedAt: 1,
    } });
    const childThread: AppServerThreadSummary = {
      id: "codex-child", title: "Codex child", titleSource: "explicit", linkedDirectories: [], source: "codex", updatedAt: 2,
    };
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:codex-child": {
          backend: "codex", threadId: "codex-child", executionMode: "default", extraLinkedDirectories: [],
          parentThreadId: parentId, parentThreadBackend: "claude",
        },
      },
    });
    const observeArchivedThreads = vi.fn(async () => {});
    Object.assign(overlayStore, { observeArchivedThreads });
    const setThreadParent = vi.spyOn(overlayStore, "setThreadParent");
    const codexClient = new MockBackendClient({ initializeResult: { methods: ["thread/list"] }, threads: [childThread] });
    const archiveCodexThread = vi.spyOn(codexClient, "archiveThread");
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
      pdfToolMcpServer: null,
      claudeBackendOptions: {
        store,
        inspectInstallation: async () => ({ executable: "/fixture/claude", authStatus: "signed-in" }),
        discoverModels: async () => [],
      },
    });
    try {
      await registry.archiveThread({ backend: "claude", threadId: parentId });
      expect(archiveCodexThread).not.toHaveBeenCalled();
      expect((await store.read(parentId)).thread.archivedAt).toEqual(expect.any(Number));
      expect(observeArchivedThreads).toHaveBeenCalledWith(
        [{ backend: "claude", threadId: parentId }], expect.any(Number), { promoteSubthreads: true },
      );
      expect(setThreadParent).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "codex-child",
        parentThreadId: undefined,
        expectedParent: { threadId: parentId, backend: "claude", instanceId: undefined },
      });
    } finally {
      await registry.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes a linked worktree when only archived threads still reference it", async () => {
    const activeThread: AppServerThreadSummary = {
      id: "thread-active",
      title: "Archive me",
      titleSource: "explicit",
      linkedDirectories: [
        {
          id: "directory:/repo/app",
          label: "app",
          path: "/repo/app",
          kind: "worktree",
          worktreePath: "/repo/.worktrees/shared",
        },
      ],
      source: "codex",
      gitBranch: "codex/shared",
      updatedAt: 2,
    };
    const archivedThread: AppServerThreadSummary = {
      ...activeThread,
      id: "thread-already-archived",
      title: "Already archived",
      updatedAt: 1,
    };
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list", "thread/archive"] },
      archivedThreads: [archivedThread],
      threads: [activeThread],
    });
    const archiveWorktree = vi.fn(async () => ({
      id: "snapshot-1",
      backend: "codex" as const,
      threadId: "thread-active",
      worktreePath: "/repo/.worktrees/shared",
      repositoryPath: "/repo/app",
      snapshotRef: "refs/codex/snapshots/snapshot-1",
      snapshotCommit: "abc123",
      sourceBranch: "codex/shared",
      sourceHead: "def456",
      createdAt: 1000,
      archivedAt: 1000,
      state: "archived" as const,
      ignoredFilesExcluded: true,
    }));
    await mockArchiveWorktreePresence(["/repo/.worktrees/shared"], () => archiveWorktree.mock.calls.length === 0);
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      worktreeArchiveService: {
        archive: archiveWorktree,
      } as unknown as WorktreeArchiveService,
    });

    const response = await registry.archiveThread({
      backend: "codex",
      threadId: "thread-active",
    });

    expect(archiveWorktree).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-active",
      worktreePath: "/repo/.worktrees/shared",
      repositoryPath: "/repo/app",
    });
    expect(response.cleanup).toEqual([
      {
        worktreePath: "/repo/.worktrees/shared",
        branch: "codex/shared",
        removedWorktree: true,
        deletedBranch: false,
      },
    ]);

    await registry.close();
  });

  it("removes a local same-worktree child worktree when no active threads still use it", async () => {
    const childThread: AppServerThreadSummary = {
      id: "thread-child",
      title: "Child thread",
      titleSource: "explicit",
      linkedDirectories: [
        {
          id: "directory:/Users/test/.codex/worktrees/shared/PwrAgnt",
          label: "PwrAgnt",
          path: "/Users/test/.codex/worktrees/shared/PwrAgnt",
          kind: "local",
        },
      ],
      source: "codex",
      gitBranch: "codex/shared",
      updatedAt: 2,
    };
    const archivedParentThread: AppServerThreadSummary = {
      id: "thread-parent",
      title: "Already archived parent",
      titleSource: "explicit",
      linkedDirectories: [
        {
          id: "directory:/repo/PwrAgnt",
          label: "PwrAgnt",
          path: "/repo/PwrAgnt",
          kind: "worktree",
          worktreePath: "/Users/test/.codex/worktrees/shared/PwrAgnt",
        },
      ],
      source: "codex",
      gitBranch: "codex/shared",
      updatedAt: 1,
    };
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list", "thread/archive"] },
      archivedThreads: [archivedParentThread],
      threads: [childThread],
    });
    const archiveWorktree = vi.fn(async () => ({
      id: "snapshot-1",
      backend: "codex" as const,
      threadId: "thread-child",
      worktreePath: "/Users/test/.codex/worktrees/shared/PwrAgnt",
      repositoryPath: "/repo/PwrAgnt",
      snapshotRef: "refs/codex/snapshots/snapshot-1",
      snapshotCommit: "abc123",
      sourceBranch: "codex/shared",
      sourceHead: "def456",
      createdAt: 1000,
      archivedAt: 1000,
      state: "archived" as const,
      ignoredFilesExcluded: true,
    }));
    await mockArchiveWorktreePresence(["/Users/test/.codex/worktrees/shared/PwrAgnt"], () => archiveWorktree.mock.calls.length === 0);
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      worktreeArchiveService: {
        archive: archiveWorktree,
      } as unknown as WorktreeArchiveService,
    });

    const response = await registry.archiveThread({
      backend: "codex",
      threadId: "thread-child",
    });

    expect(archiveWorktree).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-child",
      worktreePath: "/Users/test/.codex/worktrees/shared/PwrAgnt",
      repositoryPath: "/Users/test/.codex/worktrees/shared/PwrAgnt",
    });
    expect(response.cleanup).toEqual([
      {
        worktreePath: "/Users/test/.codex/worktrees/shared/PwrAgnt",
        branch: "codex/shared",
        removedWorktree: true,
        deletedBranch: false,
      },
    ]);

    await registry.close();
  });

  it.each([false, true])("discovers archive worktrees after a cheap listing (shared checkout: %s)", async (shared) => {
    const worktreePath = "/repo/checkouts/feature";
    const directory = {
      id: "directory:/repo/app",
      label: "app",
      path: "/repo/app",
      kind: "worktree" as const,
      worktreePath,
    };
    const target: AppServerThreadSummary = {
      id: "archive-target",
      title: "Archive target",
      titleSource: "explicit",
      source: "codex",
      projectKey: worktreePath,
      linkedDirectories: [directory],
      updatedAt: 1,
    };
    const sibling: AppServerThreadSummary = {
      ...target,
      id: "unvisited-sibling",
      title: "Unvisited sibling",
      projectKey: `${worktreePath}/src`,
    };
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list", "thread/archive"] },
    });
    vi.spyOn(codexClient, "listThreads").mockImplementation(async (params) => {
      if (params?.archived) return [];
      return (shared ? [target, sibling] : [target]).map((thread) =>
        params?.enrichDirectories || (shared && thread === target)
          ? thread
          : {
              ...thread,
              linkedDirectories: [{
                id: `directory:${thread.projectKey}`,
                label: "feature",
                path: thread.projectKey!,
                kind: "local" as const,
              }],
            },
      );
    });
    const archiveWorktree = vi.fn(async () => ({
      id: "archive-snapshot",
      backend: "codex" as const,
      threadId: target.id,
      worktreePath,
      repositoryPath: "/repo/app",
      snapshotRef: "refs/codex/snapshots/archive-snapshot",
      snapshotCommit: "abc123",
      sourceHead: "def456",
      createdAt: 1000,
      archivedAt: 1000,
      state: "archived" as const,
      ignoredFilesExcluded: true,
    }));
    await mockArchiveWorktreePresence([worktreePath], () => archiveWorktree.mock.calls.length === 0);
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      worktreeArchiveService: { archive: archiveWorktree } as unknown as WorktreeArchiveService,
    });
    try {
      await registry.listThreads({ backend: "codex", callerReason: "navigation-snapshot" });
      const response = await registry.archiveThread({ backend: "codex", threadId: target.id });
      if (shared) {
        expect(archiveWorktree).not.toHaveBeenCalled();
        expect(response.cleanup).toEqual([expect.objectContaining({
          worktreePath,
          removedWorktree: false,
          skippedReason: "Worktree is still used by another active thread: unvisited-sibling.",
        })]);
      } else {
        expect(archiveWorktree).toHaveBeenCalledWith({
          backend: "codex",
          threadId: target.id,
          worktreePath,
          repositoryPath: "/repo/app",
        });
        expect(response.cleanup).toEqual([expect.objectContaining({ removedWorktree: true })]);
      }
    } finally {
      await registry.close();
    }
  });

  it("retains parent worktree snapshots for archived same-worktree children", async () => {
    const worktreePath = "/Users/test/.codex/worktrees/shared/PwrAgnt";
    const parentThread: AppServerThreadSummary = {
      id: "thread-parent",
      title: "Parent thread",
      titleSource: "explicit",
      linkedDirectories: [
        {
          id: "directory:/repo/PwrAgnt",
          label: "PwrAgnt",
          path: "/repo/PwrAgnt",
          kind: "worktree",
          worktreePath,
        },
      ],
      source: "codex",
      gitBranch: "codex/shared",
      updatedAt: 1,
    };
    const childThread: AppServerThreadSummary = {
      id: "thread-child",
      title: "Child thread",
      titleSource: "explicit",
      linkedDirectories: [
        {
          id: `directory:${worktreePath}`,
          label: "PwrAgnt",
          path: worktreePath,
          kind: "local",
        },
      ],
      source: "codex",
      gitBranch: "codex/shared",
      updatedAt: 2,
    };
    const archivedThreads: AppServerThreadSummary[] = [];
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list", "thread/archive"] },
      archivedThreads,
      threads: [parentThread, childThread],
    });
    const snapshot: WorktreeSnapshotSummary = {
      id: "snapshot-1",
      backend: "codex",
      threadId: "thread-parent",
      worktreePath,
      repositoryPath: "/repo/PwrAgnt",
      snapshotRef: "refs/codex/snapshots/snapshot-1",
      snapshotCommit: "abc123",
      sourceBranch: "codex/shared",
      sourceHead: "def456",
      createdAt: 1000,
      archivedAt: 1000,
      state: "archived",
      ignoredFilesExcluded: true,
    };
    const archiveWorktree = vi.fn(async () => snapshot);
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-child": {
          backend: "codex",
          threadId: "thread-child",
          executionMode: "default",
          extraLinkedDirectories: [],
          parentThreadId: "thread-parent",
        },
      },
    });
    await mockArchiveWorktreePresence([worktreePath], () => archiveWorktree.mock.calls.length === 0);
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
      worktreeArchiveService: {
        archive: archiveWorktree,
      } as unknown as WorktreeArchiveService,
    });

    const childResponse = await registry.archiveThread({
      backend: "codex",
      threadId: "thread-child",
    });
    expect(childResponse.cleanup).toEqual([
      {
        worktreePath,
        branch: "codex/shared",
        removedWorktree: false,
        deletedBranch: false,
        skippedReason: "Worktree is still used by another active thread: thread-parent.",
        blockingThreads: [{ backend: "codex", threadId: "thread-parent", title: "Parent thread" }],
      },
    ]);
    expect(archiveWorktree).not.toHaveBeenCalled();
    await expect(
      overlayStore.getThreadOverlayState({
        backend: "codex",
        threadId: "thread-child",
      }),
    ).resolves.not.toMatchObject({
      worktreeSnapshots: expect.any(Array),
    });

    archivedThreads.push(childThread);
    codexClient.setThreads([parentThread]);
    const parentResponse = await registry.archiveThread({
      backend: "codex",
      threadId: "thread-parent",
    });

    expect(parentResponse.cleanup).toEqual([
      {
        worktreePath,
        branch: "codex/shared",
        removedWorktree: true,
        deletedBranch: false,
      },
    ]);
    expect(archiveWorktree).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-parent",
      worktreePath,
      repositoryPath: "/repo/PwrAgnt",
    });
    await expect(
      overlayStore.getThreadOverlayState({
        backend: "codex",
        threadId: "thread-child",
      }),
    ).resolves.toMatchObject({
      worktreeSnapshots: [
        expect.objectContaining({
          id: "snapshot-1",
          threadId: "thread-child",
          worktreePath,
          snapshotRef: "refs/codex/snapshots/snapshot-1",
        }),
      ],
    });

    await registry.close();
  });

  it("does not report a cleanup failure when an archived thread has no linked worktrees", async () => {
    mainLoggerMock.warn.mockClear();
    const thread: AppServerThreadSummary = {
      id: "thread-1",
      title: "Archive local thread",
      titleSource: "explicit",
      linkedDirectories: [],
      source: "codex",
      gitBranch: "main",
      updatedAt: 2,
    };
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list", "thread/archive"] },
      threads: [thread],
    });
    const archiveWorktree = vi.fn();
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      worktreeArchiveService: {
        archive: archiveWorktree,
      } as unknown as WorktreeArchiveService,
    });

    const response = await registry.archiveThread({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(archiveWorktree).not.toHaveBeenCalled();
    expect(response.cleanup).toEqual([]);
    expect(mainLoggerMock.warn).not.toHaveBeenCalledWith(
      "archive thread worktree cleanup skipped: no worktree candidates",
      expect.anything(),
    );

    await registry.close();
  });

  it.each([true, false])("treats a missing cleanup target or repository as a quiet skip (target missing: %s)", async (targetMissing) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-missing-archive-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const worktreePath = path.join(root, "worktree");
    const repositoryPath = path.join(root, "missing-repository");
    if (!targetMissing) {
      await mkdir(worktreePath);
    }
    const thread: AppServerThreadSummary = {
      id: "thread-missing-worktree",
      title: "Archive old thread",
      titleSource: "explicit",
      source: "codex",
      updatedAt: 2,
      linkedDirectories: [{
        id: "worktree-directory",
        kind: "worktree",
        label: "Old worktree",
        path: repositoryPath,
        worktreePath,
      }],
    };
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list", "thread/archive"] },
      threads: [thread],
    });
    const overlayStore = createOverlayStoreMock();
    const upsertSnapshot = vi.spyOn(overlayStore, "upsertWorktreeSnapshot");
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
      worktreeArchiveService: new WorktreeArchiveService(),
    });
    onTestFinished(() => registry.close());
    mainLoggerMock.warn.mockClear();
    mainLoggerMock.info.mockClear();

    const response = await registry.archiveThread({
      backend: "codex",
      threadId: thread.id,
    });

    expect(codexClient.lastArchiveThreadParams).toEqual({ threadId: thread.id });
    expect(upsertSnapshot).not.toHaveBeenCalled();
    if (targetMissing) {
      expect(response.cleanup).toEqual([{
        worktreePath,
        branch: undefined,
        removedWorktree: false,
        deletedBranch: false,
        worktreeState: "absent",
        skippedReason: "Worktree directory no longer exists.",
      }]);
      expect(mainLoggerMock.warn).not.toHaveBeenCalledWith(
        "archive thread worktree cleanup failed",
        expect.anything(),
      );
    } else {
      // The checkout exists but its repository does not: it is kept, as a
      // skip, because there is nothing to snapshot it into.
      expect(response.cleanup).toEqual([{
        worktreePath,
        branch: undefined,
        removedWorktree: false,
        deletedBranch: false,
        worktreeState: "present",
        repositoryPath,
        skippedReason: "The worktree folder still exists, but its repository is gone. The folder was kept without a snapshot.",
      }]);
      expect(mainLoggerMock.warn).not.toHaveBeenCalledWith(
        "archive thread worktree cleanup failed",
        expect.anything(),
      );
    }
    expect(mainLoggerMock.info.mock.calls.some(([event]) =>
      String(event).startsWith("archive thread worktree cleanup"),
    )).toBe(false);
  });

  it("restores archived thread worktrees from retained snapshots", async () => {
    const snapshot: WorktreeSnapshotSummary = {
      id: "snapshot-1",
      backend: "codex",
      threadId: "thread-1",
      worktreePath: "/repo/.worktrees/archive-me",
      repositoryPath: "/repo/app",
      snapshotRef: "refs/codex/snapshots/snapshot-1",
      snapshotCommit: "abc123",
      sourceBranch: "codex/archive-me",
      sourceHead: "def456",
      createdAt: 1000,
      archivedAt: 1000,
      state: "archived",
      ignoredFilesExcluded: true,
    };
    const restoredSnapshot: WorktreeSnapshotSummary = {
      ...snapshot,
      restoredAt: 2000,
      state: "restored",
    };
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/unarchive"] },
    });
    const restoreWorktree = vi.fn(async () => restoredSnapshot);
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock({
        overlays: {
          "codex:thread-1": {
            backend: "codex",
            threadId: "thread-1",
            executionMode: "default",
            extraLinkedDirectories: [],
            worktreeSnapshots: [snapshot],
          },
        },
      }),
      worktreeArchiveService: {
        restore: restoreWorktree,
      } as unknown as WorktreeArchiveService,
    });

    const response = await registry.restoreThread({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(restoreWorktree).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      worktreePath: "/repo/.worktrees/archive-me",
      repositoryPath: "/repo/app",
      snapshotRef: "refs/codex/snapshots/snapshot-1",
      snapshotCommit: "abc123",
      snapshot,
      allowDetachedFallback: true,
      // Back on its branch when free; detached at the saved HEAD otherwise.
      restoreSourceCheckout: true,
    });
    expect(response).toMatchObject({
      backend: "codex",
      threadId: "thread-1",
      worktrees: [
        {
          worktreePath: "/repo/.worktrees/archive-me",
          repositoryPath: "/repo/app",
          snapshotRef: "refs/codex/snapshots/snapshot-1",
          restored: true,
          snapshot: restoredSnapshot,
        },
      ],
    });

    await registry.close();
  });

  it("restores deleted archived thread worktrees from retained metadata when no snapshot exists", async () => {
    const archivedThread: AppServerThreadSummary = {
      id: "thread-1",
      title: "Archived worktree",
      titleSource: "explicit",
      linkedDirectories: [
        {
          id: "directory:/repo/PwrSnap",
          label: "PwrSnap",
          path: "/repo/PwrSnap",
          kind: "worktree",
          worktreePath: "/Users/test/.codex/worktrees/mp32wplq/PwrSnap",
        },
      ],
      source: "codex",
      gitBranch: "fix/float-over-hitbox",
      updatedAt: 2,
    };
    const restoredSnapshot: WorktreeSnapshotSummary = {
      id: "snapshot-1",
      backend: "codex",
      threadId: "thread-1",
      worktreePath: "/Users/test/.codex/worktrees/mp32wplq/PwrSnap",
      repositoryPath: "/repo/PwrSnap",
      snapshotRef: "fix/float-over-hitbox",
      snapshotCommit: "ecce5f83",
      sourceBranch: "fix/float-over-hitbox",
      createdAt: 2000,
      restoredAt: 2000,
      state: "restored",
      ignoredFilesExcluded: true,
      unavailableReason:
        "Restored detached worktree from repository state because no archived snapshot was available.",
    };
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/unarchive"] },
      archivedThreads: [archivedThread],
    });
    const restoreDetached = vi.fn(async () => restoredSnapshot);
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      worktreeArchiveService: {
        restoreDetached,
      } as unknown as WorktreeArchiveService,
    });

    const response = await registry.restoreThread({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(codexClient.listThreadsCalls[0]?.params).toMatchObject({
      archived: true,
    });
    expect(restoreDetached).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      worktreePath: "/Users/test/.codex/worktrees/mp32wplq/PwrSnap",
      repositoryPath: "/repo/PwrSnap",
      restoreRef: "fix/float-over-hitbox",
    });
    expect(response).toMatchObject({
      backend: "codex",
      threadId: "thread-1",
      worktrees: [
        {
          worktreePath: "/Users/test/.codex/worktrees/mp32wplq/PwrSnap",
          repositoryPath: "/repo/PwrSnap",
          snapshotRef: "fix/float-over-hitbox",
          restored: true,
        },
      ],
    });

    await registry.close();
  });

  it("reports failed cleanup when a worktree directory remains after archive", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-registry-sentinel-"));
    const repoPath = path.join(root, "PwrAgnt");
    const worktreePath = path.join(root, ".codex", "worktrees", "leaked", "PwrAgnt");

    try {
      await mkdir(worktreePath, { recursive: true });
      const thread: AppServerThreadSummary = {
        id: "thread-1",
        title: "Archive me",
        titleSource: "explicit",
        linkedDirectories: [
          {
            id: `directory:${repoPath}`,
            label: "PwrAgnt",
            path: repoPath,
            kind: "worktree",
            worktreePath,
          },
        ],
        source: "codex",
        gitBranch: "codex/archive-me",
        updatedAt: 2,
      };
      const codexClient = new MockBackendClient({
        initializeResult: { methods: ["thread/list", "thread/archive"] },
        threads: [thread],
      });
      const archiveWorktree = vi.fn(async () => ({
        id: "snapshot-1",
        backend: "codex" as const,
        threadId: "thread-1",
        worktreePath,
        repositoryPath: repoPath,
        snapshotRef: "refs/codex/snapshots/snapshot-1",
        snapshotCommit: "abc123",
        sourceBranch: "codex/archive-me",
        sourceHead: "def456",
        createdAt: 1000,
        archivedAt: 1000,
        state: "archived" as const,
        ignoredFilesExcluded: true,
      }));
      const registry = createDesktopBackendRegistry({
        codexClient,
        overlayStore: createOverlayStoreMock(),
        worktreeArchiveService: {
          archive: archiveWorktree,
        } as unknown as WorktreeArchiveService,
      });

      const response = await registry.archiveThread({
        backend: "codex",
        threadId: "thread-1",
      });

      expect(response.cleanup).toEqual([
        {
          worktreePath,
          branch: "codex/archive-me",
          removedWorktree: false,
          deletedBranch: false,
          error: "Worktree directory still exists after archive cleanup.",
        },
      ]);

      await registry.close();
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("revokes messaging bindings and clears pending intents when archiving a thread", async () => {
    const thread: AppServerThreadSummary = {
      id: "thread-1",
      title: "Archive me",
      titleSource: "explicit",
      linkedDirectories: [],
      source: "codex",
      updatedAt: 2,
    };
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list", "thread/archive"] },
      threads: [thread],
    });
    const overlayStore = createOverlayStoreMock();
    const messagingStore = createMessagingArchiveCleanupStoreMock({
      bindings: [
        { id: "binding-telegram", threadId: "thread-1", channel: "telegram" },
        { id: "binding-discord", threadId: "thread-1", channel: "discord" },
        { id: "binding-other", threadId: "thread-2", channel: "telegram" },
      ],
      pendingIntentIds: ["intent-approval", "intent-question"],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      messagingStore,
      overlayStore,
    });

    await registry.archiveThread({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(messagingStore.revokedBindingIds).toEqual([
      "binding-telegram",
      "binding-discord",
    ]);
    expect(messagingStore.deletedPendingThreads).toEqual([
      { backend: "codex", threadId: "thread-1" },
    ]);
    await expect(
      overlayStore.getThreadOverlayState({ backend: "codex", threadId: "thread-1" }),
    ).resolves.toMatchObject({
      messagingBindingTransitionLog: [
        expect.objectContaining({
          action: "unbound",
          bindingId: "binding-telegram",
          platform: "telegram",
        }),
        expect.objectContaining({
          action: "unbound",
          bindingId: "binding-discord",
          platform: "discord",
        }),
      ],
    });

    await registry.close();
  });

  it("continues archive cleanup and reports Token Miser persistence failures", async () => {
    const thread: AppServerThreadSummary = {
      id: "thread-1",
      title: "Archive me",
      titleSource: "explicit",
      linkedDirectories: [],
      source: "codex",
      updatedAt: 2,
    };
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list", "thread/archive"] },
      threads: [thread],
    });
    const messagingStore = createMessagingArchiveCleanupStoreMock({
      bindings: [{ id: "binding-telegram", threadId: "thread-1" }],
      pendingIntentIds: ["intent-approval"],
    });
    const messagingArchiveCleaner = createMessagingArchiveCleanerMock({
      notifiedCount: 1,
      revokedCount: 1,
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      messagingArchiveCleaner,
      messagingStore,
      overlayStore: createOverlayStoreMock(),
    });

    Object.assign(registry, { tokenMiserStore: {
      flushAll: vi.fn(async () => {}),
      archiveThread: vi.fn(async () => { throw new Error("fixture retention failure"); }),
    } });
    const internals = registryModules(registry).threadArchiveCoordinator as unknown as {
      ungroupChildrenOfArchivedThread(params: unknown): Promise<void>;
      archiveThreadWorktrees(params: unknown): Promise<unknown[]>;
    };
    const ungroup = vi.spyOn(internals, "ungroupChildrenOfArchivedThread");
    const worktrees = vi.spyOn(internals, "archiveThreadWorktrees");
    await registry.archiveThread({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(messagingStore.deletedPendingThreads).toEqual([
      { backend: "codex", threadId: "thread-1" },
    ]);
    expect(messagingArchiveCleaner.requests).toEqual([
      {
        backend: "codex",
        threadId: "thread-1",
        origin: "thread-archive",
      },
    ]);
    expect(messagingStore.revokedBindingIds).toEqual([]);

    expect(ungroup).toHaveBeenCalledOnce();
    expect(worktrees).toHaveBeenCalledOnce();
    expect(mainLoggerMock.warn).toHaveBeenCalledWith("Token Miser archive retention failed", expect.objectContaining({ threadId: "thread-1", error: "fixture retention failure" }));
    await registry.close();
  });

  it("coalesces repeated archive messaging cleanup before invoking the cleaner", async () => {
    const thread: AppServerThreadSummary = {
      id: "thread-1",
      title: "Archive me",
      titleSource: "explicit",
      linkedDirectories: [],
      source: "codex",
      updatedAt: 2,
    };
    const codexClient = new MockBackendClient({
      archivedThreads: [thread],
      initializeResult: { methods: ["thread/list", "thread/archive"] },
      threads: [thread],
    });
    const messagingStore = createMessagingArchiveCleanupStoreMock({
      bindings: [{ id: "binding-telegram", threadId: "thread-1" }],
      pendingIntentIds: ["intent-approval"],
    });
    const cleanerReleased = createDeferred<{
      notifiedCount: number;
      revokedCount: number;
    }>();
    const messagingArchiveCleaner = createMessagingArchiveCleanerMock(
      cleanerReleased.promise,
    );
    const registry = createDesktopBackendRegistry({
      codexClient,
      messagingArchiveCleaner,
      messagingStore,
      overlayStore: createOverlayStoreMock(),
    });

    const archivePromise = registry.archiveThread({
      backend: "codex",
      threadId: "thread-1",
    });
    while (messagingArchiveCleaner.requests.length === 0) {
      await flushAsync();
    }
    const notificationPromise = codexClient.emit({
      method: "thread/archived",
      params: { threadId: "thread-1" },
    });
    await flushAsync();

    expect(messagingArchiveCleaner.requests).toEqual([
      {
        backend: "codex",
        threadId: "thread-1",
        origin: "thread-archive",
      },
    ]);
    expect(messagingStore.deletedPendingThreads).toEqual([
      { backend: "codex", threadId: "thread-1" },
    ]);

    cleanerReleased.resolve({ notifiedCount: 1, revokedCount: 1 });
    await Promise.all([archivePromise, notificationPromise]);
    await registry.listThreads({ backend: "codex", archived: true });

    expect(messagingArchiveCleaner.requests).toHaveLength(1);
    expect(messagingStore.deletedPendingThreads).toHaveLength(1);

    await registry.close();
  });

  it("completes restoration after Token Miser retention fails", async () => {
    const thread: AppServerThreadSummary = {
      id: "thread-1",
      title: "Archive me again",
      titleSource: "explicit",
      linkedDirectories: [],
      source: "codex",
      updatedAt: 2,
    };
    const codexClient = new MockBackendClient({
      initializeResult: {
        methods: ["thread/list", "thread/archive", "thread/unarchive"],
      },
      threads: [thread],
    });
    const messagingStore = createMessagingArchiveCleanupStoreMock({
      bindings: [{ id: "binding-telegram", threadId: "thread-1" }],
      pendingIntentIds: ["intent-approval"],
    });
    const messagingArchiveCleaner = createMessagingArchiveCleanerMock({
      notifiedCount: 1,
      revokedCount: 1,
    });
    const overlayStore = createOverlayStoreMock();
    const tombstone = vi.spyOn(overlayStore, "setThreadArchiveTombstone");
    const registry = createDesktopBackendRegistry({
      codexClient,
      messagingArchiveCleaner,
      messagingStore,
      overlayStore,
    });

    const restoreWorktrees = vi.fn(async () => []);
    Object.assign(registryModules(registry).threadArchiveCoordinator, { restoreThreadWorktrees: restoreWorktrees });
    const restoreTokenMiser = vi.fn(async () => { throw new Error("fixture restore retention failure"); });
    Object.assign(registry, { tokenMiserStore: {
      flushAll: vi.fn(async () => {}),
      archiveThread: vi.fn(async () => {}),
      restoreThread: restoreTokenMiser,
    } });

    await registry.archiveThread({ backend: "codex", threadId: "thread-1" });
    await registry.restoreThread({ backend: "codex", threadId: "thread-1" });
    expect(tombstone).toHaveBeenLastCalledWith({ backend: "codex", threadId: "thread-1", archivedAt: undefined, restoredAt: expect.any(Number) });
    expect(restoreWorktrees).toHaveBeenCalledTimes(1);
    await registry.archiveThread({ backend: "codex", threadId: "thread-1" });

    expect(messagingArchiveCleaner.requests).toEqual([
      { backend: "codex", threadId: "thread-1", origin: "thread-archive" },
      { backend: "codex", threadId: "thread-1", origin: "thread-archive" },
    ]);

    expect(restoreTokenMiser).toHaveBeenCalledExactlyOnceWith("thread-1");
    await registry.close();
  });

  it("publishes archive notifications and cleans messaging after retention failure", async () => {
    const thread: AppServerThreadSummary = {
      id: "thread-1",
      title: "Archive me again",
      titleSource: "explicit",
      linkedDirectories: [],
      source: "codex",
      updatedAt: 2,
    };
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list", "thread/archive"] },
      threads: [thread],
    });
    const messagingStore = createMessagingArchiveCleanupStoreMock({
      bindings: [{ id: "binding-telegram", threadId: "thread-1" }],
      pendingIntentIds: ["intent-approval"],
    });
    const messagingArchiveCleaner = createMessagingArchiveCleanerMock({
      notifiedCount: 1,
      revokedCount: 1,
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      messagingArchiveCleaner,
      messagingStore,
      overlayStore: createOverlayStoreMock(),
    });

    const restoreTokenMiser = vi.fn(async () => { throw new Error("fixture restore retention failure"); });
    Object.assign(registry, { tokenMiserStore: {
      flushAll: vi.fn(async () => {}),
      archiveThread: vi.fn(async () => { throw new Error("fixture notification retention failure"); }),
      restoreThread: restoreTokenMiser,
    } });

    const events: AgentEvent[] = [];
    const unsubscribe = registry.onEvent((event) => { events.push(event); });
    await codexClient.emit({ method: "thread/archived", params: { threadId: "thread-1" } });
    expect(events.some((event) => event.notification.method === "thread/archived")).toBe(true);
    await codexClient.emit({
      method: "thread/unarchived",
      params: { threadId: "thread-1" },
    });
    expect(events.some((event) => event.notification.method === "thread/unarchived")).toBe(true);
    unsubscribe();
    await registry.archiveThread({ backend: "codex", threadId: "thread-1" });

    expect(messagingArchiveCleaner.requests).toHaveLength(2);

    expect(restoreTokenMiser).toHaveBeenCalledExactlyOnceWith("thread-1");
    await registry.close();
  });

  it("skips archive cleanup probes while Codex authentication is blocked", async () => {
    const codexClient = Object.assign(new MockBackendClient({
      listThreadsError: new Error("Codex is logged out. Please sign in again."),
    }), {
      isAuthenticationRequired: () => true,
    });
    const listing = vi.spyOn(codexClient, "listThreads");
    const messagingStore = createMessagingArchiveCleanupStoreMock({
      bindings: [{ id: "binding-telegram", threadId: "thread-1" }],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      messagingStore,
      overlayStore: createOverlayStoreMock(),
    });
    await expect(registry.listThreads({ backend: "codex" })).resolves.toEqual([]);
    expect(listing.mock.calls.some(([params]) => params?.archived === true)).toBe(false);
    expect(messagingStore.revokedBindingIds).toEqual([]);
    await registry.close();
  });

  it("cleans messaging state when archived threads are discovered by refresh", async () => {
    const archivedThread: AppServerThreadSummary = {
      id: "thread-1",
      title: "Archived elsewhere",
      titleSource: "explicit",
      linkedDirectories: [],
      source: "codex",
      updatedAt: 2,
    };
    const codexClient = new MockBackendClient({
      archivedThreads: [archivedThread],
      initializeResult: { methods: ["thread/list", "thread/archive"] },
      threads: [],
    });
    const messagingStore = createMessagingArchiveCleanupStoreMock({
      bindings: [{ id: "binding-telegram", threadId: "thread-1" }],
      pendingIntentIds: ["intent-approval"],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      messagingStore,
      overlayStore: createOverlayStoreMock(),
    });

    await expect(
      registry.listThreads({ backend: "codex", archived: true }),
    ).resolves.toMatchObject([archivedThread]);
    await waitForCondition(() => messagingStore.revokedBindingIds.length === 1);

    expect(messagingStore.revokedBindingIds).toEqual(["binding-telegram"]);
    expect(messagingStore.deletedPendingThreads).toEqual([
      { backend: "codex", threadId: "thread-1" },
    ]);

    await registry.close();
  });

  it("hides archived records for threads that are active again", async () => {
    const restoredThread: AppServerThreadSummary = {
      id: "thread-restored",
      title: "Restored elsewhere",
      titleSource: "explicit",
      linkedDirectories: [],
      source: "codex",
      updatedAt: 2,
    };
    const stillArchivedThread: AppServerThreadSummary = {
      id: "thread-archived",
      title: "Still archived",
      titleSource: "explicit",
      linkedDirectories: [],
      source: "codex",
      updatedAt: 1,
    };
    const codexClient = new MockBackendClient({
      archivedThreads: [restoredThread, stillArchivedThread],
      initializeResult: { methods: ["thread/list", "thread/archive"] },
      threads: [restoredThread],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
    });

    await expect(
      registry.listThreads({ backend: "codex", archived: true }),
    ).resolves.toEqual([expect.objectContaining({ id: "thread-archived" })]);

    expect(codexClient.listThreadsCalls.map((call) => call.params)).toEqual([
      { archived: true, enrichDirectories: false },
      { archived: false, enrichDirectories: false },
    ]);

    await registry.close();
  });

  it("does not restart background archive cleanup after registry close", async () => {
    let finish!: (threads: AppServerThreadSummary[]) => void;
    const gate = new Promise<AppServerThreadSummary[]>((resolve) => { finish = resolve; });
    let archivedReads = 0;
    const codexClient = Object.assign(new MockBackendClient({}), {
      listThreads: async (params?: { archived?: boolean }) => {
        if (!params?.archived) return [];
        archivedReads += 1;
        return await gate;
      },
    });
    const messagingStore = createMessagingArchiveCleanupStoreMock({
      bindings: [{ id: "closing-binding", threadId: "archived" }],
    });
    const registry = createDesktopBackendRegistry({ codexClient, messagingStore, overlayStore: createOverlayStoreMock() });
    await registry.listThreads({ backend: "codex" });
    await waitForCondition(() => archivedReads === 1);
    await registry.close();
    finish([{ id: "archived", title: "Archived", titleSource: "explicit", source: "codex", linkedDirectories: [] }]);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(archivedReads).toBe(1);
    expect(messagingStore.revokedBindingIds).toEqual([]);
  });

  it("does not revoke a restored binding from in-flight archive cleanup evidence", async () => {
    let finish!: (threads: AppServerThreadSummary[]) => void;
    const gate = new Promise<AppServerThreadSummary[]>((resolve) => { finish = resolve; });
    let archivedReads = 0;
    const codexClient = Object.assign(new MockBackendClient({}), {
      listThreads: async (params?: { archived?: boolean }) => {
        if (!params?.archived) return [];
        archivedReads += 1;
        return archivedReads === 1 ? gate : [];
      },
    });
    const messagingStore = createMessagingArchiveCleanupStoreMock({
      bindings: [{ id: "restored-binding", threadId: "restored" }],
    });
    const registry = createDesktopBackendRegistry({ codexClient, messagingStore, overlayStore: createOverlayStoreMock() });
    onTestFinished(async () => { await registry.close(); });
    await registry.listThreads({ backend: "codex" });
    await waitForCondition(() => archivedReads === 1);
    await codexClient.emit({ method: "thread/unarchived", params: { threadId: "restored" } });
    finish([{ id: "restored", title: "Restored", titleSource: "explicit", source: "codex", linkedDirectories: [] }]);
    await waitForCondition(() => archivedReads === 2);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(messagingStore.revokedBindingIds).toEqual([]);
    expect(messagingStore.deletedPendingThreads).toEqual([]);
    expect(archivedReads).toBe(2);
  });

  it("does not authorize cleanup from an archived registry listing started before restore", async () => {
    const budget = navigationListingBudgets["archive-cleanup-provider-mutation-fence"];
    const provider = new CodexAppServerClient({ directoryResolver: async () => [] });
    await provider.getInitializeResult();
    const transport = ArchiveCleanupTransport.latest;
    transport.activeIds = [];
    transport.archivedIds = ["restored"];
    transport.holdNextListing(true);
    transport.holdNextListing(false);
    const codexClient = Object.assign(new MockBackendClient({}), {
      listThreads: (...[params, diagnostics]: Parameters<CodexAppServerClient["listThreads"]>) =>
        provider.listThreads(params?.archived ? params : { ...params, skipArchivedMetadataRefresh: true }, diagnostics),
      invalidateThreadListings: (notification?: AppServerNotification) => provider.invalidateThreadListings(notification),
    });
    const messagingStore = createMessagingArchiveCleanupStoreMock({
      bindings: [{ id: "restored-binding", threadId: "restored" }],
      pendingIntentIds: ["restored-intent"],
    });
    const registry = createDesktopBackendRegistry({ codexClient, messagingStore, overlayStore: createOverlayStoreMock() });
    onTestFinished(async () => { transport.releaseListings(); await registry.close(); await provider.close(); });
    const listing = registry.listThreads({ backend: "codex", archived: true, enrichDirectories: false });
    await transport.whenListing(true);
    transport.releaseListings(true);
    // Archived-list filtering also captured a pre-restore active snapshot.
    await transport.whenListing(false);
    transport.archivedIds = [];
    transport.activeIds = ["restored"];
    await codexClient.emit({ method: "thread/unarchived", params: { threadId: "restored" } });
    transport.releaseListings(false);
    await listing;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(messagingStore.revokedBindingIds).toEqual([]);
    expect(messagingStore.deletedPendingThreads).toEqual([]);
    expect(transport.listings.filter((rpc) => rpc.archived)).toHaveLength(budget.archivedRpcsFromPreMutationRegistryListing);
  });

  it("does not split a provider generation when a restore notification is forwarded", async () => {
    const budget = navigationListingBudgets["archive-cleanup-provider-mutation-fence"];
    const provider = new CodexAppServerClient({ directoryResolver: async () => [] });
    await provider.getInitializeResult();
    const transport = ArchiveCleanupTransport.latest;
    transport.archivedIds = [];
    transport.holdNextListing(true);
    onTestFinished(async () => { transport.releaseListings(); await provider.close(); });
    let first!: Promise<AppServerThreadSummary[]>;
    let second!: Promise<AppServerThreadSummary[]>;
    let delivered!: () => void;
    const forwarded = new Promise<void>((resolve) => { delivered = resolve; });
    provider.onNotification(async (notification) => {
      // The wire handler already applied this fence. An earlier subscriber
      // can start a fresh read before the registry forwards the same event.
      first = provider.listThreads({ archived: true, enrichDirectories: false });
      await waitForCondition(() => transport.listings.length === 1);
      provider.invalidateThreadListings(notification);
      second = provider.listThreads({ archived: true, enrichDirectories: false });
      delivered();
    });
    transport.emitNotification({ method: "thread/unarchived", params: { threadId: "restored" } });
    await forwarded;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(transport.listings).toHaveLength(budget.pageRpcsForForwardedNotification);
    transport.releaseListings();
    const results = await Promise.all([first, second]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]).not.toBe(results[1]); // coalesced work, independently mutable results
  });

  it("does not borrow pre-restore archive evidence from an unrelated provider reader", async () => {
    const budget = navigationListingBudgets["archive-cleanup-provider-mutation-fence"];
    const provider = new CodexAppServerClient({ directoryResolver: async () => [] });
    await provider.getInitializeResult();
    const transport = ArchiveCleanupTransport.latest;
    transport.activeIds = [];
    transport.archivedIds = ["restored"];
    transport.holdNextListing(true);
    // An external lookup, not the cleanup pool, owns this stale physical read.
    const external = provider.listThreads({ archived: true, enrichDirectories: false }, { callerReason: "thread-id-lookup" });
    await waitForCondition(() => transport.listings.length === 1);
    const codexClient = Object.assign(new MockBackendClient({}), {
      listThreads: (...[params, diagnostics]: Parameters<CodexAppServerClient["listThreads"]>) =>
        provider.listThreads(params?.archived ? params : { ...params, skipArchivedMetadataRefresh: true }, diagnostics),
      invalidateThreadListings: (notification?: AppServerNotification) => provider.invalidateThreadListings(notification),
    });
    const messagingStore = createMessagingArchiveCleanupStoreMock({
      bindings: [{ id: "restored-binding", threadId: "restored" }],
      pendingIntentIds: ["restored-intent"],
    });
    let releaseBindings!: () => void;
    const bindingGate = new Promise<void>((resolve) => { releaseBindings = resolve; });
    const findBindings = messagingStore.findActiveBindingsForBackend.bind(messagingStore);
    const bindingReads = vi.spyOn(messagingStore, "findActiveBindingsForBackend")
      .mockImplementation(async (params) => { await bindingGate; return await findBindings(params); });
    const registry = createDesktopBackendRegistry({ codexClient, messagingStore, overlayStore: createOverlayStoreMock() });
    onTestFinished(async () => { transport.releaseListings(); await registry.close(); await provider.close(); });
    await registry.listThreads({ backend: "codex", enrichDirectories: false });
    await waitForCondition(() => bindingReads.mock.calls.length === 1);
    // Registry-local notification: the provider transport cannot independently
    // invalidate the unrelated listing. Cleanup has not entered its pool yet.
    transport.archivedIds = [];
    await codexClient.emit({ method: "thread/unarchived", params: { threadId: "restored" } });
    transport.holdNextListing(true);
    const fresh = provider.listThreads({ archived: true, enrichDirectories: false }, { callerReason: "thread-list" });
    await waitForCondition(() => transport.listings.filter((rpc) => rpc.archived).length === budget.archivedProviderListings);
    // Cleanup can still share this post-restore read with its existing owner.
    releaseBindings();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    transport.releaseListings();
    await expect(external).resolves.toMatchObject([{ id: "restored" }]);
    await expect(fresh).resolves.toEqual([]);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(messagingStore.revokedBindingIds).toHaveLength(budget.revokedBindings);
    expect(messagingStore.deletedPendingThreads).toHaveLength(budget.deletedPendingIntentThreads);
    expect(transport.listings.filter((rpc) => rpc.archived)).toHaveLength(budget.archivedPageRpcs);
    expect(transport.listings.filter((rpc) => rpc.archived && !rpc.cursor)).toHaveLength(budget.archivedProviderListings);
  });

  it("shares the archived wire walk across metadata and messaging cleanup after concurrent navigation reads", async () => {
    const provider = new CodexAppServerClient({ directoryResolver: async () => [] });
    await provider.getInitializeResult();
    const transport = ArchiveCleanupTransport.latest;
    transport.activeIds = ["active", "created"];
    transport.archivedIds = Array.from({ length: 43 }, (_, index) => `archived-${index}`);
    transport.holdNextListing(false);
    transport.holdNextListing(true);
    const listThreads = vi.fn((...args: Parameters<CodexAppServerClient["listThreads"]>) => provider.listThreads(...args));
    const codexClient = Object.assign(new MockBackendClient({}), { listThreads });
    const messagingStore = createMessagingArchiveCleanupStoreMock({ bindings: [{ id: "gone", threadId: "archived-42" }] });
    const worktreeArchive = vi.fn();
    const registry = createDesktopBackendRegistry({ codexClient, messagingStore, overlayStore: createOverlayStoreMock(),
      worktreeArchiveService: { archive: worktreeArchive } as never });
    onTestFinished(async () => { transport.releaseListings(); await registry.close(); await provider.close(); });
    const readers = ["owner-navigation-metadata", "renderer-navigation-query", "federation-navigation-query"].map((callerReason) =>
      registry.listThreads({ backend: "codex", enrichDirectories: true, callerReason }));
    await transport.whenListing(false);
    transport.releaseListings(false);
    for (const rows of await Promise.all(readers)) expect(rows.map((row) => row.id).sort()).toEqual(["active", "created"]);
    await transport.whenListing(true);
    await waitForCondition(() => listThreads.mock.calls.some(([, diagnostics]) => diagnostics?.callerReason === "archive-cleanup"));
    // Let both consumers reach the shared paginator while its first page is
    // held. Only its final archived member has a binding to revoke.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    transport.releaseListings(true);
    await waitForCondition(() => messagingStore.revokedBindingIds.includes("gone"));
    const archived = transport.listings.filter((row) => row.archived);
    expect(archived.filter((row) => !row.cursor)).toHaveLength(1);
    expect(archived).toHaveLength(43);
    expect(transport.listings.filter((row) => !row.archived)).toHaveLength(1);
    expect(worktreeArchive).not.toHaveBeenCalled();
  });

  it.each([false, true])("shares archived pages after observing an active addition (provider notice: %s)", async (notice) => {
    const provider = new CodexAppServerClient({ directoryResolver: async () => [] });
    await provider.getInitializeResult();
    const transport = ArchiveCleanupTransport.latest;
    transport.activeIds = ["active"];
    transport.archivedIds = Array.from({ length: 43 }, (_, index) => `archived-${index}`);
    const held = createDeferred<void>();
    const returned = createDeferred<void>();
    let holdActive = false;
    const listThreads = vi.fn(async (...args: Parameters<CodexAppServerClient["listThreads"]>) => {
      const rows = await provider.listThreads(...args);
      if (holdActive && !args[0]?.archived) {
        returned.resolve();
        await held.promise;
      }
      return rows;
    });
    const codexClient = Object.assign(new MockBackendClient({}), {
      listThreads, invalidateThreadListings: (notification?: AppServerNotification) => provider.invalidateThreadListings(notification),
    });
    const messagingStore = createMessagingArchiveCleanupStoreMock({ bindings: [{ id: "gone", threadId: "archived-42" }] });
    const findBindings = messagingStore.findActiveBindingsForBackend.bind(messagingStore);
    let bindingsVisible = false;
    vi.spyOn(messagingStore, "findActiveBindingsForBackend")
      .mockImplementation(async (params) => bindingsVisible ? await findBindings(params) : []);
    const registry = createDesktopBackendRegistry({ codexClient, messagingStore, overlayStore: createOverlayStoreMock() });
    onTestFinished(async () => { held.resolve(); transport.releaseListings(); await registry.close(); await provider.close(); });
    const request = { backend: "codex", callerReason: "renderer-navigation-query", enrichDirectories: true } as const;
    await registry.listThreads({ ...request, skipArchivedMetadataRefresh: true });
    transport.holdNextListing(true);
    await registry.listThreads(request);
    await transport.whenListing(true);
    transport.activeIds.push("created");
    if (notice) transport.emitNotification({ method: "thread/started", params: {
      thread: { id: "created", source: "codex", title: "Created", titleSource: "explicit", linkedDirectories: [] },
    } });
    await codexClient.emit({ method: "turn/started", params: {
      threadId: "active", turn: { id: "turn", status: "inProgress", output: [] },
    } });
    holdActive = true;
    const refreshed = registry.listThreads(request);
    await returned.promise;
    // The second active listing has scheduled metadata observation but has
    // yet to report its new active row to the registry's cleanup coordinator.
    await flushAsync();
    bindingsVisible = true;
    held.resolve();
    await expect(refreshed).resolves.toMatchObject([{ id: "active" }, { id: "created" }]);
    await waitForCondition(() => listThreads.mock.calls.some(([, diagnostics]) => diagnostics?.callerReason === "archive-cleanup"));
    await flushAsync();
    transport.releaseListings();
    await waitForCondition(() => messagingStore.revokedBindingIds.includes("gone"));
    await flushAsync();
    const archived = transport.listings.filter((listing) => listing.archived);
    expect({ walks: archived.filter(({ cursor }) => cursor === undefined).length, pages: archived.length })
      .toEqual({ walks: 1, pages: 43 });
  });

  it("requires an exhausted cursor before shared archived pages authorize messaging cleanup", async () => {
    const provider = new CodexAppServerClient({ directoryResolver: async () => [] });
    await provider.getInitializeResult();
    const transport = ArchiveCleanupTransport.latest;
    transport.repeatArchivedCursor = true;
    const codexClient = Object.assign(new MockBackendClient({}), {
      listThreads: (...args: Parameters<CodexAppServerClient["listThreads"]>) => provider.listThreads(...args),
    });
    const messagingStore = createMessagingArchiveCleanupStoreMock({ bindings: [{ id: "gone", threadId: "archive-one" }] });
    const registry = createDesktopBackendRegistry({ codexClient, messagingStore, overlayStore: createOverlayStoreMock() });
    onTestFinished(async () => { await registry.close(); await provider.close(); });
    const request = { backend: "codex", callerReason: "renderer-navigation-query" } as const;
    await registry.listThreads(request);
    await waitForCondition(() => transport.listings.filter(({ archived }) => archived).length >= 2);
    await flushAsync();
    expect(messagingStore.revokedBindingIds).toEqual([]);
    transport.repeatArchivedCursor = false;
    await codexClient.emit({ method: "thread/status/changed", params: { threadId: "active", status: { type: "idle" } } });
    await registry.listThreads(request);
    await waitForCondition(() => messagingStore.revokedBindingIds.includes("gone"));
    expect(messagingStore.revokedBindingIds).toEqual(["gone"]);
  });

  it("bounds archive cleanup scans across related navigation refreshes", async () => {
    const budget = navigationListingBudgets["archive-cleanup-related-refreshes"];
    const provider = new CodexAppServerClient({ directoryResolver: async () => [] });
    const codexClient = Object.assign(new MockBackendClient({}), {
      // The client metadata scheduler has its own budget (#2422). Isolate
      // registry cleanup while retaining production listing/pagination.
      listThreads: (...[params, diagnostics]: Parameters<CodexAppServerClient["listThreads"]>) =>
        provider.listThreads({ ...params, skipArchivedMetadataRefresh: true }, diagnostics),
      invalidateThreadListings: (notification?: AppServerNotification) => provider.invalidateThreadListings(notification),
    });
    const messagingStore = createMessagingArchiveCleanupStoreMock({
      // This binding is neither active nor archived. A negative membership
      // answer must be shared too, rather than rescanning on every turn event.
      bindings: [{ id: "unresolved-binding", threadId: "missing" }],
    });
    const reads = vi.spyOn(messagingStore, "findActiveBindingsForBackend");
    const registry = createDesktopBackendRegistry({
      codexClient,
      messagingStore,
      overlayStore: createOverlayStoreMock(),
    });
    onTestFinished(async () => { await registry.close(); await provider.close(); });
    const refresh = async (method?: "thread/status/changed" | "turn/started") => {
      if (method === "thread/status/changed") {
        await codexClient.emit({ method, params: { threadId: "active", status: { type: "idle" } } });
      } else if (method === "turn/started") {
        await codexClient.emit({ method, params: { threadId: "active", turn: { id: "turn", status: "inProgress", output: [] } } });
      }
      const before = reads.mock.calls.length;
      await registry.listThreads({
        backend: "codex",
        callerReason: method === "turn/started" ? "federation-navigation-query" : "renderer-navigation-query",
        enrichDirectories: false,
      });
      await waitForCondition(() => reads.mock.calls.length > before);
      // Drain the background cleanup, including its possible second walk.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    };
    await refresh();
    await refresh("thread/status/changed");
    await refresh("turn/started");
    const transport = ArchiveCleanupTransport.latest;
    const archivedRpcs = () => transport.listings.filter((rpc) => rpc.archived);
    expect(transport.listings.filter((rpc) => !rpc.archived)).toHaveLength(budget.activeProviderListings);
    expect(archivedRpcs()).toHaveLength(budget.archivedPageRpcs);
    expect(archivedRpcs().filter((rpc) => !rpc.cursor)).toHaveLength(budget.archivedProviderListings);
    expect(archivedRpcs().map((rpc) => rpc.cursor)).toEqual([undefined, "1", "2"]);
    expect(reads).toHaveBeenCalledTimes(budget.logicalRequests);
    await registry.listThreads({ backend: "codex", callerReason: "renderer-navigation-query", enrichDirectories: false });
    expect(archivedRpcs()).toHaveLength(budget.archivedPageRpcsAfterUnchangedRefresh);
    expect(transport.listings.filter((rpc) => !rpc.archived)).toHaveLength(budget.activeProviderListings);
    await registry.listThreads({ backend: "codex", forceRefresh: true, enrichDirectories: false });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(archivedRpcs()).toHaveLength(budget.archivedPageRpcsAfterExplicitRefresh);
    // A real disappearance invalidates negative evidence and combines binding
    // and transition candidates into one new paginated authority read.
    transport.activeIds = ["active"];
    transport.archivedIds = ["missing", "transition", "archive-three"];
    await refresh("thread/status/changed");
    await waitForCondition(() => messagingStore.revokedBindingIds.length === 1);
    expect(archivedRpcs()).toHaveLength(budget.archivedPageRpcsAfterMembershipChange);
    expect(transport.listings.filter((rpc) => !rpc.archived)).toHaveLength(budget.activeProviderListingsAfterMembershipChange);
    expect(messagingStore.revokedBindingIds).toEqual(["unresolved-binding"]);
  });

  it("cleans messaging state for bound threads missing from the active refresh", async () => {
    const archivedThread: AppServerThreadSummary = {
      id: "thread-1",
      title: "Archived elsewhere",
      titleSource: "explicit",
      linkedDirectories: [],
      source: "codex",
      updatedAt: 2,
    };
    const codexClient = new MockBackendClient({
      archivedThreads: [archivedThread],
      initializeResult: { methods: ["thread/list", "thread/archive"] },
      threads: [],
    });
    const messagingStore = createMessagingArchiveCleanupStoreMock({
      bindings: [{ id: "binding-telegram", threadId: "thread-1" }],
      pendingIntentIds: ["intent-approval"],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      messagingStore,
      overlayStore: createOverlayStoreMock(),
    });

    await expect(registry.listThreads({ backend: "codex" })).resolves.toEqual([]);
    await waitForCondition(() => messagingStore.revokedBindingIds.length === 1);

    expect(codexClient.lastListThreadsDiagnostics).toEqual({
      callerReason: "archive-cleanup",
      ownerId: expect.any(String),
    });
    expect(messagingStore.revokedBindingIds).toEqual(["binding-telegram"]);
    expect(messagingStore.deletedPendingThreads).toEqual([
      { backend: "codex", threadId: "thread-1" },
    ]);

    await registry.close();
  });

  it("does not block thread refresh when archive cleanup asks for navigation", async () => {
    const archivedThread: AppServerThreadSummary = {
      id: "thread-1",
      title: "Archived elsewhere",
      titleSource: "explicit",
      linkedDirectories: [],
      source: "codex",
      updatedAt: 2,
    };
    const codexClient = new MockBackendClient({
      archivedThreads: [archivedThread],
      initializeResult: { methods: ["thread/list", "thread/archive"] },
      threads: [],
    });
    const messagingStore = createMessagingArchiveCleanupStoreMock({
      bindings: [{ id: "binding-telegram", threadId: "thread-1" }],
    });
    const registryRef: { current?: DesktopBackendRegistry } = {};
    const nestedNavigation = createDeferred<AppServerThreadSummary[]>();
    const releaseRevocation = createDeferred<void>();
    const revocationCompleted = createDeferred<void>();
    const messagingArchiveCleaner = {
      requests: [] as Array<{
        backend: AppServerBackendKind;
        threadId: string;
        origin: "thread-archive";
      }>,
      async requestBindingRevokeAllForThread(request: {
        backend: AppServerBackendKind;
        threadId: string;
        origin: "thread-archive";
      }) {
        messagingArchiveCleaner.requests.push(request);
        nestedNavigation.resolve(await registryRef.current!.listThreads());
        await releaseRevocation.promise;
        revocationCompleted.resolve();
        return { notifiedCount: 1, revokedCount: 1 };
      },
    };
    const registry = createDesktopBackendRegistry({
      codexClient,
      messagingArchiveCleaner,
      messagingStore,
      overlayStore: createOverlayStoreMock(),
    });
    registryRef.current = registry;

    try {
      const refresh = registry.listThreads();
      // The recursive navigation and outer refresh must both resolve while
      // revocation is held open. Awaiting cleanup from the listing would form
      // a wait cycle here; the normal test watchdog still detects that bug.
      await expect(nestedNavigation.promise).resolves.toEqual([]);
      await expect(refresh).resolves.toEqual([]);

      expect(messagingArchiveCleaner.requests).toEqual([
        {
          backend: "codex",
          threadId: "thread-1",
          origin: "thread-archive",
        },
      ]);
    } finally {
      releaseRevocation.resolve();
      await revocationCompleted.promise;
      await registry.close();
    }
  });

  it("cleans messaging state when an active thread refresh transitions to archived", async () => {
    const thread: AppServerThreadSummary = {
      id: "thread-1",
      title: "Archived elsewhere",
      titleSource: "explicit",
      linkedDirectories: [],
      source: "codex",
      updatedAt: 2,
    };
    const codexClient = new MockBackendClient({
      archivedThreads: [thread],
      initializeResult: { methods: ["thread/list", "thread/archive"] },
      threads: [thread],
    });
    const messagingStore = createMessagingArchiveCleanupStoreMock({
      bindings: [{ id: "binding-telegram", threadId: "thread-1" }],
      pendingIntentIds: ["intent-approval"],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      messagingStore,
      overlayStore: createOverlayStoreMock(),
    });

    await expect(registry.listThreads({ backend: "codex" })).resolves.toMatchObject([
      thread,
    ]);
    codexClient.setThreads([]);
    await codexClient.emit({
      method: "turn/completed",
      params: {
        threadId: "another-thread",
        turnId: "turn-1",
        turn: {
          id: "turn-1",
          status: "completed",
          output: [],
        },
      },
    });
    await expect(registry.listThreads({ backend: "codex" })).resolves.toEqual([]);
    await waitForCondition(() => messagingStore.revokedBindingIds.length === 1);

    expect(messagingStore.revokedBindingIds).toEqual(["binding-telegram"]);
    expect(messagingStore.deletedPendingThreads).toEqual([
      { backend: "codex", threadId: "thread-1" },
    ]);

    await registry.close();
  });

  it("archives and reports skipped cleanup when worktree cleanup metadata cannot be loaded", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list", "thread/archive"] },
      listThreadsError: new Error("thread list unavailable"),
    });
    const archiveWorktree = vi.fn();
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      worktreeArchiveService: {
        archive: archiveWorktree,
      } as unknown as WorktreeArchiveService,
    });

    const response = await registry.archiveThread({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(codexClient.lastArchiveThreadParams).toEqual({ threadId: "thread-1" });
    expect(archiveWorktree).not.toHaveBeenCalled();
    expect(response).toEqual({
      backend: "codex",
      threadId: "thread-1",
      archivedAt: expect.any(Number),
      cleanup: [
        {
          removedWorktree: false,
          deletedBranch: false,
          skippedReason:
            "Unable to load thread metadata for archive cleanup: thread list unavailable",
        },
      ],
    });

    await registry.close();
  });

  it("tombstones a Codex thread when its rollout is already missing", async () => {
    const thread: AppServerThreadSummary = {
      id: "thread-missing-rollout",
      title: "Stale thread",
      titleSource: "explicit",
      linkedDirectories: [],
      source: "codex",
      updatedAt: 2,
    };
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list", "thread/archive"] },
      threads: [thread],
      archiveThreadError: new Error(
        "json-rpc error (-32600): no rollout found for thread id thread-missing-rollout",
      ),
    });
    const overlayStore = createOverlayStoreMock();
    const setThreadArchiveTombstone = vi.spyOn(
      overlayStore,
      "setThreadArchiveTombstone",
    );
    const requestBindingRevokeAllForThread = vi.fn(async () => ({
      notifiedCount: 0,
      revokedCount: 0,
    }));
    const registry = createDesktopBackendRegistry({
      codexClient,
      messagingArchiveCleaner: {
        requestBindingRevokeAllForThread,
      },
      overlayStore,
    });

    const response = await registry.archiveThread({
      backend: "codex",
      threadId: "thread-missing-rollout",
    });

    expect(response).toEqual({
      backend: "codex",
      threadId: "thread-missing-rollout",
      archivedAt: expect.any(Number),
      cleanup: [],
      threadTitle: "Stale thread",
    });
    await expect(
      overlayStore.getThreadOverlayState({
        backend: "codex",
        threadId: "thread-missing-rollout",
      }),
    ).resolves.toMatchObject({
      archiveTombstonedAt: response.archivedAt,
    });
    expect(requestBindingRevokeAllForThread).toHaveBeenCalledTimes(1);
    expect(
      requestBindingRevokeAllForThread.mock.invocationCallOrder[0]!,
    ).toBeLessThan(setThreadArchiveTombstone.mock.invocationCallOrder[0]!);
    await expect(
      registry.listThreads({
        backend: "codex",
        forceRefresh: true,
      }),
    ).resolves.toEqual([]);

    await registry.restoreThread({
      backend: "codex",
      threadId: "thread-missing-rollout",
    });
    await expect(
      registry.listThreads({
        backend: "codex",
        forceRefresh: true,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "thread-missing-rollout",
      }),
    ]);

    await registry.close();
  });

  it("finishes best-effort cleanup before leaving a missing-rollout thread retryable", async () => {
    const parentThread: AppServerThreadSummary = {
      id: "thread-missing-rollout",
      title: "Stale thread",
      titleSource: "explicit",
      linkedDirectories: [
        {
          id: "directory:/repo/app",
          label: "app",
          path: "/repo/app",
          kind: "worktree",
          worktreePath: "/repo/.worktrees/stale-thread",
        },
      ],
      source: "codex",
      updatedAt: 2,
    };
    const childThread: AppServerThreadSummary = {
      id: "thread-child",
      projectKey: "/repo/child",
      title: "Child thread",
      titleSource: "explicit",
      linkedDirectories: [],
      source: "codex",
      updatedAt: 1,
    };
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list", "thread/archive"] },
      threads: [parentThread, childThread],
      archiveThreadError: new Error(
        "json-rpc error (-32600): no rollout found for thread id thread-missing-rollout",
      ),
    });
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-child": {
          backend: "codex",
          threadId: "thread-child",
          executionMode: "default",
          extraLinkedDirectories: [],
          parentThreadId: "thread-missing-rollout",
        },
      },
    });
    const setThreadParent = vi
      .spyOn(overlayStore, "setThreadParent")
      .mockRejectedValue(new Error("ungroup unavailable"));
    const requestBindingRevokeAllForThread = vi.fn(async () => {
      throw new Error("messaging unavailable");
    });
    const archiveWorktree = vi.fn(async () => {
      throw new Error("worktree unavailable");
    });
    await mockArchiveWorktreePresence(["/repo/.worktrees/stale-thread"]);
    const registry = createDesktopBackendRegistry({
      codexClient,
      messagingArchiveCleaner: {
        requestBindingRevokeAllForThread,
      },
      overlayStore,
      worktreeArchiveService: {
        archive: archiveWorktree,
      } as unknown as WorktreeArchiveService,
    });

    await expect(
      registry.archiveThread({
        backend: "codex",
        threadId: "thread-missing-rollout",
      }),
    ).rejects.toThrow(
      /messaging cleanup failed: messaging unavailable; child ungrouping failed: ungroup unavailable; worktree cleanup failed.*worktree unavailable/,
    );

    expect(requestBindingRevokeAllForThread).toHaveBeenCalledTimes(1);
    expect(setThreadParent).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-child",
      parentThreadId: undefined,
      expectedParent: { threadId: "thread-missing-rollout", backend: "codex", instanceId: undefined },
    });
    expect(archiveWorktree).toHaveBeenCalledTimes(1);
    await expect(
      overlayStore.getThreadOverlayState({
        backend: "codex",
        threadId: "thread-missing-rollout",
      }),
    ).resolves.toBeUndefined();
    await expect(
      registry.listThreads({
        backend: "codex",
        forceRefresh: true,
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "thread-missing-rollout",
        }),
      ]),
    );

    await registry.close();
  });

  it("preserves non-rollout Codex archive failures", async () => {
    const thread: AppServerThreadSummary = {
      id: "thread-archive-error",
      title: "Archive error",
      titleSource: "explicit",
      linkedDirectories: [],
      source: "codex",
      updatedAt: 2,
    };
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list", "thread/archive"] },
      threads: [thread],
      archiveThreadError: new Error("archive transport unavailable"),
    });
    const overlayStore = createOverlayStoreMock();
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
    });

    await expect(
      registry.archiveThread({
        backend: "codex",
        threadId: "thread-archive-error",
      }),
    ).rejects.toThrow("archive transport unavailable");
    await expect(
      overlayStore.getThreadOverlayState({
        backend: "codex",
        threadId: "thread-archive-error",
      }),
    ).resolves.toBeUndefined();

    await registry.close();
  });

  it("removes a real Git worktree and unregisters it from the source repo when archiving a thread", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-registry-archive-"));
    const repoPath = path.join(root, "PwrAgnt");
    const worktreeRoot = path.join(root, ".codex", "worktrees", "mozycyl1");
    const worktreePath = path.join(worktreeRoot, "PwrAgnt");

    try {
      await mkdir(repoPath, { recursive: true });
      await git(repoPath, ["init", "-b", "main"]);
      await writeFile(path.join(repoPath, "README.md"), "base\n", "utf8");
      await git(repoPath, ["add", "README.md"]);
      await git(repoPath, ["commit", "-m", "initial"]);
      await mkdir(worktreeRoot, { recursive: true });
      await git(repoPath, ["worktree", "add", "-b", "feat/archive-cleanup", worktreePath, "main"]);
      const resolvedWorktreePath = await realpath(worktreePath);

      const thread: AppServerThreadSummary = {
        id: "thread-1",
        title: "Archive real worktree",
        titleSource: "explicit",
        linkedDirectories: [
          {
            id: `directory:${repoPath}`,
            label: "PwrAgnt",
            path: repoPath,
            kind: "worktree",
            worktreePath,
          },
        ],
        source: "codex",
        gitBranch: "feat/archive-cleanup",
        updatedAt: 2,
      };
      const codexClient = new MockBackendClient({
        initializeResult: { methods: ["thread/list", "thread/archive"] },
        threads: [thread],
      });
      const registry = createDesktopBackendRegistry({
        codexClient,
        overlayStore: createOverlayStoreMock(),
      });

      const response = await registry.archiveThread({
        backend: "codex",
        threadId: "thread-1",
      });

      expect(response.cleanup).toEqual([
        {
          worktreePath: resolvedWorktreePath,
          branch: "feat/archive-cleanup",
          removedWorktree: true,
          deletedBranch: false,
        },
      ]);
      expect(await pathExists(resolvedWorktreePath)).toBe(false);
      expect(await git(repoPath, ["worktree", "list", "--porcelain"])).not.toContain(
        resolvedWorktreePath,
      );

      await registry.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("archives the managed worktree after repeated project moves", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-repeated-project-move-"));
    let registry: DesktopBackendRegistry | undefined;
    try {
      const repoPath = path.join(root, "PwrGit");
      await mkdir(repoPath);
      await git(repoPath, ["init", "-b", "main"]);
      await writeFile(path.join(repoPath, "README.md"), "base\n", "utf8");
      await git(repoPath, ["add", "README.md"]);
      await git(repoPath, ["commit", "-m", "initial"]);
      const handoffService = new GitWorkspaceHandoffService({ resolveWorktreeStorage: () => "in-repo" });
      const created = await handoffService.handoff({
        backend: "codex", threadId: "thread-1", direction: "to-project", targetPath: repoPath,
        sourceWorkMode: "worktree", now: 1000,
      });
      const overlayStore = createOverlayStoreMock();
      await overlayStore.replaceWorkspaceLinkedDirectory({
        backend: "codex", threadId: "thread-1", directory: created.linkedDirectory,
      });
      const thread: AppServerThreadSummary = {
        id: "thread-1", title: "Repeated project move", titleSource: "explicit", source: "codex",
        projectKey: created.targetPath, linkedDirectories: [created.linkedDirectory], gitBranch: "HEAD", updatedAt: 2,
      };
      registry = createDesktopBackendRegistry({
        codexClient: new MockBackendClient({ threads: [thread] }), overlayStore, gitWorkspaceHandoffService: handoffService,
      });
      for (let move = 0; move < 2; move += 1) {
        const result = await registry.handoffThreadWorkspace({
          backend: "codex", threadId: thread.id, direction: "to-project", targetPath: repoPath,
        });
        expect(result.targetPath).toBe(created.targetPath);
      }
      const archived = await registry.archiveThread({ backend: "codex", threadId: thread.id });
      expect(archived.cleanup).toContainEqual(expect.objectContaining({ removedWorktree: true }));
      expect(await pathExists(created.targetPath)).toBe(false);
      expect(await git(repoPath, ["worktree", "list", "--porcelain"])).not.toContain(created.targetPath);
    } finally {
      await registry?.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    { case: "archives it when no other thread uses it", sharedWithActiveThread: false },
    { case: "leaves it while another active thread still runs in it", sharedWithActiveThread: true },
  ])("reads a retained worktree in paged archive discovery and $case", async ({ sharedWithActiveThread }) => {
    const oldWorktree = "/repo/app/.worktrees/old";
    const newWorktree = "/repo/app/.worktrees/new";
    const thread: AppServerThreadSummary = {
      id: "thread-1", title: "Fresh start", titleSource: "explicit", source: "codex", updatedAt: 1,
      linkedDirectories: [{ id: "pwragent-handoff:codex:thread-1", label: "app", path: "/repo/app", kind: "worktree", worktreePath: newWorktree }],
    };
    // A sub-thread can still run in the worktree its parent moved away from.
    const child: AppServerThreadSummary = {
      id: "thread-2", title: "Child", titleSource: "explicit", source: "codex", updatedAt: 1,
      linkedDirectories: [{ id: "directory:/repo/app", label: "app", path: "/repo/app", kind: "worktree", worktreePath: oldWorktree }],
    };
    const archiveWorktree = vi.fn(async (params: { worktreePath: string; repositoryPath: string }) => ({
      id: `snapshot:${params.worktreePath}`, backend: "codex", threadId: "thread-1", worktreePath: params.worktreePath,
      repositoryPath: params.repositoryPath, snapshotRef: "refs/pwragent/snapshot", snapshotCommit: "abc123",
      createdAt: 1, archivedAt: 1, state: "archived", ignoredFilesExcluded: true,
    }));
    const codexClient = Object.assign(new MockBackendClient({
      initializeResult: { methods: ["thread/list", "thread/archive"] },
      threads: [thread],
    }), {
      listArchiveCleanupThreadsPage: vi.fn(async ({ archived }: { archived: boolean }) => ({
        threads: archived ? [{ ...thread, archived: true }] : sharedWithActiveThread ? [child] : [],
      })),
    });
    await mockArchiveWorktreePresence([oldWorktree, newWorktree], (target) => !archiveWorktree.mock.calls.some(([params]) => params.worktreePath === target));
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock({ overlays: { "codex:thread-1": {
        backend: "codex", threadId: "thread-1", executionMode: "default",
        extraLinkedDirectories: [thread.linkedDirectories[0]!],
        retainedWorktrees: [{
          id: `pwragent-retained-worktree:codex:thread-1:${oldWorktree}`, label: "app", path: "/repo/app",
          kind: "worktree", worktreePath: oldWorktree,
        }],
      } } }),
      pdfToolMcpServer: null,
      worktreeArchiveService: { archive: archiveWorktree } as unknown as WorktreeArchiveService,
    });
    try {
      const response = await registry.archiveThread({ backend: "codex", threadId: "thread-1" });

      expect(codexClient.listArchiveCleanupThreadsPage).toHaveBeenCalled();
      const archivedPaths = archiveWorktree.mock.calls.map(([params]) => params.worktreePath);
      expect(archivedPaths).toContain(newWorktree);
      if (sharedWithActiveThread) {
        expect(archivedPaths).not.toContain(oldWorktree);
        expect(response.cleanup).toContainEqual(expect.objectContaining({
          worktreePath: oldWorktree, removedWorktree: false,
          skippedReason: "Worktree is still used by another active thread: thread-2.",
        }));
      } else {
        expect(archivedPaths).toContain(oldWorktree);
      }
    } finally {
      await registry.close();
    }
  });
});

describe("DesktopBackendRegistry — ACP worktree directory grouping", () => {
  const acpBackendId = "acp:kimi" as AcpBackendId;
  const worktreeCwd = "/Users/me/.codex/worktrees/abcd/PwrAgnt";
  const repoPath = "/Users/me/pwrdrvr/PwrAgnt";

  const resolvedDirectory: LinkedDirectorySummary = {
    id: repoPath,
    label: "PwrAgnt",
    path: repoPath,
    worktreePath: worktreeCwd,
    kind: "worktree",
  };

  function acpSessionWithCwd(cwd: string): AcpSessionMetadata {
    return {
      backendId: acpBackendId,
      sessionId: "s1",
      title: "ACP session",
      cwd,
      createdAt: 1000,
      updatedAt: 1000,
      executionMode: "default",
      status: "idle",
    };
  }

  it("resolves a managed-worktree ACP thread onto its repository checkout and caches it", async () => {
    // ACP sessions only know their cwd. For a worktree cwd we follow the
    // worktree's `.git` link (filesystem only, no git process) to a repo-rooted
    // linked directory so the thread groups under the repo row (path = repo,
    // worktreePath = cwd) instead of getting its own folder — then persist the
    // result on the overlay so it is never re-resolved.
    const resolver = vi.fn(async () => resolvedDirectory);
    const overlayStore = createOverlayStoreMock();
    const setSpy = vi.spyOn(overlayStore, "setAcpWorktreeDirectory");
    const { registry } = createKimiAcpRegistry({
      acpBackendId,
      sessionId: "s1",
      sessions: [acpSessionWithCwd(worktreeCwd)],
      overlayStore,
      acpWorktreeRepositoryResolver: resolver,
    });

    const threads = await registry.listThreads({ backend: acpBackendId });

    expect(resolver).toHaveBeenCalledWith(worktreeCwd);
    expect(threads[0]?.linkedDirectories).toEqual([resolvedDirectory]);
    expect(setSpy).toHaveBeenCalledWith({
      backend: acpBackendId,
      threadId: "s1",
      cwd: worktreeCwd,
      directory: resolvedDirectory,
    });
  });

  it("reuses the cached resolution from the overlay without touching the filesystem", async () => {
    // The repo↔worktree mapping is immutable, so a thread that already carries
    // a cached `acpWorktreeDirectory` for its cwd must short-circuit the
    // resolver entirely.
    const resolver = vi.fn(async () => resolvedDirectory);
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "acp:kimi:s1": {
          backend: acpBackendId,
          threadId: "s1",
          executionMode: "default",
          extraLinkedDirectories: [],
          acpWorktreeDirectory: { cwd: worktreeCwd, directory: resolvedDirectory },
        },
      },
    });
    const { registry } = createKimiAcpRegistry({
      acpBackendId,
      sessionId: "s1",
      sessions: [acpSessionWithCwd(worktreeCwd)],
      overlayStore,
      acpWorktreeRepositoryResolver: resolver,
    });

    const threads = await registry.listThreads({ backend: acpBackendId });

    expect(resolver).not.toHaveBeenCalled();
    expect(threads[0]?.linkedDirectories).toEqual([resolvedDirectory]);
  });

  it("does not resolve a plain local ACP thread's directory", async () => {
    const resolver = vi.fn(async () => resolvedDirectory);
    const { registry } = createKimiAcpRegistry({
      acpBackendId,
      sessionId: "s1",
      sessions: [acpSessionWithCwd(repoPath)],
      acpWorktreeRepositoryResolver: resolver,
    });

    const threads = await registry.listThreads({ backend: acpBackendId });

    expect(resolver).not.toHaveBeenCalled();
    expect(threads[0]?.linkedDirectories).toEqual([
      { id: repoPath, label: "PwrAgnt", path: repoPath, kind: "local" },
    ]);
  });

  it("keeps the session directory when the worktree cannot be resolved and does not cache the miss", async () => {
    // A vanished/unresolvable worktree must not drop the thread to "unlinked";
    // fall back to the session's own cwd-rooted directory and leave the miss
    // uncached so a later refresh retries cheaply.
    const resolver = vi.fn(async () => undefined);
    const overlayStore = createOverlayStoreMock();
    const setSpy = vi.spyOn(overlayStore, "setAcpWorktreeDirectory");
    const { registry } = createKimiAcpRegistry({
      acpBackendId,
      sessionId: "s1",
      sessions: [acpSessionWithCwd(worktreeCwd)],
      overlayStore,
      acpWorktreeRepositoryResolver: resolver,
    });

    const threads = await registry.listThreads({ backend: acpBackendId });

    expect(resolver).toHaveBeenCalledWith(worktreeCwd);
    expect(setSpy).not.toHaveBeenCalled();
    expect(threads[0]?.linkedDirectories).toEqual([
      { id: worktreeCwd, label: "PwrAgnt", path: worktreeCwd, kind: "local" },
    ]);
  });

  it("canonicalizes navigation PR chips and degrades when the registry read fails", async () => {
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      overlayStore: createOverlayStoreMock(),
    });
    const stalePr = {
      number: 1270,
      provider: "github" as const,
      org: "pwrdrvr",
      repo: "PwrAgent",
      title: "canonical PR status",
      url: "https://github.com/pwrdrvr/PwrAgent/pull/1270",
      state: "open" as const,
      lifecycleState: "open" as const,
    };
    const mergedPr = {
      ...stalePr,
      state: "merged" as const,
      lifecycleState: "merged" as const,
    };
    const threads = [
      { id: "thread-1", source: "codex", prs: [stalePr] },
      { id: "thread-2", source: "codex" },
    ] as unknown as NavigationSnapshot["threads"];

    // No canonicalizer injected yet: threads pass through by reference
    // rather than being rewritten with a half-initialized view.
    expect(
      await registry.canonicalizeNavigationThreadPullRequests(threads),
    ).toBe(threads);

    const canonicalizer = vi.fn(async () => [mergedPr]);
    registry.setThreadPullRequestCanonicalizer(canonicalizer);
    const canonical = await registry.canonicalizeNavigationThreadPullRequests(
      threads,
    );
    expect(canonical[0]?.prs).toEqual([mergedPr]);
    // Threads with no attached PRs skip the canonicalizer entirely.
    expect(canonical[1]).toBe(threads[1]);
    expect(canonicalizer).toHaveBeenCalledTimes(1);

    // A failing status-registry read must not fail the snapshot: serving
    // the overlay's own rows beats serving an error.
    registry.setThreadPullRequestCanonicalizer(async () => {
      throw new Error("pr_status_cache unreadable");
    });
    expect(
      await registry.canonicalizeNavigationThreadPullRequests(threads),
    ).toBe(threads);
    registry.setThreadPrimaryGitRepositoryReader((_backend, threadId) =>
      threadId === "thread-2" ? "github.com/pwrdrvr/pwragent" : undefined,
    );
    const withPrimary = await registry.canonicalizeNavigationThreadPullRequests(threads);
    expect(withPrimary[1]?.primaryGitRepository).toBe("github.com/pwrdrvr/pwragent");
    expect(withPrimary[0]?.primaryGitRepository).toBeUndefined();
    registry.setThreadPrimaryGitRepositoryReader(undefined);

  });

  /**
   * Runs the missing-thread audit to completion. Each wait is for a specific
   * thing rather than for a guessed amount of time, and the two waits cover
   * different failures:
   *
   * - The FIRST settles the fire-and-forget workspace synchronizations. Their
   *   rejections are what arm the audit, so without this the clock can advance
   *   past the debounce before the timer is armed — after which the timer is
   *   due 2s into a future that never arrives, the audit never runs, and the
   *   archive assertion sees an empty list. That is the reported Windows
   *   symptom (#1793), and it is the wait that is NOT load-bearing on macOS:
   *   locally the rejection has always landed first.
   * - The SECOND settles the audit itself, however many awaited hops its
   *   archive path takes. This one IS load-bearing everywhere — drop it and
   *   the test fails locally, because the audit is still running when the
   *   debounce timer fires.
   *
   * The pump this replaces (50 ticks of 100ms) satisfied the second by budget
   * — the audit settled by tick 20 — and the first only by luck of ordering.
   */
  async function settleMissingCodexThreadAudit(
    registry: DesktopBackendRegistry,
  ): Promise<void> {
    await registry.whenMissingCodexThreadWorkSettledForTests();
    await vi.advanceTimersByTimeAsync(CODEX_MISSING_THREAD_EVALUATION_DELAY_MS);
    await registry.whenMissingCodexThreadWorkSettledForTests();
  }

  /**
   * Runs an archive to completion under fake timers.
   *
   * Archive cleanup yields at each checkpoint through one owned pause timer,
   * and between checkpoints it awaits provider, DB, and filesystem work.
   * Advancing the clock never completes that I/O, so slicing it on a budget
   * ran out on a slow runner while a probe was in flight (#2665). This waits
   * for the archive itself and advances the clock only while cleanup is parked
   * on its checkpoint, so new I/O on the path needs no fixture stub.
   */
  async function withArchivePacing<T>(
    registry: DesktopBackendRegistry,
    promise: Promise<T>,
  ): Promise<T> {
    let settled = false;
    const settlement = promise.then(() => { settled = true; }, () => { settled = true; });
    for (;;) {
      await Promise.race([settlement, registryModules(registry).threadArchiveCoordinator.whenArchiveCleanupCheckpointPendingForTests()]);
      if (settled) return await promise;
      await vi.advanceTimersByTimeAsync(ARCHIVE_CLEANUP_PAUSE_MS);
    }
  }

  function buildMissingThreadFixture(params: {
    missingThreadIds: string[];
    presentThreadIds: string[];
  }) {
    const buildThread = (id: string): AppServerThreadSummary => ({
      id,
      title: `Thread ${id}`,
      titleSource: "explicit",
      linkedDirectories: [
        {
          id: `directory:/repo/${id}`,
          label: id,
          path: `/repo/${id}`,
          kind: "local",
        },
      ],
      projectKey: `/repo/${id}`,
      source: "codex",
      updatedAt: 2,
    });
    const overlays = Object.fromEntries(
      params.missingThreadIds.map((id) => [
        buildThreadIdentityKey("codex", id),
        {
          backend: "codex" as const,
          threadId: id,
          executionMode: "default" as const,
          // A handoff directory whose path differs from the provider CWD is
          // what schedules the workspace synchronization this audit hangs off.
          extraLinkedDirectories: [
            {
              id: `pwragent-handoff:codex:${id}`,
              label: id,
              path: `/repo/${id}`,
              worktreePath: `/worktrees/${id}`,
              kind: "worktree" as const,
            },
          ],
        },
      ]),
    );
    // Each thread's cwd: its handoff worktree when missing, else its repository.
    const environmentDirectories = [
      ...params.missingThreadIds.map((id) => `/worktrees/${id}`),
      ...params.presentThreadIds.map((id) => `/repo/${id}`),
    ].map((workspace) => path.join(workspace, ".codex", "environments"));
    return {
      environmentDirectories,
      overlays,
      threads: [
        ...params.missingThreadIds.map(buildThread),
        ...params.presentThreadIds.map(buildThread),
      ],
    };
  }

  class MissingThreadCodexClient extends MockBackendClient {
    constructor(
      private readonly missingThreadIds: Set<string>,
      options: ConstructorParameters<typeof MockBackendClient>[0],
    ) {
      super(options);
    }

    updateThreadWorkspaceCallCount = 0;
    readonly archivedThreadIds: string[] = [];

    override async updateThreadWorkspace(params: {
      threadId: string;
      cwd: string;
    }): Promise<{ threadId: string }> {
      this.updateThreadWorkspaceCallCount += 1;
      if (this.missingThreadIds.has(params.threadId)) {
        throw new Error(
          `json-rpc error (-32600): thread not found: ${params.threadId}`,
        );
      }
      return { threadId: params.threadId };
    }

    override async archiveThread(params: {
      threadId: string;
    }): Promise<{ threadId: string }> {
      this.archivedThreadIds.push(params.threadId);
      if (this.missingThreadIds.has(params.threadId)) {
        throw new Error(
          `json-rpc error (-32600): thread not found: ${params.threadId}`,
        );
      }
      return { threadId: params.threadId };
    }
  }

  it("does not synchronize archived threads while collecting archive cleanup metadata", async () => {
    vi.useFakeTimers();
    let registry: DesktopBackendRegistry | undefined;
    try {
      const fixture = buildMissingThreadFixture({
        missingThreadIds: ["already-archived"],
        presentThreadIds: ["archive-target"],
      });
      const codexClient = new MissingThreadCodexClient(new Set(["already-archived"]), {
        initializeResult: { methods: ["thread/list", "thread/archive"] },
        threads: fixture.threads.filter((thread) => thread.id === "archive-target"),
        archivedThreads: fixture.threads.filter((thread) => thread.id === "already-archived"),
      });
      registry = createDesktopBackendRegistry({
        codexClient,
        overlayStore: createOverlayStoreMock({ overlays: fixture.overlays }),
      });
      const events: AgentEvent[] = [];
      registry.onEvent((event) => { events.push(event); });
      vi.mocked(stat).mockClear();
      const result = await withArchivePacing(registry, registry.archiveThread({ backend: "codex", threadId: "archive-target" }));
      expect(result.cleanup).toEqual([]);
      for (const directory of fixture.environmentDirectories) {
        expect(stat).toHaveBeenCalledWith(directory);
      }
      await settleMissingCodexThreadAudit(registry);
      expect(codexClient.updateThreadWorkspaceCallCount).toBe(0);
      expect(codexClient.archivedThreadIds).toEqual(["archive-target"]);
      expect(events.filter((event) =>
        event.notification.method === "codex/missingThreads/updated",
      )).toEqual([]);
    } finally {
      try {
        await registry?.close();
      } finally {
        vi.useRealTimers();
      }
    }
  });

  it("reports the failed thread when an approved missing-thread archive fails", async () => {
    vi.useFakeTimers();
    let registry: DesktopBackendRegistry | undefined;
    try {
      const fixture = buildMissingThreadFixture({
        missingThreadIds: ["thread-missing"],
        presentThreadIds: ["a", "b", "c", "d", "e"],
      });
      const codexClient = new MissingThreadCodexClient(new Set(["thread-missing"]), {
        initializeResult: { methods: ["thread/list", "thread/archive"] },
        threads: fixture.threads,
        archivedThreads: [],
      });
      const overlayStore = createOverlayStoreMock({ overlays: fixture.overlays });
      vi.spyOn(overlayStore, "setThreadArchiveTombstone").mockRejectedValue(
        new Error("archive storage unavailable"),
      );
      registry = createDesktopBackendRegistry({ codexClient, overlayStore });
      await registry.listThreads({ backend: "codex", forceRefresh: true });
      await settleMissingCodexThreadAudit(registry);
      expect(codexClient.archivedThreadIds).toEqual([]);
      vi.mocked(stat).mockClear();
      const result = await withArchivePacing(registry, registry.resolveMissingCodexThreads({
        action: "archive",
        threadIds: ["thread-missing"],
      }));
      expect(result.failedThreadIds).toEqual(["thread-missing"]);
      for (const directory of fixture.environmentDirectories) {
        expect(stat).toHaveBeenCalledWith(directory);
      }
    } finally {
      try {
        await registry?.close();
      } finally {
        vi.useRealTimers();
      }
    }
  });

  it("preserves a handed-off thread when workspace synchronization reports it missing in a large profile", async () => {
    vi.useFakeTimers();
    let registry: DesktopBackendRegistry | undefined;
    try {
      const missingThreadIds = new Set(["thread-missing"]);
      const fixture = buildMissingThreadFixture({
        missingThreadIds: [...missingThreadIds],
        presentThreadIds: ["a", "b", "c", "d", "e", "f", "g", "h", "i"],
      });
      const codexClient = new MissingThreadCodexClient(missingThreadIds, {
        initializeResult: { methods: ["thread/list", "thread/archive"] },
        threads: fixture.threads,
      });
      const overlayStore = createOverlayStoreMock({ overlays: fixture.overlays });
      registry = createDesktopBackendRegistry({ codexClient, overlayStore });
      const events: AgentEvent[] = [];
      registry.onEvent((event) => {
        events.push(event);
      });

      await registry.listThreads({ backend: "codex", forceRefresh: true });
      await settleMissingCodexThreadAudit(registry);

      expect(codexClient.archivedThreadIds).toEqual([]);
      expect(events.find((event) =>
        event.notification.method === "codex/missingThreads/updated",
      )?.notification.params).toMatchObject({
        status: "confirmationRequired",
        totalCount: 10,
        threadIds: ["thread-missing"],
      });
      expect((await overlayStore.getThreadOverlayState({
        backend: "codex",
        threadId: "thread-missing",
      }))?.archiveTombstonedAt).toBeUndefined();
    } finally {
      try {
        await registry?.close();
      } finally {
        vi.useRealTimers();
      }
    }
  });

  it("asks before archiving when Codex reports more than a fifth of the profile missing", async () => {
    vi.useFakeTimers();
    let registry: DesktopBackendRegistry | undefined;
    try {
      const missingThreadIds = new Set(["thread-missing-1", "thread-missing-2"]);
      const fixture = buildMissingThreadFixture({
        missingThreadIds: [...missingThreadIds],
        presentThreadIds: ["a", "b", "c"],
      });
      const codexClient = new MissingThreadCodexClient(missingThreadIds, {
        initializeResult: { methods: ["thread/list", "thread/archive"] },
        threads: fixture.threads,
      });
      const overlayStore = createOverlayStoreMock({ overlays: fixture.overlays });
      registry = createDesktopBackendRegistry({ codexClient, overlayStore });
      const events: AgentEvent[] = [];
      registry.onEvent((event) => {
        events.push(event);
      });

      await registry.listThreads({ backend: "codex", forceRefresh: true });
      await settleMissingCodexThreadAudit(registry);

      expect(codexClient.archivedThreadIds).toEqual([]);
      const update = events.find(
        (event) =>
          event.notification.method === "codex/missingThreads/updated",
      );
      expect(update?.notification.params).toMatchObject({
        missingCount: 2,
        status: "confirmationRequired",
        totalCount: 5,
      });
      expect(
        (update!.notification.params as { threadIds: string[] }).threadIds.sort(),
      ).toEqual(["thread-missing-1", "thread-missing-2"]);
    } finally {
      try {
        await registry?.close();
      } finally {
        vi.useRealTimers();
      }
    }
  });

  it("stops retrying missing Codex threads the operator chose to keep", async () => {
    vi.useFakeTimers();
    let registry: DesktopBackendRegistry | undefined;
    try {
      const missingThreadIds = new Set(["thread-missing-1", "thread-missing-2"]);
      const fixture = buildMissingThreadFixture({
        missingThreadIds: [...missingThreadIds],
        presentThreadIds: ["a", "b", "c"],
      });
      const codexClient = new MissingThreadCodexClient(missingThreadIds, {
        initializeResult: { methods: ["thread/list", "thread/archive"] },
        threads: fixture.threads,
      });
      const overlayStore = createOverlayStoreMock({ overlays: fixture.overlays });
      registry = createDesktopBackendRegistry({ codexClient, overlayStore });

      await registry.listThreads({ backend: "codex", forceRefresh: true });
      await settleMissingCodexThreadAudit(registry);
      const callsBeforeAnswer = codexClient.updateThreadWorkspaceCallCount;
      expect(callsBeforeAnswer).toBe(2);

      await expect(
        registry.resolveMissingCodexThreads({
          action: "keep",
          threadIds: ["thread-missing-1", "thread-missing-2"],
        }),
      ).resolves.toEqual({
        action: "keep",
        archivedThreadIds: [],
        failedThreadIds: [],
      });

      await registry.listThreads({ backend: "codex", forceRefresh: true });
      await settleMissingCodexThreadAudit(registry);

      expect(codexClient.updateThreadWorkspaceCallCount).toBe(callsBeforeAnswer);
      expect(codexClient.archivedThreadIds).toEqual([]);
    } finally {
      try {
        await registry?.close();
      } finally {
        vi.useRealTimers();
      }
    }
  });

  it("archives the missing Codex threads once when both windows answer the prompt", async () => {
    vi.useFakeTimers();
    let registry: DesktopBackendRegistry | undefined;
    try {
      const missingThreadIds = new Set(["thread-missing-1", "thread-missing-2"]);
      const fixture = buildMissingThreadFixture({
        missingThreadIds: [...missingThreadIds],
        presentThreadIds: ["a", "b", "c"],
      });
      const codexClient = new MissingThreadCodexClient(missingThreadIds, {
        initializeResult: { methods: ["thread/list", "thread/archive"] },
        threads: fixture.threads,
      });
      const overlayStore = createOverlayStoreMock({ overlays: fixture.overlays });
      registry = createDesktopBackendRegistry({ codexClient, overlayStore });

      await registry.listThreads({ backend: "codex", forceRefresh: true });
      await settleMissingCodexThreadAudit(registry);

      const threadIds = ["thread-missing-1", "thread-missing-2"];
      vi.mocked(stat).mockClear();
      const first = await withArchivePacing(registry, registry.resolveMissingCodexThreads({
        action: "archive",
        threadIds,
      }));
      const second = await withArchivePacing(registry, registry.resolveMissingCodexThreads({
        action: "archive",
        threadIds,
      }));

      expect(first.archivedThreadIds.sort()).toEqual(threadIds);
      expect(second.archivedThreadIds).toEqual([]);
      expect(codexClient.archivedThreadIds.sort()).toEqual(threadIds);
      for (const directory of fixture.environmentDirectories) {
        expect(stat).toHaveBeenCalledWith(directory);
      }
    } finally {
      try {
        await registry?.close();
      } finally {
        vi.useRealTimers();
      }
    }
  });

  it("re-asks when another Codex thread goes missing after an unanswered prompt", async () => {
    vi.useFakeTimers();
    let registry: DesktopBackendRegistry | undefined;
    try {
      const missingThreadIds = new Set(["thread-missing-1", "thread-missing-2"]);
      const fixture = buildMissingThreadFixture({
        missingThreadIds: ["thread-missing-1", "thread-missing-2"],
        presentThreadIds: ["a", "b", "c"],
      });
      const codexClient = new MissingThreadCodexClient(missingThreadIds, {
        initializeResult: { methods: ["thread/list", "thread/archive"] },
        threads: fixture.threads,
      });
      const overlayStore = createOverlayStoreMock({ overlays: fixture.overlays });
      registry = createDesktopBackendRegistry({ codexClient, overlayStore });
      const events: AgentEvent[] = [];
      registry.onEvent((event) => {
        events.push(event);
      });

      // The first prompt is emitted before any window subscribes. Nothing
      // answers it, so a latched flag would disable the audit for the session.
      await registry.listThreads({ backend: "codex", forceRefresh: true });
      await settleMissingCodexThreadAudit(registry);
      expect(
        events.filter(
          (event) =>
            event.notification.method === "codex/missingThreads/updated",
        ),
      ).toHaveLength(1);

      missingThreadIds.add("thread-missing-3");
      const extended = buildMissingThreadFixture({
        missingThreadIds: [
          "thread-missing-1",
          "thread-missing-2",
          "thread-missing-3",
        ],
        presentThreadIds: ["a", "b", "c"],
      });
      codexClient.setThreads(extended.threads);
      await overlayStore.addLinkedDirectory({
        backend: "codex",
        threadId: "thread-missing-3",
        directory: {
          id: "pwragent-handoff:codex:thread-missing-3",
          label: "thread-missing-3",
          path: "/repo/thread-missing-3",
          worktreePath: "/worktrees/thread-missing-3",
          kind: "worktree",
        },
      });

      await registry.listThreads({ backend: "codex", forceRefresh: true });
      await settleMissingCodexThreadAudit(registry);

      const updates = events.filter(
        (event) => event.notification.method === "codex/missingThreads/updated",
      );
      expect(updates).toHaveLength(2);
      expect(updates[1]?.notification.params).toMatchObject({
        status: "confirmationRequired",
      });
    } finally {
      try {
        await registry?.close();
      } finally {
        vi.useRealTimers();
      }
    }
  });

  it("requires a new decision for later missing threads after the operator chose keep", async () => {
    vi.useFakeTimers();
    let registry: DesktopBackendRegistry | undefined;
    try {
      const missingThreadIds = new Set(["thread-missing-1", "thread-missing-2"]);
      const fixture = buildMissingThreadFixture({
        missingThreadIds: ["thread-missing-1", "thread-missing-2"],
        presentThreadIds: ["a", "b", "c"],
      });
      const codexClient = new MissingThreadCodexClient(missingThreadIds, {
        initializeResult: { methods: ["thread/list", "thread/archive"] },
        threads: fixture.threads,
      });
      const overlayStore = createOverlayStoreMock({ overlays: fixture.overlays });
      registry = createDesktopBackendRegistry({ codexClient, overlayStore });
      const events: AgentEvent[] = [];
      registry.onEvent((event) => {
        events.push(event);
      });

      await registry.listThreads({ backend: "codex", forceRefresh: true });
      await settleMissingCodexThreadAudit(registry);
      // The initial failures require an operator decision.
      expect(codexClient.archivedThreadIds).toEqual([]);

      await registry.resolveMissingCodexThreads({
        action: "keep",
        threadIds: ["thread-missing-1", "thread-missing-2"],
      });

      missingThreadIds.add("thread-missing-3");
      const extended = buildMissingThreadFixture({
        missingThreadIds: [
          "thread-missing-1",
          "thread-missing-2",
          "thread-missing-3",
        ],
        presentThreadIds: ["a", "b", "c"],
      });
      codexClient.setThreads(extended.threads);
      await overlayStore.addLinkedDirectory({
        backend: "codex",
        threadId: "thread-missing-3",
        directory: {
          id: "pwragent-handoff:codex:thread-missing-3",
          label: "thread-missing-3",
          path: "/repo/thread-missing-3",
          worktreePath: "/worktrees/thread-missing-3",
          kind: "worktree",
        },
      });

      await registry.listThreads({ backend: "codex", forceRefresh: true });
      await settleMissingCodexThreadAudit(registry);

      // A later failure still requires a decision, even when it affects
      // only one thread in the profile.
      expect(codexClient.archivedThreadIds).toEqual([]);
      const updates = events.filter(
        (event) => event.notification.method === "codex/missingThreads/updated",
      );
      expect(updates.at(-1)?.notification.params).toMatchObject({
        status: "confirmationRequired",
        threadIds: ["thread-missing-3"],
      });
    } finally {
      try {
        await registry?.close();
      } finally {
        vi.useRealTimers();
      }
    }
  });
});
