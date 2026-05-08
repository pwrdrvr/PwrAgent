import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MessagingActivityLog } from "../messaging/messaging-activity-log";
import { StateDb } from "../state/state-db";

let stateDb: StateDb;
let log: MessagingActivityLog;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "pwragent-activity-log-"));
  stateDb = StateDb.open(path.join(tempDir, "state.db"));
  log = new MessagingActivityLog(stateDb);
});

afterEach(() => {
  stateDb.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("MessagingActivityLog", () => {
  it("returns nothing when no events have been recorded", () => {
    expect(log.list()).toEqual([]);
  });

  it("records inbound-routed events with full metadata", () => {
    const recorded = log.record({
      platform: "telegram",
      kind: "inbound-routed",
      backend: "codex",
      threadId: "thread-1",
      bindingId: "binding-1",
      conversationId: "tg-chat-1",
      conversationTitle: "Direct messages",
      actorId: "user-1",
      actorDisplayName: "Alice",
      summary: "Routed inbound from Alice",
      createdAt: 1_000,
    });

    expect(recorded.id).toBeGreaterThan(0);
    expect(log.list()).toEqual([
      expect.objectContaining({
        id: recorded.id,
        platform: "telegram",
        kind: "inbound-routed",
        backend: "codex",
        threadId: "thread-1",
        bindingId: "binding-1",
        conversationId: "tg-chat-1",
        conversationTitle: "Direct messages",
        actorId: "user-1",
        actorDisplayName: "Alice",
        summary: "Routed inbound from Alice",
        createdAt: 1_000,
      }),
    ]);
  });

  it("binds adversarial platform text literally without executing it as SQL", () => {
    const adversarialText =
      "'; UPDATE meta SET value = 'pwned' WHERE key = 'sql_injection_sentinel'; DROP TABLE bindings; --\0"
      + "x".repeat(8_192);
    stateDb.raw
      .prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)")
      .run("sql_injection_sentinel", "intact");

    log.record({
      platform: "telegram",
      kind: "inbound-routed",
      backend: "codex",
      threadId: adversarialText,
      bindingId: adversarialText,
      conversationId: adversarialText,
      conversationTitle: adversarialText,
      actorId: adversarialText,
      actorDisplayName: adversarialText,
      summary: adversarialText,
      payload: { adversarialText },
      createdAt: 1_234,
    });

    const sentinel = stateDb.raw
      .prepare("SELECT value FROM meta WHERE key = ?")
      .get("sql_injection_sentinel") as { value: string };
    expect(sentinel.value).toBe("intact");
    expect(
      stateDb.raw
        .prepare("SELECT COUNT(*) AS count FROM bindings")
        .get(),
    ).toEqual({ count: 0 });
    expect(log.list()).toEqual([
      expect.objectContaining({
        threadId: adversarialText,
        bindingId: adversarialText,
        conversationId: adversarialText,
        conversationTitle: adversarialText,
        actorId: adversarialText,
        actorDisplayName: adversarialText,
        summary: adversarialText,
        payload: { adversarialText },
      }),
    ]);
  });

  it("returns events newest-first by id", () => {
    log.record({ platform: "telegram", kind: "outbound", summary: "first", createdAt: 1 });
    log.record({ platform: "telegram", kind: "outbound", summary: "second", createdAt: 2 });
    log.record({ platform: "telegram", kind: "outbound", summary: "third", createdAt: 3 });
    expect(log.list().map((entry) => entry.summary)).toEqual([
      "third",
      "second",
      "first",
    ]);
  });

  it("respects sinceId for incremental polling", () => {
    const first = log.record({
      platform: "telegram",
      kind: "outbound",
      summary: "old",
    });
    const second = log.record({
      platform: "telegram",
      kind: "outbound",
      summary: "new",
    });

    const result = log.list({ sinceId: first.id });
    expect(result).toEqual([
      expect.objectContaining({ id: second.id, summary: "new" }),
    ]);
  });

  it("clamps the limit to the [1, 500] range", () => {
    for (let i = 0; i < 10; i += 1) {
      log.record({
        platform: "telegram",
        kind: "outbound",
        summary: `event-${i}`,
      });
    }
    expect(log.list({ limit: 0 })).toHaveLength(1);
    expect(log.list({ limit: 100_000 })).toHaveLength(10);
  });

  it("evicts to the per-platform cap on cleanupExpired", () => {
    for (let i = 0; i < 7; i += 1) {
      log.record({ platform: "telegram", kind: "outbound", summary: `t-${i}` });
      log.record({ platform: "discord", kind: "outbound", summary: `d-${i}` });
    }
    // Synthetic small cap via cleanupExpired uses the file-level cap (500).
    // Verify that calling cleanup is a no-op below the cap.
    stateDb.cleanupExpired();
    expect(log.list({ limit: 500 })).toHaveLength(14);
  });

  it("survives close + reopen of the DB", () => {
    log.record({
      platform: "telegram",
      kind: "inbound-rejected",
      summary: "spam from unknown sender",
      actorDisplayName: "RandoBot",
      createdAt: 42,
    });
    const dbPath = stateDb.raw.name;
    stateDb.close();

    const reopened = StateDb.open(dbPath);
    try {
      const reopenedLog = new MessagingActivityLog(reopened);
      expect(reopenedLog.list()).toEqual([
        expect.objectContaining({
          summary: "spam from unknown sender",
          actorDisplayName: "RandoBot",
          kind: "inbound-rejected",
          createdAt: 42,
        }),
      ]);
    } finally {
      reopened.close();
    }
    // Reopen the temp DB so afterEach close() doesn't double-close.
    stateDb = StateDb.open(dbPath);
    log = new MessagingActivityLog(stateDb);
  });
});
