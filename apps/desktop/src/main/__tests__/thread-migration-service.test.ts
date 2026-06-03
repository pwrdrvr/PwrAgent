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
    expect(response.projects[0]!.threads.map((thread) => thread.threadId)).toEqual(
      expect.arrayContaining(["local-thread", "worktree-thread"]),
    );
    expect(response.projects[0]!.threads).toHaveLength(2);
  });

  it("moves a thread by forking the source rollout path, validating, then archiving source", async () => {
    const calls: string[] = [];
    const sourceClient = {
      listThreadsForMigration: vi.fn(async () => [makeSourceThread()]),
      readThread: vi.fn(async () => {
        calls.push("source-read");
        return makeReplay();
      }),
      archiveThread: vi.fn(async () => {
        calls.push("source-archive");
        return { threadId: "source-thread" };
      }),
      close: vi.fn(),
    };
    const destination = {
      forkThread: vi.fn(async (request) => {
        calls.push("destination-fork");
        expect(request).toMatchObject({
          sourceThreadId: "source-thread",
          sourceThreadPath: "/Users/alice/.codex/sessions/source-thread.jsonl",
          directoryPath: "/repo/app",
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
      close: vi.fn(),
    };
    const destination = {
      forkThread: vi.fn(async (request) => {
        calls.push("destination-fork");
        expect(request).toMatchObject({
          branchName: "feature/source-work",
          directoryPath: "/repo/app",
          sourceThreadId: "source-thread",
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
            worktreePath: "/Users/alice/.codex/profiles/work/worktrees/repo/app",
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

  it("blocks Copy before fork/archive when a source thread has a profile-owned worktree", async () => {
    const sourceClient = {
      listThreadsForMigration: vi.fn(async () => [
        makeSourceThread({
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
      readThread: vi.fn(),
      archiveThread: vi.fn(),
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
      operation: "copy",
      threadIds: ["source-thread"],
    });

    expect(response.items[0]).toMatchObject({
      status: "failed",
      error:
        "Copy is disabled for selected managed worktrees. Use Move so the destination worktree is created before the source is archived.",
    });
    expect(destination.forkThread).not.toHaveBeenCalled();
    expect(sourceClient.archiveThread).not.toHaveBeenCalled();
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
