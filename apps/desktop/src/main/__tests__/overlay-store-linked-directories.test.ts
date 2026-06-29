import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";

let stateDb: StateDb;
let store: SqliteOverlayStore;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "pwragent-linked-dirs-test-"));
  stateDb = StateDb.open(path.join(tempDir, "state.db"));
  store = new SqliteOverlayStore(stateDb);
});

afterEach(() => {
  stateDb.close();
  rmSync(tempDir, { recursive: true, force: true });
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
});
