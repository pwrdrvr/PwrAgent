import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ThreadPermissionTransition } from "@pwragent/shared";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";

let stateDb: StateDb;
let store: SqliteOverlayStore;
let tempDir: string;

function buildTransition(
  overrides: Partial<ThreadPermissionTransition>,
): ThreadPermissionTransition {
  return {
    id: "01HV0000000000000000000001",
    fromExecutionMode: "default",
    toExecutionMode: "full-access",
    status: "queued",
    occurredAt: 1000,
    queueId: "queue-1",
    ...overrides,
  };
}

beforeEach(() => {
  tempDir = mkdtempSync(
    path.join(os.tmpdir(), "pwragent-permission-transitions-test-"),
  );
  stateDb = StateDb.open(path.join(tempDir, "state.db"));
  store = new SqliteOverlayStore(stateDb);
});

afterEach(() => {
  stateDb.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("SqliteOverlayStore — permission transition log", () => {
  it("appends a transition entry that getThreadOverlayState surfaces", async () => {
    await store.appendPermissionTransition({
      backend: "codex",
      threadId: "thread-1",
      transition: buildTransition({ id: "entry-1", status: "queued" }),
    });

    const overlay = await store.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(overlay?.permissionTransitionLog).toEqual([
      buildTransition({ id: "entry-1", status: "queued" }),
    ]);
  });

  it("evicts the oldest entry when 101 transitions are appended", async () => {
    for (let index = 0; index < 101; index += 1) {
      await store.appendPermissionTransition({
        backend: "codex",
        threadId: "thread-1",
        transition: buildTransition({
          id: `entry-${index}`,
          occurredAt: 1000 + index,
        }),
      });
    }

    const overlay = await store.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(overlay?.permissionTransitionLog).toHaveLength(100);
    expect(overlay?.permissionTransitionLog?.[0]?.id).toBe("entry-1");
    expect(overlay?.permissionTransitionLog?.[99]?.id).toBe("entry-100");
  });

  it("does NOT persist queued execution-mode fields across reopen", async () => {
    // Seed an overlay with executionMode + a transition log entry, then
    // simulate the registry-memory queue by writing the queue fields
    // through setThreadExecutionMode + a side-channel manipulation that
    // we'd never do in real code — except we DON'T have a public
    // setter for queue fields, so the only way to verify persistence
    // semantics is to confirm the ThreadOverlayState read does not
    // resurrect queue fields after reopen, even when an
    // appendPermissionTransition has happened in between.
    await store.setThreadExecutionMode({
      backend: "codex",
      threadId: "thread-1",
      executionMode: "default",
    });
    await store.appendPermissionTransition({
      backend: "codex",
      threadId: "thread-1",
      transition: buildTransition({ id: "entry-1", status: "applied" }),
    });

    const dbPath = path.join(tempDir, "state.db");
    stateDb.close();

    const reopened = StateDb.open(dbPath);
    const reopenedStore = new SqliteOverlayStore(reopened);
    const overlay = await reopenedStore.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-1",
    });
    // Transition log persists.
    expect(overlay?.permissionTransitionLog).toEqual([
      buildTransition({ id: "entry-1", status: "applied" }),
    ]);
    // Queue fields, even if they leaked into the in-memory state at
    // some point, are never serialized — they reset to undefined on
    // reopen.
    expect(overlay?.queuedExecutionMode).toBeUndefined();
    expect(overlay?.queuedExecutionModeAt).toBeUndefined();
    reopened.close();

    // Re-open the original handle so afterEach's close doesn't double-close.
    stateDb = StateDb.open(dbPath);
    store = new SqliteOverlayStore(stateDb);
  });

  it("scopes the log per (backend, threadId)", async () => {
    await store.appendPermissionTransition({
      backend: "codex",
      threadId: "thread-1",
      transition: buildTransition({ id: "codex-1" }),
    });
    await store.appendPermissionTransition({
      backend: "grok",
      threadId: "thread-1",
      transition: buildTransition({ id: "grok-1" }),
    });

    const codex = await store.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-1",
    });
    const grok = await store.getThreadOverlayState({
      backend: "grok",
      threadId: "thread-1",
    });

    expect(codex?.permissionTransitionLog?.map((entry) => entry.id)).toEqual([
      "codex-1",
    ]);
    expect(grok?.permissionTransitionLog?.map((entry) => entry.id)).toEqual([
      "grok-1",
    ]);
  });
});
