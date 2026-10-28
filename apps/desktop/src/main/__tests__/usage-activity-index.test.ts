import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { ensureUsageActivityIndex } from "../state/usage-activity-index";

it("backfills authoritative endpoints atomically and follows old and new writers, deletion, and VACUUM", () => {
  const db = new Database(":memory:");
  try {
    // The migration must work for data written before this index existed.
    db.exec(`CREATE TABLE thread_usage_lines (
      usage_line_id TEXT PRIMARY KEY, usage_turn_id TEXT, scope TEXT, status TEXT,
      created_at INTEGER, completed_at INTEGER, updated_at INTEGER);
      CREATE TABLE thread_usage_turns (usage_turn_id TEXT PRIMARY KEY, started_at INTEGER, completed_at INTEGER);
      INSERT INTO thread_usage_turns VALUES ('turn', 120000, 360000);
      INSERT INTO thread_usage_lines VALUES
        ('deleted-first', NULL, 'turn', 'pending', 0, NULL, 1000),
        ('joined', 'turn', 'turn', 'pending', 240000, 300000, 900000),
        ('monitor', NULL, 'monitor', 'finalized', 180000, NULL, 900000),
        ('live', NULL, 'turn', 'pending', -1, NULL, 60001),
        ('superseded', NULL, 'turn', 'superseded', 0, NULL, 1000);`);
    ensureUsageActivityIndex(db);
    const check = () => {
      const expected = db.prepare("SELECT usage_line_id, started_at, ended_at FROM usage_activity_endpoints ORDER BY usage_line_id").all();
      const actual = db.prepare("SELECT usage_line_id, started_at, ended_at FROM usage_activity_keys ORDER BY usage_line_id").all();
      expect(actual).toEqual(expected);
      expect(db.prepare(`SELECT k.usage_line_id FROM usage_activity_keys k LEFT JOIN usage_activity_intervals i ON i.id = k.id
        WHERE i.id IS NULL OR i.start_min > k.started_at OR i.start_max < k.started_at + 60000
          OR i.end_min > k.ended_at OR i.end_max < k.ended_at + 60000`).all()).toEqual([]);
      expect(db.prepare("SELECT COUNT(*) AS n FROM usage_activity_intervals").get())
        .toEqual({ n: expected.length });
    };
    check();
    expect(db.prepare("SELECT started_at, ended_at FROM usage_activity_keys WHERE usage_line_id = 'joined'").get())
      .toEqual({ started_at: 120000, ended_at: 360000 });
    expect(db.prepare("SELECT started_at, ended_at FROM usage_activity_keys WHERE usage_line_id = 'monitor'").get())
      .toEqual({ started_at: 180000, ended_at: 180000 });
    expect(db.prepare("SELECT started_at, ended_at FROM usage_activity_keys WHERE usage_line_id = 'live'").get())
      .toEqual({ started_at: -60000, ended_at: 60000 });
    for (const sql of [
      "UPDATE thread_usage_turns SET completed_at = 720000 WHERE usage_turn_id = 'turn'",
      "DELETE FROM thread_usage_turns WHERE usage_turn_id = 'turn'",
      "INSERT INTO thread_usage_turns VALUES ('turn', 0, 800000)",
      "UPDATE thread_usage_turns SET usage_turn_id = 'renamed' WHERE usage_turn_id = 'turn'",
      "UPDATE thread_usage_lines SET usage_turn_id = 'renamed' WHERE usage_line_id = 'joined'",
      "UPDATE thread_usage_lines SET status = 'superseded' WHERE usage_line_id = 'live'",
      "UPDATE thread_usage_lines SET status = 'pending', updated_at = 800000 WHERE usage_line_id = 'live'",
      "DELETE FROM thread_usage_lines WHERE usage_line_id = 'deleted-first'",
      "VACUUM",
      "UPDATE thread_usage_lines SET usage_line_id = 'moved', completed_at = 950000 WHERE usage_line_id = 'joined'",
    ]) { db.exec(sql); check(); }
    const before = db.prepare("SELECT total_changes() AS n").get();
    ensureUsageActivityIndex(db);
    expect(db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
    expect(() => db.transaction(() => {
      db.exec("UPDATE thread_usage_turns SET completed_at = 1000000");
      throw new Error("rollback");
    })()).toThrow("rollback");
    check();
  } finally { db.close(); }
});
