import {
  expectedDir,
  git,
  expectEventually,
  createOverlayStoreMock,
  MockBackendClient,
  createKimiAcpRegistry,
} from "./helpers/backend-registry-fixture";
import { createDesktopBackendRegistry } from "../app-server/backend-registry-wiring";
import { PendingEnvironmentLaunchStore } from "../app-server/pending-environment-launch-store";
import type { Options as ClaudeOptions, Query as ClaudeQuery, SDKMessage as ClaudeMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeSessionStore } from "../claude/claude-session-store";
import { launchpadStorageKey } from "@pwragent/shared/contracts/navigation";
import {
  mkdir,
  mkdtemp,
  rm,
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
import type {
  AcpBackendId,
  AppServerPendingRequestNotification,
  CodexThreadEnvironmentRuntime,
} from "@pwragent/shared/contracts/normalized-app-server";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import type { BackendAcpRuntimeCapabilities } from "@pwragent/shared/contracts/backend";
import { CodexEnvironmentCommandError, type CodexEnvironmentCommandRunner } from "../app-server/codex-environment-runtime";
import * as codexEnvironmentRuntime from "../app-server/codex-environment-runtime";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

describe("DesktopBackendRegistry", () => {
  it("prepares a launchpad worktree from the base the request names", async () => {
    const prepareLaunchpadWorkspace = vi.fn(async (_launchpad: object) => ({
      cwd: "/repo/project",
      workMode: "local" as const,
    }));
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      overlayStore: createOverlayStoreMock(),
      gitDirectoryService: { prepareLaunchpadWorkspace } as never,
    });
    const launchpad = {
      directoryKey: "directory:/repo/project",
      directoryKind: "directory" as const,
      directoryLabel: "project",
      directoryPath: "/repo/project",
      backend: "codex" as const,
      executionMode: "default" as const,
      prompt: "",
      workMode: "worktree" as const,
      createdAt: 1000,
      updatedAt: 2000,
    };

    // A peer's to-do card asks for this; the owner's checkout may be on a
    // branch that holds another thread's unpublished work.
    await registry.materializeDirectoryLaunchpad({
      directoryKey: launchpad.directoryKey,
      launchpad,
      worktreeBase: "default_branch",
    });
    await registry.materializeDirectoryLaunchpad({
      directoryKey: launchpad.directoryKey,
      launchpad,
    });

    expect(prepareLaunchpadWorkspace).toHaveBeenNthCalledWith(1, expect.objectContaining({
      directoryPath: "/repo/project",
      workMode: "worktree",
      worktreeBase: "default_branch",
    }));
    expect(prepareLaunchpadWorkspace.mock.calls[1]![0]).not.toHaveProperty("worktreeBase");

    await registry.close();
  });

  it("refuses a launchpad whose required worktree resolved to the project checkout", async () => {
    const codexClient = new MockBackendClient({ threads: [] });
    const prepareLaunchpadWorkspace = vi.fn(async (_launchpad: object) => ({
      cwd: "/repo/project",
      workMode: "local" as const,
    }));
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      gitDirectoryService: { prepareLaunchpadWorkspace } as never,
    });
    const launchpad = {
      directoryKey: "directory:/repo/project",
      directoryKind: "directory" as const,
      directoryLabel: "project",
      directoryPath: "/repo/project",
      backend: "codex" as const,
      executionMode: "default" as const,
      prompt: "",
      workMode: "worktree" as const,
      createdAt: 1000,
      updatedAt: 2000,
    };

    // A peer's New worktree card must not share the peer's checkout.
    await expect(registry.materializeDirectoryLaunchpad({
      directoryKey: launchpad.directoryKey,
      launchpad,
      requiredWorkMode: "worktree",
      input: [{ type: "text", text: "Rewrite the CLI" }],
    })).rejects.toThrow(/worktree/);
    expect(codexClient.lastStartThreadParams).toBeUndefined();

    // Without the requirement the fallback is unchanged.
    await expect(registry.materializeDirectoryLaunchpad({
      directoryKey: launchpad.directoryKey,
      launchpad,
    })).resolves.toMatchObject({ workMode: "local" });

    await registry.close();
  });

  it("keeps a required worktree and removes it when the requirement fails", async () => {
    const rollback = vi.fn(async () => {});
    const prepareLaunchpadWorkspace = vi.fn(async (_launchpad: object) => ({
      cwd: "/worktrees/abc/project",
      repositoryPath: "/repo/project",
      workMode: "worktree" as const,
      rollback,
    }));
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      overlayStore: createOverlayStoreMock(),
      gitDirectoryService: {
        prepareLaunchpadWorkspace,
        recordCodexWorktreeOwnerThread: vi.fn(async () => {}),
      } as never,
    });
    const launchpad = {
      directoryKey: "directory:/repo/project",
      directoryKind: "directory" as const,
      directoryLabel: "project",
      directoryPath: "/repo/project",
      backend: "codex" as const,
      executionMode: "default" as const,
      prompt: "",
      workMode: "worktree" as const,
      createdAt: 1000,
      updatedAt: 2000,
    };

    await expect(registry.materializeDirectoryLaunchpad({
      directoryKey: launchpad.directoryKey,
      launchpad,
      requiredWorkMode: "worktree",
    })).resolves.toMatchObject({ workMode: "worktree" });
    expect(rollback).not.toHaveBeenCalled();

    // The workspace prepared for a refused request is not left behind.
    await expect(registry.materializeDirectoryLaunchpad({
      directoryKey: launchpad.directoryKey,
      launchpad,
      requiredWorkMode: "local",
    })).rejects.toThrow(/local/);
    expect(rollback).toHaveBeenCalledTimes(1);

    await registry.close();
  });

  it("preserves the project Working Updates override after materialization", async () => {
    const overlayStore = createOverlayStoreMock();
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ threads: [] }),
      overlayStore,
      gitDirectoryService: {
        prepareLaunchpadWorkspace: vi.fn(async () => ({
          cwd: "/repo/project",
          workMode: "local" as const,
        })),
      } as never,
    });

    await registry.materializeDirectoryLaunchpad({
      directoryKey: "directory:/repo/project",
      launchpad: {
        directoryKey: "directory:/repo/project",
        directoryKind: "directory",
        directoryLabel: "project",
        directoryPath: "/repo/project",
        backend: "codex",
        executionMode: "default",
        messagingToolUpdateMode: "show_more",
        prompt: "Fix bug",
        workMode: "local",
        createdAt: 1000,
        updatedAt: 2000,
      },
    });

    const resetLaunchpad = await overlayStore.getDirectoryLaunchpad({
      directoryKey: "directory:/repo/project",
    });
    expect(resetLaunchpad).toMatchObject({
      messagingToolUpdateMode: "show_more",
      prompt: "",
    });
    expect(resetLaunchpad?.settingsTouchedAt).toBeUndefined();

    await registry.close();
  });

  describe("releasing a launchpad draft on submit", () => {
    const directoryKey = "directory:/repo/project";
    const submitted = {
      directoryKey,
      directoryKind: "directory" as const,
      directoryLabel: "project",
      directoryPath: "/repo/project",
      backend: "codex" as const,
      executionMode: "default" as const,
      prompt: "Fix bug",
      workMode: "local" as const,
      createdAt: 1000,
      updatedAt: 2000,
    };
    const createRegistry = (
      prepareLaunchpadWorkspace: (
        overlayStore: ReturnType<typeof createOverlayStoreMock>,
      ) => Promise<{ cwd: string; workMode: "local" }>,
    ) => {
      const overlayStore = createOverlayStoreMock();
      const registry = createDesktopBackendRegistry({
        codexClient: new MockBackendClient({ threads: [], models: [
          { id: "gpt-5.5", current: true }, { id: "project-model" },
        ] }),
        overlayStore,
        gitDirectoryService: {
          prepareLaunchpadWorkspace: vi.fn(() => prepareLaunchpadWorkspace(overlayStore)),
        } as never,
      });
      return { overlayStore, registry };
    };
    const readPrompt = async (
      overlayStore: ReturnType<typeof createOverlayStoreMock>,
    ) => (await overlayStore.getDirectoryLaunchpad({ directoryKey }))?.prompt ?? "";

    it("clears the draft before the workspace is prepared", async () => {
      let promptDuringSetup: string | undefined;
      const { overlayStore, registry } = createRegistry(async (store) => {
        promptDuringSetup = await readPrompt(store);
        return { cwd: "/repo/project", workMode: "local" };
      });
      await overlayStore.upsertDirectoryLaunchpad(submitted);

      await registry.materializeDirectoryLaunchpad({
        directoryKey,
        launchpad: submitted,
        input: [{ type: "text", text: "Fix bug" }],
        releaseLaunchpadOnSubmit: true,
      });

      expect(promptDuringSetup).toBe("");
      expect(await readPrompt(overlayStore)).toBe("");
      await registry.close();
    });

    it("keeps a registered project when its submitted draft is cleared", async () => {
      vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
      const temp = createTempStateDb("pwragent-registered-project-submit-");
      const db = StateDb.open(temp.dbPath);
      const persisted = new SqliteOverlayStore(db);
      onTestFinished(() => {
        db.close();
        removeTempStateDbDir(temp.tempDir);
        vi.unstubAllEnvs();
      });
      const registered = { ...submitted, registeredAt: 1500, model: "project-model" };
      const unrelated = {
        ...registered,
        directoryKey: "directory:/repo/libuv",
        directoryLabel: "libuv",
        directoryPath: "/repo/libuv",
        prompt: "",
      };
      let registeredDuringSetup: number | undefined;
      const { overlayStore, registry } = createRegistry(async (store) => {
        registeredDuringSetup = (await store.getDirectoryLaunchpad({ directoryKey }))?.registeredAt;
        return { cwd: "/repo/project", workMode: "local" };
      });
      vi.spyOn(overlayStore, "getDirectoryLaunchpad").mockImplementation((request) => persisted.getDirectoryLaunchpad(request));
      vi.spyOn(overlayStore, "upsertDirectoryLaunchpad").mockImplementation((launchpad) => persisted.upsertDirectoryLaunchpad(launchpad));
      vi.spyOn(overlayStore, "resetDirectoryLaunchpad").mockImplementation((request) => persisted.resetDirectoryLaunchpad(request));
      await overlayStore.upsertDirectoryLaunchpad(registered);
      await overlayStore.upsertDirectoryLaunchpad(unrelated);

      const { writes } = await measureSqliteWrites(async () => {
        await registry.materializeDirectoryLaunchpad({
          directoryKey,
          launchpad: registered,
          input: [{ type: "text", text: registered.prompt }],
          releaseLaunchpadOnSubmit: true,
        });
      });
      expectSqliteWriteBudget({ scenario: "registered-project-launchpad-submit", writes,
        note: "One registered project draft reset per new thread: one replacement commit, no delete/insert pair; at 100 starts/day the measured WAL is approximately 0.8 MB/day; no idle writes" });

      expect(registeredDuringSetup).toBe(registered.registeredAt);
      await expect(overlayStore.getDirectoryLaunchpad({ directoryKey })).resolves.toMatchObject({
        registeredAt: registered.registeredAt,
        model: registered.model,
        prompt: "",
      });
      await expect(overlayStore.getDirectoryLaunchpad({ directoryKey: unrelated.directoryKey }))
        .resolves.toEqual(unrelated);
      expect(persisted.readNavigationQueryIndex({ backend: "all", threads: [] }).directories.map((directory) => directory.key))
        .toEqual(expect.arrayContaining([directoryKey, unrelated.directoryKey]));
      await registry.close();
    });

    it("keeps a new draft started while the thread starts", async () => {
      const { overlayStore, registry } = createRegistry(async (store) => {
        await store.upsertDirectoryLaunchpad({ ...submitted, prompt: "Next task", updatedAt: 3000 });
        return { cwd: "/repo/project", workMode: "local" };
      });
      await overlayStore.upsertDirectoryLaunchpad(submitted);

      await registry.materializeDirectoryLaunchpad({
        directoryKey,
        launchpad: submitted,
        input: [{ type: "text", text: "Fix bug" }],
        releaseLaunchpadOnSubmit: true,
      });

      expect(await readPrompt(overlayStore)).toBe("Next task");
      await registry.close();
    });

    it("clears the submitted prompt again when a late draft save restores it", async () => {
      const { overlayStore, registry } = createRegistry(async (store) => {
        await store.upsertDirectoryLaunchpad(submitted);
        return { cwd: "/repo/project", workMode: "local" };
      });

      await registry.materializeDirectoryLaunchpad({
        directoryKey,
        launchpad: submitted,
        input: [{ type: "text", text: "Fix bug" }],
        releaseLaunchpadOnSubmit: true,
      });

      expect(await readPrompt(overlayStore)).toBe("");
      await registry.close();
    });

    it("puts the draft back when no thread could be created", async () => {
      const { overlayStore, registry } = createRegistry(async () => {
        throw new Error("branch already exists");
      });
      await overlayStore.upsertDirectoryLaunchpad(submitted);

      await expect(registry.materializeDirectoryLaunchpad({
        directoryKey,
        launchpad: submitted,
        input: [{ type: "text", text: "Fix bug" }],
        releaseLaunchpadOnSubmit: true,
      })).rejects.toThrow("branch already exists");

      expect(await readPrompt(overlayStore)).toBe("Fix bug");
      await registry.close();
    });

    it("does not put the draft back over one started meanwhile", async () => {
      const { overlayStore, registry } = createRegistry(async (store) => {
        await store.upsertDirectoryLaunchpad({ ...submitted, prompt: "Next task", updatedAt: 3000 });
        throw new Error("branch already exists");
      });
      await overlayStore.upsertDirectoryLaunchpad(submitted);

      await expect(registry.materializeDirectoryLaunchpad({
        directoryKey,
        launchpad: submitted,
        input: [{ type: "text", text: "Fix bug" }],
        releaseLaunchpadOnSubmit: true,
      })).rejects.toThrow("branch already exists");

      expect(await readPrompt(overlayStore)).toBe("Next task");
      await registry.close();
    });
  });

  it("notifies when a launchpad thread is materialized before starting input", async () => {
    const codexClient = new MockBackendClient({ threads: [] });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      gitDirectoryService: {
        prepareLaunchpadWorkspace: vi.fn(async () => ({
          cwd: "/repo/project",
          workMode: "local" as const,
        })),
      } as never,
    });
    const observed: string[] = [];

    const response = await registry.materializeDirectoryLaunchpad(
      {
        directoryKey: "directory:/repo/project",
        launchpad: {
          directoryKey: "directory:/repo/project",
          directoryKind: "directory",
          directoryLabel: "project",
          directoryPath: "/repo/project",
          backend: "codex",
          executionMode: "default",
          prompt: "",
          workMode: "local",
          createdAt: 1000,
          updatedAt: 2000,
        },
        input: [{ type: "text", text: "Fix bug" }],
      },
      {
        onThreadMaterialized: (thread) => {
          observed.push(`${thread.threadId}:${codexClient.startTurnCallCount}`);
        },
      },
    );

    expect(observed).toEqual(["thread-1:0"]);
    expect(codexClient.startTurnCallCount).toBe(1);
    expect(response).toMatchObject({
      backend: "codex",
      threadId: "thread-1",
      turnId: "turn-1",
    });

    await registry.close();
  });

  it("materializes Kimi worktree launchpads with local environment setup", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-kimi-launchpad-"));
    const worktreePath = path.join(root, ".worktrees", "thread-1", "app");
    await mkdir(path.join(root, ".codex", "environments"), { recursive: true });
    await writeFile(
      path.join(root, ".codex", "environments", "environment.toml"),
      `
version = 1
name = "Repo Environment"

[setup]
script = "echo setup"
`,
      "utf8",
    );
    const commandRunner = vi.fn(async () => ({ output: "setup", exitCode: 0 }));
    const recordCodexWorktreeOwnerThread = vi.fn(async () => {});
    const { acpBackendId, registry, sendControlPrompt, sessions } =
      createKimiAcpRegistry({
        runtimeCapabilities: { schemaVersion: 1, status: "discovered", checkedAt: 1,
          models: { availableModels: [{ id: "kimi-for-coding", label: "Kimi" }] } },
        codexEnvironmentCommandRunner: commandRunner,
        gitDirectoryService: {
          prepareLaunchpadWorkspace: vi.fn(async () => ({
            cwd: worktreePath,
            repositoryPath: root,
            workMode: "worktree" as const,
          })),
          recordCodexWorktreeOwnerThread,
        },
      });

    try {
      const response = await registry.materializeDirectoryLaunchpad({
        directoryKey: `directory:${root}`,
        launchpad: {
          directoryKey: `directory:${root}`,
          directoryKind: "directory",
          directoryLabel: "app",
          directoryPath: root,
          backend: acpBackendId,
          executionMode: "full-access",
          prompt: "",
          workMode: "worktree",
          model: "kimi-for-coding",
          codexEnvironmentId: "environment",
          codexEnvironmentExecutionTarget: "local",
          createdAt: 1_000,
          updatedAt: 2_000,
        },
      });

      expect(response).toMatchObject({
        backend: acpBackendId,
        threadId: "kimi-session-1",
        executionMode: "full-access",
        workMode: "worktree",
        linkedDirectory: {
          // Directory identifiers are forward-slash + path.resolve normalized by
          // the product on every platform; expectedDir mirrors that (no-op on POSIX).
          id: expectedDir(root),
          kind: "worktree",
          label: "app",
          path: expectedDir(root),
          worktreePath: expectedDir(worktreePath),
        },
      });
      expect(response.codexEnvironmentRuntime).toMatchObject({
        environmentId: "environment",
        environmentName: "Repo Environment",
        executionTarget: "local",
        cwd: worktreePath,
        setupStatus: "completed",
        setupCommand: "echo setup",
        setupOutput: "setup",
      });
      expect(response.codexEnvironmentStartupFailure).toBeUndefined();
      expect(commandRunner).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: worktreePath,
          command: "echo setup",
          mode: "wait",
        }),
      );
      expect(recordCodexWorktreeOwnerThread).not.toHaveBeenCalled();
      expect(sendControlPrompt).toHaveBeenCalledWith({
        sessionId: "kimi-session-1",
        prompt: "/yolo",
      });
      expect(sessions[0]).toMatchObject({
        cwd: worktreePath,
        executionMode: "full-access",
      });
    } finally {
      await registry.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("remembers launchpad work mode for future directory drafts", async () => {
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/start"] },
      }),
      overlayStore: createOverlayStoreMock(),
    });

    await registry.ensureDirectoryLaunchpad({
      directoryKey: "directory:/repo-a",
      directoryKind: "directory",
      directoryLabel: "Repo A",
      directoryPath: "/repo-a",
    });
    const updated = await registry.updateDirectoryLaunchpad({
      directoryKey: "directory:/repo-a",
      patch: { workMode: "worktree" },
      stickySettingsChanged: true,
    });
    const next = await registry.ensureDirectoryLaunchpad({
      directoryKey: "directory:/repo-b",
      directoryKind: "directory",
      directoryLabel: "Repo B",
      directoryPath: "/repo-b",
    });

    expect(updated.defaults.workMode).toBe("worktree");
    expect(next.launchpad.workMode).toBe("worktree");

    await registry.close();
  });

  it("leaves a launchpad as stored when its update condition fails", async () => {
    const overlayStore = createOverlayStoreMock();
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/start"] },
      }),
      overlayStore,
    });

    await registry.ensureDirectoryLaunchpad({
      directoryKey: "directory:/repo-a",
      directoryKind: "directory",
      directoryLabel: "Repo A",
      directoryPath: "/repo-a",
    });
    await registry.updateDirectoryLaunchpad({
      directoryKey: "directory:/repo-a",
      patch: { prompt: "keep me" },
    });
    const skipped = await registry.updateDirectoryLaunchpad(
      { directoryKey: "directory:/repo-a", patch: { prompt: "replaced" } },
      { onlyIf: (current) => current.prompt === "" },
    );
    expect(skipped.launchpad.prompt).toBe("keep me");
    expect(
      (await overlayStore.getDirectoryLaunchpad({ directoryKey: "directory:/repo-a" }))?.prompt,
    ).toBe("keep me");

    const applied = await registry.updateDirectoryLaunchpad(
      { directoryKey: "directory:/repo-a", patch: { prompt: "replaced" } },
      { onlyIf: (current) => current.prompt === "keep me" },
    );
    expect(applied.launchpad.prompt).toBe("replaced");

    await registry.close();
  });

  it("shares environment selections across repeated OpenAI, Claude and ACP flips", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-acp-env-options-"));
    await mkdir(path.join(root, ".codex", "environments"), { recursive: true });
    await writeFile(
      path.join(root, ".codex", "environments", "codex.toml"),
      `
version = 1
name = "Codex Environment"

[setup]
script = "pnpm install"

[[actions]]
name = "Codex action"
command = "pnpm codex"
`,
      "utf8",
    );
    await writeFile(
      path.join(root, ".codex", "environments", "grok.toml"),
      `
version = 1
name = "Grok Environment"

[[actions]]
name = "Grok action"
command = "pnpm grok"
`,
      "utf8",
    );

    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/start"] },
      }),
      overlayStore: createOverlayStoreMock(),
    });

    try {
      await registry.ensureDirectoryLaunchpad({
        directoryKey: `directory:${root}`,
        directoryKind: "directory",
        directoryLabel: "repo",
        directoryPath: root,
      });

      const codexSelected = await registry.updateDirectoryLaunchpad({
        directoryKey: `directory:${root}`,
        patch: {
          codexEnvironmentId: "codex",
          codexEnvironmentExecutionTarget: "local",
          codexEnvironmentActionId: "codex-action",
        },
        stickySettingsChanged: true,
      });
      expect(codexSelected.launchpad).toMatchObject({
        backend: "codex",
        codexEnvironmentId: "codex",
        codexEnvironmentExecutionTarget: "local",
        codexEnvironmentActionId: "codex-action",
      });

      const switchedToAcp = await registry.updateDirectoryLaunchpad({
        directoryKey: `directory:${root}`,
        patch: {
          backend: "acp:kimi" as AcpBackendId,
        },
        stickySettingsChanged: true,
      });
      expect(switchedToAcp.launchpad).toMatchObject({
        backend: "acp:kimi",
        codexEnvironmentOptions: [
          {
            id: "codex",
            name: "Codex Environment",
            setupScript: "pnpm install",
          },
          {
            id: "grok",
            name: "Grok Environment",
          },
        ],
      });
      expect(switchedToAcp.launchpad.codexEnvironmentId).toBe("codex");

      const acpSelected = await registry.updateDirectoryLaunchpad({
        directoryKey: `directory:${root}`,
        patch: {
          codexEnvironmentId: "grok",
          codexEnvironmentExecutionTarget: "local",
          codexEnvironmentActionId: "grok-action",
        },
        stickySettingsChanged: true,
      });
      expect(acpSelected.launchpad).toMatchObject({
        backend: "acp:kimi",
        codexEnvironmentId: "grok",
        codexEnvironmentExecutionTarget: "local",
        codexEnvironmentActionId: "grok-action",
      });

      const restoredCodex = await registry.updateDirectoryLaunchpad({
        directoryKey: `directory:${root}`,
        patch: {
          backend: "codex",
        },
        stickySettingsChanged: true,
      });
      expect(restoredCodex.launchpad).toMatchObject({
        backend: "codex",
        codexEnvironmentId: "grok",
        codexEnvironmentExecutionTarget: "local",
        codexEnvironmentActionId: "grok-action",
      });

      const switchedToClaude = await registry.updateDirectoryLaunchpad({
        directoryKey: `directory:${root}`,
        patch: { backend: "claude" },
      });
      expect(switchedToClaude.launchpad.codexEnvironmentId).toBe("grok");

      const restoredAcp = await registry.updateDirectoryLaunchpad({
        directoryKey: `directory:${root}`,
        patch: {
          backend: "acp:kimi" as AcpBackendId,
        },
        stickySettingsChanged: true,
      });
      expect(restoredAcp.launchpad).toMatchObject({
        backend: "acp:kimi",
        codexEnvironmentId: "grok",
        codexEnvironmentExecutionTarget: "local",
        codexEnvironmentActionId: "grok-action",
      });
      expect(restoredAcp.launchpad.codexEnvironmentOptions).toMatchObject([
        {
          id: "codex",
          name: "Codex Environment",
          setupScript: "pnpm install",
        },
        {
          id: "grok",
          name: "Grok Environment",
        },
      ]);
    } finally {
      await registry.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("refreshes empty saved directory drafts from current launchpad work mode defaults", async () => {
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/start"] },
      }),
      overlayStore: createOverlayStoreMock(),
    });

    await registry.ensureDirectoryLaunchpad({
      directoryKey: "directory:/repo-a",
      directoryKind: "directory",
      directoryLabel: "Repo A",
      directoryPath: "/repo-a",
      currentBranch: "main",
    });
    await registry.updateDirectoryLaunchpad({
      directoryKey: "directory:/repo-b",
      patch: { workMode: "worktree" },
      stickySettingsChanged: true,
    });

    const reopened = await registry.ensureDirectoryLaunchpad({
      directoryKey: "directory:/repo-a",
      directoryKind: "directory",
      directoryLabel: "Repo A",
      directoryPath: "/repo-a",
      currentBranch: "main",
    });

    expect(reopened.defaults.workMode).toBe("worktree");
    expect(reopened.launchpad.workMode).toBe("worktree");
    expect(reopened.launchpad.branchName).toBe("main");

    await registry.close();
  });

  it("keeps a selected Agent designation when reopening a blank launchpad", async () => {
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/start"] },
      }),
      overlayStore: createOverlayStoreMock(),
    });

    await registry.ensureDirectoryLaunchpad({
      directoryKey: "directory:/repo-a",
      directoryKind: "directory",
      directoryLabel: "Repo A",
      directoryPath: "/repo-a",
    });
    await registry.updateDirectoryLaunchpad({
      directoryKey: "directory:/repo-a",
      patch: {
        agent: {
          name: "PwrAgent Agent",
          instructions: "Manage PwrAgent threads.",
        },
      },
    });

    const reopened = await registry.ensureDirectoryLaunchpad({
      directoryKey: "directory:/repo-a",
      directoryKind: "directory",
      directoryLabel: "Repo A",
      directoryPath: "/repo-a",
    });

    expect(reopened.launchpad.agent).toEqual({
      name: "PwrAgent Agent",
      instructions: "Manage PwrAgent threads.",
    });

    await registry.close();
  });

  it("marks picked project directories as registered launchpads", async () => {
    const overlayStore = createOverlayStoreMock();
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/start"] },
      }),
      overlayStore,
    });

    const opened = await registry.ensureDirectoryLaunchpad({
      directoryKey: "directory:/repo-a",
      directoryKind: "directory",
      directoryLabel: "Repo A",
      directoryPath: "/repo-a",
      registeredAt: 12_345,
    });

    expect(opened.launchpad.registeredAt).toBe(12_345);
    await expect(
      overlayStore.getDirectoryLaunchpad({ directoryKey: "directory:/repo-a" }),
    ).resolves.toMatchObject({
      directoryKey: "directory:/repo-a",
      registeredAt: 12_345,
      prompt: "",
    });

    await registry.close();
  });

  it("keeps launchpad directory metadata when the first draft update arrives", async () => {
    const overlayStore = createOverlayStoreMock();
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/start"] },
      }),
      overlayStore,
    });

    await registry.ensureDirectoryLaunchpad({
      directoryKey: "directory:/repo-a",
      directoryKind: "directory",
      directoryLabel: "Repo A",
      directoryPath: "/repo-a",
      currentBranch: "main",
    });

    const updated = await registry.updateDirectoryLaunchpad({
      directoryKey: "directory:/repo-a",
      patch: { prompt: "Fix the app" },
    });

    expect(updated.launchpad.directoryLabel).toBe("Repo A");
    expect(updated.launchpad.directoryPath).toBe("/repo-a");
    expect(updated.launchpad.branchName).toBe("main");

    await registry.close();
  });

  it("keeps sub-thread parent metadata when launchpad drafts update", async () => {
    const overlayStore = createOverlayStoreMock();
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/start"] },
      }),
      overlayStore,
    });

    await registry.ensureDirectoryLaunchpad({
      directoryKey: "subthread:codex:thread-parent:new-worktree",
      directoryKind: "directory",
      directoryLabel: "Repo A",
      directoryPath: "/repo-a",
      currentBranch: "main",
      parentThreadId: "thread-parent",
      parentThreadTitle: "Issue 193 Markdown attachments",
    });

    const updated = await registry.updateDirectoryLaunchpad({
      directoryKey: "subthread:codex:thread-parent:new-worktree",
      patch: { prompt: "Start a child investigation" },
    });

    expect(updated.launchpad).toMatchObject({
      parentThreadId: "thread-parent",
      parentThreadTitle: "Issue 193 Markdown attachments",
      prompt: "Start a child investigation",
    });

    await registry.close();
  });

  it("repairs stale non-empty launchpad directory metadata when reopened", async () => {
    const overlayStore = createOverlayStoreMock();
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/start"] },
      }),
      overlayStore,
    });

    await registry.updateDirectoryLaunchpad({
      directoryKey: "directory:/repo-a",
      patch: { prompt: "Already drafted" },
    });

    const reopened = await registry.ensureDirectoryLaunchpad({
      directoryKey: "directory:/repo-a",
      directoryKind: "directory",
      directoryLabel: "Repo A",
      directoryPath: "/repo-a",
      currentBranch: "main",
    });

    expect(reopened.launchpad).toMatchObject({
      directoryKey: "directory:/repo-a",
      directoryKind: "directory",
      directoryLabel: "Repo A",
      directoryPath: "/repo-a",
      prompt: "Already drafted",
    });
    await expect(
      overlayStore.getDirectoryLaunchpad({ directoryKey: "directory:/repo-a" }),
    ).resolves.toMatchObject({
      directoryLabel: "Repo A",
      directoryPath: "/repo-a",
    });

    await registry.close();
  });

  it("does not rewrite sticky defaults when only pending prompt data is saved", async () => {
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/start"] },
      }),
      overlayStore: createOverlayStoreMock({
        launchpadDefaults: {
          backend: "codex",
          executionMode: "full-access",
          workMode: "local",
        },
      }),
    });

    const updated = await registry.updateDirectoryLaunchpad({
      directoryKey: "directory:/repo-a",
      patch: {
        prompt: "Draft work",
        executionMode: "default",
      },
    });

    expect(updated.launchpad.executionMode).toBe("default");
    expect(updated.defaults.executionMode).toBe("full-access");

    await registry.close();
  });

  it("derives launchpad identity when a late update recreates a missing row", async () => {
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/start"] },
      }),
      overlayStore: createOverlayStoreMock(),
    });

    const updated = await registry.updateDirectoryLaunchpad({
      directoryKey: "directory:/Users/fixture-user/github/PwrAgnt",
      patch: { prompt: "Late composer update" },
    });

    expect(updated.launchpad).toMatchObject({
      directoryKind: "directory",
      directoryLabel: "PwrAgnt",
      directoryPath: "/Users/fixture-user/github/PwrAgnt",
      prompt: "Late composer update",
    });

    const trailingWhitespace = await registry.updateDirectoryLaunchpad({
      directoryKey: "directory:/tmp/repo ",
      patch: { prompt: "Preserve the exact path" },
    });

    expect(trailingWhitespace.launchpad).toMatchObject({
      directoryKind: "directory",
      directoryLabel: "repo ",
      directoryPath: "/tmp/repo ",
      prompt: "Preserve the exact path",
    });

    const workspace = await registry.updateDirectoryLaunchpad({
      directoryKey: "workspace:new-thread",
      patch: { prompt: "Late directory-less update" },
    });

    expect(workspace.launchpad).toMatchObject({
      directoryKind: "workspace",
      directoryLabel: "Workspaces",
      directoryPath: undefined,
      prompt: "Late directory-less update",
    });

    await registry.close();
  });

  it("refuses a viewer-only launchpad model before creating a thread or review", async () => {
    const launchpad = {
      directoryKey: "directory:/repo/app",
      directoryKind: "directory" as const,
      directoryLabel: "app",
      directoryPath: "/repo/app",
      backend: "codex" as const,
      executionMode: "default" as const,
      prompt: "",
      workMode: "local" as const,
      model: "gpt-viewer-only",
      reasoningEffort: "medium" as const,
      createdAt: 1_000,
      updatedAt: 2_000,
    };
    const createRegistry = () => {
      const codexClient = new MockBackendClient({
        initializeResult: {
          serverInfo: { name: "Codex App Server", version: "1.0.0" },
          methods: ["thread/start", "review/start"],
        },
        models: [
          {
            id: "gpt-5.4",
            label: "GPT-5.4",
            supportsReasoning: true,
          },
        ],
      });
      return {
        codexClient,
        registry: createDesktopBackendRegistry({
          codexClient,
          overlayStore: createOverlayStoreMock(),
        }),
      };
    };

    for (const sourceInstanceId of [undefined, "pwr_viewer"]) {
      const { registry, codexClient } = createRegistry();
      try {
        await expect(registry.materializeDirectoryLaunchpad({
          directoryKey: launchpad.directoryKey,
          reviewTarget: { type: "baseBranch", branch: "main" },
          launchpad,
        }, { sourceInstanceId })).rejects.toThrow('model="gpt-viewer-only" is not available for backend="codex"');
        expect(codexClient.lastStartThreadParams).toBeUndefined();
        expect(codexClient.lastStartReviewParams).toBeUndefined();
      } finally {
        await registry.close();
      }
    }
  });

  it.each(["directory:/owner/repo", "subthread:acp%3Akimi:parent:same-worktree"])("stores remote model choices without resolving them against this viewer's catalog: %s", async (directoryKey) => {
    const codexClient = new MockBackendClient({ models: [{ id: "viewer-only", current: true }] });
    const registry = createDesktopBackendRegistry({ codexClient, overlayStore: createOverlayStoreMock() });
    const owner = { scope: "remote" as const, instanceId: "owner" };
    try {
      await registry.ensureDirectoryLaunchpad({ directoryKey, directoryKind: "directory", directoryLabel: "Owner", directoryPath: "/owner/repo" },
        { owner, skipFilesystemInspection: true, skipMcpConnectionDefaults: true });
      const result = await registry.updateDirectoryLaunchpad({ directoryKey,
        patch: { backend: "codex", model: "owner-only", reasoningEffort: "high", fastMode: true, serviceTier: "priority" },
      }, { owner });
      expect(result.launchpad).toMatchObject({ backend: "codex", model: "owner-only", reasoningEffort: "high", fastMode: true, serviceTier: "priority" });
      const saved = await registry.updateDirectoryLaunchpad({ directoryKey, patch: { prompt: "Review on the owner" } }, { owner });
      expect(saved.launchpad).toMatchObject({ model: "owner-only", reasoningEffort: "high", prompt: "Review on the owner" });
      const reopened = await registry.ensureDirectoryLaunchpad({ directoryKey, directoryKind: "directory", directoryLabel: "Owner", directoryPath: "/owner/repo" },
        { owner, skipFilesystemInspection: true, skipMcpConnectionDefaults: true });
      expect(reopened.launchpad).toMatchObject({ model: "owner-only", reasoningEffort: "high", fastMode: true, serviceTier: "priority" });
    } finally {
      await registry.close();
    }
  });

  it("materializes workspace launchpads into a scratch directory instead of the workspace root", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start"] },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      createScratchProjectDirectory: async () => "/Users/test/.pwragent/projects/2026-05-02-a1b2c3",
    });

    await registry.materializeDirectoryLaunchpad({
      directoryKey: "workspace:/Users/test/.pwragent/projects",
      launchpad: {
        directoryKey: "workspace:/Users/test/.pwragent/projects",
        directoryKind: "workspace",
        directoryLabel: "Workspaces",
        directoryPath: "/Users/test/.pwragent/projects",
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

    expect(codexClient.lastStartThreadParams?.cwd).toBe(
      "/Users/test/.pwragent/projects/2026-05-02-a1b2c3",
    );

    await registry.close();
  });

  it("retains the viewer environment when clearing a submitted remote draft", async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const temp = createTempStateDb("pwragent-viewer-environment-");
    const db = StateDb.open(temp.dbPath);
    const persisted = new SqliteOverlayStore(db);
    const overlayStore = createOverlayStoreMock();
    vi.spyOn(overlayStore, "getDirectoryLaunchpad").mockImplementation((request) => persisted.getDirectoryLaunchpad(request));
    vi.spyOn(overlayStore, "upsertDirectoryLaunchpad").mockImplementation((value) => persisted.upsertDirectoryLaunchpad(value));
    vi.spyOn(overlayStore, "resetDirectoryLaunchpad").mockImplementation((request) => persisted.resetDirectoryLaunchpad(request));
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ initializeResult: { methods: ["thread/start"] } }),
      overlayStore,
    });
    const request = {
      directoryKey: "directory:/owner-only/repo",
      directoryKind: "directory" as const,
      directoryLabel: "Repo",
      directoryPath: "/owner-only/repo",
    };
    try {
      await registry.ensureDirectoryLaunchpad(request, { skipFilesystemInspection: true });
      await registry.updateDirectoryLaunchpad({
        directoryKey: request.directoryKey,
        patch: {
          prompt: "submitted message",
          codexEnvironmentId: "project",
          codexEnvironmentExecutionTarget: "local",
          codexEnvironmentActionId: "dev",
        },
      });
      const { writes } = await measureSqliteWrites(async () => {
        await registry.resetDirectoryLaunchpad({ directoryKey: request.directoryKey, preserveEnvironment: true });
      });
      const reopened = await registry.ensureDirectoryLaunchpad(request, { skipFilesystemInspection: true });
      expect(reopened.launchpad).toMatchObject({
        prompt: "",
        codexEnvironmentId: "project",
        codexEnvironmentExecutionTarget: "local",
        codexEnvironmentActionId: "dev",
      });
      expectSqliteWriteBudget({
        scenario: "remote-launchpad-environment-reset",
        note: "Clear one submitted viewer draft and retain its environment at the submission boundary. Two commits, approximately 1.7 MB/day at 100 threads/day, with no idle or streamed-event writes.",
        writes,
      });
      await registry.updateDirectoryLaunchpad({
        directoryKey: request.directoryKey,
        patch: { backend: "claude", codexEnvironmentId: undefined, codexEnvironmentActionId: undefined },
      });
      await registry.resetDirectoryLaunchpad({ directoryKey: request.directoryKey, preserveEnvironment: true });
      const cleared = await registry.ensureDirectoryLaunchpad(request, { skipFilesystemInspection: true });
      expect(cleared.launchpad.codexEnvironmentId).toBeUndefined();
      const otherProject = await registry.ensureDirectoryLaunchpad({
        ...request, directoryKey: "directory:/owner-only/other", directoryPath: "/owner-only/other",
      }, { skipFilesystemInspection: true });
      expect(otherProject.launchpad.codexEnvironmentId).toBeUndefined();
      await registry.resetDirectoryLaunchpad({ directoryKey: request.directoryKey });
      await expect(persisted.getDirectoryLaunchpad({ directoryKey: request.directoryKey })).resolves.toBeUndefined();
    } finally {
      await registry.close();
      db.close();
      removeTempStateDbDir(temp.tempDir);
      vi.unstubAllEnvs();
    }
  });

  describe("a peer's draft for a directory key this machine also uses", () => {
    // Two Macs with one home layout: the peer's key is this machine's key.
    const request = {
      directoryKey: "directory:/Users/fixture/src/app",
      directoryKind: "directory" as const,
      directoryLabel: "app",
      directoryPath: "/Users/fixture/src/app",
    };
    const owner = { scope: "remote" as const, instanceId: "owner_one" };
    const remote = {
      skipFilesystemInspection: true,
      skipMcpConnectionDefaults: true,
      owner,
    };
    const openStore = () => {
      const temp = createTempStateDb("pwragent-peer-launchpad-");
      const db = StateDb.open(temp.dbPath);
      const persisted = new SqliteOverlayStore(db);
      const overlayStore = Object.assign(createOverlayStoreMock(), {
        adoptLegacyRemoteDirectoryLaunchpad: (
          params: Parameters<SqliteOverlayStore["adoptLegacyRemoteDirectoryLaunchpad"]>[0],
        ) => persisted.adoptLegacyRemoteDirectoryLaunchpad(params),
      });
      vi.spyOn(overlayStore, "getDirectoryLaunchpad").mockImplementation((value) => persisted.getDirectoryLaunchpad(value));
      vi.spyOn(overlayStore, "listDirectoryLaunchpads").mockImplementation(() => persisted.listDirectoryLaunchpads());
      vi.spyOn(overlayStore, "upsertDirectoryLaunchpad").mockImplementation((value) => persisted.upsertDirectoryLaunchpad(value));
      vi.spyOn(overlayStore, "resetDirectoryLaunchpad").mockImplementation((value) => persisted.resetDirectoryLaunchpad(value));
      const registry = createDesktopBackendRegistry({
        codexClient: new MockBackendClient({ initializeResult: { methods: ["thread/start"] } }),
        overlayStore,
      });
      return {
        persisted,
        registry,
        close: async () => {
          await registry.close();
          db.close();
          removeTempStateDbDir(temp.tempDir);
          vi.unstubAllEnvs();
        },
      };
    };

    it("is stored apart from this machine's own draft", async () => {
      const { persisted, registry, close } = openStore();
      try {
        const opened = await registry.ensureDirectoryLaunchpad(request, remote);
        // The renderer and the owner keep using the owner's key.
        expect(opened.launchpad.directoryKey).toBe(request.directoryKey);
        await registry.ensureDirectoryLaunchpad(request, { skipFilesystemInspection: true });

        await registry.updateDirectoryLaunchpad(
          { directoryKey: request.directoryKey, patch: { prompt: "this machine's draft" } },
          { skipFilesystemInspection: true },
        );
        const typed = await registry.updateDirectoryLaunchpad(
          { directoryKey: request.directoryKey, patch: { prompt: "the peer's draft" } },
          { skipFilesystemInspection: true, owner },
        );
        expect(typed.launchpad).toMatchObject({
          directoryKey: request.directoryKey,
          prompt: "the peer's draft",
        });
        await expect(persisted.getDirectoryLaunchpad({ directoryKey: request.directoryKey }))
          .resolves.toMatchObject({ prompt: "this machine's draft" });

        // A provider switch for the peer (#3029) leaves this machine's draft.
        await registry.updateDirectoryLaunchpad(
          { directoryKey: request.directoryKey, patch: { backend: "claude" } },
          { skipFilesystemInspection: true, owner },
        );
        await expect(persisted.getDirectoryLaunchpad({
          directoryKey: launchpadStorageKey(request.directoryKey, owner),
        })).resolves.toMatchObject({ prompt: "the peer's draft", backend: "claude" });
        await expect(persisted.getDirectoryLaunchpad({ directoryKey: request.directoryKey }))
          .resolves.toMatchObject({ prompt: "this machine's draft", backend: "codex" });
        await expect(registry.ensureDirectoryLaunchpad(request, remote)).resolves.toMatchObject({
          launchpad: { directoryKey: request.directoryKey, prompt: "the peer's draft" },
        });
        // One row per owner.
        expect(await persisted.listDirectoryLaunchpads()).toHaveLength(2);

        // Clearing the peer's draft leaves this machine's, and does not bring
        // this machine's text back into the peer's draft.
        await registry.resetDirectoryLaunchpad({ directoryKey: request.directoryKey }, { owner });
        await expect(persisted.getDirectoryLaunchpad({ directoryKey: request.directoryKey }))
          .resolves.toMatchObject({ prompt: "this machine's draft" });
        await expect(registry.ensureDirectoryLaunchpad(request, remote)).resolves.toMatchObject({
          launchpad: { prompt: "" },
        });
      } finally {
        await close();
      }
    });

    it("takes no environments from this machine's folder at the peer's path", async () => {
      // This machine has its own project, with an environment, at the path
      // the peer's project uses.
      const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-peer-path-"));
      await mkdir(path.join(root, ".codex", "environments"), { recursive: true });
      await writeFile(
        path.join(root, ".codex", "environments", "environment.toml"),
        "version = 1\nname = \"This machine's environment\"\n",
        "utf8",
      );
      const shared = { ...request, directoryKey: `directory:${root}`, directoryPath: root };
      const { registry, close } = openStore();
      try {
        await registry.ensureDirectoryLaunchpad(shared, remote);
        const peerEdit = await registry.updateDirectoryLaunchpad(
          { directoryKey: shared.directoryKey, patch: { prompt: "for the peer" } },
          { owner },
        );
        expect(peerEdit.launchpad.codexEnvironmentOptions).toBeUndefined();

        // A late edit that recreates the peer's row takes none either.
        await registry.resetDirectoryLaunchpad({ directoryKey: shared.directoryKey }, { owner });
        const recreated = await registry.updateDirectoryLaunchpad(
          { directoryKey: shared.directoryKey, patch: { prompt: "late edit" } },
          { owner },
        );
        expect(recreated.launchpad.codexEnvironmentOptions).toBeUndefined();

        // This machine's own draft still reads its own folder.
        const localEdit = await registry.updateDirectoryLaunchpad({
          directoryKey: shared.directoryKey,
          patch: { prompt: "for this machine" },
        });
        expect(localEdit.launchpad.codexEnvironmentOptions?.map((option) => option.name))
          .toEqual(["This machine's environment"]);
      } finally {
        await close();
        await rm(root, { recursive: true, force: true });
      }
    });

    it("keeps the text it held under the shared key before the split", async () => {
      vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
      const { persisted, registry, close } = openStore();
      try {
        // The one shared row, as an earlier build left it. Its provider pick
        // may have been made for this machine.
        await persisted.upsertDirectoryLaunchpad({
          ...request,
          backend: "codex",
          executionMode: "default",
          model: "gpt-5.5",
          prompt: "typed before the upgrade",
          workMode: "local",
          settingsTouchedAt: 50,
          createdAt: 10,
          updatedAt: 20,
        });

        const opened = await registry.ensureDirectoryLaunchpad(request, remote);
        expect(opened.launchpad).toMatchObject({
          directoryKey: request.directoryKey,
          prompt: "typed before the upgrade",
        });
        expect(opened.launchpad.settingsTouchedAt).toBeUndefined();
        // This machine's draft is not moved.
        await expect(persisted.getDirectoryLaunchpad({ directoryKey: request.directoryKey }))
          .resolves.toMatchObject({
            prompt: "typed before the upgrade",
            model: "gpt-5.5",
            settingsTouchedAt: 50,
          });

        // Sent or discarded, the peer's draft stays empty after that.
        await registry.resetDirectoryLaunchpad(
          { directoryKey: request.directoryKey, preserveEnvironment: true },
          { owner },
        );
        await expect(registry.ensureDirectoryLaunchpad(request, remote)).resolves.toMatchObject({
          launchpad: { prompt: "" },
        });

        const otherPeer = { scope: "remote" as const, instanceId: "owner_two" };
        const { result, writes } = await measureSqliteWrites(async () =>
          await persisted.adoptLegacyRemoteDirectoryLaunchpad({
            instanceId: otherPeer.instanceId,
            directoryKey: request.directoryKey,
            storageKey: launchpadStorageKey(request.directoryKey, otherPeer),
          }));
        expect(result).toMatchObject({ prompt: "typed before the upgrade" });
        expectSqliteWriteBudget({
          scenario: "remote-launchpad-legacy-adoption",
          note: "First open of one peer's draft after drafts named their owner: one commit for the copy and its marker, once per peer directory, none after that.",
          writes,
        });
        const { writes: repeated } = await measureSqliteWrites(async () => {
          await persisted.adoptLegacyRemoteDirectoryLaunchpad({
            instanceId: otherPeer.instanceId,
            directoryKey: request.directoryKey,
            storageKey: launchpadStorageKey(request.directoryKey, otherPeer),
          });
        });
        expect(repeated.commits).toBe(0);
      } finally {
        await close();
      }
    });

    it("keeps the earlier text when an edit reaches the peer's draft first", async () => {
      const { persisted, registry, close } = openStore();
      try {
        await persisted.upsertDirectoryLaunchpad({
          ...request,
          backend: "codex",
          executionMode: "default",
          prompt: "typed before the upgrade",
          workMode: "local",
          createdAt: 10,
          updatedAt: 20,
        });

        // A settings change from another window, before any ensure.
        const updated = await registry.updateDirectoryLaunchpad(
          { directoryKey: request.directoryKey, patch: { executionMode: "full-access" } },
          { owner },
        );
        expect(updated.launchpad).toMatchObject({
          directoryKey: request.directoryKey,
          executionMode: "full-access",
          prompt: "typed before the upgrade",
        });
        await expect(persisted.getDirectoryLaunchpad({ directoryKey: request.directoryKey }))
          .resolves.toMatchObject({
            executionMode: "default",
            prompt: "typed before the upgrade",
          });
      } finally {
        await close();
      }
    });
  });

  it("keeps selected Codex environments sticky after materializing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-launchpad-env-"));
    const environmentsDir = path.join(root, ".codex", "environments");
    await mkdir(environmentsDir, { recursive: true });
    await writeFile(
      path.join(environmentsDir, "environment.toml"),
      `
version = 1
name = "Repo Environment"
`,
      "utf8",
    );

    const overlayStore = createOverlayStoreMock();
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start"] },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
    });

    try {
      await registry.materializeDirectoryLaunchpad({
        directoryKey: `directory:${root}`,
        launchpad: {
          directoryKey: `directory:${root}`,
          directoryKind: "directory",
          directoryLabel: "repo",
          directoryPath: root,
          backend: "codex",
          executionMode: "default",
          prompt: "hello",
          workMode: "local",
          model: "gpt-5.5",
          reasoningEffort: "high",
          codexEnvironmentId: "environment",
          codexEnvironmentExecutionTarget: "local",
          createdAt: 1_000,
          updatedAt: 2_000,
        },
      });

      await expect(
        overlayStore.getDirectoryLaunchpad({ directoryKey: `directory:${root}` }),
      ).resolves.toMatchObject({
        prompt: "",
        codexEnvironmentId: "environment",
        codexEnvironmentExecutionTarget: "local",
      });
    } finally {
      await registry.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("surfaces Codex environment options on existing threads", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-thread-env-options-"));
    await mkdir(path.join(root, ".codex", "environments"), { recursive: true });
    await writeFile(
      path.join(root, ".codex", "environments", "environment.toml"),
      `
version = 1
name = "PwrAgnt"

[[actions]]
name = "Dev - Messaging"
command = "pnpm dev:messaging"
`,
      "utf8",
    );

    const overlayStore = createOverlayStoreMock();
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/list"] },
        threads: [
          {
            id: "thread-1",
            title: "Thread",
            titleSource: "explicit",
            source: "codex",
            updatedAt: 1,
            projectKey: root,
            linkedDirectories: [
              {
                id: root,
                kind: "local",
                label: "repo",
                path: root,
              },
            ],
          },
        ],
      }),
      overlayStore,
    });

    try {
      await expect(registry.listThreads({ backend: "codex" })).resolves.toEqual([
        expect.objectContaining({
          id: "thread-1",
          codexEnvironmentOptions: [
            expect.objectContaining({
              id: "environment",
              name: "PwrAgnt",
              actions: [
                expect.objectContaining({
                  id: "dev-messaging",
                  name: "Dev - Messaging",
                  command: "pnpm dev:messaging",
                }),
              ],
            }),
          ],
        }),
      ]);
    } finally {
      await registry.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("surfaces environment options on existing Claude threads", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-claude-thread-env-"));
    const worktree = path.join(root, "worktree");
    await mkdir(path.join(worktree, ".codex", "environments"), { recursive: true });
    await writeFile(
      path.join(worktree, ".codex", "environments", "environment.toml"),
      `
version = 1
name = "PwrAgnt"

[[actions]]
name = "Dev - Messaging"
command = "pnpm dev:messaging"
`,
      "utf8",
    );
    const sessions = new ClaudeSessionStore(path.join(root, "sessions"));
    await sessions.save({ cwd: worktree, thread: {
      id: "c1111111-1111-4111-8111-111111111111", source: "claude", title: "Claude thread", titleSource: "explicit",
      projectKey: worktree,
      linkedDirectories: [{
        id: path.join(root, "repo"), kind: "worktree", label: "repo",
        path: path.join(root, "repo"), worktreePath: worktree,
      }],
    } });

    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({}),
      overlayStore: createOverlayStoreMock(),
      agentToolMcpServer: null,
      pdfToolMcpServer: null,
      claudeBackendOptions: { store: sessions },
    });

    try {
      await expect(registry.listThreads({ backend: "claude" })).resolves.toEqual([
        expect.objectContaining({
          id: "c1111111-1111-4111-8111-111111111111",
          source: "claude",
          codexEnvironmentOptions: [
            expect.objectContaining({
              id: "environment",
              name: "PwrAgnt",
              actions: [
                expect.objectContaining({
                  id: "dev-messaging",
                  name: "Dev - Messaging",
                  command: "pnpm dev:messaging",
                }),
              ],
            }),
          ],
        }),
      ]);
    } finally {
      await registry.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("surfaces environment options on existing ACP threads", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-acp-thread-env-"));
    await mkdir(path.join(root, ".codex", "environments"), { recursive: true });
    await writeFile(
      path.join(root, ".codex", "environments", "environment.toml"),
      `
version = 1
name = "PwrAgnt"

[[actions]]
name = "Dev - Messaging"
command = "pnpm dev:messaging"
`,
      "utf8",
    );

    const { acpBackendId, registry } = createKimiAcpRegistry({
      sessions: [
        {
          backendId: "acp:kimi" as AcpBackendId,
          sessionId: "kimi-session-1",
          title: "Kimi thread",
          titleSource: "explicit",
          cwd: root,
          createdAt: 1_000,
          updatedAt: 2_000,
          executionMode: "default",
          status: "idle",
        },
      ],
    });

    const withEnvironment = expect.objectContaining({
      id: "kimi-session-1",
      source: acpBackendId,
      codexEnvironmentOptions: [
        expect.objectContaining({
          id: "environment",
          name: "PwrAgnt",
          actions: [
            expect.objectContaining({
              id: "dev-messaging",
              name: "Dev - Messaging",
              command: "pnpm dev:messaging",
            }),
          ],
        }),
      ],
    });
    try {
      await expect(registry.listThreads({ backend: acpBackendId })).resolves.toEqual([
        withEnvironment,
      ]);
      // The all-backends list reads ACP rows on their own path.
      await expect(registry.listThreads({ forceRefresh: true })).resolves.toEqual(
        expect.arrayContaining([withEnvironment]),
      );
    } finally {
      await registry.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("lets existing Codex threads select a local environment for command actions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-thread-env-select-"));
    await mkdir(path.join(root, ".codex", "environments"), { recursive: true });
    await writeFile(
      path.join(root, ".codex", "environments", "environment.toml"),
      `
version = 1
name = "PwrAgnt"

[setup]
script = "pnpm install"

[[actions]]
name = "Dev - Messaging"
command = "pnpm dev:messaging"
`,
      "utf8",
    );

    let finishSetup!: () => void;
    let markSetupStarted!: () => void;
    const setupGate = new Promise<void>((resolve) => { finishSetup = resolve; });
    const setupStarted = new Promise<void>((resolve) => { markSetupStarted = resolve; });
    const progress = vi.fn();
    const commandRunner = vi.fn(async (params: Parameters<CodexEnvironmentCommandRunner>[0]) => {
      params.onProgress?.({ phase: "stdout", chunk: "installing dependencies\n", at: Date.now() });
      markSetupStarted();
      await setupGate;
      return {
        output: "installed",
        exitCode: 0,
        durationMs: 10,
        shellEnvironment: { PATH: "/fixture/node/bin:/usr/bin", NVM_BIN: "/fixture/node/bin" },
      };
    });
    const overlayStore = createOverlayStoreMock();
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/list"] },
      threads: [
        {
          id: "thread-1",
          title: "Thread",
          titleSource: "explicit",
          source: "codex",
          updatedAt: 1,
          projectKey: root,
          linkedDirectories: [
            {
              id: root,
              kind: "local",
              label: "repo",
              path: root,
            },
          ],
        },
      ],
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
      codexEnvironmentCommandRunner: commandRunner,
    });
    const events: AgentEvent[] = [];
    registry.onEvent((event) => {
      events.push(event);
    });

    try {
      const selection = registry.setCodexThreadEnvironment({
        backend: "codex", threadId: "thread-1", environmentId: "environment",
      }, progress);
      await setupStarted;
      expect(progress).toHaveBeenCalledWith(expect.objectContaining({ directoryKey: "thread:codex:thread-1", phase: "started" }));
      expect(progress).toHaveBeenCalledWith(expect.objectContaining({ phase: "stdout", chunk: "installing dependencies\n" }));
      const turn = registry.startTurn({
        backend: "codex", threadId: "thread-1", input: [{ type: "text", text: "Use node" }],
      });
      expect(codexClient.startTurnCalls).toHaveLength(0);
      finishSetup();
      await expect(selection).resolves.toMatchObject({
        backend: "codex",
        threadId: "thread-1",
        codexEnvironmentRuntime: {
          environmentId: "environment",
          environmentName: "PwrAgnt",
          executionTarget: "local",
          cwd: root,
          setupCommand: "pnpm install",
          setupStatus: "completed",
          shellEnvironment: { PATH: "/fixture/node/bin:/usr/bin" },
          actions: [
            {
              id: "dev-messaging",
              name: "Dev - Messaging",
              command: "pnpm dev:messaging",
            },
          ],
        },
      });

      expect(progress).toHaveBeenCalledWith(expect.objectContaining({ phase: "completed", output: "installed" }));
      expect(commandRunner).toHaveBeenCalledWith(expect.objectContaining({
        cwd: root,
        command: "pnpm install",
        captureShellEnvironment: true,
        mode: "wait",
      }));
      await registry.setCodexThreadEnvironment({
        backend: "codex",
        threadId: "thread-1",
        environmentId: "environment",
        actionId: "dev-messaging",
      });
      expect(commandRunner).toHaveBeenCalledOnce();

      await expect(
        overlayStore.getThreadOverlayState({
          backend: "codex",
          threadId: "thread-1",
        }),
      ).resolves.toMatchObject({
        codexEnvironmentRuntime: {
          environmentName: "PwrAgnt",
          actions: [
            expect.objectContaining({
              name: "Dev - Messaging",
            }),
          ],
        },
      });

      expect(
        events.find(
          (event) =>
            event.notification.method === "thread/codexEnvironment/updated",
        ),
      ).toMatchObject({
        backend: "codex",
        notification: {
          method: "thread/codexEnvironment/updated",
          params: {
            threadId: "thread-1",
            codexEnvironmentRuntime: {
              environmentId: "environment",
              environmentName: "PwrAgnt",
            },
          },
        },
      });
      await turn;
      expect(codexClient.lastStartTurnParams?.codexEnvironmentRuntime?.shellEnvironment)
        .toEqual({ PATH: "/fixture/node/bin:/usr/bin", NVM_BIN: "/fixture/node/bin" });

      await registry.setCodexThreadEnvironment({ backend: "codex", threadId: "thread-1" });
      commandRunner.mockRejectedValueOnce(new Error("setup failed"));
      await expect(registry.setCodexThreadEnvironment({
        backend: "codex", threadId: "thread-1", environmentId: "environment",
      }, progress)).rejects.toThrow("setup failed");
      expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({
        directoryKey: "thread:codex:thread-1", phase: "failed", output: "setup failed",
      }));
      expect((await overlayStore.getThreadOverlayState({ backend: "codex", threadId: "thread-1" }))
        ?.codexEnvironmentRuntime).toMatchObject({ setupStatus: "failed", setupOutput: "setup failed" });
      await registry.setCodexThreadEnvironment({
        backend: "codex", threadId: "thread-1", environmentId: "environment",
      }, progress);
      expect(commandRunner).toHaveBeenCalledTimes(3);
    } finally {
      await registry.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("persists selected Codex environment actions per thread environment", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-thread-env-action-select-"));
    await mkdir(path.join(root, ".codex", "environments"), { recursive: true });
    await writeFile(
      path.join(root, ".codex", "environments", "environment.toml"),
      `
version = 1
name = "PwrAgnt"

[[actions]]
name = "Dev"
command = "pnpm dev"

[[actions]]
name = "Test"
command = "pnpm test"
`,
      "utf8",
    );

    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-1": {
          backend: "codex",
          threadId: "thread-1",
          executionMode: "default",
          extraLinkedDirectories: [],
          codexEnvironmentRuntime: {
            environmentId: "environment",
            environmentName: "PwrAgnt",
            executionTarget: "local",
            cwd: root,
            setupStatus: "completed",
            shellEnvironment: {
              PATH: "/Users/fixture-user/.nvm/versions/node/v24.14.1/bin:/usr/bin",
            },
            selectedActionIdByEnvironmentId: {
              environment: "dev",
            },
          },
        },
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/list"] },
        threads: [
          {
            id: "thread-1",
            title: "Thread",
            titleSource: "explicit",
            source: "codex",
            updatedAt: 1,
            projectKey: root,
            linkedDirectories: [
              {
                id: root,
                kind: "local",
                label: "repo",
                path: root,
              },
            ],
          },
        ],
      }),
      overlayStore,
    });

    try {
      await registry.setCodexThreadEnvironment({
        backend: "codex",
        threadId: "thread-1",
        environmentId: "environment",
        actionId: "test",
      });

      await expect(
        overlayStore.getThreadOverlayState({
          backend: "codex",
          threadId: "thread-1",
        }),
      ).resolves.toMatchObject({
        codexEnvironmentRuntime: {
          environmentId: "environment",
          shellEnvironment: {
            PATH: "/Users/fixture-user/.nvm/versions/node/v24.14.1/bin:/usr/bin",
          },
          selectedActionIdByEnvironmentId: {
            environment: "test",
          },
        },
      });
    } finally {
      await registry.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("refreshes stale thread environment actions before running a command", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-thread-env-run-"));
    const expectedActionCommand = `node -e "process.stdout.write('action-ran')"`;
    await mkdir(path.join(root, ".codex", "environments"), { recursive: true });
    await writeFile(
      path.join(root, ".codex", "environments", "environment.toml"),
      `
version = 1
name = "PwrAgnt"

[[actions]]
name = "Dev - Messaging"
command = '''${expectedActionCommand}'''
`,
      "utf8",
    );

    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-1": {
          backend: "codex",
          threadId: "thread-1",
          executionMode: "default",
          extraLinkedDirectories: [],
          codexEnvironmentRuntime: {
            environmentId: "environment",
            environmentName: "PwrAgnt",
            executionTarget: "local",
            cwd: root,
            actions: [],
          },
        },
      },
    });
    let commandParams: Parameters<CodexEnvironmentCommandRunner>[0] | undefined;
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/list"] },
        threads: [],
      }),
      overlayStore,
      codexEnvironmentCommandRunner: vi.fn(async (params) => {
        commandParams = params;
        return { pid: 12345 };
      }),
    });

    try {
      await expect(
        registry.runCodexEnvironmentAction({
          backend: "codex",
          threadId: "thread-1",
          actionId: "dev-messaging",
        }),
      ).resolves.toMatchObject({
        codexEnvironmentRuntime: {
          actionRuns: [
            expect.objectContaining({
              actionId: "dev-messaging",
              actionName: "Dev - Messaging",
              status: "started",
            }),
          ],
        },
      });
      expect(commandParams).toMatchObject({
        command: expectedActionCommand,
        cwd: root,
        mode: "detach",
      });
    } finally {
      await registry.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("runs existing-thread environment actions from the current worktree directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-thread-env-worktree-"));
    const localPath = path.join(root, "local");
    const worktreePath = path.join(root, "worktree");
    await mkdir(localPath, { recursive: true });
    await mkdir(worktreePath, { recursive: true });

    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-1": {
          backend: "codex",
          threadId: "thread-1",
          executionMode: "default",
          extraLinkedDirectories: [
            {
              id: "fixture-repo",
              label: "FixtureRepo",
              path: localPath,
              worktreePath,
              kind: "worktree",
            },
          ],
          codexEnvironmentRuntime: {
            environmentId: "environment",
            environmentName: "PwrAgnt",
            executionTarget: "local",
            cwd: localPath,
            actions: [
              {
                id: "capture-cwd",
                name: "Capture CWD",
                command: "capture-cwd",
              },
            ],
          },
        },
      },
    });
    let commandParams: Parameters<CodexEnvironmentCommandRunner>[0] | undefined;
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/list"] },
        threads: [],
      }),
      overlayStore,
      codexEnvironmentCommandRunner: vi.fn(async (params) => {
        commandParams = params;
        return { pid: 12345 };
      }),
    });

    try {
      await expect(
        registry.runCodexEnvironmentAction({
          backend: "codex",
          threadId: "thread-1",
          actionId: "capture-cwd",
        }),
      ).resolves.toMatchObject({
        codexEnvironmentRuntime: {
          cwd: worktreePath,
          actionRuns: [
            expect.objectContaining({
              actionId: "capture-cwd",
              actionName: "Capture CWD",
              status: "started",
            }),
          ],
        },
      });
      expect(commandParams).toMatchObject({
        command: "capture-cwd",
        cwd: worktreePath,
        mode: "detach",
      });
      await expect(
        overlayStore.getThreadOverlayState({
          backend: "codex",
          threadId: "thread-1",
        }),
      ).resolves.toMatchObject({
        codexEnvironmentRuntime: {
          cwd: worktreePath,
        },
      });
    } finally {
      await registry.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("runs existing-thread environment actions from Local after worktree handoff back", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-thread-env-local-"));
    const localPath = path.join(root, "local");
    const worktreePath = path.join(root, "worktree");
    await mkdir(localPath, { recursive: true });
    await mkdir(worktreePath, { recursive: true });

    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-1": {
          backend: "codex",
          threadId: "thread-1",
          executionMode: "default",
          extraLinkedDirectories: [
            {
              id: "fixture-repo",
              label: "FixtureRepo",
              path: localPath,
              kind: "local",
            },
          ],
          codexEnvironmentRuntime: {
            environmentId: "environment",
            environmentName: "PwrAgnt",
            executionTarget: "local",
            cwd: worktreePath,
            actions: [
              {
                id: "capture-cwd",
                name: "Capture CWD",
                command: "capture-cwd",
              },
            ],
          },
        },
      },
    });
    let commandParams: Parameters<CodexEnvironmentCommandRunner>[0] | undefined;
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/list"] },
        threads: [],
      }),
      overlayStore,
      codexEnvironmentCommandRunner: vi.fn(async (params) => {
        commandParams = params;
        return { pid: 12345 };
      }),
    });

    try {
      await expect(
        registry.runCodexEnvironmentAction({
          backend: "codex",
          threadId: "thread-1",
          actionId: "capture-cwd",
        }),
      ).resolves.toMatchObject({
        codexEnvironmentRuntime: {
          cwd: localPath,
          actionRuns: [
            expect.objectContaining({
              actionId: "capture-cwd",
              actionName: "Capture CWD",
              status: "started",
            }),
          ],
        },
      });
      expect(commandParams).toMatchObject({
        command: "capture-cwd",
        cwd: localPath,
        mode: "detach",
      });
    } finally {
      await registry.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("persists failed existing-thread environment actions before rejecting", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-thread-env-fail-"));
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-1": {
          backend: "codex",
          threadId: "thread-1",
          executionMode: "default",
          extraLinkedDirectories: [],
          codexEnvironmentRuntime: {
            environmentId: "environment",
            environmentName: "PwrAgnt",
            executionTarget: "local",
            cwd: path.join(root, "missing"),
            actions: [
              {
                id: "dev-messaging",
                name: "Dev - Messaging",
                command: "pnpm dev",
              },
            ],
          },
        },
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/list"] },
        threads: [],
      }),
      overlayStore,
    });

    try {
      await expect(
        registry.runCodexEnvironmentAction({
          backend: "codex",
          threadId: "thread-1",
          actionId: "dev-messaging",
        }),
      ).rejects.toThrow();
      await expect(
        overlayStore.getThreadOverlayState({
          backend: "codex",
          threadId: "thread-1",
        }),
      ).resolves.toMatchObject({
        codexEnvironmentRuntime: {
          actionRuns: [
            expect.objectContaining({
              actionId: "dev-messaging",
              actionName: "Dev - Messaging",
              command: "pnpm dev",
              status: "failed",
            }),
          ],
        },
      });
    } finally {
      await registry.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it.each(["list", "legacy", "empty"])("clears the selection while preserving %s action data", async (format) => {
    // Keep the schema-compatibility fixture outside prior-session zombie cleanup.
    const startedAt = Date.now() + 60_000;
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-1": {
          backend: "codex",
          threadId: "thread-1",
          extraLinkedDirectories: [],
          codexEnvironmentRuntime: {
            environmentId: "original",
            environmentName: "Original",
            executionTarget: "local",
            ...(format === "list" ? {
              actionRuns: [{
                runId: "old-run", actionId: "dev", actionName: "Dev", command: "pnpm dev",
                status: "started" as const, startedAt, output: "ready",
              }],
            } : format === "legacy" ? {
              actionId: "dev", actionName: "Dev", actionCommand: "pnpm dev",
              actionStatus: "started" as const, actionStartedAt: startedAt, actionOutput: "ready",
            } : {}),
          },
        },
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ initializeResult: { methods: ["thread/list"] }, threads: [] }),
      overlayStore,
    });
    try {
      const response = await registry.setCodexThreadEnvironment({ backend: "codex", threadId: "thread-1" });
      if (format === "empty") {
        expect(response.codexEnvironmentRuntime).toBeUndefined();
      } else {
        expect(response.codexEnvironmentRuntime?.environmentId).toBeUndefined();
        expect(response.codexEnvironmentRuntime?.actionRuns).toEqual([
          expect.objectContaining({
            environmentId: "original", environmentName: "Original", status: "started", output: "ready",
          }),
        ]);
      }
      expect((await overlayStore.getThreadOverlayState({ backend: "codex", threadId: "thread-1" }))
        ?.codexEnvironmentRuntime).toEqual(response.codexEnvironmentRuntime);
    } finally {
      await registry.close();
    }
  });

  it.each([undefined, "other", "broken"])("keeps action runs controllable after selecting environment %s", async (environmentId) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-thread-env-switch-"));
    await mkdir(path.join(root, ".codex", "environments"), { recursive: true });
    for (const id of ["other", "broken"]) {
      await writeFile(path.join(root, ".codex", "environments", `${id}.toml`), `
version = 1
name = "${id}"
${id === "broken" ? '[setup]\nscript = "fail-setup"' : ""}
`, "utf8");
    }
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-1": {
          backend: "codex", threadId: "thread-1", extraLinkedDirectories: [],
          codexEnvironmentRuntime: {
            environmentId: "original", environmentName: "Original", executionTarget: "local", cwd: root,
            shellEnvironment: { ORIGINAL_TOOLCHAIN: "enabled" },
            setupStatus: "completed",
            actions: [{ id: "dev", name: "Dev", command: "pnpm dev" }],
          },
        },
      },
    });
    let commandParams: Parameters<CodexEnvironmentCommandRunner>[0] | undefined;
    const stop = vi.spyOn(codexEnvironmentRuntime, "stopCodexEnvironmentDetachedCommand")
      .mockReturnValue({ found: true, alreadyClosed: false });
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/list"] },
        threads: [{
          id: "thread-1", title: "Thread", titleSource: "explicit", source: "codex", updatedAt: 1,
          projectKey: root,
          linkedDirectories: [{ id: root, kind: "local", label: "repo", path: root }],
        }],
      }),
      overlayStore,
      codexEnvironmentCommandRunner: vi.fn(async (params) => {
        if (params.mode === "wait") throw new Error("setup failed");
        commandParams = params;
        return { pid: 12345 };
      }),
    });
    const events: AgentEvent[] = [];
    registry.onEvent((event) => { events.push(event); });
    const readRuntime = async () => (await overlayStore.getThreadOverlayState({
      backend: "codex", threadId: "thread-1",
    }))?.codexEnvironmentRuntime;

    try {
      const started = await registry.runCodexEnvironmentAction({
        backend: "codex", threadId: "thread-1", actionId: "dev",
      });
      const runId = started.codexEnvironmentRuntime?.actionRuns?.[0]?.runId;
      expect(runId).toBeTruthy();
      commandParams?.onDetachedOutput?.({ output: "booting" });
      await expectEventually(async () => (await readRuntime())?.actionRuns?.[0]?.output, "booting");

      const selection = registry.setCodexThreadEnvironment({ backend: "codex", threadId: "thread-1", environmentId });
      if (environmentId === "broken") {
        await expect(selection).rejects.toThrow("setup failed");
      } else {
        const response = await selection;
        expect(response.codexEnvironmentRuntime?.actionRuns?.[0]).toMatchObject({ runId, status: "started", output: "booting" });
      }
      const selected = await readRuntime();
      expect(selected?.environmentId).toBe(environmentId);
      expect(selected?.shellEnvironment).toBeUndefined();
      expect(selected?.actionRuns?.[0]).toMatchObject({
        runId, status: "started", pid: 12345, output: "booting",
        environmentId: "original", environmentName: "Original",
      });
      expect(events.at(-1)?.notification).toMatchObject({
        method: "thread/codexEnvironment/updated",
        params: { codexEnvironmentRuntime: selected },
      });
      if (!environmentId) {
        expect(selected?.actions).toBeUndefined();
        expect(selected?.setupStatus).toBeUndefined();
        await expect(registry.runCodexEnvironmentAction({
          backend: "codex", threadId: "thread-1", actionId: "dev",
        })).rejects.toThrow("does not have a selected environment");
      }

      commandParams?.onDetachedOutput?.({ output: "booting\nready" });
      await expectEventually(async () => (await readRuntime())?.actionRuns?.[0]?.output, "booting\nready");
      await registry.stopCodexEnvironmentAction({
        backend: "codex", threadId: "thread-1", runId: runId!, mode: "stop",
      });
      expect(stop).toHaveBeenCalledWith(runId, "stop");
      expect((await readRuntime())?.actionRuns?.[0]?.terminationMode).toBe("stop");
      commandParams?.onDetachedExit?.({ exitCode: 0, exitSignal: null, durationMs: 100, output: "booting\nready\nstopped" });
      await expectEventually(async () => (await readRuntime())?.actionRuns?.[0]?.status, "exited");
      expect((await readRuntime())?.actionRuns?.[0]).toMatchObject({ runId, output: "booting\nready\nstopped", exitCode: 0 });
      expect((await readRuntime())?.environmentId).toBe(environmentId);
    } finally {
      stop.mockRestore();
      await registry.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("restores an ambiguously failed detached action to running when output continues", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-thread-env-live-output-"));
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-1": {
          backend: "codex",
          threadId: "thread-1",
          executionMode: "default",
          extraLinkedDirectories: [],
          codexEnvironmentRuntime: {
            environmentId: "environment",
            environmentName: "PwrAgnt",
            executionTarget: "local",
            cwd: root,
            actions: [
              {
                id: "dev",
                name: "Dev",
                command: "pnpm dev",
              },
            ],
          },
        },
      },
    });
    let commandParams: Parameters<CodexEnvironmentCommandRunner>[0] | undefined;
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/list"] },
        threads: [],
      }),
      overlayStore,
      codexEnvironmentCommandRunner: vi.fn(async (params) => {
        commandParams = params;
        return { pid: 12345 };
      }),
    });

    try {
      const response = await registry.runCodexEnvironmentAction({
        backend: "codex",
        threadId: "thread-1",
        actionId: "dev",
      });
      const runId = response.codexEnvironmentRuntime?.actionRuns?.[0]?.runId;
      expect(runId).toBeTruthy();
      expect(commandParams).toBeTruthy();

      commandParams?.onDetachedOutput?.({ output: "booting" });
      await expectEventually(
        async () =>
          (
            await overlayStore.getThreadOverlayState({
              backend: "codex",
              threadId: "thread-1",
            })
          )?.codexEnvironmentRuntime?.actionRuns?.[0]?.output,
        "booting",
      );

      commandParams?.onDetachedExit?.({
        exitCode: null,
        exitSignal: null,
        durationMs: 7_000,
        output: "booting",
      });
      await expectEventually(
        async () =>
          (
            await overlayStore.getThreadOverlayState({
              backend: "codex",
              threadId: "thread-1",
            })
          )?.codexEnvironmentRuntime?.actionRuns?.[0]?.status,
        "failed",
      );

      commandParams?.onDetachedOutput?.({ output: "booting\nready" });
      await expectEventually(
        async () =>
          (
            await overlayStore.getThreadOverlayState({
              backend: "codex",
              threadId: "thread-1",
            })
          )?.codexEnvironmentRuntime?.actionRuns?.[0]?.status,
        "started",
      );
      const overlay = await overlayStore.getThreadOverlayState({
        backend: "codex",
        threadId: "thread-1",
      });
      const run = overlay?.codexEnvironmentRuntime?.actionRuns?.[0];
      expect(run).toMatchObject({
        runId,
        status: "started",
        output: "booting\nready",
      });
      expect(run?.durationMs).toBeUndefined();
      expect(run?.exitedAt).toBeUndefined();
      expect(run?.exitCode).toBeUndefined();
      expect(run?.exitSignal).toBeUndefined();
    } finally {
      await registry.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("attributes output to the right run when two env actions run concurrently on the same thread", async () => {
    // Multi-instance regression test: Start + Test (or E2E + Unit) workflows
    // require independent run tracking, otherwise a second concurrent run
    // would overwrite the first's overlay entry and the first run's output
    // would disappear.
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-thread-env-parallel-"));
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-1": {
          backend: "codex",
          threadId: "thread-1",
          executionMode: "default",
          extraLinkedDirectories: [],
          codexEnvironmentRuntime: {
            environmentId: "environment",
            environmentName: "PwrAgnt",
            executionTarget: "local",
            cwd: root,
            actions: [
              {
                id: "action-a",
                name: "Action A",
                command: "action-a-command",
              },
              {
                id: "action-b",
                name: "Action B",
                command: "action-b-command",
              },
            ],
          },
        },
      },
    });
    const commandParams: Array<Parameters<CodexEnvironmentCommandRunner>[0]> = [];
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/list"] },
        threads: [],
      }),
      overlayStore,
      codexEnvironmentCommandRunner: vi.fn(async (params) => {
        commandParams.push(params);
        return { pid: 12345 + commandParams.length };
      }),
    });

    try {
      // Fire both run requests without awaiting either, so the spawn paths
      // and their detached children interleave.
      const [resultA, resultB] = await Promise.all([
        registry.runCodexEnvironmentAction({
          backend: "codex",
          threadId: "thread-1",
          actionId: "action-a",
        }),
        registry.runCodexEnvironmentAction({
          backend: "codex",
          threadId: "thread-1",
          actionId: "action-b",
        }),
      ]);

      // Each invocation's return value should carry its own runId.
      const runIdA = resultA.codexEnvironmentRuntime?.actionRuns?.find(
        (run) => run.actionId === "action-a",
      )?.runId;
      const runIdB = resultB.codexEnvironmentRuntime?.actionRuns?.find(
        (run) => run.actionId === "action-b",
      )?.runId;
      expect(runIdA).toBeTruthy();
      expect(runIdB).toBeTruthy();
      expect(runIdA).not.toBe(runIdB);

      const paramsA = commandParams.find(
        (params) => params.command === "action-a-command",
      );
      const paramsB = commandParams.find(
        (params) => params.command === "action-b-command",
      );
      expect(paramsA).toBeTruthy();
      expect(paramsB).toBeTruthy();

      // Interleave the injected lifecycle callbacks after both runs exist.
      // This exercises run-id attribution without making a unit test launch
      // competing Git Bash/PowerShell process trees.
      paramsA?.onDetachedOutput?.({ output: "A-output-marker" });
      paramsB?.onDetachedOutput?.({ output: "B-output-marker" });
      paramsB?.onDetachedExit?.({
        exitCode: 0,
        exitSignal: null,
        durationMs: 200,
        output: "B-output-marker",
      });
      paramsA?.onDetachedExit?.({
        exitCode: 0,
        exitSignal: null,
        durationMs: 250,
        output: "A-output-marker",
      });

      const deadline = Date.now() + 10_000;
      let lastSnapshot: ReadonlyArray<unknown> | undefined;
      let lastError: string | undefined;
      while (Date.now() < deadline) {
        const overlay = await overlayStore.getThreadOverlayState({
          backend: "codex",
          threadId: "thread-1",
        });
        const runs = overlay?.codexEnvironmentRuntime?.actionRuns ?? [];
        lastSnapshot = runs;
        const a = runs.find((run) => run.actionId === "action-a");
        const b = runs.find((run) => run.actionId === "action-b");
        if (
          a?.status === "exited" &&
          b?.status === "exited" &&
          a.output?.includes("A-output-marker") &&
          !a.output.includes("B-output-marker") &&
          b.output?.includes("B-output-marker") &&
          !b.output.includes("A-output-marker")
        ) {
          // Sanity-check the runId attribution: each invocation's return
          // value's run should match the overlay's persisted entry.
          expect(a.runId).toBe(runIdA);
          expect(b.runId).toBe(runIdB);
          return;
        }
        lastError = `a.status=${a?.status} b.status=${b?.status} a.output=${JSON.stringify(a?.output)} b.output=${JSON.stringify(b?.output)}`;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(
        `concurrent runs did not settle in time. last snapshot: ${JSON.stringify(lastSnapshot)} (${lastError ?? "no probe"})`,
      );
    } finally {
      await registry.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("cleans up prior-session env-action runs on startup", async () => {
    // Before the cleanup pass: an overlay row from a previous app launch
    // carries a "started" run that's effectively a zombie (the child died
    // when the parent exited) plus completed runs whose ~36KB outputs no
    // longer matter. After construction, those should be normalised:
    // zombies become "failed" with output dropped; finished runs keep
    // status but lose their stored output.
    const fakeSessionStart = Date.now();
    const longAgo = fakeSessionStart - 60_000; // 1 minute before this session
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-zombie": {
          backend: "codex",
          threadId: "thread-zombie",
          executionMode: "default",
          extraLinkedDirectories: [],
          codexEnvironmentRuntime: {
            environmentId: "environment",
            environmentName: "PwrAgnt",
            executionTarget: "local",
            cwd: "/tmp/x",
            actions: [],
            actionRuns: [
              {
                runId: "old-zombie",
                actionId: "dev",
                actionName: "Dev",
                command: "pnpm dev",
                status: "started",
                startedAt: longAgo,
                pid: 12345,
                output: "a lot of stale output bytes that nobody will read",
              },
            ],
          },
        },
        "codex:thread-finished": {
          backend: "codex",
          threadId: "thread-finished",
          executionMode: "default",
          extraLinkedDirectories: [],
          codexEnvironmentRuntime: {
            environmentId: "environment",
            environmentName: "PwrAgnt",
            executionTarget: "local",
            cwd: "/tmp/y",
            actions: [],
            actionRuns: [
              {
                runId: "old-exited",
                actionId: "test",
                actionName: "Test",
                command: "pnpm test",
                status: "exited",
                startedAt: longAgo,
                exitedAt: longAgo + 5_000,
                exitCode: 0,
                durationMs: 5_000,
                output: "build done\nready\n…lots more bytes…",
              },
            ],
          },
        },
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/list"] },
        threads: [],
      }),
      overlayStore,
    });

    try {
      // The cleanup runs fire-and-forget in the constructor; poll until
      // the persisted overlay reflects the post-cleanup shape.
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const zombie = await overlayStore.getThreadOverlayState({
          backend: "codex",
          threadId: "thread-zombie",
        });
        const finished = await overlayStore.getThreadOverlayState({
          backend: "codex",
          threadId: "thread-finished",
        });
        const zombieRun = zombie?.codexEnvironmentRuntime?.actionRuns?.[0];
        const finishedRun = finished?.codexEnvironmentRuntime?.actionRuns?.[0];
        if (
          zombieRun?.status === "failed" &&
          zombieRun.output === undefined &&
          finishedRun?.status === "exited" &&
          finishedRun.output === undefined
        ) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error("startup cleanup did not normalise overlays in time");
    } finally {
      await registry.close();
    }
  });

  it("converts started env-action runs to failed even when timestamps are 0 or missing (legacy-synthesised data)", async () => {
    // Reproduces the PwrAgent-killed-by-Computer-Use regression: an
    // overlay row from a pre-actionStartedAt build (or any data where
    // synthesis produces startedAt=0) used to slip past the
    // timestamp-gated cleanup, then slip past the renderer's
    // session-start filter, leaving the user with a perpetual
    // "running" anchor and no Dismiss control. The fix is to convert
    // any "started" run unconditionally — by lifecycle, anything we
    // didn't start in this process lifetime is a zombie.
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-zombie-legacy": {
          backend: "codex",
          threadId: "thread-zombie-legacy",
          executionMode: "default",
          extraLinkedDirectories: [],
          codexEnvironmentRuntime: {
            environmentId: "environment",
            environmentName: "PwrAgnt",
            executionTarget: "local",
            cwd: "/tmp/x",
            actions: [],
            actionRuns: [
              {
                runId: "legacy:dev:0",
                actionId: "dev",
                actionName: "Dev",
                command: "pnpm dev",
                status: "started",
                startedAt: 0, // legacy-synthesised
                pid: 72685,
                output: "lots of stale bytes",
              },
            ],
          },
        },
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/list"] },
        threads: [],
      }),
      overlayStore,
    });

    try {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const overlay = await overlayStore.getThreadOverlayState({
          backend: "codex",
          threadId: "thread-zombie-legacy",
        });
        const run = overlay?.codexEnvironmentRuntime?.actionRuns?.[0];
        if (run?.status === "failed" && run.output === undefined) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error("cleanup did not convert legacy zombie run in time");
    } finally {
      await registry.close();
    }
  });

  it("leaves current-session env-action runs untouched on startup", async () => {
    // Negative case: a run whose startedAt is >= the registry's session
    // start (which is captured at construction) must survive the cleanup
    // pass intact. This guards against the cleanup accidentally clobbering
    // runs that the auto-action emitted during the same session.
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-1": {
          backend: "codex",
          threadId: "thread-1",
          executionMode: "default",
          extraLinkedDirectories: [],
          codexEnvironmentRuntime: {
            environmentId: "environment",
            environmentName: "PwrAgnt",
            executionTarget: "local",
            cwd: "/tmp/x",
            actions: [],
            // startedAt set well into the future so the cleanup is
            // guaranteed to see this run as "fresh this session" no
            // matter when the test executes.
            actionRuns: [
              {
                runId: "fresh-run",
                actionId: "dev",
                actionName: "Dev",
                command: "pnpm dev",
                status: "started",
                startedAt: Date.now() + 60_000,
                pid: 99999,
                output: "important live output",
              },
            ],
          },
        },
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({
        initializeResult: { methods: ["thread/list"] },
        threads: [],
      }),
      overlayStore,
    });

    try {
      // Wait long enough for the cleanup pass to run.
      await new Promise((resolve) => setTimeout(resolve, 100));
      const overlay = await overlayStore.getThreadOverlayState({
        backend: "codex",
        threadId: "thread-1",
      });
      const run = overlay?.codexEnvironmentRuntime?.actionRuns?.[0];
      expect(run?.status).toBe("started");
      expect(run?.output).toBe("important live output");
    } finally {
      await registry.close();
    }
  });

  it("captures Codex environment setup output in the thread replay", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-launchpad-env-"));
    const environmentsDir = path.join(root, ".codex", "environments");
    await mkdir(environmentsDir, { recursive: true });
    await writeFile(
      path.join(environmentsDir, "environment.toml"),
      `
version = 1
name = "Repo Environment"

[setup]
script = "printf setup-output"
`,
      "utf8",
    );

    const overlayStore = createOverlayStoreMock();
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start"] },
    });
    const commandRunner: CodexEnvironmentCommandRunner = vi.fn(async (params) => {
      expect(params).toMatchObject({
        // The real GitDirectoryService forward-slashes the prepared workspace
        // cwd it returns (no-op on POSIX). The setup command runs from that
        // normalized cwd, so the expected value must be slash-flipped too.
        cwd: root.replace(/\\/g, "/"),
        command: "printf setup-output",
        mode: "wait",
      });
      params.onProgress?.({
        phase: "stdout",
        chunk: "setup-output",
        at: Date.now(),
      });
      return {
        durationMs: 4,
        exitCode: 0,
        output: "setup-output",
      };
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      codexEnvironmentCommandRunner: commandRunner,
      overlayStore,
    });

    try {
      await registry.materializeDirectoryLaunchpad({
        directoryKey: `directory:${root}`,
        launchpad: {
          directoryKey: `directory:${root}`,
          directoryKind: "directory",
          directoryLabel: "repo",
          directoryPath: root,
          backend: "codex",
          executionMode: "default",
          prompt: "",
          workMode: "local",
          model: "gpt-5.5",
          reasoningEffort: "high",
          codexEnvironmentId: "environment",
          codexEnvironmentExecutionTarget: "local",
          createdAt: 1_000,
          updatedAt: 2_000,
        },
      });

      const read = await registry.readThread({
        backend: "codex",
        threadId: "thread-1",
      });
      expect(read.replay.entries[0]).toMatchObject({
        type: "activity",
        createdAt: expect.any(Number),
        summary: "Environment setup completed: Repo Environment",
        details: [
          {
            command: {
              output: expect.stringContaining("setup-output"),
              exitCode: 0,
            },
          },
        ],
      });
      expect(commandRunner).toHaveBeenCalledTimes(1);
    } finally {
      await registry.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("reruns selected Codex environment setup when forking into a new worktree", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-fork-env-setup-"));
    const repoPath = path.join(root, "repo");
    const worktreePath = path.join(root, "worktree");
    await mkdir(path.join(worktreePath, ".codex", "environments"), { recursive: true });
    await writeFile(
      path.join(worktreePath, ".codex", "environments", "environment.toml"),
      `
version = 1
name = "PwrAgnt"

[setup]
script = "printf setup"

[[actions]]
name = "Dev"
command = "pnpm dev"
`,
      "utf8",
    );

    const commandRunner: CodexEnvironmentCommandRunner = vi.fn(async (params) => {
      expect(params).toMatchObject({
        cwd: worktreePath,
        command: "printf setup",
        mode: "wait",
        captureShellEnvironment: true,
      });
      return {
        durationMs: 5,
        exitCode: 0,
        output: "setup",
        shellEnvironment: {
          PATH: `${worktreePath}/.venv/bin:/usr/bin`,
          VIRTUAL_ENV: `${worktreePath}/.venv`,
        },
      };
    });
    const sourceRuntime: CodexThreadEnvironmentRuntime = {
      environmentId: "environment",
      environmentName: "PwrAgnt",
      executionTarget: "local",
      cwd: repoPath,
      setupStatus: "completed",
      setupCommand: "printf setup",
      shellEnvironment: {
        PATH: `${repoPath}/.venv/bin:/usr/bin`,
        VIRTUAL_ENV: `${repoPath}/.venv`,
      },
      selectedActionIdByEnvironmentId: {
        environment: "dev",
      },
      actions: [
        {
          id: "dev",
          name: "Dev",
          command: "pnpm dev",
        },
      ],
    };
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-parent": {
          backend: "codex",
          threadId: "thread-parent",
          executionMode: "default",
          codexEnvironmentRuntime: sourceRuntime,
          extraLinkedDirectories: [],
        },
      },
    });
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/fork"] },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      codexEnvironmentCommandRunner: commandRunner,
      overlayStore,
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
        workMode: "worktree",
      });

      expect(commandRunner).toHaveBeenCalledTimes(1);
      expect(codexClient.lastForkThreadParams?.codexEnvironmentRuntime).toMatchObject({
        environmentId: "environment",
        cwd: worktreePath,
        setupStatus: "completed",
        shellEnvironment: {
          PATH: `${worktreePath}/.venv/bin:/usr/bin`,
          VIRTUAL_ENV: `${worktreePath}/.venv`,
        },
        selectedActionIdByEnvironmentId: {
          environment: "dev",
        },
      });
      expect(
        codexClient.lastForkThreadParams?.codexEnvironmentRuntime?.shellEnvironment
          ?.VIRTUAL_ENV,
      ).not.toBe(`${repoPath}/.venv`);
      expect(response.codexEnvironmentRuntime).toEqual(
        codexClient.lastForkThreadParams?.codexEnvironmentRuntime,
      );
    } finally {
      await registry.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("keeps failed environment setup worktree threads registered without starting the turn", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-env-failure-"));
    const repoPath = path.join(root, "repo");
    const worktreePath = path.join(root, "worktree");
    await mkdir(path.join(repoPath, ".codex", "environments"), { recursive: true });
    await mkdir(worktreePath, { recursive: true });
    await writeFile(
      path.join(repoPath, ".codex", "environments", "environment.toml"),
      `
version = 1
name = "Broken Env"

[setup]
script = "printf setup-failed && exit 42"
`,
      "utf8",
    );

    const recordCodexWorktreeOwnerThread = vi.fn(async () => {});
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start", "turn/start"] },
      startTurnErrors: [new Error("temporary start failure"), undefined],
    });
    const commandRunner: CodexEnvironmentCommandRunner = vi.fn(async (params) => {
      expect(params).toMatchObject({
        cwd: worktreePath,
        command: "printf setup-failed && exit 42",
        mode: "wait",
      });
      throw new CodexEnvironmentCommandError(
        "Codex environment command exited with 42",
        {
          durationMs: 3,
          exitCode: 42,
          output: "setup-failed",
        },
      );
    });
    const pendingDirectory = path.join(root, "pending-launches");
    const acknowledgeThreadEnvironmentFailure = vi.fn(async () => true);
    const overlayStore = { ...createOverlayStoreMock(), acknowledgeThreadEnvironmentFailure };
    const registry = createDesktopBackendRegistry({
      pendingEnvironmentLaunchStore: new PendingEnvironmentLaunchStore(pendingDirectory),
      codexClient,
      codexEnvironmentCommandRunner: commandRunner,
      overlayStore,
      gitDirectoryService: {
        prepareLaunchpadWorkspace: vi.fn(async () => ({
          cwd: worktreePath,
          workMode: "worktree" as const,
        })),
        recordCodexWorktreeOwnerThread,
      } as never,
    });

    try {
      const response = await registry.materializeDirectoryLaunchpad({
        directoryKey: `directory:${repoPath}`,
        input: [{ type: "text", text: "start after setup" }],
        launchpad: {
          directoryKey: `directory:${repoPath}`,
          directoryKind: "directory",
          directoryLabel: "repo",
          directoryPath: repoPath,
          backend: "codex",
          executionMode: "default",
          prompt: "",
          workMode: "worktree",
          model: "gpt-5.5",
          reasoningEffort: "high",
          codexEnvironmentId: "environment",
          // Deprecated persisted flag must not suppress config-driven setup.
          codexEnvironmentSetupEnabled: false,
          createdAt: 1_000,
          updatedAt: 2_000,
        },
      });

      expect(response.threadId).toBe("thread-1");
      expect(response.turnId).toBeUndefined();
      expect(response.codexEnvironmentStartupFailure).toMatchObject({
        message: expect.stringContaining("Codex environment command exited with 42"),
        phase: "setup",
        worktreeCleanupAvailable: true,
      });
      expect(response.codexEnvironmentRuntime).toMatchObject({
        environmentName: "Broken Env",
        setupStatus: "failed",
        setupExitCode: 42,
        setupOutput: expect.stringContaining("setup-failed"),
      });
      expect(commandRunner).toHaveBeenCalledTimes(1);
      expect(recordCodexWorktreeOwnerThread).toHaveBeenCalledWith({
        worktreePath,
        threadId: "thread-1",
      });
      expect(codexClient.lastStartTurnParams).toBeUndefined();
      // A fresh registry and store model an owner restart. The viewer supplies
      // only a thread identity; the owner recovers the original request.
      const recovered = createDesktopBackendRegistry({
        codexClient,
        overlayStore,
        pendingEnvironmentLaunchStore: new PendingEnvironmentLaunchStore(pendingDirectory),
      });
      try {
        const request = { backend: "codex" as const, threadId: response.threadId };
        await expect(recovered.continueThreadEnvironmentStartup(request)).rejects.toThrow("temporary start failure");
        expect(acknowledgeThreadEnvironmentFailure).not.toHaveBeenCalled();
        expect(new PendingEnvironmentLaunchStore(pendingDirectory).get(request)?.request.input)
          .toEqual([{ type: "text", text: "start after setup" }]);
        const [first, second] = await Promise.all([
          recovered.continueThreadEnvironmentStartup(request),
          recovered.continueThreadEnvironmentStartup(request),
        ]);
        expect(first.turnId).toBe("turn-1");
        expect(second).toEqual(first);
        expect(codexClient.startTurnCallCount).toBe(2);
        expect(codexClient.lastStartTurnParams).toMatchObject({
          input: [{ type: "text", text: "start after setup" }],
          model: "gpt-5.5",
          reasoningEffort: "high",
        });
        expect(commandRunner).toHaveBeenCalledTimes(1);
        expect(acknowledgeThreadEnvironmentFailure).toHaveBeenCalledOnce();
        expect(new PendingEnvironmentLaunchStore(pendingDirectory).get(request)).toBeUndefined();
      } finally {
        await recovered.close();
      }

    } finally {
      await registry.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("passes persisted Codex environment hydration when starting turns", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["turn/start"] },
    });
    const codexEnvironmentRuntime: CodexThreadEnvironmentRuntime = {
      environmentId: "env",
      environmentName: "Env",
      executionTarget: "local",
      shellEnvironment: {
        PATH: "/Users/fixture-user/.nvm/versions/node/v24.14.1/bin:/usr/bin",
        NVM_DIR: "/Users/fixture-user/.nvm",
      },
    };
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock({
        overlays: {
          "codex:thread-env": {
            backend: "codex",
            threadId: "thread-env",
            executionMode: "default",
            codexEnvironmentRuntime,
            extraLinkedDirectories: [],
          },
        },
      }),
    });

    await registry.startTurn({
      backend: "codex",
      threadId: "thread-env",
      input: [{ type: "text", text: "Use hydrated environment" }],
    });

    expect(codexClient.lastStartTurnParams).toMatchObject({
      threadId: "thread-env",
      codexEnvironmentRuntime,
    });

    await registry.close();
  });
});

describe("DesktopBackendRegistry agent-created thread environments", () => {
  const ENVIRONMENT_TOML = `
version = 1
name = "PwrAgent"

[setup]
script = "pnpm install"

[[actions]]
name = "Dev"
command = "pnpm dev"
`;

  async function environmentProject(prefix: string) {
    const root = await mkdtemp(path.join(os.tmpdir(), prefix));
    const repoPath = path.join(root, "repo");
    const worktreePath = path.join(root, "worktree");
    try {
      await mkdir(repoPath, { recursive: true });
      await git(repoPath, ["init", "-b", "main"]);
    } catch {
      await git(repoPath, ["init"]);
      await git(repoPath, ["checkout", "-b", "main"]);
    }
    await writeFile(path.join(repoPath, "README.md"), "handoff\n", "utf8");
    await git(repoPath, ["add", "README.md"]);
    await git(repoPath, ["commit", "-m", "initial"]);
    // The worktree is a checkout of the repository, so both carry the config.
    for (const directory of [repoPath, worktreePath]) {
      await mkdir(path.join(directory, ".codex", "environments"), { recursive: true });
      await writeFile(
        path.join(directory, ".codex", "environments", "pwragent.toml"),
        ENVIRONMENT_TOML,
        "utf8",
      );
    }
    return { root, repoPath, worktreePath };
  }

  function claudeFixtureOptions(root: string, optionsSeen: ClaudeOptions[]) {
    return {
      store: new ClaudeSessionStore(path.join(root, "sessions")),
      getSessionInfo: vi.fn().mockResolvedValue(undefined),
      inspectInstallation: async () => ({ executable: "/fixture/claude", version: "2.1.330", authStatus: "signed-in" as const }),
      discoverModels: async () => [{ id: "fable", label: "Fable 5.1", current: true }],
      query: ({ options = {} }: { options?: ClaudeOptions }) => {
        optionsSeen.push(options);
        async function* messages(): AsyncGenerator<ClaudeMessage> {
          yield { type: "system", subtype: "init", session_id: options.sessionId ?? options.resume } as ClaudeMessage;
          yield { type: "result", subtype: "success", is_error: false, result: "Done" } as ClaudeMessage;
        }
        return Object.assign(messages(), { close: vi.fn(), setPermissionMode: vi.fn() }) as unknown as ClaudeQuery;
      },
    };
  }

  async function environmentHandoffFixture(params: {
    prefix: string;
    sourceRuntime?: CodexThreadEnvironmentRuntime;
    commandRunner?: (worktreePath: string) => CodexEnvironmentCommandRunner;
  }) {
    const project = await environmentProject(params.prefix);
    const { root, repoPath, worktreePath } = project;
    const commandRunner = vi.fn(params.commandRunner?.(worktreePath) ?? (async () => ({
      durationMs: 5,
      exitCode: 0,
      output: "installed",
      shellEnvironment: {
        PATH: `${worktreePath}/node_modules/.bin:/usr/bin`,
        NVM_DIR: "/fixture/nvm",
      },
    })));
    const prepareLaunchpadWorkspace = vi.fn(async () => ({
      cwd: worktreePath,
      repositoryPath: repoPath,
      workMode: "worktree" as const,
    }));
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
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:ordinary-thread": {
          backend: "codex",
          threadId: "ordinary-thread",
          executionMode: "full-access",
          ...(params.sourceRuntime ? { codexEnvironmentRuntime: params.sourceRuntime } : {}),
          extraLinkedDirectories: [linkedDirectory],
        },
      },
    });
    const claudeOptionsSeen: ClaudeOptions[] = [];
    const registry = createDesktopBackendRegistry({
      codexClient,
      codexEnvironmentCommandRunner: commandRunner,
      gitDirectoryService: {
        inspectWorkspaceGit: vi.fn(async (cwd: string) => ({
          kind: "worktree" as const,
          branch: cwd === worktreePath ? "HEAD" : "main",
          hasCommits: true,
          headHasCommit: true,
          worktreeCreationAvailable: true,
        })),
        prepareLaunchpadWorkspace,
        recordCodexWorktreeOwnerThread: vi.fn(async () => {}),
        resolvePrimaryWorkspacePath: vi.fn(async (cwd: string) => cwd),
      } as never,
      overlayStore,
      pdfToolMcpServer: null,
      threadTitleGenerationService: null,
      claudeBackendOptions: claudeFixtureOptions(root, claudeOptionsSeen),
    });
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: { threadId: "ordinary-thread", turnId: "turn-1", turn: { id: "turn-1" } },
      },
    });
    const handoff = async (args: Record<string, unknown>) => {
      const response = await codexClient.emitRequest({
        method: "item/tool/call",
        params: {
          threadId: "ordinary-thread",
          turnId: "turn-1",
          callId: "call-1",
          requestId: "call-1",
          namespace: "pwragent",
          tool: "handoff_task",
          arguments: { task: "Fix the recorder crash.", workspaceMode: "new_worktree", ...args },
        },
      } as AppServerPendingRequestNotification);
      return {
        response,
        payload: JSON.parse(
          (response as { contentItems: Array<{ text: string }> }).contentItems[0]!.text,
        ),
      };
    };
    const cleanup = async () => {
      await registry.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    };
    return {
      ...project,
      claudeOptionsSeen,
      cleanup,
      codexClient,
      commandRunner,
      handoff,
      overlayStore,
      prepareLaunchpadWorkspace,
      registry,
    };
  }

  const parentRuntime = (cwd: string): CodexThreadEnvironmentRuntime => ({
    environmentId: "pwragent",
    environmentName: "PwrAgent",
    executionTarget: "local",
    cwd,
    setupStatus: "completed",
    setupCommand: "pnpm install",
    shellEnvironment: { PATH: `${cwd}/node_modules/.bin:/usr/bin` },
  });

  it("runs a named environment's setup in a Claude handoff child's new worktree", async () => {
    const fixture = await environmentHandoffFixture({ prefix: "pwragent-handoff-env-claude-" });
    try {
      const { response, payload } = await fixture.handoff({ backend: "claude", environment: "PwrAgent" });

      expect(response).toMatchObject({ success: true });
      expect(fixture.commandRunner).toHaveBeenCalledTimes(1);
      expect(fixture.commandRunner).toHaveBeenCalledWith(expect.objectContaining({
        cwd: fixture.worktreePath,
        command: "pnpm install",
        captureShellEnvironment: true,
      }));
      expect(payload.backend).toBe("claude");
      expect(payload.environment).toEqual({
        source: "requested",
        requested: "PwrAgent",
        environmentId: "pwragent",
        environmentName: "PwrAgent",
        setup: "completed",
        setupExitCode: 0,
        setupDurationMs: 5,
        message: "Started with environment PwrAgent (pwragent). Setup completed in the child's workspace.",
      });
      await expect(fixture.overlayStore.getThreadOverlayState({
        backend: "claude",
        threadId: payload.threadId,
      })).resolves.toMatchObject({
        codexEnvironmentRuntime: {
          environmentId: "pwragent",
          cwd: fixture.worktreePath,
          setupStatus: "completed",
          actions: [expect.objectContaining({ id: "dev", command: "pnpm dev" })],
          shellEnvironment: { NVM_DIR: "/fixture/nvm" },
        },
      });
      // The child's Claude process runs with the toolchain setup captured.
      await vi.waitFor(() => expect(fixture.claudeOptionsSeen).toHaveLength(1));
      expect(fixture.claudeOptionsSeen[0]!.cwd).toBe(fixture.worktreePath);
      expect(fixture.claudeOptionsSeen[0]!.env).toMatchObject({
        NVM_DIR: "/fixture/nvm",
        PATH: `${fixture.worktreePath}/node_modules/.bin:/usr/bin`,
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("gives a same-project Claude child the parent's environment when none is named", async () => {
    const fixture = await environmentHandoffFixture({ prefix: "pwragent-handoff-env-inherit-" });
    await fixture.overlayStore.setThreadCodexEnvironmentRuntime!({
      backend: "codex",
      threadId: "ordinary-thread",
      codexEnvironmentRuntime: parentRuntime(fixture.repoPath),
    });
    try {
      const { payload } = await fixture.handoff({ backend: "claude" });

      expect(fixture.commandRunner).toHaveBeenCalledWith(expect.objectContaining({
        cwd: fixture.worktreePath,
        command: "pnpm install",
      }));
      expect(payload.environment).toMatchObject({
        source: "inherited",
        environmentId: "pwragent",
        setup: "completed",
      });
      expect(payload.environment.requested).toBeUndefined();
      await expect(fixture.overlayStore.getThreadOverlayState({
        backend: "claude",
        threadId: payload.threadId,
      })).resolves.toMatchObject({
        codexEnvironmentRuntime: { environmentId: "pwragent", cwd: fixture.worktreePath },
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("does not give a cross-project child the parent's environment", async () => {
    const fixture = await environmentHandoffFixture({ prefix: "pwragent-handoff-env-cross-" });
    const other = await environmentProject("pwragent-handoff-env-other-");
    await fixture.overlayStore.setThreadCodexEnvironmentRuntime!({
      backend: "codex",
      threadId: "ordinary-thread",
      codexEnvironmentRuntime: parentRuntime(fixture.repoPath),
    });
    try {
      const { payload } = await fixture.handoff({ backend: "claude", cwd: other.repoPath });

      expect(fixture.commandRunner).not.toHaveBeenCalled();
      expect(payload.environment).toEqual({
        source: "none",
        message: "Started with no environment.",
      });
    } finally {
      await fixture.cleanup();
      await rm(other.root, { recursive: true, force: true });
    }
  });

  it("starts a handoff child with no environment when environment is none", async () => {
    const fixture = await environmentHandoffFixture({ prefix: "pwragent-handoff-env-none-" });
    await fixture.overlayStore.setThreadCodexEnvironmentRuntime!({
      backend: "codex",
      threadId: "ordinary-thread",
      codexEnvironmentRuntime: parentRuntime(fixture.repoPath),
    });
    try {
      const { payload } = await fixture.handoff({ environment: "none" });

      expect(fixture.commandRunner).not.toHaveBeenCalled();
      expect(fixture.codexClient.lastStartThreadParams?.codexEnvironmentRuntime).toBeUndefined();
      expect(payload.inheritedSettings.codexEnvironmentRuntime).toBeUndefined();
      expect(payload.environment).toEqual({
        source: "none",
        requested: "none",
        message: "Started with no environment.",
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("runs a named environment's setup before a Codex handoff child starts", async () => {
    const fixture = await environmentHandoffFixture({ prefix: "pwragent-handoff-env-codex-" });
    try {
      const { payload } = await fixture.handoff({ environment: "pwragent" });

      expect(fixture.codexClient.lastStartThreadParams?.codexEnvironmentRuntime).toMatchObject({
        environmentId: "pwragent",
        cwd: fixture.worktreePath,
        setupStatus: "completed",
        shellEnvironment: { NVM_DIR: "/fixture/nvm" },
      });
      expect(payload.environment).toMatchObject({
        source: "requested",
        requested: "pwragent",
        environmentId: "pwragent",
        setup: "completed",
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("runs a named environment's setup in a same-workspace child", async () => {
    const fixture = await environmentHandoffFixture({ prefix: "pwragent-handoff-env-local-" });
    try {
      const { payload } = await fixture.handoff({
        environment: "PwrAgent",
        workspaceMode: "project_local",
      });

      expect(fixture.prepareLaunchpadWorkspace).not.toHaveBeenCalled();
      expect(fixture.commandRunner).toHaveBeenCalledWith(expect.objectContaining({
        // The project checkout comes from the linked directory, which is
        // stored forward-slash normalized on every platform.
        cwd: expectedDir(fixture.repoPath),
        command: "pnpm install",
      }));
      expect(payload.environment).toMatchObject({ source: "requested", setup: "completed" });
    } finally {
      await fixture.cleanup();
    }
  });

  it("keeps an environment from an ACP child whose agent cannot load a session", async () => {
    const { root, repoPath, worktreePath } = await environmentProject("pwragent-handoff-env-acp-");
    const commandRunner = vi.fn(async () => ({ durationMs: 5, exitCode: 0, output: "installed" }));
    const linkedDirectory = {
      id: expectedDir(repoPath),
      kind: "local" as const,
      label: "repo",
      path: expectedDir(repoPath),
    };
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start", "thread/list", "turn/start"] },
      threads: [{
        id: "ordinary-thread",
        title: "Parent Thread",
        titleSource: "explicit",
        source: "codex",
        linkedDirectories: [linkedDirectory],
        updatedAt: 1000,
      }],
    });
    const { acpBackendId, registry } = createKimiAcpRegistry({
      codexClient,
      codexEnvironmentCommandRunner: commandRunner,
      runtimeCapabilities: { agentCapabilities: { loadSession: false } } as BackendAcpRuntimeCapabilities,
      overlayStore: createOverlayStoreMock({
        overlays: {
          "codex:ordinary-thread": {
            backend: "codex",
            threadId: "ordinary-thread",
            executionMode: "full-access",
            codexEnvironmentRuntime: parentRuntime(repoPath),
            extraLinkedDirectories: [linkedDirectory],
          },
        },
      }),
      gitDirectoryService: {
        inspectWorkspaceGit: vi.fn(async () => ({
          kind: "worktree" as const,
          branch: "main",
          hasCommits: true,
          headHasCommit: true,
          worktreeCreationAvailable: true,
        })),
        prepareLaunchpadWorkspace: vi.fn(async () => ({
          cwd: worktreePath,
          repositoryPath: repoPath,
          workMode: "worktree" as const,
        })),
        recordCodexWorktreeOwnerThread: vi.fn(async () => {}),
        resolvePrimaryWorkspacePath: vi.fn(async (cwd: string) => cwd),
      },
    });
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: { threadId: "ordinary-thread", turnId: "turn-1", turn: { id: "turn-1" } },
      },
    });
    const handoff = async (callId: string, args: Record<string, unknown>) => {
      const response = await codexClient.emitRequest({
        method: "item/tool/call",
        params: {
          threadId: "ordinary-thread",
          turnId: "turn-1",
          callId,
          requestId: callId,
          namespace: "pwragent",
          tool: "handoff_task",
          arguments: { task: "Fix the recorder crash.", backend: acpBackendId, ...args },
        },
      } as AppServerPendingRequestNotification);
      return JSON.parse((response as { contentItems: Array<{ text: string }> }).contentItems[0]!.text);
    };
    try {
      await expect(handoff("call-named", { environment: "PwrAgent" })).resolves.toEqual({
        code: "invalid_arguments",
        message: `backend="${acpBackendId}" cannot start with an environment, because its agent cannot reload a session. Pass environment="none", or choose another backend.`,
      });

      // Inheriting would fail the child's first turn, so the child starts without it.
      const inherited = await handoff("call-inherited", {});
      expect(commandRunner).not.toHaveBeenCalled();
      expect(inherited.inheritedSettings.codexEnvironmentRuntime).toBeUndefined();
      expect(inherited.environment).toEqual({
        source: "none",
        message: `Started with no environment: backend="${acpBackendId}" cannot start with an environment, because its agent cannot reload a session.`,
      });
    } finally {
      await registry.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("rejects an unknown handoff environment before creating a child", async () => {
    const fixture = await environmentHandoffFixture({ prefix: "pwragent-handoff-env-unknown-" });
    try {
      const { response, payload } = await fixture.handoff({ environment: "Docs" });

      expect(response).toMatchObject({ success: false });
      expect(payload).toEqual({
        code: "invalid_arguments",
        message:
          'Environment "Docs" is not defined in repo. Available environments: PwrAgent (pwragent). Pass environment="none" to start without one.',
      });
      expect(fixture.prepareLaunchpadWorkspace).not.toHaveBeenCalled();
      expect(fixture.codexClient.lastStartThreadParams).toBeUndefined();
    } finally {
      await fixture.cleanup();
    }
  });

  it("reports a failed handoff environment setup in the tool response", async () => {
    const fixture = await environmentHandoffFixture({
      prefix: "pwragent-handoff-env-failed-",
      commandRunner: () => async () => {
        throw new CodexEnvironmentCommandError("Codex environment command exited with 1", {
          durationMs: 7,
          exitCode: 1,
          output: "ERR_PNPM_NO_LOCKFILE",
        });
      },
    });
    try {
      const { response, payload } = await fixture.handoff({ backend: "claude", environment: "PwrAgent" });

      expect(response).toMatchObject({ success: true });
      expect(payload.codexEnvironmentStartupFailure).toMatchObject({ phase: "setup" });
      expect(payload.environment).toMatchObject({
        source: "requested",
        environmentId: "pwragent",
        setup: "failed",
        setupExitCode: 1,
        setupOutputTail: "ERR_PNPM_NO_LOCKFILE",
      });
      expect(payload.environment.message).toMatch(/^Environment PwrAgent \(pwragent\) setup failed/);
    } finally {
      await fixture.cleanup();
    }
  });

  it("starts a Claude launchpad thread with its environment set up in the new worktree", async () => {
    const { root, repoPath, worktreePath } = await environmentProject("pwragent-claude-launchpad-env-");
    const commandRunner = vi.fn(async () => ({
      durationMs: 5,
      exitCode: 0,
      output: "installed",
      shellEnvironment: { PATH: "/fixture/node/bin:/usr/bin", NVM_DIR: "/fixture/nvm" },
    }));
    const optionsSeen: ClaudeOptions[] = [];
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({}),
      codexEnvironmentCommandRunner: commandRunner,
      overlayStore: createOverlayStoreMock(),
      pdfToolMcpServer: null,
      threadTitleGenerationService: null,
      gitDirectoryService: {
        prepareLaunchpadWorkspace: vi.fn(async () => ({
          cwd: worktreePath,
          repositoryPath: repoPath,
          workMode: "worktree" as const,
        })),
        recordCodexWorktreeOwnerThread: vi.fn(async () => {}),
      } as never,
      claudeBackendOptions: claudeFixtureOptions(root, optionsSeen),
    });
    try {
      const response = await registry.materializeDirectoryLaunchpad({
        directoryKey: `directory:${repoPath}`,
        launchpad: {
          directoryKey: `directory:${repoPath}`,
          directoryKind: "directory",
          directoryLabel: "repo",
          directoryPath: repoPath,
          backend: "claude",
          executionMode: "default",
          prompt: "Fix the recorder crash.",
          workMode: "worktree",
          codexEnvironmentId: "pwragent",
          codexEnvironmentExecutionTarget: "local",
          createdAt: 1_000,
          updatedAt: 2_000,
        },
      });

      expect(commandRunner).toHaveBeenCalledWith(expect.objectContaining({
        cwd: worktreePath,
        command: "pnpm install",
      }));
      expect(response).toMatchObject({
        backend: "claude",
        workMode: "worktree",
        codexEnvironmentRuntime: { environmentId: "pwragent", cwd: worktreePath, setupStatus: "completed" },
      });
      expect(response.turnId).toEqual(expect.any(String));
      await vi.waitFor(() => expect(optionsSeen).toHaveLength(1));
      expect(optionsSeen[0]!.cwd).toBe(worktreePath);
      expect(optionsSeen[0]!.env).toMatchObject({ NVM_DIR: "/fixture/nvm", PATH: "/fixture/node/bin:/usr/bin" });
    } finally {
      await registry.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("runs Claude launchpad setup but withholds its variables when the profile turns them off", async () => {
    const { root, repoPath, worktreePath } = await environmentProject("pwragent-claude-launchpad-env-off-");
    const commandRunner = vi.fn(async () => ({
      durationMs: 5,
      exitCode: 0,
      output: "installed",
      shellEnvironment: { PATH: "/fixture/node/bin:/usr/bin", NVM_DIR: "/fixture/nvm" },
    }));
    const optionsSeen: ClaudeOptions[] = [];
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({}),
      codexEnvironmentCommandRunner: commandRunner,
      overlayStore: createOverlayStoreMock(),
      pdfToolMcpServer: null,
      threadTitleGenerationService: null,
      resolvePassSetupVariablesToAgents: () => false,
      gitDirectoryService: {
        prepareLaunchpadWorkspace: vi.fn(async () => ({
          cwd: worktreePath,
          repositoryPath: repoPath,
          workMode: "worktree" as const,
        })),
        recordCodexWorktreeOwnerThread: vi.fn(async () => {}),
      } as never,
      claudeBackendOptions: claudeFixtureOptions(root, optionsSeen),
    });
    try {
      await registry.materializeDirectoryLaunchpad({
        directoryKey: `directory:${repoPath}`,
        launchpad: {
          directoryKey: `directory:${repoPath}`,
          directoryKind: "directory",
          directoryLabel: "repo",
          directoryPath: repoPath,
          backend: "claude",
          executionMode: "default",
          prompt: "Fix the recorder crash.",
          workMode: "worktree",
          codexEnvironmentId: "pwragent",
          codexEnvironmentExecutionTarget: "local",
          createdAt: 1_000,
          updatedAt: 2_000,
        },
      });

      expect(commandRunner).toHaveBeenCalledWith(expect.objectContaining({
        cwd: worktreePath,
        command: "pnpm install",
      }));
      await vi.waitFor(() => expect(optionsSeen).toHaveLength(1));
      expect(optionsSeen[0]!.cwd).toBe(worktreePath);
      // Claude starts with PwrAgent's own environment, not the captured one.
      expect(optionsSeen[0]!.env?.NVM_DIR).not.toBe("/fixture/nvm");
      expect(optionsSeen[0]!.env?.PATH).not.toBe("/fixture/node/bin:/usr/bin");
    } finally {
      await registry.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("starts an ACP launchpad thread's first turn with its environment's shell variables", async () => {
    const { root, repoPath, worktreePath } = await environmentProject("pwragent-acp-launchpad-env-");
    const commandRunner = vi.fn(async () => ({
      durationMs: 5,
      exitCode: 0,
      output: "installed",
      shellEnvironment: { PATH: "/fixture/node/bin:/usr/bin", NVM_DIR: "/fixture/nvm" },
    }));
    const { acpBackendId, registry, startPrompt } = createKimiAcpRegistry({
      codexEnvironmentCommandRunner: commandRunner,
      gitDirectoryService: {
        prepareLaunchpadWorkspace: vi.fn(async () => ({
          cwd: worktreePath,
          repositoryPath: repoPath,
          workMode: "worktree" as const,
        })),
        recordCodexWorktreeOwnerThread: vi.fn(async () => {}),
      },
    });
    const prepareSessionEnvironment = vi
      .spyOn(
        (registry as unknown as { acpBackend: { prepareSessionEnvironment: (...args: unknown[]) => Promise<void> } }).acpBackend,
        "prepareSessionEnvironment",
      )
      .mockResolvedValue(undefined);
    try {
      const response = await registry.materializeDirectoryLaunchpad({
        directoryKey: `directory:${repoPath}`,
        launchpad: {
          directoryKey: `directory:${repoPath}`,
          directoryKind: "directory",
          directoryLabel: "repo",
          directoryPath: repoPath,
          backend: acpBackendId,
          executionMode: "default",
          prompt: "Fix the recorder crash.",
          workMode: "worktree",
          codexEnvironmentId: "pwragent",
          codexEnvironmentExecutionTarget: "local",
          createdAt: 1_000,
          updatedAt: 2_000,
        },
      });

      expect(commandRunner).toHaveBeenCalledWith(expect.objectContaining({ cwd: worktreePath }));
      expect(response.codexEnvironmentRuntime).toMatchObject({ environmentId: "pwragent", cwd: worktreePath });
      expect(response.turnId).toEqual(expect.any(String));
      expect(prepareSessionEnvironment).toHaveBeenCalledWith(
        acpBackendId,
        response.threadId,
        { PATH: "/fixture/node/bin:/usr/bin", NVM_DIR: "/fixture/nvm" },
      );
      expect(startPrompt).toHaveBeenCalled();
    } finally {
      await registry.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("runs ACP launchpad setup but starts the session without its variables when the profile turns them off", async () => {
    const { root, repoPath, worktreePath } = await environmentProject("pwragent-acp-launchpad-env-off-");
    const commandRunner = vi.fn(async () => ({
      durationMs: 5,
      exitCode: 0,
      output: "installed",
      shellEnvironment: { PATH: "/fixture/node/bin:/usr/bin", NVM_DIR: "/fixture/nvm" },
    }));
    const { acpBackendId, registry, startPrompt } = createKimiAcpRegistry({
      codexEnvironmentCommandRunner: commandRunner,
      resolvePassSetupVariablesToAgents: () => false,
      gitDirectoryService: {
        prepareLaunchpadWorkspace: vi.fn(async () => ({
          cwd: worktreePath,
          repositoryPath: repoPath,
          workMode: "worktree" as const,
        })),
        recordCodexWorktreeOwnerThread: vi.fn(async () => {}),
      },
    });
    const prepareSessionEnvironment = vi
      .spyOn(
        (registry as unknown as { acpBackend: { prepareSessionEnvironment: (...args: unknown[]) => Promise<void> } }).acpBackend,
        "prepareSessionEnvironment",
      )
      .mockResolvedValue(undefined);
    try {
      const response = await registry.materializeDirectoryLaunchpad({
        directoryKey: `directory:${repoPath}`,
        launchpad: {
          directoryKey: `directory:${repoPath}`,
          directoryKind: "directory",
          directoryLabel: "repo",
          directoryPath: repoPath,
          backend: acpBackendId,
          executionMode: "default",
          prompt: "Fix the recorder crash.",
          workMode: "worktree",
          codexEnvironmentId: "pwragent",
          codexEnvironmentExecutionTarget: "local",
          createdAt: 1_000,
          updatedAt: 2_000,
        },
      });

      expect(commandRunner).toHaveBeenCalledWith(expect.objectContaining({ cwd: worktreePath }));
      expect(prepareSessionEnvironment).toHaveBeenCalledWith(
        acpBackendId,
        response.threadId,
        undefined,
      );
      expect(startPrompt).toHaveBeenCalled();
    } finally {
      await registry.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("resolves an environment name on the owner when a launchpad request names one", async () => {
    const { root, repoPath, worktreePath } = await environmentProject("pwragent-launchpad-env-selector-");
    const commandRunner = vi.fn(async () => ({ durationMs: 5, exitCode: 0, output: "installed" }));
    const prepareLaunchpadWorkspace = vi.fn(async () => ({
      cwd: worktreePath,
      repositoryPath: repoPath,
      workMode: "worktree" as const,
    }));
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({ initializeResult: { methods: ["thread/start", "turn/start"] } }),
      codexEnvironmentCommandRunner: commandRunner,
      overlayStore: createOverlayStoreMock(),
      pdfToolMcpServer: null,
      threadTitleGenerationService: null,
      gitDirectoryService: {
        prepareLaunchpadWorkspace,
        recordCodexWorktreeOwnerThread: vi.fn(async () => {}),
      } as never,
    });
    const launchpad = {
      directoryKey: `directory:${repoPath}`,
      directoryKind: "directory" as const,
      directoryLabel: "repo",
      directoryPath: repoPath,
      backend: "codex" as const,
      executionMode: "default" as const,
      prompt: "",
      workMode: "worktree" as const,
      // An older owner reads only this field and matches it as an id.
      codexEnvironmentId: "PwrAgent",
      codexEnvironmentExecutionTarget: "local" as const,
      createdAt: 1_000,
      updatedAt: 2_000,
    };
    try {
      await expect(registry.materializeDirectoryLaunchpad({
        directoryKey: launchpad.directoryKey,
        launchpad,
        codexEnvironmentSelector: "PwrAgent",
      })).resolves.toMatchObject({
        codexEnvironmentRuntime: { environmentId: "pwragent", cwd: worktreePath, setupStatus: "completed" },
      });

      await expect(registry.materializeDirectoryLaunchpad({
        directoryKey: launchpad.directoryKey,
        launchpad: { ...launchpad, codexEnvironmentId: "Docs" },
        codexEnvironmentSelector: "Docs",
      })).rejects.toThrow(
        'Environment "Docs" is not defined in repo. Available environments: PwrAgent (pwragent). Pass environment="none" to start without one.',
      );
      expect(prepareLaunchpadWorkspace).toHaveBeenCalledTimes(1);
    } finally {
      await registry.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
