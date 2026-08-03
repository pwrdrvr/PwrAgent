import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyNavigationLaunchpadProviderSettingsPatch,
  type NavigationLaunchpadDraft,
} from "@pwragent/shared";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import {
  createTempStateDb,
  openInMemoryStateDb,
  removeTempStateDbDir,
} from "./sqlite-test-utils";

let stateDb: StateDb;
let store: SqliteOverlayStore;

beforeEach(() => {
  stateDb = openInMemoryStateDb();
  store = new SqliteOverlayStore(stateDb);
});

afterEach(() => {
  stateDb.close();
});

function listDefaultKeys(): string[] {
  return (
    stateDb.raw
      .prepare("SELECT key FROM launchpad_defaults ORDER BY key")
      .all() as { key: string }[]
  ).map((row) => row.key);
}

function readDefaultValue(key: string): unknown {
  const row = stateDb.raw
    .prepare("SELECT value FROM launchpad_defaults WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row ? JSON.parse(row.value) : undefined;
}

describe("SqliteOverlayStore - launchpad defaults", () => {
  it("persists and clears a thread's selected MCP connections", async () => {
    await store.setThreadMcpConnectionIds({
      backend: "acp:gemini",
      threadId: "thread-1",
      connectionIds: ["pwrsnap", " pwrsnap ", ""],
    });

    await expect(
      store.getThreadOverlayState({
        backend: "acp:gemini",
        threadId: "thread-1",
      }),
    ).resolves.toMatchObject({
      mcpConnectionIds: ["pwrsnap"],
    });

    await store.setThreadMcpConnectionIds({
      backend: "acp:gemini",
      threadId: "thread-1",
      connectionIds: [],
    });
    await expect(
      store.getThreadOverlayState({
        backend: "acp:gemini",
        threadId: "thread-1",
      }).then((overlay) => overlay?.mcpConnectionIds),
    ).resolves.toBeUndefined();
  });

  it("persists the selected navigation browse mode", async () => {
    const { dbPath, tempDir } = createTempStateDb(
      "pwragent-launchpad-defaults-test-",
    );
    stateDb.close();
    stateDb = StateDb.open(dbPath);
    store = new SqliteOverlayStore(stateDb);

    expect(store.getNavigationBrowseModeSync()).toBe("inbox");

    try {
      await expect(store.setNavigationBrowseMode("directories")).resolves.toBe(
        "directories",
      );
      await expect(store.getNavigationBrowseMode()).resolves.toBe("directories");
      stateDb.close();

      const reopenedDb = StateDb.open(dbPath);
      const reopenedStore = new SqliteOverlayStore(reopenedDb);
      try {
        expect(reopenedStore.getNavigationBrowseModeSync()).toBe("directories");
      } finally {
        reopenedDb.close();
      }
    } finally {
      stateDb.close();
      removeTempStateDbDir(tempDir);
      stateDb = openInMemoryStateDb();
      store = new SqliteOverlayStore(stateDb);
    }
  });

  it("does not persist Codex Fast serviceTier in launchpad defaults", async () => {
    const defaults = await store.setLaunchpadDefaults({
      model: "gpt-5.5",
      reasoningEffort: "medium",
      serviceTier: "priority",
      fastMode: true,
    });

    expect(defaults).toMatchObject({
      backend: "codex",
      executionMode: "default",
      model: "gpt-5.5",
      reasoningEffort: "medium",
      fastMode: true,
    });
    expect(defaults.serviceTier).toBeUndefined();
    expect(listDefaultKeys()).not.toContain("serviceTier");
  });

  it("removes legacy Fast serviceTier aliases from launchpad defaults", async () => {
    const defaults = await store.setLaunchpadDefaults({
      serviceTier: "fast",
      fastMode: true,
    });

    expect(defaults.fastMode).toBe(true);
    expect(defaults.serviceTier).toBeUndefined();
    expect(listDefaultKeys()).not.toContain("serviceTier");
  });

  it("turns Fast off across Codex threads, launchpads, and sticky defaults", async () => {
    await store.setThreadModelSettings({
      backend: "codex",
      threadId: "codex-fast",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      fastMode: true,
    });
    await store.setThreadModelSettings({
      backend: "acp:kimi",
      threadId: "kimi-thinking",
      model: "kimi-k2.6",
      reasoningEffort: "on",
      fastMode: true,
    });
    await store.setThreadModelSettings({
      backend: "codex",
      threadId: "codex-unset",
      model: "gpt-5.5",
      reasoningEffort: "high",
    });
    await store.upsertDirectoryLaunchpad({
      directoryKey: "directory:/codex",
      directoryKind: "directory",
      directoryLabel: "Codex",
      directoryPath: "/codex",
      backend: "codex",
      executionMode: "default",
      workMode: "local",
      prompt: "keep me",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      fastMode: true,
      createdAt: 1,
      updatedAt: 1,
    });
    await store.upsertDirectoryLaunchpad({
      directoryKey: "directory:/codex-unset",
      directoryKind: "directory",
      directoryLabel: "Codex unset",
      directoryPath: "/codex-unset",
      backend: "codex",
      executionMode: "default",
      workMode: "local",
      prompt: "do not touch me",
      model: "gpt-5.5",
      reasoningEffort: "high",
      createdAt: 1,
      updatedAt: 7,
    });
    await store.upsertDirectoryLaunchpad({
      directoryKey: "directory:/kimi",
      directoryKind: "directory",
      directoryLabel: "Kimi",
      directoryPath: "/kimi",
      backend: "acp:kimi",
      executionMode: "default",
      workMode: "local",
      prompt: "leave me alone",
      model: "kimi-k2.6",
      reasoningEffort: "on",
      createdAt: 1,
      updatedAt: 1,
    });
    await store.setLaunchpadDefaults({
      backend: "codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      fastMode: true,
      providerSettings: {
        codex: {
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
          fastMode: true,
        },
      },
    });

    await expect(store.turnOffCodexFastEverywhere()).resolves.toEqual({
      launchpadCount: 1,
      threadCount: 1,
      updatedThreadIds: ["codex-fast"],
    });
    await expect(store.getThreadOverlayState({
      backend: "codex",
      threadId: "codex-fast",
    })).resolves.toMatchObject({
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      fastMode: false,
    });
    await expect(store.getThreadOverlayState({
      backend: "codex",
      threadId: "codex-unset",
    })).resolves.toMatchObject({
      model: "gpt-5.5",
      reasoningEffort: "high",
    });
    expect(
      (
        await store.getThreadOverlayState({
          backend: "codex",
          threadId: "codex-unset",
        })
      )?.fastMode,
    ).toBeUndefined();
    await expect(store.getThreadOverlayState({
      backend: "acp:kimi",
      threadId: "kimi-thinking",
    })).resolves.toMatchObject({
      fastMode: true,
    });
    await expect(store.getDirectoryLaunchpad({
      directoryKey: "directory:/codex",
    })).resolves.toMatchObject({
      prompt: "keep me",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      fastMode: false,
    });
    await expect(store.getDirectoryLaunchpad({
      directoryKey: "directory:/codex-unset",
    })).resolves.toMatchObject({
      prompt: "do not touch me",
      model: "gpt-5.5",
      updatedAt: 7,
    });
    expect(
      (
        await store.getDirectoryLaunchpad({
          directoryKey: "directory:/codex-unset",
        })
      )?.fastMode,
    ).toBeUndefined();
    await expect(store.getDirectoryLaunchpad({
      directoryKey: "directory:/kimi",
    })).resolves.toMatchObject({
      prompt: "leave me alone",
      model: "kimi-k2.6",
    });
    const defaults = await store.getLaunchpadDefaults();
    expect(defaults.model).toBe("gpt-5.6-sol");
    expect(defaults.reasoningEffort).toBe("high");
    expect(defaults.fastMode).not.toBe(true);
    expect(defaults.providerSettings?.codex?.fastMode).not.toBe(true);
  });

  it("remembers launchpad reasoning effort per selected model", async () => {
    await store.setLaunchpadDefaults({
      model: "gpt-5.6-terra",
      reasoningEffort: "ultra",
    });
    await store.setLaunchpadDefaults({
      model: "gpt-5.6-luna",
      reasoningEffort: "medium",
    });

    const defaults = await store.setLaunchpadDefaults({
      model: "gpt-5.6-terra",
    });

    expect(defaults.reasoningEffort).toBe("ultra");
    expect(defaults.providerSettings?.codex?.reasoningEffortsByModel).toEqual({
      "gpt-5.6-luna": "medium",
      "gpt-5.6-terra": "ultra",
    });
    expect(readDefaultValue("providerSettings")).toMatchObject({
      codex: {
        reasoningEffortsByModel: {
          "gpt-5.6-luna": "medium",
          "gpt-5.6-terra": "ultra",
        },
      },
    });
  });

  it("persists provider-specific launchpad environments across a database reopen", async () => {
    const { dbPath, tempDir } = createTempStateDb(
      "pwragent-provider-launchpad-test-",
    );
    stateDb.close();
    stateDb = StateDb.open(dbPath);
    store = new SqliteOverlayStore(stateDb);

    const initialLaunchpad: NavigationLaunchpadDraft = {
      directoryKey: "directory:/repo",
      directoryKind: "directory",
      directoryLabel: "Repo",
      directoryPath: "/repo",
      backend: "codex",
      executionMode: "full-access",
      model: "gpt-5.6-sol",
      reasoningEffort: "ultra",
      fastMode: true,
      codexEnvironmentId: "codex-environment",
      codexEnvironmentExecutionTarget: "local",
      codexEnvironmentActionId: "codex-action",
      providerSettings: {
        codex: {
          executionMode: "full-access",
          model: "gpt-5.6-sol",
          reasoningEffort: "ultra",
          fastMode: true,
          codexEnvironmentId: "codex-environment",
          codexEnvironmentExecutionTarget: "local",
          codexEnvironmentActionId: "codex-action",
        },
        "acp:grok": {
          executionMode: "default",
          model: "grok-4.5",
          reasoningEffort: "high",
          serviceTier: "standard",
          acpRuntime: {
            currentModeId: "default",
          },
          codexEnvironmentId: "grok-environment",
          codexEnvironmentExecutionTarget: "local",
          codexEnvironmentActionId: "grok-action",
        },
      },
      prompt: "Keep the draft",
      workMode: "worktree",
      branchName: "feature/provider-memory",
      createdAt: 1,
      updatedAt: 1,
    };

    try {
      await store.upsertDirectoryLaunchpad(
        applyNavigationLaunchpadProviderSettingsPatch(initialLaunchpad, {
          backend: "acp:grok",
        }),
      );
      stateDb.close();

      const reopenedDb = StateDb.open(dbPath);
      const reopenedStore = new SqliteOverlayStore(reopenedDb);
      try {
        const restoredGrok = await reopenedStore.getDirectoryLaunchpad({
          directoryKey: "directory:/repo",
        });
        expect(restoredGrok).toMatchObject({
          backend: "acp:grok",
          executionMode: "default",
          model: "grok-4.5",
          reasoningEffort: "high",
          serviceTier: "standard",
          acpRuntime: {
            currentModeId: "default",
          },
          codexEnvironmentId: "grok-environment",
          codexEnvironmentExecutionTarget: "local",
          codexEnvironmentActionId: "grok-action",
          prompt: "Keep the draft",
          workMode: "worktree",
          branchName: "feature/provider-memory",
        });

        const restoredCodex = applyNavigationLaunchpadProviderSettingsPatch(
          restoredGrok!,
          { backend: "codex" },
        );
        expect(restoredCodex).toMatchObject({
          backend: "codex",
          executionMode: "full-access",
          model: "gpt-5.6-sol",
          reasoningEffort: "ultra",
          fastMode: true,
          codexEnvironmentId: "codex-environment",
          codexEnvironmentExecutionTarget: "local",
          codexEnvironmentActionId: "codex-action",
          prompt: "Keep the draft",
          workMode: "worktree",
          branchName: "feature/provider-memory",
        });
      } finally {
        reopenedDb.close();
      }
    } finally {
      stateDb.close();
      removeTempStateDbDir(tempDir);
      stateDb = openInMemoryStateDb();
      store = new SqliteOverlayStore(stateDb);
    }
  });

  it("removes stale launchpad default rows when a setting is cleared", async () => {
    stateDb.raw
      .prepare("INSERT OR REPLACE INTO launchpad_defaults(key, value) VALUES (?, ?)")
      .run("backend", JSON.stringify("codex"));
    stateDb.raw
      .prepare("INSERT OR REPLACE INTO launchpad_defaults(key, value) VALUES (?, ?)")
      .run("executionMode", JSON.stringify("default"));
    stateDb.raw
      .prepare("INSERT OR REPLACE INTO launchpad_defaults(key, value) VALUES (?, ?)")
      .run("serviceTier", JSON.stringify("fast"));
    stateDb.raw
      .prepare("INSERT OR REPLACE INTO launchpad_defaults(key, value) VALUES (?, ?)")
      .run("fastMode", JSON.stringify(false));
    stateDb.raw
      .prepare("INSERT OR REPLACE INTO launchpad_defaults(key, value) VALUES (?, ?)")
      .run(
        "providerSettings",
        JSON.stringify({
          codex: {
            executionMode: "default",
            serviceTier: "priority",
            fastMode: false,
          },
        }),
      );

    const readDefaults = await store.getLaunchpadDefaults();
    expect(readDefaults.fastMode).toBeUndefined();
    expect(readDefaults.serviceTier).toBeUndefined();
    expect(readDefaults.providerSettings?.codex?.fastMode).toBeUndefined();
    expect(readDefaults.providerSettings?.codex?.serviceTier).toBeUndefined();
    expect(listDefaultKeys()).toEqual([
      "backend",
      "executionMode",
      "providerSettings",
    ]);
    expect(readDefaultValue("providerSettings")).toEqual({
      codex: {
        executionMode: "default",
      },
    });

    await store.setLaunchpadDefaults({ fastMode: false, serviceTier: undefined });

    expect(listDefaultKeys()).toEqual([
      "backend",
      "executionMode",
      "providerSettings",
    ]);
    expect(readDefaultValue("providerSettings")).toEqual({
      codex: {
        executionMode: "default",
      },
    });
  });

  it("preserves unknown launchpad default keys while clearing owned keys", async () => {
    stateDb.raw
      .prepare("INSERT OR REPLACE INTO launchpad_defaults(key, value) VALUES (?, ?)")
      .run("backend", JSON.stringify("codex"));
    stateDb.raw
      .prepare("INSERT OR REPLACE INTO launchpad_defaults(key, value) VALUES (?, ?)")
      .run("executionMode", JSON.stringify("default"));
    stateDb.raw
      .prepare("INSERT OR REPLACE INTO launchpad_defaults(key, value) VALUES (?, ?)")
      .run("serviceTier", JSON.stringify("priority"));
    stateDb.raw
      .prepare("INSERT OR REPLACE INTO launchpad_defaults(key, value) VALUES (?, ?)")
      .run("futureExperimentalFlag", JSON.stringify({ enabled: true }));

    const defaults = await store.setLaunchpadDefaults({
      serviceTier: undefined,
      fastMode: false,
    });

    expect(defaults.serviceTier).toBeUndefined();
    expect(defaults.fastMode).toBeUndefined();
    expect(defaults).toMatchObject({
      futureExperimentalFlag: { enabled: true },
    });
    expect(readDefaultValue("serviceTier")).toBeUndefined();
    expect(readDefaultValue("fastMode")).toBeUndefined();
    expect(readDefaultValue("futureExperimentalFlag")).toEqual({ enabled: true });
  });
});
