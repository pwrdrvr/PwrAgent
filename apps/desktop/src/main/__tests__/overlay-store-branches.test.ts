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
  tempDir = mkdtempSync(path.join(os.tmpdir(), "pwragent-branches-test-"));
  stateDb = StateDb.open(path.join(tempDir, "state.db"));
  store = new SqliteOverlayStore(stateDb);
});

afterEach(() => {
  stateDb.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("SqliteOverlayStore branch metadata", () => {
  it("promotes legacy observed branch metadata before recording checkout drift", async () => {
    await store.setThreadObservedBranch({
      backend: "codex",
      threadId: "thread-1",
      branch: "feature/expected",
    });

    const initialOverlay = await store.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(initialOverlay?.gitBranch).toBeUndefined();
    expect(initialOverlay?.observedGitBranch).toBe("feature/expected");

    await store.setThreadObservedBranch({
      backend: "codex",
      threadId: "thread-1",
      branch: "feature/current",
    });

    await expect(
      store.getThreadOverlayState({ backend: "codex", threadId: "thread-1" }),
    ).resolves.toMatchObject({
      gitBranch: "feature/expected",
      observedGitBranch: "feature/current",
    });
  });

  it("uses the caller supplied expected branch when recording checkout drift", async () => {
    await store.setThreadObservedBranch({
      backend: "codex",
      threadId: "thread-1",
      branch: "feature/current",
      expectedBranch: "feature/expected",
    });

    await expect(
      store.getThreadOverlayState({ backend: "codex", threadId: "thread-1" }),
    ).resolves.toMatchObject({
      gitBranch: "feature/expected",
      observedGitBranch: "feature/current",
    });
  });
});
