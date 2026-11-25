import { afterEach, expect, it, vi } from "vitest";

import { listModelSettingsRecents, recordModelSettingsRecent } from "../state/model-settings-recents-store";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

afterEach(() => vi.unstubAllEnvs());

/**
 * Every new thread records the settings it started with, so the next
 * new-thread panel can offer them under Recent. A new combination costs one
 * commit; starting again on the newest one writes nothing.
 */
it("budgets recording new-thread starts in the composer recents", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const temp = createTempStateDb("model-settings-recents-budget-");
  const db = StateDb.open(temp.dbPath);
  const opus = { backend: "claude" as const, model: "opus", reasoningEffort: "high" };
  try {
    const { writes } = await measureSqliteWrites(() => {
      recordModelSettingsRecent(db, "composer", { backend: "codex", model: "gpt-6-sol", fastMode: true });
      for (let index = 0; index < 20; index += 1) {
        recordModelSettingsRecent(db, "composer", opus);
      }
    });
    expect(listModelSettingsRecents(db, "composer")).toEqual([
      opus,
      { backend: "codex", model: "gpt-6-sol", fastMode: true },
    ]);
    expectSqliteWriteBudget({
      scenario: "new-thread-model-settings-recent",
      writes,
      note: "Two new-thread starts on new settings, then 20 more on the newest: 2 commits, one meta upsert each; repeats write nothing. ~8 KB WAL per changed start; 100 starts/day on changing settings projects ~0.8 MB/day, no idle writes.",
    });
  } finally {
    db.close();
    removeTempStateDbDir(temp.tempDir);
  }
});
