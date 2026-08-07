import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { CURRENT_STATE_DB_USER_VERSION, StateDb } from "../state/state-db";
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

describe("SqliteOverlayStore — remote thread targets", () => {
  it("remembers an owner durably and refreshes its label and last-seen time", async () => {
    await store.rememberRemoteThreadTarget({
      instanceId: "pwr_studio",
      instanceLabel: "Studio Mac",
      backend: "codex",
      threadId: "thread-1",
      observedAt: 1_000,
    });
    await store.rememberRemoteThreadTarget({
      instanceId: "pwr_studio",
      instanceLabel: "Studio Mac / default",
      backend: "codex",
      threadId: "thread-1",
      observedAt: 2_000,
    });

    await expect(
      store.listRemoteThreadTargets({
        backend: "codex",
        threadId: "thread-1",
      }),
    ).resolves.toEqual([{
      instanceId: "pwr_studio",
      instanceLabel: "Studio Mac / default",
      backend: "codex",
      threadId: "thread-1",
      firstSeenAt: 1_000,
      lastSeenAt: 2_000,
    }]);
  });

  it("preserves multiple owners so routing can reject an ambiguous id", async () => {
    for (const [instanceId, instanceLabel] of [
      ["pwr_one", "One"],
      ["pwr_two", "Two"],
    ] as const) {
      await store.rememberRemoteThreadTarget({
        instanceId,
        instanceLabel,
        backend: "codex",
        threadId: "shared-thread",
      });
    }

    const targets = await store.listRemoteThreadTargets({
      backend: "codex",
      threadId: "shared-thread",
    });
    expect(targets.map((target) => target.instanceId).sort()).toEqual([
      "pwr_one",
      "pwr_two",
    ]);
  });

  it("migrates v45 and seeds routing knowledge from existing remote pins", () => {
    const { dbPath, tempDir } = createTempStateDb("pwragent-remote-targets-");
    try {
      const seeded = StateDb.open(dbPath);
      seeded.raw
        .prepare(
          `INSERT INTO remote_thread_pins(
             instance_id,
             backend,
             thread_id,
             added_at,
             payload
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run("pwr_studio", "codex", "thread-1", 1_000, "{}");
      seeded.raw.exec("DROP TABLE remote_thread_targets");
      seeded.raw.pragma("user_version = 45");
      seeded.close();

      const migrated = StateDb.open(dbPath);
      try {
        expect(migrated.raw.pragma("user_version", { simple: true })).toBe(
          CURRENT_STATE_DB_USER_VERSION,
        );
        const row = migrated.raw
          .prepare(
            `SELECT instance_id, backend, thread_id, first_seen_at, last_seen_at
             FROM remote_thread_targets`,
          )
          .get();
        expect(row).toEqual({
          instance_id: "pwr_studio",
          backend: "codex",
          thread_id: "thread-1",
          first_seen_at: 1_000,
          last_seen_at: 1_000,
        });
      } finally {
        migrated.close();
      }
    } finally {
      removeTempStateDbDir(tempDir);
    }
  });
});
