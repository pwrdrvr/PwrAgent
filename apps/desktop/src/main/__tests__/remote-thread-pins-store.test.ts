import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildFederatedThreadRef,
  type NavigationThreadSummary,
} from "@pwragent/shared";
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

function ref(threadId = "thread-1", instanceId = "peer-laptop") {
  return buildFederatedThreadRef({
    backend: "codex",
    instanceId,
    threadId,
  });
}

function summary(partial: Partial<NavigationThreadSummary> = {}): NavigationThreadSummary {
  return {
    source: "codex",
    id: "thread-1",
    title: "Remote fix",
    linkedDirectories: [],
    ...partial,
  } as NavigationThreadSummary;
}

describe("SqliteOverlayStore — remote thread pins", () => {
  it("adds, lists, and removes a pin", async () => {
    const pin = await store.addRemoteThreadPin({
      ref: ref(),
      summary: summary(),
      instanceLabel: "Laptop",
      addedAt: 1_000,
    });
    expect(pin.addedAt).toBe(1_000);
    expect(pin.instanceLabel).toBe("Laptop");

    const listed = await store.listRemoteThreadPins();
    expect(listed).toHaveLength(1);
    expect(listed[0].ref).toEqual(ref());
    expect(listed[0].summary?.title).toBe("Remote fix");
    expect(await store.listRemoteThreadTargets({
      backend: "codex",
      threadId: "thread-1",
    })).toEqual([{
      instanceId: "peer-laptop",
      instanceLabel: "Laptop",
      backend: "codex",
      threadId: "thread-1",
      firstSeenAt: 1_000,
      lastSeenAt: 1_000,
    }]);

    expect(await store.removeRemoteThreadPin({ ref: ref() })).toBe(true);
    expect(await store.listRemoteThreadPins()).toEqual([]);
  });

  it("is idempotent: re-pinning refreshes the payload but keeps addedAt", async () => {
    await store.addRemoteThreadPin({
      ref: ref(),
      summary: summary({ title: "Old title" }),
      instanceLabel: "Laptop",
      addedAt: 1_000,
    });
    const repinned = await store.addRemoteThreadPin({
      ref: ref(),
      summary: summary({ title: "New title" }),
      instanceLabel: "Laptop 2",
      addedAt: 9_000,
    });
    expect(repinned.addedAt).toBe(1_000);

    const listed = await store.listRemoteThreadPins();
    expect(listed).toHaveLength(1);
    expect(listed[0].addedAt).toBe(1_000);
    expect(listed[0].summary?.title).toBe("New title");
    expect(listed[0].instanceLabel).toBe("Laptop 2");
    expect(await store.listRemoteThreadTargets({
      backend: "codex",
      threadId: "thread-1",
    })).toEqual([{
      instanceId: "peer-laptop",
      instanceLabel: "Laptop 2",
      backend: "codex",
      threadId: "thread-1",
      firstSeenAt: 1_000,
      lastSeenAt: 9_000,
    }]);
  });

  it("strips the live federation stamp before persisting summaries", async () => {
    const stamped = summary();
    stamped.federation = {
      ref: ref(),
      instanceLabel: "Laptop",
      peerStatus: "connected",
    };
    await store.addRemoteThreadPin({
      ref: ref(),
      summary: stamped,
      instanceLabel: "Laptop",
    });
    const listed = await store.listRemoteThreadPins();
    expect(listed[0].summary?.federation).toBeUndefined();
  });

  it("removal reports false for an unknown pin and needs no connectivity", async () => {
    expect(await store.removeRemoteThreadPin({ ref: ref("nope") })).toBe(false);
  });

  it("refuses a local-target ref", async () => {
    const localRef = {
      backend: "codex",
      target: { scope: "local" },
      threadId: "thread-1",
    } as const;
    await expect(
      store.addRemoteThreadPin({
        ref: localRef,
        instanceLabel: "Local",
      }),
    ).rejects.toThrow(/remote federation target/i);
  });

  it("tolerates a malformed payload row instead of throwing", async () => {
    await store.addRemoteThreadPin({
      ref: ref(),
      summary: summary(),
      instanceLabel: "Laptop",
    });
    stateDb.raw
      .prepare("UPDATE remote_thread_pins SET payload = ?")
      .run("{not json");

    const listed = await store.listRemoteThreadPins();
    expect(listed).toHaveLength(1);
    expect(listed[0].summary).toBeUndefined();
    // Falls back to the instance id when the label is unreadable.
    expect(listed[0].instanceLabel).toBe("peer-laptop");
  });

  it("migrates a v42 database to v43 with the pins table", () => {
    const { dbPath, tempDir } = createTempStateDb("pwragent-remote-pins-");
    try {
      const seeded = StateDb.open(dbPath);
      seeded.raw.exec("DROP TABLE remote_thread_pins");
      seeded.raw.pragma("user_version = 42");
      seeded.close();

      const migrated = StateDb.open(dbPath);
      try {
        expect(migrated.raw.pragma("user_version", { simple: true })).toBe(
          CURRENT_STATE_DB_USER_VERSION,
        );
        const table = migrated.raw
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
          )
          .get("remote_thread_pins");
        expect(table).toBeTruthy();
      } finally {
        migrated.close();
      }
    } finally {
      removeTempStateDbDir(tempDir);
    }
  });

  it("sets and clears a viewer-owned local pin rank", async () => {
    await store.addRemoteThreadPin({
      ref: ref(),
      summary: summary(),
      instanceLabel: "Laptop",
      pinnedVia: "explicit",
    });

    expect(
      await store.setRemoteThreadLocalPin({ ref: ref(), pinnedRank: "2048" }),
    ).toEqual({ pinnedRank: "2048" });
    let listed = await store.listRemoteThreadPins();
    expect(listed[0].localPinnedRank).toBe("2048");
    // The rank patch must not disturb the rest of the payload.
    expect(listed[0].summary?.title).toBe("Remote fix");
    expect(listed[0].pinnedVia).toBe("explicit");

    expect(
      await store.setRemoteThreadLocalPin({ ref: ref(), pinnedRank: null }),
    ).toEqual({});
    listed = await store.listRemoteThreadPins();
    expect(listed[0].localPinnedRank).toBeUndefined();

    // A rank write for a thread that was never pinned is a no-op.
    expect(
      await store.setRemoteThreadLocalPin({
        ref: ref("never-pinned"),
        pinnedRank: "1024",
      }),
    ).toEqual({});
    expect(await store.listRemoteThreadPins()).toHaveLength(1);
  });

  it("keeps viewer-owned pin state through snapshot payload refreshes", async () => {
    await store.addRemoteThreadPin({
      ref: ref(),
      summary: summary({ title: "Stale" }),
      instanceLabel: "Laptop",
      pinnedVia: "companion",
    });
    await store.setRemoteThreadLocalPin({ ref: ref(), pinnedRank: "4096" });

    // The reachable-owner refresh path rewrites summary + label on every
    // merge; it must PATCH, never replace — a refresh that wiped the
    // viewer's rank would silently unpin the row seconds after pinning.
    await store.updateRemoteThreadPinSnapshots([
      {
        ref: ref(),
        summary: summary({ title: "Fresh" }),
        instanceLabel: "Laptop (renamed)",
      },
    ]);

    const listed = await store.listRemoteThreadPins();
    expect(listed[0].summary?.title).toBe("Fresh");
    expect(listed[0].instanceLabel).toBe("Laptop (renamed)");
    expect(listed[0].localPinnedRank).toBe("4096");
    expect(listed[0].pinnedVia).toBe("companion");
  });

  it("reorders colliding local and remote pins atomically from the full order", async () => {
    await store.addRemoteThreadPin({
      ref: ref("remote-1"),
      summary: summary({ id: "remote-1" }),
      instanceLabel: "Laptop",
    });
    await store.setRemoteThreadLocalPin({
      ref: ref("remote-1"),
      pinnedRank: "9999",
    });
    await store.setThreadPin({
      backend: "codex",
      threadId: "local-1",
      pinnedRank: "9999",
    });

    const pinnedRanks = await store.reorderThreadPins({
      threadKeys: ["codex:remote-1", "codex:local-1"],
      remoteRefsByKey: { "codex:remote-1": ref("remote-1") },
    });

    expect(pinnedRanks).toEqual({
      "codex:remote-1": "1024",
      "codex:local-1": "2048",
    });
    const pins = await store.listRemoteThreadPins();
    expect(pins[0].localPinnedRank).toBe("1024");
    // The remote key must not have leaked into the local thread overlay.
    const localOverlay = await store.getThreadOverlayState({
      backend: "codex",
      threadId: "local-1",
    });
    expect(localOverlay?.pinnedRank).toBe("2048");
  });

  it("round-trips pinnedVia and answers membership checks", async () => {
    await store.addRemoteThreadPin({
      ref: ref("explicit"),
      summary: summary({ id: "explicit" }),
      instanceLabel: "Laptop",
      pinnedVia: "explicit",
    });
    await store.addRemoteThreadPin({
      ref: ref("parent"),
      summary: summary({ id: "parent" }),
      instanceLabel: "Laptop",
      pinnedVia: "companion",
    });
    await store.addRemoteThreadPin({
      ref: ref("child"),
      summary: summary({ id: "child" }),
      instanceLabel: "Laptop",
      pinnedVia: "child",
    });

    const listed = await store.listRemoteThreadPins();
    const byThread = new Map(listed.map((pin) => [pin.ref.threadId, pin]));
    expect(byThread.get("explicit")?.pinnedVia).toBe("explicit");
    expect(byThread.get("parent")?.pinnedVia).toBe("companion");
    expect(byThread.get("child")?.pinnedVia).toBe("child");

    expect(await store.hasRemoteThreadPin({ ref: ref("parent") })).toBe(true);
    expect(await store.hasRemoteThreadPin({ ref: ref("nope") })).toBe(false);
  });

  it("skips byte-equal snapshot rewrites", async () => {
    await store.addRemoteThreadPin({
      ref: ref(),
      summary: summary(),
      instanceLabel: "Laptop",
    });
    // Count actual row rewrites — the merge refreshes payloads on every
    // navigation snapshot, and unchanged data must not churn the db.
    stateDb.raw.exec(
      `CREATE TEMP TABLE pin_write_log(n INTEGER);
       CREATE TEMP TRIGGER pin_update_log AFTER UPDATE ON remote_thread_pins
       BEGIN INSERT INTO pin_write_log VALUES (1); END;`,
    );
    const entry = {
      ref: ref(),
      summary: summary(),
      instanceLabel: "Laptop",
    };
    await store.updateRemoteThreadPinSnapshots([entry]);
    await store.updateRemoteThreadPinSnapshots([entry]);
    const unchangedWrites = stateDb.raw
      .prepare("SELECT COUNT(*) AS count FROM pin_write_log")
      .get() as { count: number };
    expect(unchangedWrites.count).toBe(0);

    await store.updateRemoteThreadPinSnapshots([
      { ...entry, summary: summary({ title: "Changed" }) },
    ]);
    const changedWrites = stateDb.raw
      .prepare("SELECT COUNT(*) AS count FROM pin_write_log")
      .get() as { count: number };
    expect(changedWrites.count).toBe(1);
  });

  it("tombstones an instance's pins, hides them, and restores them", async () => {
    await store.addRemoteThreadPin({
      ref: ref("t1", "peer-revoked"),
      summary: summary({ id: "t1" }),
      instanceLabel: "Old laptop",
      pinnedVia: "explicit",
    });
    await store.setRemoteThreadLocalPin({
      ref: ref("t1", "peer-revoked"),
      pinnedRank: "2048",
    });
    await store.addRemoteThreadPin({
      ref: ref("t2", "peer-kept"),
      summary: summary({ id: "t2" }),
      instanceLabel: "Desktop",
    });

    expect(
      await store.tombstoneRemoteThreadPinsForInstance({
        instanceId: "peer-revoked",
        revokedAt: 7_000,
      }),
    ).toBe(1);

    // Hidden from the default list — the merge must never serve a row the
    // viewer cannot reach for cause — but still on disk.
    const live = await store.listRemoteThreadPins();
    expect(live.map((pin) => pin.ref.threadId)).toEqual(["t2"]);
    const all = await store.listRemoteThreadPins({ includeRevoked: true });
    expect(all).toHaveLength(2);
    expect(
      all.find((pin) => pin.ref.threadId === "t1")?.revokedAt,
    ).toBe(7_000);

    // Re-enrolling brings the row back with its viewer-owned state intact.
    expect(
      await store.restoreRemoteThreadPinsForInstance({
        instanceId: "peer-revoked",
      }),
    ).toBe(1);
    const restored = await store.listRemoteThreadPins();
    expect(restored).toHaveLength(2);
    const t1 = restored.find((pin) => pin.ref.threadId === "t1");
    expect(t1?.revokedAt).toBeUndefined();
    expect(t1?.localPinnedRank).toBe("2048");
    expect(t1?.pinnedVia).toBe("explicit");
    expect(t1?.summary?.title).toBe("Remote fix");
  });

  it("re-pinning a tombstoned thread brings it straight back", async () => {
    // Restoring on reconnect is best-effort. If it never ran, an explicit
    // pin must still land visibly — otherwise the operator clicks pin, the
    // write succeeds, and nothing appears.
    await store.addRemoteThreadPin({
      ref: ref(),
      summary: summary({ title: "Old" }),
      instanceLabel: "Laptop",
    });
    await store.tombstoneRemoteThreadPinsForInstance({
      instanceId: "peer-laptop",
    });
    expect(await store.listRemoteThreadPins()).toHaveLength(0);

    await store.addRemoteThreadPin({
      ref: ref(),
      summary: summary({ title: "Fresh" }),
      instanceLabel: "Laptop",
    });

    const live = await store.listRemoteThreadPins();
    expect(live).toHaveLength(1);
    expect(live[0].revokedAt).toBeUndefined();
    expect(live[0].summary?.title).toBe("Fresh");
  });

  it("reports a tombstoned pin as absent so it can be re-pinned", async () => {
    // `hasRemoteThreadPin` gates companion-parent pinning. Counting a
    // hidden row would skip a parent that never renders, stranding its
    // child as a bare top-level row.
    await store.addRemoteThreadPin({
      ref: ref("parent"),
      instanceLabel: "Laptop",
    });
    expect(await store.hasRemoteThreadPin({ ref: ref("parent") })).toBe(true);

    await store.tombstoneRemoteThreadPinsForInstance({
      instanceId: "peer-laptop",
    });
    expect(await store.hasRemoteThreadPin({ ref: ref("parent") })).toBe(false);

    await store.restoreRemoteThreadPinsForInstance({
      instanceId: "peer-laptop",
    });
    expect(await store.hasRemoteThreadPin({ ref: ref("parent") })).toBe(true);
  });

  it("keeps the original tombstone timestamp on a repeat revoke", async () => {
    await store.addRemoteThreadPin({
      ref: ref("t1", "peer-revoked"),
      instanceLabel: "Old laptop",
    });
    await store.tombstoneRemoteThreadPinsForInstance({
      instanceId: "peer-revoked",
      revokedAt: 1_000,
    });
    // A second revoke touches nothing: restating when the list was put
    // away would misreport how long it has been gone.
    expect(
      await store.tombstoneRemoteThreadPinsForInstance({
        instanceId: "peer-revoked",
        revokedAt: 9_000,
      }),
    ).toBe(0);
    const all = await store.listRemoteThreadPins({ includeRevoked: true });
    expect(all[0].revokedAt).toBe(1_000);
  });

  it("counts live and tombstoned pins per instance", async () => {
    await store.addRemoteThreadPin({
      ref: ref("t1", "peer-a"),
      instanceLabel: "A",
    });
    await store.addRemoteThreadPin({
      ref: ref("t2", "peer-a"),
      instanceLabel: "A",
    });
    await store.addRemoteThreadPin({
      ref: ref("t3", "peer-b"),
      instanceLabel: "B",
    });
    await store.tombstoneRemoteThreadPinsForInstance({ instanceId: "peer-b" });

    const counts = await store.countRemoteThreadPinsByInstance();
    expect(counts.get("peer-a")).toEqual({ live: 2, revoked: 0 });
    expect(counts.get("peer-b")).toEqual({ live: 0, revoked: 1 });
    // An instance the operator never pinned from is simply absent, so the
    // keep-or-forget prompt stays hidden.
    expect(counts.get("peer-none")).toBeUndefined();
    expect([...counts.keys()].sort()).toEqual(["peer-a", "peer-b"]);
  });

  it("migrates a v44 database to v45 with the revoked_at column", () => {
    const { dbPath, tempDir } = createTempStateDb("pwragent-pin-tombstone-");
    try {
      const seeded = StateDb.open(dbPath);
      seeded.raw.exec("DROP TABLE remote_thread_pins");
      seeded.raw.exec(`
CREATE TABLE remote_thread_pins (
  instance_id TEXT NOT NULL,
  backend     TEXT NOT NULL,
  thread_id   TEXT NOT NULL,
  added_at    INTEGER NOT NULL,
  payload     TEXT NOT NULL,
  PRIMARY KEY (instance_id, backend, thread_id)
);`);
      seeded.raw
        .prepare(
          `INSERT INTO remote_thread_pins(instance_id, backend, thread_id, added_at, payload)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run("peer-laptop", "codex", "thread-1", 1_000, "{}");
      seeded.raw.pragma("user_version = 44");
      seeded.close();

      const migrated = StateDb.open(dbPath);
      try {
        expect(migrated.raw.pragma("user_version", { simple: true })).toBe(
          CURRENT_STATE_DB_USER_VERSION,
        );
        const columns = (
          migrated.raw.prepare("PRAGMA table_info(remote_thread_pins)").all() as
            Array<{ name: string }>
        ).map((column) => column.name);
        expect(columns).toContain("revoked_at");
        // A pin that predates the column is live, not tombstoned.
        const row = migrated.raw
          .prepare("SELECT revoked_at FROM remote_thread_pins")
          .get() as { revoked_at: number | null };
        expect(row.revoked_at).toBeNull();
      } finally {
        migrated.close();
      }
    } finally {
      removeTempStateDbDir(tempDir);
    }
  });

  it("removes every pin for one instance in a single call", async () => {
    await store.addRemoteThreadPin({
      ref: ref("t1", "peer-revoked"),
      summary: summary({ id: "t1" }),
      instanceLabel: "Old laptop",
    });
    await store.addRemoteThreadPin({
      ref: ref("t2", "peer-revoked"),
      summary: summary({ id: "t2" }),
      instanceLabel: "Old laptop",
    });
    await store.addRemoteThreadPin({
      ref: ref("t3", "peer-kept"),
      summary: summary({ id: "t3" }),
      instanceLabel: "Desktop",
    });

    expect(
      await store.removeRemoteThreadPinsForInstance({
        instanceId: "peer-revoked",
      }),
    ).toBe(2);
    const listed = await store.listRemoteThreadPins();
    expect(listed).toHaveLength(1);
    expect(listed[0].ref.threadId).toBe("t3");

    expect(
      await store.removeRemoteThreadPinsForInstance({
        instanceId: "peer-revoked",
      }),
    ).toBe(0);
  });

  it("updates cached snapshots in batch", async () => {
    await store.addRemoteThreadPin({
      ref: ref("t1"),
      summary: summary({ id: "t1", title: "Stale" }),
      instanceLabel: "Laptop",
    });
    await store.addRemoteThreadPin({
      ref: ref("t2"),
      summary: summary({ id: "t2", title: "Stale too" }),
      instanceLabel: "Laptop",
    });
    await store.updateRemoteThreadPinSnapshots([
      {
        ref: ref("t1"),
        summary: summary({ id: "t1", title: "Fresh" }),
        instanceLabel: "Laptop (renamed)",
      },
    ]);

    const listed = await store.listRemoteThreadPins();
    const t1 = listed.find((pin) => pin.ref.threadId === "t1");
    const t2 = listed.find((pin) => pin.ref.threadId === "t2");
    expect(t1?.summary?.title).toBe("Fresh");
    expect(t1?.instanceLabel).toBe("Laptop (renamed)");
    expect(t2?.summary?.title).toBe("Stale too");
  });
});
