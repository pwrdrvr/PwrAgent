import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AsyncQuestionStatus, OperatorRequestStorage } from "@pwragent/owner-core/operator-request-storage";
import { operatorQuestionItemKey, type OperatorAsyncQuestion } from "@pwragent/shared";
import { createDesktopOperatorRequestService } from "../operator-requests/operator-request-runtime";
import type { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { createOperatorRequestStorage } from "../storage/desktop-operator-request-storage";
import { openInMemoryStateDb } from "./sqlite-test-utils";

const active = vi.hoisted(() => ({ db: undefined as StateDb | undefined }));
vi.mock("../state/app-state", () => ({ getAppStateDb: () => {
  if (!active.db) throw new Error("App state not initialized");
  return active.db;
} }));
vi.mock("../app-server/backend-registry", () => ({ getDesktopBackendRegistry: () => ({
  getThreadInfo: () => undefined, listPendingServerRequests: () => [], onEvent: () => () => {},
}) }));

afterEach(() => { active.db = undefined; vi.unstubAllEnvs(); });

const RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const operation = fc.record({
  kind: fc.constantFrom("insert", "resolve", "dismiss", "dismissAll", "seen", "prune"),
  backend: fc.constantFrom("codex" as const, "claude" as const),
  threadId: fc.constantFrom("one", "two"),
  messageId: fc.constantFrom("a", "b", "c"),
  messageIds: fc.array(fc.constantFrom("a", "b", "c"), { maxLength: 4 }),
  extraKeys: fc.array(fc.constantFrom("todo:open", "todo:closed", "todo:review:review", "request:gone"), { maxLength: 5 }),
  text: fc.string({ maxLength: 20 }),
  advance: fc.constantFrom(1, RETENTION_MS, RETENTION_MS + 1),
});
type Question = { record: OperatorAsyncQuestion; status: AsyncQuestionStatus; resolvedAt?: number };

describe("operator request storage model", () => {
  it("preserves first records, closure privacy, seen batching and retention with the same commit counts", async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    // Model: identity-keyed questions and first-seen timestamps. Closed question
    // text is discarded; only closed records and unprotected old marks expire.
    await fc.assert(fc.asyncProperty(fc.array(operation, { minLength: 1, maxLength: 40 }), async (operations) => {
      const db = openInMemoryStateDb();
      active.db = db;
      const store: OperatorRequestStorage = createOperatorRequestStorage();
      const questions = new Map<string, Question>();
      const seen = new Map<string, number>();
      let now = 0;
      try {
        db.raw.prepare(`INSERT INTO thread_todos(todo_id, backend, thread_id, kind, status, title, created_at, updated_at)
          VALUES (?, ?, ?, 'task', ?, 'Fixture', 0, 0)`)
          .run("open", "codex", "one", "open");
        db.raw.prepare(`INSERT INTO thread_todos(todo_id, backend, thread_id, kind, status, title, created_at, updated_at)
          VALUES (?, ?, ?, 'task', ?, 'Fixture', 0, 0)`)
          .run("closed", "claude", "two", "done");
        db.raw.prepare("INSERT INTO thread_reviews(review_id, backend, thread_id, status, updated_at, payload) VALUES ('review', 'codex', 'two', 'handled', 0, '{}')").run();
        const cards = [
          { key: "todo:open", backend: "codex", threadId: "one" },
          { key: "todo:closed", backend: "claude", threadId: "two" },
          { key: "todo:review:review", backend: "codex", threadId: "two" },
        ];
        for (const op of operations) {
          now += op.advance;
          const identity = { backend: op.backend, threadId: op.threadId, messageId: op.messageId };
          const key = JSON.stringify(identity);
          const question = questions.get(key);
          let result: boolean | number | undefined;
          let commits = 0;
          let rows = 0;
          const closing = [...questions.values()].filter((entry) => entry.status === "open"
            && entry.record.backend === op.backend && entry.record.threadId === op.threadId
            && (op.kind === "dismissAll" || (op.kind === "dismiss"
              ? entry.record.messageId === op.messageId : op.messageIds.some((id) => id === entry.record.messageId))));
          const record = { ...identity, questions: [{ title: `Question ${op.text}`, options: ["Yes", "No"] }], now };
          const keys = [operatorQuestionItemKey(op.backend, op.threadId, op.messageId), ...op.extraKeys];
          if (op.kind === "insert") {
            result = !question;
            commits = 1;
            if (!question) {
              questions.set(key, { record: { ...identity, questions: record.questions, createdAt: now }, status: "open" });
              rows = 1;
            }
          } else if (op.kind === "seen") {
            const fresh = [...new Set(keys)].filter((key) => !seen.has(key));
            for (const key of fresh) seen.set(key, now);
            result = rows = fresh.length;
            commits = fresh.length ? 1 : 0;
          } else if (op.kind === "prune") {
            const protectedKeys = new Set(["todo:open", ...[...questions.values()]
              .filter((entry) => entry.status === "open")
              .map(({ record }) => operatorQuestionItemKey(record.backend, record.threadId, record.messageId))]);
            for (const [key, entry] of questions) {
              if (entry.status !== "open" && entry.resolvedAt! < now - RETENTION_MS) { questions.delete(key); rows++; }
            }
            for (const [key, at] of seen) {
              if (at < now - RETENTION_MS && !protectedKeys.has(key)) { seen.delete(key); rows++; }
            }
            commits = rows ? 1 : 0;
          } else {
            for (const entry of closing) {
              entry.status = op.kind === "resolve" ? "answered" : "dismissed";
              entry.record = { ...entry.record, questions: [] };
              entry.resolvedAt = now;
            }
            rows = closing.length;
            result = rows > 0;
            commits = op.kind === "dismiss" ? Number(result)
              : op.kind === "resolve" && !op.messageIds.length ? 0 : 1;
          }
          const actual = await measureSqliteWrites(() => {
            if (op.kind === "insert") return store.insertQuestion(record);
            if (op.kind === "seen") return store.markSeen(keys, now);
            if (op.kind === "prune") return store.prune(now);
            if (op.kind === "dismiss") return store.dismissQuestion({ ...identity, now });
            if (op.kind === "dismissAll") return store.dismissQuestionsForThread({ ...identity, now });
            return store.resolveQuestions({ ...identity, messageIds: op.messageIds, status: "answered", now });
          });
          expect(actual.result).toBe(result);
          expect({ commits: actual.writes.commits, rows: actual.writes.rowsChanged }).toEqual({ commits, rows });
          expect(store.listOpenQuestions()).toEqual([...questions.values()].filter((entry) => entry.status === "open")
            .sort((a, b) => b.record.createdAt - a.record.createdAt).map((entry) => entry.record));
          expect(store.listSeenKeys().sort()).toEqual([...seen.keys()].sort());
          expect(db.raw.prepare("SELECT questions_json FROM operator_async_questions WHERE status != 'open'").all())
            .toEqual([...questions.values()].filter((entry) => entry.status !== "open").map(() => ({ questions_json: "[]" })));
          for (const backend of ["codex", "claude"] as const) {
            for (const threadId of ["one", "two"]) {
              expect(store.listDismissedQuestionMessageIds({ backend, threadId }).sort()).toEqual([...questions.values()]
                .filter((entry) => entry.status === "dismissed" && entry.record.backend === backend && entry.record.threadId === threadId)
                .map((entry) => entry.record.messageId).sort());
              expect(store.listTodoItemKeys({ backend, threadId }).sort()).toEqual(cards
                .filter((card) => card.backend === backend && card.threadId === threadId).map((card) => card.key).sort());
            }
          }
          expect(store.listTodoItemKeys({}).sort()).toEqual(cards.map((card) => card.key).sort());
        }
      } finally { active.db = undefined; db.close(); }
    }), { numRuns: 25 });
  });

  it("binds each service to the profile active at its construction without rebinding older services", () => {
    const first = openInMemoryStateDb();
    const second = openInMemoryStateDb();
    try {
      const services = [first, second].map((db, index) => {
        active.db = db;
        const store = createOperatorRequestStorage();
        store.insertQuestion({ backend: "codex", threadId: "same", messageId: String(index),
          questions: [{ title: "Fixture question", options: null }], now: 1 });
        return createDesktopOperatorRequestService(() => {});
      });
      expect(services[0]!.list().questions.map((entry) => entry.messageId)).toEqual(["0"]);
      expect(services[1]!.list().questions.map((entry) => entry.messageId)).toEqual(["1"]);
      active.db = undefined;
      expect(() => createDesktopOperatorRequestService(() => {})).toThrow("App state not initialized");
      expect(services[0]!.list().questions.map((entry) => entry.messageId)).toEqual(["0"]);
    } finally { active.db = undefined; first.close(); second.close(); }
  });
});
