import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ScheduledThreadActionStore } from "../scheduled-actions/scheduled-thread-action-store";
import { StateDb } from "../state/state-db";

let stateDb: StateDb;
let store: ScheduledThreadActionStore;

beforeEach(() => {
  stateDb = StateDb.open(":memory:");
  store = new ScheduledThreadActionStore(stateDb);
});

afterEach(() => {
  stateDb.close();
});

describe("ScheduledThreadActionStore", () => {
  const claim = (now: number, ownerId = "instance-1") => ({
    now,
    ownerId,
    leaseExpiresAt: now + 30_000,
  });

  it("persists scheduled actions and filters them by thread", () => {
    store.create({
      id: "scheduled-1",
      backend: "codex",
      threadId: "thread-1",
      kind: "turn",
      origin: "desktop",
      scheduledFor: 20_000,
      displayText: "Follow up",
      turn: { input: [{ type: "text", text: "Follow up" }] },
      now: 1_000,
    });
    store.create({
      id: "scheduled-2",
      backend: "codex",
      threadId: "thread-2",
      kind: "review",
      origin: "desktop",
      scheduledFor: 30_000,
      displayText: "/review",
      review: { target: { type: "uncommittedChanges" } },
      now: 2_000,
    });

    expect(store.list({ backend: "codex", threadId: "thread-1" })).toEqual([
      expect.objectContaining({
        id: "scheduled-1",
        status: "scheduled",
        displayText: "Follow up",
      }),
    ]);
    expect(store.nextScheduledAt()).toBe(20_000);
  });

  it("lists retained failures without hydrating unrelated terminal history", () => {
    for (const [id, scheduledFor] of [
      ["active", 10_000],
      ["failed", 20_000],
      ["cancelled", 30_000],
    ] as const) {
      store.create({
        id,
        backend: "codex",
        threadId: "thread-1",
        kind: "turn",
        origin: "desktop",
        scheduledFor,
        displayText: id,
        turn: { input: [{ type: "text", text: id }] },
        now: 1_000,
      });
    }
    store.claim("failed", claim(2_000));
    store.markFailed("failed", "backend offline", 3_000, "instance-1");
    store.cancel("cancelled", 4_000);

    expect(store.list({ includeFailed: true })).toEqual([
      expect.objectContaining({ id: "active", status: "scheduled" }),
      expect.objectContaining({ id: "failed", status: "failed" }),
    ]);
  });

  it("atomically claims due actions once", () => {
    store.create({
      id: "scheduled-1",
      backend: "codex",
      threadId: "thread-1",
      kind: "turn",
      origin: "desktop",
      scheduledFor: 10_000,
      displayText: "First",
      turn: { input: [{ type: "text", text: "First" }] },
      now: 1_000,
    });
    store.create({
      id: "scheduled-2",
      backend: "codex",
      threadId: "thread-1",
      kind: "turn",
      origin: "desktop",
      scheduledFor: 20_000,
      displayText: "Second",
      turn: { input: [{ type: "text", text: "Second" }] },
      now: 2_000,
    });

    expect(store.claimNextDue(claim(15_000))).toMatchObject({
      id: "scheduled-1",
      status: "dispatching",
    });
    expect(store.claimNextDue(claim(15_000))).toBeUndefined();
    expect(store.get("scheduled-2")).toMatchObject({ status: "scheduled" });
  });

  it("updates and cancels only actions that have not dispatched", () => {
    store.create({
      id: "scheduled-1",
      backend: "codex",
      threadId: "thread-1",
      kind: "turn",
      origin: "desktop",
      scheduledFor: 10_000,
      displayText: "Original",
      turn: { input: [{ type: "text", text: "Original" }] },
      now: 1_000,
    });

    expect(store.update("scheduled-1", {
      scheduledFor: 12_000,
      displayText: "Updated",
      turn: { input: [{ type: "text", text: "Updated" }] },
      now: 2_000,
    })).toMatchObject({
      scheduledFor: 12_000,
      displayText: "Updated",
    });
    expect(store.cancel("scheduled-1", 3_000)).toMatchObject({
      status: "cancelled",
    });
    expect(store.update("scheduled-1", {
      displayText: "Too late",
      now: 4_000,
    })).toBeUndefined();
  });

  it("recovers registry-queued work after a main-process restart", () => {
    store.create({
      id: "scheduled-1",
      backend: "codex",
      threadId: "thread-1",
      kind: "turn",
      origin: "desktop",
      scheduledFor: 10_000,
      displayText: "Follow up",
      turn: { input: [{ type: "text", text: "Follow up" }] },
      now: 1_000,
    });
    store.claim("scheduled-1", claim(10_000));
    store.markQueued("scheduled-1", "queue-1", 10_001, "instance-1");

    expect(store.recoverExpiredClaims(20_000)).toEqual([]);
    expect(store.expiredClaimOwnerIds(40_000)).toEqual(["instance-1"]);
    expect(
      store.recoverExpiredClaims(40_000, new Set(["instance-1"])),
    ).toEqual([]);
    expect(store.recoverExpiredClaims(40_000)).toEqual([
      expect.objectContaining({
        id: "scheduled-1",
        queueEntryId: undefined,
        status: "scheduled",
      }),
    ]);
    expect(store.claimNextDue(claim(40_000))).toMatchObject({
      id: "scheduled-1",
      status: "dispatching",
    });
  });

  it("does not automatically replay an ambiguous interrupted dispatch", () => {
    store.create({
      id: "scheduled-1",
      backend: "codex",
      threadId: "thread-1",
      kind: "turn",
      origin: "desktop",
      scheduledFor: 10_000,
      displayText: "Follow up",
      turn: { input: [{ type: "text", text: "Follow up" }] },
      now: 1_000,
    });
    store.claim("scheduled-1", claim(10_000));

    expect(store.recoverExpiredClaims(20_000)).toEqual([]);
    expect(store.recoverExpiredClaims(40_000)).toEqual([
      expect.objectContaining({
        id: "scheduled-1",
        status: "failed",
        errorMessage: expect.stringContaining("Check the thread"),
      }),
    ]);
    expect(store.claimNextDue(claim(40_000))).toBeUndefined();
  });

  it("keeps accepted prompt and attachment content out of desktop SQLite", () => {
    const temporaryDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "pwragent-scheduled-store-"),
    );
    const diskDb = StateDb.open(path.join(temporaryDirectory, "state.db"));
    try {
      const diskStore = new ScheduledThreadActionStore(diskDb);
      const sensitiveText = "sqlite-boundary-secret-6f8182";
      diskStore.create({
        id: "scheduled-sensitive",
        backend: "codex",
        threadId: "thread-1",
        kind: "turn",
        origin: "desktop",
        scheduledFor: 10_000,
        displayText: sensitiveText,
        imageAttachments: [{
          id: "image-1",
          name: "private.png",
          size: 17,
          type: "image/png",
          url: "data:image/png;base64,c2Vuc2l0aXZlLWltYWdl",
        }],
        turn: { input: [{ type: "text", text: sensitiveText }] },
        now: 1_000,
      });

      const row = diskDb.raw.prepare(
        "SELECT * FROM scheduled_thread_actions WHERE action_id = ?",
      ).get("scheduled-sensitive");
      const serializedRow = JSON.stringify(row);
      expect(serializedRow).not.toContain(sensitiveText);
      expect(serializedRow).not.toContain("c2Vuc2l0aXZlLWltYWdl");
      expect(diskStore.get("scheduled-sensitive")?.displayText).toBe(sensitiveText);
    } finally {
      diskDb.close();
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("moves legacy SQLite payload content into the approved payload store", () => {
    const temporaryDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "pwragent-scheduled-migration-"),
    );
    const dbPath = path.join(temporaryDirectory, "state.db");
    let legacyDb = StateDb.open(dbPath);
    try {
      legacyDb.raw.exec(`
        DROP TABLE scheduled_thread_actions;
        CREATE TABLE scheduled_thread_actions (
          action_id TEXT PRIMARY KEY,
          backend TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          origin TEXT NOT NULL,
          status TEXT NOT NULL,
          scheduled_for INTEGER NOT NULL,
          queue_entry_id TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          payload TEXT NOT NULL
        );
        PRAGMA user_version = 39;
      `);
      const sensitiveText = "legacy-sqlite-prompt-eaa631";
      legacyDb.raw.prepare(
        `INSERT INTO scheduled_thread_actions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "scheduled-legacy",
        "codex",
        "thread-1",
        "turn",
        "desktop",
        "scheduled",
        10_000,
        null,
        1_000,
        1_000,
        JSON.stringify({
          id: "scheduled-legacy",
          backend: "codex",
          threadId: "thread-1",
          kind: "turn",
          origin: "desktop",
          status: "scheduled",
          scheduledFor: 10_000,
          displayText: sensitiveText,
          turn: { input: [{ type: "text", text: sensitiveText }] },
          createdAt: 1_000,
          updatedAt: 1_000,
        }),
      );
      legacyDb.close();

      legacyDb = StateDb.open(dbPath);
      const migratedStore = new ScheduledThreadActionStore(legacyDb);
      const row = legacyDb.raw.prepare(
        "SELECT payload, payload_ref FROM scheduled_thread_actions WHERE action_id = ?",
      ).get("scheduled-legacy") as { payload: string; payload_ref: string };

      expect(row.payload).toBe("{}");
      expect(row.payload_ref).toMatch(/\.json$/);
      expect(migratedStore.get("scheduled-legacy")?.displayText).toBe(sensitiveText);
    } finally {
      legacyDb.close();
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
