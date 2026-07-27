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

    const initialLaunchpad = {
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
    } as unknown as NavigationLaunchpadDraft;

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
