import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { operatorQuestionItemKey } from "@pwragent/shared";
import { OperatorRequestStore, OPERATOR_REQUEST_RETENTION_MS } from "@pwragent/sqlite-storage/operator-request-store";
import { ThreadTodoStore } from "@pwragent/sqlite-storage/thread-todo-store";
import { SqliteThreadReviewStorage } from "@pwragent/sqlite-storage/thread-review-storage-sqlite";
import { CURRENT_STATE_DB_USER_VERSION, StateDb } from "@pwragent/sqlite-storage/state-db";
import type { DesktopApi } from "../src/renderer/src/lib/desktop-api";
import { expect, test } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";
import { stateDbPathForHomeRoot } from "./fixtures/readme-state-seeding";

const specDir = path.dirname(fileURLToPath(import.meta.url));

test("desktop preserves portable pending questions and old open-work seen marks and hands closure back to Node", async () => {
  const now = Date.now();
  const old = now - OPERATOR_REQUEST_RETENTION_MS - 60_000;
  const identity = { backend: "codex" as const, threadId: "thread-smoke" };
  const pendingKey = operatorQuestionItemKey("codex", identity.threadId, "portable-pending");
  const siblingKey = operatorQuestionItemKey("claude", identity.threadId, "portable-pending");
  const cardKeys = ["todo:portable-seen-card", "todo:review:portable-seen-review"];
  const app = await launchElectronApp({
    fixturePath: path.join(specDir, "fixtures/smoke/replay.fixture.json"),
    preLaunchHook(homeRoot) {
      const db = StateDb.open(stateDbPathForHomeRoot(homeRoot));
      try {
        const store = new OperatorRequestStore(db);
        for (const backend of ["codex", "claude"] as const) store.insertQuestion({ ...identity, backend,
          messageId: "portable-pending", questions: [{ title: `Invented portable ${backend} question`, options: ["Yes", "No"] }], now: old });
        for (const [messageId, at] of [["portable-expired", old], ["portable-closed", now]] as const) {
          store.insertQuestion({ ...identity, messageId, questions: [{ title: "Invented retired question text", options: null }], now: at });
          store.resolveQuestions({ ...identity, messageIds: [messageId], status: "answered", now: at });
        }
        new ThreadTodoStore(db).insert({ ...identity, id: "portable-seen-card", kind: "reminder",
          title: "Invented old open card", now: old });
        const reviews = new SqliteThreadReviewStorage(db);
        reviews.trackingStartedAt(() => old);
        reviews.insert({ ...identity, id: "portable-seen-review", sourceKey: "portable-seen-artifact", origin: "explicit",
          title: "Invented old open review", status: "open", createdAt: old, updatedAt: old,
          items: [{ id: "finding", title: "Invented open finding", status: "open", createdAt: old, updatedAt: old }] });
        store.markSeen([pendingKey, siblingKey, ...cardKeys, "todo:review:missing-review", "request:retired-process"], old);
      } finally { db.close(); }
    },
  });
  try {
    await app.window.getByRole("button", { name: /Replay smoke thread/i }).first().click();
    await expect(app.window.getByText("The replay harness is live.")).toBeVisible();
    const result = await app.window.evaluate(async ({ identity, pendingKey, cardKeys }) => {
      const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
      const before = await api.listOperatorRequests!({});
      const filtered = await api.listOperatorRequests!(identity);
      await api.markOperatorItemsSeen!({ ...identity, keys: [pendingKey, ...cardKeys, pendingKey] });
      await api.dismissOperatorQuestion!({ ...identity, messageId: "portable-pending" });
      await api.dismissOperatorQuestion!({ ...identity, messageId: "portable-pending" });
      const dismissed = await api.listDismissedOperatorQuestions!(identity);
      const after = await api.listOperatorRequests!({});
      return { before, filtered, dismissed, after };
    }, { identity, pendingKey, cardKeys });
    for (const backend of ["codex", "claude"]) expect(result.before.questions).toContainEqual(expect.objectContaining({
      backend, threadId: identity.threadId, messageId: "portable-pending", createdAt: old,
      questions: [{ title: `Invented portable ${backend} question`, options: ["Yes", "No"] }],
    }));
    expect(result.before.seenKeys).toEqual(expect.arrayContaining([pendingKey, siblingKey, ...cardKeys]));
    expect(result.before.seenKeys).not.toContain("todo:review:missing-review");
    expect(result.before.seenKeys).not.toContain("request:retired-process");
    expect(result.filtered.questions).toHaveLength(1);
    // The federation queue filters questions but retains its global seen set.
    expect(result.filtered.seenKeys.sort()).toEqual([pendingKey, siblingKey, ...cardKeys].sort());
    expect(result.dismissed).toEqual(["portable-pending"]);
    expect(result.after.questions).toHaveLength(1);
    expect(result.after.questions[0]).toMatchObject({ backend: "claude", messageId: "portable-pending" });
    // Observe the actual service's startup retention and closure from a separate
    // read-only WAL connection before a portable opener can do any housekeeping.
    const raw = new Database(stateDbPathForHomeRoot(app.homeRoot), { readonly: true });
    try {
      expect(raw.prepare("SELECT 1 FROM operator_async_questions WHERE message_id = 'portable-expired'").get()).toBeUndefined();
      expect(raw.prepare("SELECT status, questions_json FROM operator_async_questions WHERE backend = 'codex' AND message_id = 'portable-pending'").get())
        .toEqual({ status: "dismissed", questions_json: "[]" });
      expect(raw.prepare("SELECT questions_json FROM operator_async_questions WHERE message_id = 'portable-closed'").pluck().get()).toBe("[]");
      for (const key of [pendingKey, siblingKey, ...cardKeys]) {
        expect(raw.prepare("SELECT seen_at FROM operator_seen_items WHERE item_key = ?").pluck().get(key)).toBe(old);
      }
      expect(raw.prepare("PRAGMA user_version").pluck().get()).toBe(CURRENT_STATE_DB_USER_VERSION);
    } finally { raw.close(); }
    await app.closeApplication();
    const db = StateDb.open(stateDbPathForHomeRoot(app.homeRoot));
    try {
      const store = new OperatorRequestStore(db);
      expect(store.listOpenQuestions()).toEqual(result.after.questions.map(({ threadTitle: _threadTitle, ...question }) => question));
      expect(store.listDismissedQuestionMessageIds(identity)).toEqual(result.dismissed);
      expect(store.insertQuestion({ ...identity, messageId: "portable-pending",
        questions: [{ title: "Invented replay must not resurrect text", options: null }], now: now + 1 })).toBe(false);
      expect(store.listSeenKeys()).toEqual(expect.arrayContaining([pendingKey, siblingKey, ...cardKeys]));
      expect(store.markSeen([pendingKey, ...cardKeys], now + 1)).toBe(0);
      expect(db.raw.prepare("SELECT questions_json FROM operator_async_questions WHERE backend = 'codex' AND message_id = 'portable-pending'").pluck().get()).toBe("[]");
    } finally { db.close(); }
  } finally { await app.close(); }
});
