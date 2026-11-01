import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PROJECT_FORGE_AUTOMATION,
  type ProjectForgeAutomation,
} from "@pwragent/shared";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";

const PROJECT = "directory:/Users/fixture/src/openclaw";
const pause: ProjectForgeAutomation = { ...DEFAULT_PROJECT_FORGE_AUTOMATION, paused: true };

describe("SqliteOverlayStore — project Forge Automation", () => {
  let db: StateDb;
  let store: SqliteOverlayStore;
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const temp = createTempStateDb("pwragent-project-forge-automation-");
    tempDir = temp.tempDir;
    dbPath = temp.dbPath;
    db = StateDb.open(dbPath);
    store = new SqliteOverlayStore(db);
  });

  afterEach(() => {
    db.close();
    removeTempStateDbDir(tempDir);
    vi.unstubAllEnvs();
  });

  it("stamps pausedAt from the clock on pause, keeps it while paused, and drops it on resume", async () => {
    const first = await store.setDirectoryForgeAutomation({
      directoryKey: PROJECT,
      automation: { ...pause, pausedAt: 5 },
      now: 1_000,
    });
    expect(first.forgeAutomation).toEqual({ ...pause, pausedAt: 1_000 });

    const stillPaused = await store.setDirectoryForgeAutomation({
      directoryKey: PROJECT,
      automation: { ...pause, wakeupPolicy: "discard" },
      now: 2_000,
    });
    expect(stillPaused.forgeAutomation).toEqual({ ...pause, wakeupPolicy: "discard", pausedAt: 1_000 });

    const resumed = await store.setDirectoryForgeAutomation({
      directoryKey: PROJECT,
      automation: { ...DEFAULT_PROJECT_FORGE_AUTOMATION, autoFixMergeConflicts: false },
      now: 3_000,
    });
    expect(resumed.forgeAutomation).toEqual({
      ...DEFAULT_PROJECT_FORGE_AUTOMATION,
      autoFixMergeConflicts: false,
    });
  });

  it("stores nothing for the defaults and keeps the overlay's other preferences", async () => {
    await store.setDirectoryPin({ directoryKey: PROJECT, pinned: true });
    await store.setDirectoryForgeAutomation({ directoryKey: PROJECT, automation: pause, now: 1_000 });
    const cleared = await store.setDirectoryForgeAutomation({
      directoryKey: PROJECT,
      automation: { ...DEFAULT_PROJECT_FORGE_AUTOMATION },
      now: 2_000,
    });
    expect(cleared).not.toHaveProperty("forgeAutomation");
    expect(cleared.pinnedRank).toBeTruthy();
    const stored = await store.getDirectoryOverlayState({ directoryKey: PROJECT });
    expect(stored).not.toHaveProperty("forgeAutomation");
    expect(stored?.pinnedRank).toBe(cleared.pinnedRank);
  });

  it("survives a restart", async () => {
    await store.setDirectoryForgeAutomation({ directoryKey: PROJECT, automation: pause, now: 1_000 });
    db.close();
    db = StateDb.open(dbPath);
    store = new SqliteOverlayStore(db);
    const overlays = await store.readAllDirectoryOverlays();
    expect(overlays[PROJECT]?.forgeAutomation).toEqual({ ...pause, pausedAt: 1_000 });
  });

  it("commits once per Save", async () => {
    const { writes } = await measureSqliteWrites(async () => {
      await store.setDirectoryForgeAutomation({ directoryKey: PROJECT, automation: pause, now: 1_000 });
      await store.setDirectoryForgeAutomation({
        directoryKey: PROJECT,
        automation: { ...DEFAULT_PROJECT_FORGE_AUTOMATION },
        now: 2_000,
      });
    });
    expectSqliteWriteBudget({
      note: "Two operator Saves (pause, then resume) commit one overlay row each (~0.012 MB per Save); "
        + "a few Saves a day cost well under 0.1 MB/day, with no per-poll, per-turn or idle writes.",
      scenario: "project-forge-automation-save",
      writes,
    });
  });
});
