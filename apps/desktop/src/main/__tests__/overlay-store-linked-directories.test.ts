import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { openInMemoryStateDb } from "./sqlite-test-utils";

let stateDb: StateDb;
let store: SqliteOverlayStore;

beforeEach(() => {
  stateDb = openInMemoryStateDb();
  store = new SqliteOverlayStore(stateDb);
});

afterEach(() => {
  stateDb.close();
});

describe("SqliteOverlayStore — linked directories", () => {
  it("replaces same-path local directories even when their IDs use different shapes", async () => {
    await store.addLinkedDirectory({
      backend: "codex",
      threadId: "thread-1",
      directory: {
        id: "/repo/app",
        kind: "local",
        label: "app",
        path: "/repo/app",
      },
    });

    const overlay = await store.addLinkedDirectory({
      backend: "codex",
      threadId: "thread-1",
      directory: {
        id: "directory:/repo/app",
        kind: "local",
        label: "app",
        path: "/repo/app",
      },
    });

    expect(overlay.extraLinkedDirectories).toEqual([
      {
        id: "directory:/repo/app",
        kind: "local",
        label: "app",
        path: "/repo/app",
      },
    ]);
  });

  it("removes same-path local directories even when their IDs use different shapes", async () => {
    await store.addLinkedDirectory({
      backend: "codex",
      threadId: "thread-1",
      directory: {
        id: "/repo/app",
        kind: "local",
        label: "app",
        path: "/repo/app",
      },
    });

    const overlay = await store.removeLinkedDirectory({
      backend: "codex",
      threadId: "thread-1",
      directory: {
        id: "directory:/repo/app",
        kind: "local",
        label: "app",
        path: "/repo/app",
      },
    });

    expect(overlay.extraLinkedDirectories).toEqual([]);
  });
});
