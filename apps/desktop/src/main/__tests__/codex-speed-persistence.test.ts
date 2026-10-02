import { expect, it } from "vitest";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

it("persists Ultrafast across reopen and clears it with the profile speed reset", async () => {
  const { dbPath, tempDir } = createTempStateDb("pwragent-speed-budget-");
  const previousMetrics = process.env[SQLITE_WRITE_METRICS_ENV];
  process.env[SQLITE_WRITE_METRICS_ENV] = "1";
  let db = StateDb.open(dbPath);
  try {
    let store = new SqliteOverlayStore(db);
    const settings = {
      backend: "codex" as const, threadId: "speed-fixture", model: "gpt-6-astra",
      serviceTier: "ultrafast", fastMode: false,
    };
    const selection = await measureSqliteWrites(() => store.setThreadModelSettings(settings));
    expectSqliteWriteBudget({
      scenario: "codex-ultrafast-selection",
      note: "one persisted thread speed selection; no extra writes per turn or streamed event",
      writes: selection.writes,
    });
    await store.setLaunchpadDefaults(settings);
    await store.upsertDirectoryLaunchpad({
      directoryKey: "directory:/fixture", directoryKind: "directory",
      directoryLabel: "Fixture", directoryPath: "/fixture", backend: "codex",
      executionMode: "default", workMode: "local", prompt: "Keep this draft",
      model: settings.model, serviceTier: "ultrafast", fastMode: false,
      createdAt: 1, updatedAt: 1,
    });
    db.close();
    db = StateDb.open(dbPath);
    store = new SqliteOverlayStore(db);
    expect(await store.getThreadOverlayState(settings)).toMatchObject(settings);
    expect((await store.getLaunchpadDefaults()).serviceTier).toBe("ultrafast");
    const reset = await measureSqliteWrites(() => store.turnOffCodexFastEverywhere());
    expect(reset.result).toMatchObject({ threadCount: 1, launchpadCount: 1 });
    expectSqliteWriteBudget({
      scenario: "codex-ultrafast-profile-reset",
      note: "one explicit profile reset of one Ultrafast thread, one launchpad and sticky defaults",
      writes: reset.writes,
    });
    expect((await store.getThreadOverlayState(settings))?.serviceTier).toBeUndefined();
    expect((await store.getLaunchpadDefaults()).serviceTier).toBeUndefined();
    expect(await store.getDirectoryLaunchpad({ directoryKey: "directory:/fixture" })).toMatchObject({
      prompt: "Keep this draft", model: settings.model, fastMode: false,
    });
    expect((await store.getDirectoryLaunchpad({ directoryKey: "directory:/fixture" }))?.serviceTier).toBeUndefined();
  } finally {
    db.close();
    if (previousMetrics === undefined) delete process.env[SQLITE_WRITE_METRICS_ENV];
    else process.env[SQLITE_WRITE_METRICS_ENV] = previousMetrics;
    removeTempStateDbDir(tempDir);
  }
});
