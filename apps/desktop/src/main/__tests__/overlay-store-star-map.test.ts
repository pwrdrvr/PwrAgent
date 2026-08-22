import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  STAR_MAP_WORKSPACE_KEY,
  STAR_MAP_WORKSPACE_VERSION,
  type StarMapArrangementEntry,
  type StarMapWorkspaceSnapshot,
} from "@pwragent/shared";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { openInMemoryStateDb } from "./sqlite-test-utils";

let stateDb: StateDb;
let store: SqliteOverlayStore;

function entry(
  overrides: Partial<StarMapArrangementEntry>,
): StarMapArrangementEntry {
  return {
    instanceId: "pwr_local",
    threadKey: "codex:t1",
    dx: 10,
    dy: 20,
    updatedAt: 1_000,
    by: "pwr_local",
    ...overrides,
  };
}

function workspace(): StarMapWorkspaceSnapshot {
  return {
    version: STAR_MAP_WORKSPACE_VERSION,
    cards: [
      {
        key: "pwr_remote::codex:t1",
        ownerInstanceId: "pwr_remote",
        thread: {
          id: "t1",
          title: "Persist this chat",
          titleSource: "derived",
          linkedDirectories: [],
          source: "codex",
          inbox: { inInbox: true },
          federation: {
            ref: {
              backend: "codex",
              threadId: "t1",
              target: { scope: "remote", instanceId: "pwr_remote" },
            },
            instanceLabel: "Remote Mac",
          },
        },
        geometry: {
          anchor: {
            kind: "thread",
            instanceId: "pwr_remote",
            threadKey: "codex:t1",
          },
          dx: 28,
          dy: -10,
          instanceDx: 160,
          instanceDy: 80,
          fallbackRect: { left: 500, top: 220, width: 420, height: 520 },
        },
        contextOpen: true,
        terminalOpen: true,
        terminalHeight: 300,
      },
    ],
    views: {
      orbit: { x: -120, y: 80, scale: 0.8 },
    },
  };
}

beforeEach(() => {
  stateDb = openInMemoryStateDb();
  store = new SqliteOverlayStore(stateDb);
});

afterEach(() => {
  stateDb.close();
});

describe("star map arrangement overlay", () => {
  it("round-trips entries", async () => {
    await store.mergeStarMapArrangement([entry({})]);
    const entries = await store.readStarMapArrangement();
    expect(entries).toEqual([entry({})]);
  });

  it("keeps ACP keys raw in memory and encoded in shared storage", async () => {
    const acpEntry = entry({ threadKey: "acp:gemini:t1" });

    await store.mergeStarMapArrangement([acpEntry]);

    expect(await store.readStarMapArrangement()).toEqual([acpEntry]);
    expect(
      stateDb.raw.prepare(
        "SELECT entry_key, payload FROM star_map_arrangement",
      ).get(),
    ).toEqual({
      entry_key: "pwr_local acp%3Agemini:t1",
      payload: JSON.stringify({
        ...acpEntry,
        threadKey: "acp%3Agemini:t1",
      }),
    });
  });

  it("merges last-writer-wins per card and reports accepted deltas", async () => {
    await store.mergeStarMapArrangement([entry({})]);
    const older = await store.mergeStarMapArrangement([
      entry({ dx: 99, dy: 99, updatedAt: 500 }),
    ]);
    expect(older.accepted).toEqual([]);
    const newer = await store.mergeStarMapArrangement([
      entry({ dx: 30, dy: 40, updatedAt: 2_000, by: "pwr_remote" }),
    ]);
    expect(newer.accepted).toHaveLength(1);
    const entries = await store.readStarMapArrangement();
    expect(entries).toEqual([
      entry({ dx: 30, dy: 40, updatedAt: 2_000, by: "pwr_remote" }),
    ]);
  });

  it("replaying a snapshot is a no-op", async () => {
    const snapshot = [
      entry({}),
      entry({ threadKey: "codex:t2", dx: -50, dy: 5 }),
    ];
    await store.mergeStarMapArrangement(snapshot);
    const replay = await store.mergeStarMapArrangement(snapshot);
    expect(replay.accepted).toEqual([]);
  });

  it("stores tombstones so slot resets propagate", async () => {
    await store.mergeStarMapArrangement([entry({})]);
    await store.mergeStarMapArrangement([
      entry({ dx: null, dy: null, updatedAt: 3_000 }),
    ]);
    const entries = await store.readStarMapArrangement();
    expect(entries).toEqual([entry({ dx: null, dy: null, updatedAt: 3_000 })]);
  });

  it("drops malformed rows on read and malformed input on merge", async () => {
    const malformed = {
      instanceId: "pwr_local",
      threadKey: "codex:t9",
      dx: 5,
      dy: null,
      updatedAt: 1,
      by: "pwr_local",
    } as unknown as StarMapArrangementEntry;
    const result = await store.mergeStarMapArrangement([malformed]);
    expect(result.accepted).toEqual([]);
    expect(await store.readStarMapArrangement()).toEqual([]);
  });
});

describe("star map workspace overlay", () => {
  it("round-trips viewer-owned cards, satellites, geometry, and cameras", async () => {
    const written = await store.writeStarMapWorkspace(workspace(), 0);

    expect(written).toMatchObject({
      ...workspace(),
      revision: 1,
    });
    expect(written.updatedAt).toBeGreaterThan(0);
    expect(await store.readStarMapWorkspace()).toEqual(written);
  });

  it("increments the revision while replacing the workspace atomically", async () => {
    await store.writeStarMapWorkspace(workspace(), 0);
    const next = workspace();
    next.cards[0].terminalOpen = false;

    const written = await store.writeStarMapWorkspace(next, 1);

    expect(written.revision).toBe(2);
    expect((await store.readStarMapWorkspace()).cards[0].terminalOpen).toBe(
      false,
    );
    expect(
      stateDb.raw.prepare(
        "SELECT COUNT(*) AS count FROM star_map_workspace",
      ).get(),
    ).toEqual({ count: 1 });
  });

  it("rejects a stale full-snapshot write instead of losing newer state", async () => {
    const otherInstanceStore = new SqliteOverlayStore(stateDb);
    const first = workspace();
    const second = workspace();
    second.cards[0].terminalOpen = false;

    await store.writeStarMapWorkspace(first, 0);

    await expect(
      otherInstanceStore.writeStarMapWorkspace(second, 0),
    ).rejects.toThrow(
      "Star Map workspace revision conflict: expected 0, found 1",
    );
    expect(await store.readStarMapWorkspace()).toMatchObject({
      cards: first.cards,
      revision: 1,
    });
  });

  it("degrades a malformed payload without losing its durable revision", async () => {
    stateDb.raw.prepare(
      `INSERT INTO star_map_workspace(
         workspace_key,
         revision,
         updated_at,
         payload
       ) VALUES (?, 1, 100, ?)`,
    ).run(STAR_MAP_WORKSPACE_KEY, "{not-json");

    expect(await store.readStarMapWorkspace()).toMatchObject({
      cards: [],
      revision: 1,
      updatedAt: 100,
      views: {},
    });

    const recovered = await store.writeStarMapWorkspace(workspace(), 1);
    expect(recovered.revision).toBe(2);
    expect(await store.readStarMapWorkspace()).toEqual(recovered);
  });

  it("refuses to overwrite a workspace written by a future version", async () => {
    const futurePayload = JSON.stringify({
      ...workspace(),
      version: STAR_MAP_WORKSPACE_VERSION + 1,
      futureField: { preserve: true },
    });
    stateDb.raw.prepare(
      `INSERT INTO star_map_workspace(
         workspace_key,
         revision,
         updated_at,
         payload
       ) VALUES (?, 9, 100, ?)`,
    ).run(STAR_MAP_WORKSPACE_KEY, futurePayload);

    await expect(store.readStarMapWorkspace()).rejects.toThrow(
      "Unsupported Star Map workspace version: 2",
    );
    await expect(
      store.writeStarMapWorkspace(workspace(), 9),
    ).rejects.toThrow("Unsupported Star Map workspace version: 2");
    expect(
      stateDb.raw.prepare(
        "SELECT revision, payload FROM star_map_workspace",
      ).get(),
    ).toEqual({ revision: 9, payload: futurePayload });
  });

  it("keeps valid cards when another saved card is corrupt", async () => {
    const partial = workspace();
    partial.cards.push({
      ...partial.cards[0],
      key: "wrong-owner::codex:t2",
      thread: { ...partial.cards[0].thread, id: "t2" },
    });
    stateDb.raw.prepare(
      `INSERT INTO star_map_workspace(
         workspace_key,
         revision,
         updated_at,
         payload
       ) VALUES (?, 3, 100, ?)`,
    ).run(STAR_MAP_WORKSPACE_KEY, JSON.stringify(partial));

    expect(await store.readStarMapWorkspace()).toMatchObject({
      cards: workspace().cards,
      revision: 3,
      updatedAt: 100,
    });
  });
});
