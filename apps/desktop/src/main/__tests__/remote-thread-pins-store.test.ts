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

  it("round-trips pinnedVia and answers membership checks", async () => {
    await store.addRemoteThreadPin({
      ref: ref("child"),
      summary: summary({ id: "child" }),
      instanceLabel: "Laptop",
      pinnedVia: "explicit",
    });
    await store.addRemoteThreadPin({
      ref: ref("parent"),
      summary: summary({ id: "parent" }),
      instanceLabel: "Laptop",
      pinnedVia: "companion",
    });

    const listed = await store.listRemoteThreadPins();
    const byThread = new Map(listed.map((pin) => [pin.ref.threadId, pin]));
    expect(byThread.get("child")?.pinnedVia).toBe("explicit");
    expect(byThread.get("parent")?.pinnedVia).toBe("companion");

    expect(await store.hasRemoteThreadPin({ ref: ref("parent") })).toBe(true);
    expect(await store.hasRemoteThreadPin({ ref: ref("nope") })).toBe(false);
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
