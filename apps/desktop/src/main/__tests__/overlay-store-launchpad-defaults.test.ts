import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyNavigationLaunchpadProviderSettingsPatch,
  type NavigationLaunchpadDraft,
} from "@pwragent/shared";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
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
  it("replaces directory and learned model choices, including an inactive provider", async () => {
    const codex = { model: "gpt-6-sol", reasoningEffortsByModel: { "gpt-6-sol": "high" } };
    const next = { model: "gpt-6.1-sol", reasoningEffortsByModel: { "gpt-6.1-sol": "low" } };
    await store.setLaunchpadDefaults({ backend: "codex", model: codex.model, reasoningEffort: "high", fastMode: true });
    const launchpad: NavigationLaunchpadDraft = {
      directoryKey: "directory:/repo",
      directoryKind: "directory",
      directoryLabel: "Repo",
      backend: "codex",
      executionMode: "full-access",
      workMode: "worktree",
      prompt: "unsent prompt",
      editorDocument: { type: "doc", content: [] },
      imageAttachments: [{ id: "image", name: "fixture.png", size: 10, type: "image/png", url: "data:image/png;base64,AA==" }],
      fileAttachments: [{ id: "file", label: "fixture.txt", path: "/fixture.txt" }],
      mcpConnectionIds: ["fixture-connection"],
      model: codex.model,
      reasoningEffort: "high",
      fastMode: true,
      codexEnvironmentId: "environment",
      createdAt: 1,
      updatedAt: 1,
    };
    await store.upsertDirectoryLaunchpad(launchpad);
    await store.upsertDirectoryLaunchpad(applyNavigationLaunchpadProviderSettingsPatch(
      { ...launchpad, directoryKey: "directory:/inactive" },
      { backend: "acp:kimi", model: "kimi-k3", reasoningEffort: "high" },
    ));
    await store.upsertDirectoryLaunchpad({ ...launchpad, directoryKey: "directory:/other", backend: "acp:grok", model: "grok-4" });
    await store.setThreadModelSettings({ backend: "codex", threadId: "existing", model: codex.model, reasoningEffort: "high" });

    expect(store.applyProviderModelDefaults({ codex }, { codex: next })).toBe(2);
    expect(await store.getLaunchpadDefaults()).toMatchObject({ model: next.model, reasoningEffort: "low", fastMode: true });
    const updated = await store.getDirectoryLaunchpad({ directoryKey: launchpad.directoryKey });
    expect(updated).toMatchObject({ ...launchpad, model: next.model, reasoningEffort: "low", updatedAt: expect.any(Number) });
    const inactive = await store.getDirectoryLaunchpad({ directoryKey: "directory:/inactive" });
    expect(inactive).toMatchObject({ backend: "acp:kimi", model: "kimi-k3", reasoningEffort: "high" });
    const switched = applyNavigationLaunchpadProviderSettingsPatch(inactive!, { backend: "codex" });
    expect(switched).toMatchObject({ model: next.model, reasoningEffort: "low", fastMode: true, codexEnvironmentId: "environment" });
    expect(await store.getDirectoryLaunchpad({ directoryKey: "directory:/other" })).toMatchObject({ model: "grok-4", updatedAt: 1 });
    expect(await store.getThreadOverlayState({ backend: "codex", threadId: "existing" })).toMatchObject({ model: codex.model, reasoningEffort: "high" });
  });

  it("replaces remembered reasoning and clears saved choices when the default is reset", async () => {
    const before = { model: "gpt-6.1-sol", reasoningEffortsByModel: { "gpt-6.1-sol": "high" } };
    const after = { ...before, reasoningEffortsByModel: { "gpt-6.1-sol": "low" } };
    await store.setLaunchpadDefaults({ backend: "codex", executionMode: "full-access", model: before.model, reasoningEffort: "high" });
    await store.upsertDirectoryLaunchpad({
      directoryKey: "directory:/repo", directoryKind: "directory", directoryLabel: "Repo",
      backend: "codex", executionMode: "full-access", workMode: "local", prompt: "draft",
      model: before.model, reasoningEffort: "high", createdAt: 1, updatedAt: 1,
    });
    store.applyProviderModelDefaults({ codex: before }, { codex: after });
    expect(await store.getLaunchpadDefaults()).toMatchObject({ model: before.model, reasoningEffort: "low" });
    expect(await store.getDirectoryLaunchpad({ directoryKey: "directory:/repo" })).toMatchObject({ model: before.model, reasoningEffort: "low" });
    const advertisedReasoning = { model: before.model, reasoningEffortsByModel: {} };
    store.applyProviderModelDefaults({ codex: after }, { codex: advertisedReasoning });
    expect((await store.getLaunchpadDefaults()).reasoningEffort).toBeUndefined();
    expect((await store.getDirectoryLaunchpad({ directoryKey: "directory:/repo" }))?.reasoningEffort).toBeUndefined();
    store.applyProviderModelDefaults({ codex: advertisedReasoning }, {});
    const reopened = new SqliteOverlayStore(stateDb);
    for (const value of [await reopened.getLaunchpadDefaults(), await reopened.getDirectoryLaunchpad({ directoryKey: "directory:/repo" })]) {
      expect(value?.model).toBeUndefined();
      expect(value?.reasoningEffort).toBeUndefined();
      expect(value?.providerSettings?.codex?.reasoningEffortsByModel).toBeUndefined();
      expect(value?.executionMode).toBe("full-access");
    }
  });

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

  it("persists the Pinned group's collapse with one commit per change", async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const { dbPath, tempDir } = createTempStateDb(
      "pwragent-recents-pinned-collapse-test-",
    );
    stateDb.close();
    stateDb = StateDb.open(dbPath);
    store = new SqliteOverlayStore(stateDb);

    try {
      expect(store.getPinnedGroupCollapsedSync()).toBe(false);
      const { writes } = await measureSqliteWrites(async () => {
        await expect(store.setPinnedGroupCollapsed(true)).resolves.toBe(true);
        // A repeat, such as a reveal that finds the group already in the
        // state it wants, commits nothing.
        await store.setPinnedGroupCollapsed(true);
        await store.setPinnedGroupCollapsed(true);
        await store.setPinnedGroupCollapsed(false);
        await store.setPinnedGroupCollapsed(false);
        await store.setPinnedGroupCollapsed(true);
      });
      expectSqliteWriteBudget({
        note: "three header clicks and three repeated writes of the same value: one commit per change, none per repeat; a few clicks a day is well under 1 MB/day of WAL",
        scenario: "pinned-group-collapse",
        writes,
      });
      stateDb.close();

      const reopenedDb = StateDb.open(dbPath);
      try {
        expect(new SqliteOverlayStore(reopenedDb).getPinnedGroupCollapsedSync()).toBe(true);
      } finally {
        reopenedDb.close();
      }
    } finally {
      vi.unstubAllEnvs();
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
