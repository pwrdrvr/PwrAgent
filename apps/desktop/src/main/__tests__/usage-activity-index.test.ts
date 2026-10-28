import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { ensureUsageActivityLookupIndex } from "../state/usage-activity-index";
import { StateDb } from "../state/state-db";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

it("removes the experimental derived index on reopen without changing ledger facts or activity", async () => {
  const temp = createTempStateDb("pwragent-usage-index-removal-");
  let db = StateDb.open(temp.dbPath);
  try {
    const store = new SqliteOverlayStore(db);
    const time = Date.UTC(2026, 9, 27, 15);
    await store.upsertThreadUsageLine({ line: {
      usageLineId: "fixture-helper", backend: "codex", provider: "openai", threadId: "helper",
      parentThreadId: "parent", accountKey: "fixture-account", scope: "monitor", status: "finalized",
      source: "monitor", sourceItemId: "system:title:fixture", createdAt: time, model: "fixture-unknown",
      inputTokens: 10, cachedInputTokens: 2, uncachedInputTokens: 8, outputTokens: 3,
      reasoningOutputTokens: 1, totalTokens: 13, currency: "USD", priceStatus: "unpriced",
      uncachedInputCostMicros: 0, cachedInputCostMicros: 0, outputCostMicros: 0, totalCostMicros: 0,
    } });
    const request = { from: time - 1000, to: time + 1000 };
    const activity = await store.readUsageActivity(request);
    const lines = db.raw.prepare("SELECT * FROM thread_usage_lines").all();
    const turns = db.raw.prepare("SELECT * FROM thread_usage_turns").all();
    db.raw.exec(readFileSync(new URL("./fixtures/usage-activity-rtree-schema.sql", import.meta.url), "utf8"));
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM usage_activity_keys").get()).toEqual({ n: 1 });
    db.close();
    db = StateDb.open(temp.dbPath);
    expect(db.raw.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'usage_activity_%'").all()).toEqual([]);
    expect(db.raw.prepare("SELECT * FROM thread_usage_lines").all()).toEqual(lines);
    expect(db.raw.prepare("SELECT * FROM thread_usage_turns").all()).toEqual(turns);
    expect(await new SqliteOverlayStore(db).readUsageActivity(request)).toEqual(activity);
    const before = db.raw.prepare("SELECT total_changes() AS n").get();
    ensureUsageActivityLookupIndex(db.raw);
    expect(db.raw.prepare("SELECT total_changes() AS n").get()).toEqual(before);
    db.raw.exec("VACUUM");
    db.raw.prepare("UPDATE thread_usage_lines SET account_key = 'changed' WHERE usage_line_id = 'fixture-helper'").run();
    expect((await new SqliteOverlayStore(db).readUsageActivity(request)).rows[0].line.accountKey).toBe("changed");
  } finally { db.close(); removeTempStateDbDir(temp.tempDir); }
});
