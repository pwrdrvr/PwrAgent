import { describe, expect, it, vi } from "vitest";
import type {
  AppServerThreadReplay,
  DesktopSettingsSnapshot,
} from "@pwragent/shared";
import type { CodexThreadMigrationMetadata } from "../codex-app-server/client";
import { ThreadMigrationService } from "../app-server/thread-migration-service";

function makeSettingsSnapshot(activeProfile = "work"): DesktopSettingsSnapshot {
  return {
    models: {
      codex: {
        profile: { value: activeProfile, source: "config" },
        path: { value: "codex", source: "default" },
        discovery: {} as never,
        profiles: {
          profileRoot: "/Users/alice/.codex/profiles",
          effectiveCodexHome: "/Users/alice/.codex/profiles/work",
          profiles: [
            {
              name: "",
              displayName: "System default",
              codexHome: "/Users/alice/.codex",
              source: "default",
              exists: true,
              selected: activeProfile === "",
              hasAuthFile: true,
              hasConfigFile: true,
              accountEmail: "personal@example.com",
            },
            {
              name: "work",
              displayName: "work",
              codexHome: "/Users/alice/.codex/profiles/work",
              source: "directory",
              exists: true,
              selected: activeProfile === "work",
              hasAuthFile: true,
              hasConfigFile: true,
              accountEmail: "work@example.com",
            },
            {
              name: "personal",
              displayName: "personal",
              codexHome: "/Users/alice/.codex/profiles/personal",
              source: "directory",
              exists: false,
              selected: false,
              hasAuthFile: false,
              hasConfigFile: false,
            },
          ],
        },
      },
    },
  } as unknown as DesktopSettingsSnapshot;
}

function makeReplay(text = "hello"): AppServerThreadReplay {
  return {
    entries: [],
    messages: [{ id: "m1", role: "user", text }],
    pagination: {
      supportsPagination: false,
      hasPreviousPage: false,
    },
  };
}

function makeSourceThread(
  overrides: Partial<CodexThreadMigrationMetadata> = {},
): CodexThreadMigrationMetadata {
  return {
    id: "source-thread",
    title: "Source thread",
    titleSource: "explicit",
    source: "codex",
    projectKey: "/repo/app",
    linkedDirectories: [
      {
        id: "local:/repo/app",
        label: "app",
        path: "/repo/app",
        kind: "local",
      },
    ],
    rolloutPath: "/Users/alice/.codex/sessions/source-thread.jsonl",
    ...overrides,
  };
}

describe("ThreadMigrationService", () => {
  it("lists source profiles without the active Codex profile", async () => {
    const service = new ThreadMigrationService({
      destination: {} as never,
      settingsService: {
        readSettings: async () => makeSettingsSnapshot("work"),
        resolveCodexCommandPreference: () => "codex",
        resolveCodexSpawnEnv: () => ({}),
      },
    });

    const response = await service.listSources();

    expect(response.activeCodexProfile).toBe("work");
    expect(response.profiles.map((profile) => profile.profile)).toEqual([
      "",
      "personal",
    ]);
    expect(response.profiles[0]).toMatchObject({
      displayName: "System default",
      available: true,
      accountEmail: "personal@example.com",
    });
    expect(response.profiles[1]).toMatchObject({
      available: false,
      unavailableReason: "Codex profile directory does not exist.",
    });
  });

  it("lists source threads through a captive CAS client without exposing rollout paths", async () => {
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const sourceClient = {
      listThreadsForMigration: vi.fn(async () => [makeSourceThread()]),
      readThread: vi.fn(),
      archiveThread: vi.fn(),
      restoreThread: vi.fn(),
      close: vi.fn(),
    };
    const service = new ThreadMigrationService({
      destination: {} as never,
      settingsService: {
        readSettings: async () => makeSettingsSnapshot("work"),
        resolveCodexCommandPreference: () => "codex",
        resolveCodexSpawnEnv: () => ({ PATH: "/bin" }),
      },
      sourceClientFactory: ({ env }) => {
        capturedEnv = env;
        return sourceClient;
      },
      now: () => 1234,
    });

    const response = await service.listSourceThreads({ sourceProfile: "" });

    expect(capturedEnv?.CODEX_HOME).toBe("/Users/alice/.codex");
    expect(response).toMatchObject({
      sourceProfile: "",
      fetchedAt: 1234,
      projects: [
        {
          key: "directory:/repo/app",
          label: "app",
          path: "/repo/app",
        },
      ],
    });
    expect(response.projects[0]!.threads[0]).toMatchObject({
      sourceProfile: "",
      threadId: "source-thread",
      title: "Source thread",
    });
    expect(response.projects[0]!.threads[0]).not.toHaveProperty("rolloutPath");
    expect(sourceClient.listThreadsForMigration).toHaveBeenCalledWith({
      archived: false,
      filter: undefined,
    });
  });

  it("groups source worktrees with their repository project like navigation", async () => {
    const sourceClient = {
      listThreadsForMigration: vi.fn(async () => [
        makeSourceThread({
          id: "local-thread",
          projectKey: "/Users/alice/GIPHY/giphy-bandwidth-saver",
          title: "Local thread",
          linkedDirectories: [
            {
              id: "/Users/alice/GIPHY/giphy-bandwidth-saver",
              label: "giphy-bandwidth-saver",
              path: "/Users/alice/GIPHY/giphy-bandwidth-saver",
              kind: "local",
            },
          ],
        }),
        makeSourceThread({
          id: "worktree-thread",
          projectKey:
            "/Users/alice/.codex/profiles/work/worktrees/mph2i055/giphy-bandwidth-saver",
          title: "Worktree thread",
          linkedDirectories: [
            {
              id: "/Users/alice/GIPHY/giphy-bandwidth-saver",
              label: "giphy-bandwidth-saver",
              path: "/Users/alice/GIPHY/giphy-bandwidth-saver",
              worktreePath:
                "/Users/alice/.codex/profiles/work/worktrees/mph2i055/giphy-bandwidth-saver",
              kind: "worktree",
            },
          ],
        }),
      ]),
      readThread: vi.fn(),
      archiveThread: vi.fn(),
      restoreThread: vi.fn(),
      close: vi.fn(),
    };
    const service = new ThreadMigrationService({
      destination: {} as never,
      settingsService: {
        readSettings: async () => makeSettingsSnapshot("work"),
        resolveCodexCommandPreference: () => "codex",
        resolveCodexSpawnEnv: () => ({}),
      },
      sourceClientFactory: () => sourceClient,
    });

    const response = await service.listSourceThreads({ sourceProfile: "" });

    expect(response.projects).toHaveLength(1);
    expect(response.projects[0]).toMatchObject({
      key: "directory:/Users/alice/GIPHY/giphy-bandwidth-saver",
      label: "giphy-bandwidth-saver",
      path: "/Users/alice/GIPHY/giphy-bandwidth-saver",
    });
    expect(
      response.projects[0]!.threads.map((thread) => thread.threadId),
    ).toEqual(expect.arrayContaining(["local-thread", "worktree-thread"]));
    expect(response.projects[0]!.threads).toHaveLength(2);
  });

  it("moves a thread by forking the source rollout path, validating, then archiving source", async () => {
    const calls: string[] = [];
    const sourceClient = {
      listThreadsForMigration: vi.fn(async () => [
        makeSourceThread({ gitBranch: "feature/local-work" }),
      ]),
      readThread: vi.fn(async () => {
        calls.push("source-read");
        return makeReplay();
      }),
      archiveThread: vi.fn(async () => {
        calls.push("source-archive");
        return { threadId: "source-thread" };
      }),
      restoreThread: vi.fn(),
      close: vi.fn(),
    };
    const destination = {
      forkThread: vi.fn(async (request) => {
        calls.push("destination-fork");
        expect(request).toMatchObject({
          sourceThreadId: "source-thread",
          sourceThreadPath: "/Users/alice/.codex/sessions/source-thread.jsonl",
          directoryPath: "/repo/app",
          workMode: "local",
        });
        expect(request).not.toHaveProperty("worktreeBranchMode");
        return {
          backend: "codex" as const,
          sourceThreadId: "source-thread",
          threadId: "destination-thread",
          executionMode: "default" as const,
          linkedDirectory: {
            id: "local:/repo/app",
            label: "app",
            path: "/repo/app",
            kind: "local" as const,
          },
          workMode: "local" as const,
        };
      }),
      readThread: vi.fn(async () => {
        calls.push("destination-read");
        return { replay: makeReplay() };
      }),
    };
    const service = new ThreadMigrationService({
      destination,
      settingsService: {
        readSettings: async () => makeSettingsSnapshot("work"),
        resolveCodexCommandPreference: () => "codex",
        resolveCodexSpawnEnv: () => ({}),
      },
      sourceClientFactory: () => sourceClient,
      idFactory: () => "run-1",
      now: () => 5678,
    });

    const response = await service.startMigration({
      sourceProfile: "",
      operation: "move",
      threadIds: ["source-thread"],
    });

    expect(response.items[0]).toMatchObject({
      sourceProfile: "",
      sourceThreadId: "source-thread",
      destinationThreadId: "destination-thread",
      status: "completed",
      validation: {
        sourceMessageCount: 1,
        destinationMessageCount: 1,
        matched: true,
      },
    });
    expect(calls).toEqual([
      "destination-fork",
      "source-read",
      "destination-read",
      "source-archive",
    ]);
  });

  it("copies a non-worktree thread without requiring a branch strategy", async () => {
    const sourceClient = {
      listThreadsForMigration: vi.fn(async () => [makeSourceThread()]),
      readThread: vi.fn(async () => makeReplay()),
      archiveThread: vi.fn(),
      restoreThread: vi.fn(),
      close: vi.fn(),
    };
    const destination = {
      forkThread: vi.fn(async () => ({
        backend: "codex" as const,
        sourceThreadId: "source-thread",
        threadId: "destination-thread",
        executionMode: "default" as const,
        linkedDirectory: {
          id: "local:/repo/app",
          label: "app",
          path: "/repo/app",
          kind: "local" as const,
        },
        workMode: "local" as const,
      })),
      readThread: vi.fn(async () => ({ replay: makeReplay() })),
    };
    const service = new ThreadMigrationService({
      destination,
      settingsService: {
        readSettings: async () => makeSettingsSnapshot("work"),
        resolveCodexCommandPreference: () => "codex",
        resolveCodexSpawnEnv: () => ({}),
      },
      sourceClientFactory: () => sourceClient,
    });

    const response = await service.startMigration({
      sourceProfile: "",
      operation: "copy",
      threadIds: ["source-thread"],
    });

    expect(response.items[0]).toMatchObject({
      destinationThreadId: "destination-thread",
      status: "completed",
    });
    expect(sourceClient.archiveThread).not.toHaveBeenCalled();
  });

  it("moves a profile-owned source worktree into a destination-owned worktree before archiving", async () => {
    const calls: string[] = [];
    const sourceClient = {
      listThreadsForMigration: vi.fn(async () => [
        makeSourceThread({
          gitBranch: "feature/source-work",
          linkedDirectories: [
            {
              id: "worktree:/Users/alice/.codex/profiles/personal/worktrees/repo/app",
              label: "app",
              path: "/repo/app",
              worktreePath:
                "/Users/alice/.codex/profiles/personal/worktrees/repo/app",
              kind: "worktree",
            },
          ],
        }),
      ]),
      readThread: vi.fn(async () => {
        calls.push("source-read");
        return makeReplay();
      }),
      archiveThread: vi.fn(async () => {
        calls.push("source-archive");
        return { threadId: "source-thread" };
      }),
      restoreThread: vi.fn(),
      close: vi.fn(),
    };
    const destination = {
      forkThread: vi.fn(async (request) => {
        calls.push("destination-fork");
        expect(request).toMatchObject({
          branchName: "feature/source-work",
          directoryPath: "/repo/app",
          excludedWorktreePaths: [
            "/Users/alice/.codex/profiles/personal/worktrees/repo/app",
          ],
          sourceThreadId: "source-thread",
          worktreeBranchMode: "attached",
          workMode: "worktree",
        });
        return {
          backend: "codex" as const,
          sourceThreadId: "source-thread",
          threadId: "destination-thread",
          executionMode: "default" as const,
          linkedDirectory: {
            id: "worktree:/Users/alice/.codex/profiles/work/worktrees/repo/app",
            label: "app",
            path: "/repo/app",
            worktreePath:
              "/Users/alice/.codex/profiles/work/worktrees/repo/app",
            kind: "worktree" as const,
          },
          workMode: "worktree" as const,
        };
      }),
      readThread: vi.fn(async () => {
        calls.push("destination-read");
        return { replay: makeReplay() };
      }),
    };
    const service = new ThreadMigrationService({
      destination,
      settingsService: {
        readSettings: async () => makeSettingsSnapshot("work"),
        resolveCodexCommandPreference: () => "codex",
        resolveCodexSpawnEnv: () => ({}),
      },
      sourceClientFactory: () => sourceClient,
    });

    const response = await service.startMigration({
      sourceProfile: "",
      operation: "move",
      threadIds: ["source-thread"],
    });

    expect(response.items[0]).toMatchObject({
      destinationThreadId: "destination-thread",
      status: "completed",
    });
    expect(calls).toEqual([
      "destination-fork",
      "source-read",
      "destination-read",
      "source-archive",
    ]);
  });

  it("surfaces diagnostics when a requested destination worktree falls back to local", async () => {
    const sourceClient = {
      listThreadsForMigration: vi.fn(async () => [
        makeSourceThread({
          gitBranch: "feature/source-work",
          linkedDirectories: [
            {
              id: "worktree:/Users/alice/.codex/profiles/personal/worktrees/repo/app",
              label: "app",
              path: "/repo/app",
              worktreePath:
                "/Users/alice/.codex/profiles/personal/worktrees/repo/app",
              kind: "worktree",
            },
          ],
        }),
      ]),
      readThread: vi.fn(async () => makeReplay()),
      archiveThread: vi.fn(async () => ({ threadId: "source-thread" })),
      restoreThread: vi.fn(),
      close: vi.fn(),
    };
    const destination = {
      forkThread: vi.fn(async (request) => {
        expect(request).toMatchObject({
          branchName: "feature/source-work",
          directoryPath: "/repo/app",
          workMode: "worktree",
          worktreeBranchMode: "attached",
        });
        return {
          backend: "codex" as const,
          sourceThreadId: "source-thread",
          threadId: "destination-thread",
          executionMode: "default" as const,
          linkedDirectory: {
            id: "local:/repo/app",
            label: "app",
            path: "/repo/app",
            kind: "local" as const,
          },
          workMode: "local" as const,
        };
      }),
      readThread: vi.fn(async () => ({ replay: makeReplay() })),
    };
    const service = new ThreadMigrationService({
      destination,
      settingsService: {
        readSettings: async () => makeSettingsSnapshot("work"),
        resolveCodexCommandPreference: () => "codex",
        resolveCodexSpawnEnv: () => ({}),
      },
      sourceClientFactory: () => sourceClient,
      idFactory: () => "run-1",
    });

    const response = await service.startMigration({
      sourceProfile: "",
      operation: "move",
      threadIds: ["source-thread"],
    });

    expect(response.items[0]).toMatchObject({
      destinationThreadId: "destination-thread",
      diagnostics: {
        requestedBranchName: "feature/source-work",
        requestedDirectoryPath: "/repo/app",
        requestedWorkMode: "worktree",
        requestedWorktreeBranchMode: "attached",
        destinationDirectoryPath: "/repo/app",
        destinationWorkMode: "local",
        archivedSource: true,
      },
      status: "completed",
      warnings: expect.arrayContaining([
        "Destination returned local even though migration requested a worktree.",
        "Destination did not report a worktree path.",
      ]),
    });
  });

  it("copies a source worktree to a detached destination worktree", async () => {
    const sourceClient = {
      listThreadsForMigration: vi.fn(async () => [
        makeSourceThread({
          gitBranch: "feature/source-work",
          linkedDirectories: [
            {
              id: "worktree:/Users/alice/.codex/profiles/personal/worktrees/repo/app",
              label: "app",
              path: "/repo/app",
              worktreePath:
                "/Users/alice/.codex/profiles/personal/worktrees/repo/app",
              kind: "worktree",
            },
          ],
        }),
      ]),
      readThread: vi.fn(async () => makeReplay()),
      archiveThread: vi.fn(),
      restoreThread: vi.fn(),
      close: vi.fn(),
    };
    const destination = {
      forkThread: vi.fn(async (request) => {
        expect(request).toMatchObject({
          branchName: "feature/source-work",
          directoryPath: "/repo/app",
          excludedWorktreePaths: [
            "/Users/alice/.codex/profiles/personal/worktrees/repo/app",
          ],
          sourceThreadId: "source-thread",
          worktreeBranchMode: "detached",
          workMode: "worktree",
        });
        return {
          backend: "codex" as const,
          sourceThreadId: "source-thread",
          threadId: "destination-thread",
          executionMode: "default" as const,
          linkedDirectory: {
            id: "worktree:/Users/alice/.codex/profiles/work/worktrees/repo/app",
            label: "app",
            path: "/repo/app",
            worktreePath:
              "/Users/alice/.codex/profiles/work/worktrees/repo/app",
            kind: "worktree" as const,
          },
          workMode: "worktree" as const,
        };
      }),
      readThread: vi.fn(async () => ({ replay: makeReplay() })),
    };
    const service = new ThreadMigrationService({
      destination,
      settingsService: {
        readSettings: async () => makeSettingsSnapshot("work"),
        resolveCodexCommandPreference: () => "codex",
        resolveCodexSpawnEnv: () => ({}),
      },
      sourceClientFactory: () => sourceClient,
    });

    const response = await service.startMigration({
      sourceProfile: "",
      operation: "copy",
      copyStrategy: "detached-destination",
      threadIds: ["source-thread"],
    });

    expect(response.items[0]).toMatchObject({
      destinationThreadId: "destination-thread",
      status: "completed",
    });
    expect(sourceClient.archiveThread).not.toHaveBeenCalled();
  });

  it("rolls back prepared source branch transfer when migration validation fails", async () => {
    const rollback = vi.fn(async () => undefined);
    const sourceClient = {
      listThreadsForMigration: vi.fn(async () => [
        makeSourceThread({
          gitBranch: "feature/source-work",
          linkedDirectories: [
            {
              id: "worktree:/Users/alice/.codex/profiles/personal/worktrees/repo/app",
              label: "app",
              path: "/repo/app",
              worktreePath:
                "/Users/alice/.codex/profiles/personal/worktrees/repo/app",
              kind: "worktree",
            },
          ],
        }),
      ]),
      readThread: vi.fn(async () => makeReplay("source")),
      archiveThread: vi.fn(),
      restoreThread: vi.fn(),
      close: vi.fn(),
    };
    const destination = {
      forkThread: vi.fn(async (request) => {
        request.onPreparedWorkspaceRollback?.(rollback);
        return {
          backend: "codex" as const,
          sourceThreadId: "source-thread",
          threadId: "destination-thread",
          executionMode: "default" as const,
          linkedDirectory: {
            id: "worktree:/Users/alice/.codex/profiles/work/worktrees/repo/app",
            label: "app",
            path: "/repo/app",
            worktreePath:
              "/Users/alice/.codex/profiles/work/worktrees/repo/app",
            kind: "worktree" as const,
          },
          workMode: "worktree" as const,
        };
      }),
      readThread: vi.fn(async () => ({ replay: makeReplay("destination") })),
    };
    const service = new ThreadMigrationService({
      destination,
      settingsService: {
        readSettings: async () => makeSettingsSnapshot("work"),
        resolveCodexCommandPreference: () => "codex",
        resolveCodexSpawnEnv: () => ({}),
      },
      sourceClientFactory: () => sourceClient,
    });

    const response = await service.startMigration({
      sourceProfile: "",
      operation: "move",
      threadIds: ["source-thread"],
    });

    expect(response.items[0]).toMatchObject({
      destinationThreadId: "destination-thread",
      error: "Destination replay did not match source replay.",
      status: "failed",
    });
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(sourceClient.archiveThread).not.toHaveBeenCalled();
  });

  it("restores source workspace metadata before retrying a failed migration", async () => {
    const calls: string[] = [];
    const staleThread = makeSourceThread({
      projectKey: "/Users/alice/.codex/worktrees/0cb4/web-app",
      linkedDirectories: [
        {
          id: "worktree:/Users/alice/.codex/worktrees/0cb4/web-app",
          label: "web-app",
          path: "/repo/web-app",
          worktreePath: "/Users/alice/.codex/worktrees/0cb4/web-app",
          kind: "worktree",
        },
      ],
    });
    const restoredThread = makeSourceThread({
      gitBranch: "codex/chunk-file-errors",
      projectKey: "/Users/alice/.codex/worktrees/0cb4/web-app",
      linkedDirectories: [
        {
          id: "worktree:/Users/alice/.codex/worktrees/0cb4/web-app",
          label: "web-app",
          path: "/repo/web-app",
          worktreePath: "/Users/alice/.codex/worktrees/0cb4/web-app",
          kind: "worktree",
        },
      ],
    });
    const sourceClient = {
      listThreadsForMigration: vi
        .fn()
        .mockResolvedValueOnce([staleThread])
        .mockResolvedValue([restoredThread]),
      readThread: vi.fn(async () => {
        calls.push("source-read");
        return makeReplay();
      }),
      archiveThread: vi.fn(async () => {
        calls.push("source-archive");
        return { threadId: "source-thread" };
      }),
      restoreThread: vi.fn(async () => {
        calls.push("source-restore");
        return { threadId: "source-thread" };
      }),
      close: vi.fn(),
    };
    const destination = {
      forkThread: vi.fn(async (request) => {
        calls.push("destination-fork");
        expect(request).toMatchObject({
          branchName: "codex/chunk-file-errors",
          directoryPath: "/repo/web-app",
          excludedWorktreePaths: ["/Users/alice/.codex/worktrees/0cb4/web-app"],
          sourceThreadId: "source-thread",
          workMode: "worktree",
          worktreeBranchMode: "attached",
        });
        return {
          backend: "codex" as const,
          sourceThreadId: "source-thread",
          threadId: "destination-thread",
          executionMode: "default" as const,
          linkedDirectory: {
            id: "worktree:/Users/alice/.codex/profiles/work/worktrees/web-app",
            label: "web-app",
            path: "/repo/web-app",
            worktreePath: "/Users/alice/.codex/profiles/work/worktrees/web-app",
            kind: "worktree" as const,
          },
          workMode: "worktree" as const,
        };
      }),
      readThread: vi.fn(async () => {
        calls.push("destination-read");
        return { replay: makeReplay() };
      }),
    };
    const service = new ThreadMigrationService({
      destination,
      settingsService: {
        readSettings: async () => makeSettingsSnapshot("work"),
        resolveCodexCommandPreference: () => "codex",
        resolveCodexSpawnEnv: () => ({}),
      },
      sourceClientFactory: () => sourceClient,
      idFactory: () => "run-1",
    });

    const failed = await service.startMigration({
      sourceProfile: "",
      operation: "move",
      threadIds: ["source-thread"],
    });

    expect(failed.items[0]).toMatchObject({
      status: "failed",
      error:
        "Migration is blocked because the source managed worktree did not report an attached branch.",
    });
    expect(destination.forkThread).not.toHaveBeenCalled();
    expect(sourceClient.archiveThread).not.toHaveBeenCalled();

    const retried = await service.retryMigration({
      sourceProfile: "",
      operation: "move",
      threadId: "source-thread",
    });

    expect(retried.items[0]).toMatchObject({
      destinationThreadId: "destination-thread",
      diagnostics: {
        requestedBranchName: "codex/chunk-file-errors",
        requestedDirectoryPath: "/repo/web-app",
        requestedWorkMode: "worktree",
        requestedWorktreeBranchMode: "attached",
        destinationWorktreePath:
          "/Users/alice/.codex/profiles/work/worktrees/web-app",
        archivedSource: true,
      },
      status: "completed",
    });
    expect(sourceClient.restoreThread).toHaveBeenCalledWith({
      threadId: "source-thread",
    });
    expect(sourceClient.listThreadsForMigration).toHaveBeenNthCalledWith(2, {
      archived: false,
      filter: undefined,
    });
    expect(calls).toEqual([
      "source-restore",
      "destination-fork",
      "source-read",
      "destination-read",
      "source-archive",
    ]);
  });

  it("rearchives an archived source after a successful copy retry", async () => {
    const archivedThread = makeSourceThread({
      archivedAt: 1234,
      gitBranch: "feature/source-work",
      linkedDirectories: [
        {
          id: "worktree:/Users/alice/.codex/worktrees/0cb4/web-app",
          label: "web-app",
          path: "/repo/web-app",
          worktreePath: "/Users/alice/.codex/worktrees/0cb4/web-app",
          kind: "worktree",
        },
      ],
      projectKey: "/Users/alice/.codex/worktrees/0cb4/web-app",
    });
    const restoredThread = makeSourceThread({
      gitBranch: "feature/source-work",
      linkedDirectories: [
        {
          id: "worktree:/Users/alice/.codex/worktrees/0cb4/web-app",
          label: "web-app",
          path: "/repo/web-app",
          worktreePath: "/Users/alice/.codex/worktrees/0cb4/web-app",
          kind: "worktree",
        },
      ],
      projectKey: "/Users/alice/.codex/worktrees/0cb4/web-app",
    });
    const sourceClient = {
      listThreadsForMigration: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([archivedThread])
        .mockResolvedValue([restoredThread]),
      readThread: vi.fn(async () => makeReplay()),
      archiveThread: vi.fn(async () => ({ threadId: "source-thread" })),
      restoreThread: vi.fn(async () => ({ threadId: "source-thread" })),
      close: vi.fn(),
    };
    const destination = {
      forkThread: vi.fn(async () => ({
        backend: "codex" as const,
        sourceThreadId: "source-thread",
        threadId: "destination-thread",
        executionMode: "default" as const,
        linkedDirectory: {
          id: "worktree:/Users/alice/.codex/profiles/work/worktrees/web-app",
          label: "web-app",
          path: "/repo/web-app",
          worktreePath: "/Users/alice/.codex/profiles/work/worktrees/web-app",
          kind: "worktree" as const,
        },
        workMode: "worktree" as const,
      })),
      readThread: vi.fn(async () => ({ replay: makeReplay() })),
    };
    const service = new ThreadMigrationService({
      destination,
      settingsService: {
        readSettings: async () => makeSettingsSnapshot("work"),
        resolveCodexCommandPreference: () => "codex",
        resolveCodexSpawnEnv: () => ({}),
      },
      sourceClientFactory: () => sourceClient,
    });

    const retried = await service.retryMigration({
      sourceProfile: "",
      operation: "copy",
      copyStrategy: "detached-destination",
      threadId: "source-thread",
    });

    expect(retried.items[0]).toMatchObject({
      destinationThreadId: "destination-thread",
      diagnostics: {
        archivedSource: true,
      },
      status: "completed",
    });
    expect(sourceClient.restoreThread).toHaveBeenCalledWith({
      threadId: "source-thread",
    });
    expect(sourceClient.archiveThread).toHaveBeenCalledTimes(1);
    expect(sourceClient.archiveThread).toHaveBeenCalledWith({
      threadId: "source-thread",
    });
  });

  it("blocks Move before fork/archive when projectKey is a profile-owned worktree", async () => {
    const sourceClient = {
      listThreadsForMigration: vi.fn(async () => [
        makeSourceThread({
          projectKey:
            "/Users/alice/.codex/profiles/personal/worktrees/mph2i055/repo-app",
          linkedDirectories: [],
        }),
      ]),
      readThread: vi.fn(),
      archiveThread: vi.fn(),
      restoreThread: vi.fn(),
      close: vi.fn(),
    };
    const destination = {
      forkThread: vi.fn(),
      readThread: vi.fn(),
    };
    const service = new ThreadMigrationService({
      destination,
      settingsService: {
        readSettings: async () => makeSettingsSnapshot("work"),
        resolveCodexCommandPreference: () => "codex",
        resolveCodexSpawnEnv: () => ({}),
      },
      sourceClientFactory: () => sourceClient,
    });

    const response = await service.startMigration({
      sourceProfile: "",
      operation: "move",
      threadIds: ["source-thread"],
    });

    expect(response.items[0]).toMatchObject({
      status: "failed",
      error:
        "Move is blocked because the source managed worktree did not report its repository path.",
    });
    expect(destination.forkThread).not.toHaveBeenCalled();
    expect(sourceClient.archiveThread).not.toHaveBeenCalled();
  });
});
