import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";

let stateDb: StateDb;
let store: SqliteOverlayStore;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "pwragent-launchpad-defaults-test-"));
  stateDb = StateDb.open(path.join(tempDir, "state.db"));
  store = new SqliteOverlayStore(stateDb);
});

afterEach(() => {
  stateDb.close();
  rmSync(tempDir, { recursive: true, force: true });
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
    expect(store.getNavigationBrowseModeSync()).toBe("inbox");

    await expect(store.setNavigationBrowseMode("directories")).resolves.toBe(
      "directories",
    );
    await expect(store.getNavigationBrowseMode()).resolves.toBe("directories");

    const reopenedDb = StateDb.open(path.join(tempDir, "state.db"));
    const reopenedStore = new SqliteOverlayStore(reopenedDb);
    try {
      expect(reopenedStore.getNavigationBrowseModeSync()).toBe("directories");
    } finally {
      reopenedDb.close();
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

    const readDefaults = await store.getLaunchpadDefaults();
    expect(readDefaults.fastMode).toBe(false);
    expect(readDefaults.serviceTier).toBeUndefined();
    expect(listDefaultKeys()).toEqual(["backend", "executionMode", "fastMode"]);

    await store.setLaunchpadDefaults({ fastMode: false, serviceTier: undefined });

    expect(listDefaultKeys()).toEqual(["backend", "executionMode", "fastMode"]);
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
    expect(defaults).toMatchObject({
      futureExperimentalFlag: { enabled: true },
    });
    expect(readDefaultValue("serviceTier")).toBeUndefined();
    expect(readDefaultValue("futureExperimentalFlag")).toEqual({ enabled: true });
  });
});
