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

  it("reorders mixed local and remote pins atomically from the full order", async () => {
    await store.addRemoteThreadPin({
      ref: ref("remote-1"),
      summary: summary({ id: "remote-1" }),
      instanceLabel: "Laptop",
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
