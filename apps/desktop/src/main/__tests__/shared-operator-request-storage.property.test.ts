import fc from "fast-check";
import { afterEach, expect, it, vi } from "vitest";
import type { AppServerBackendKind, CodexAsyncQuestion, OperatorAsyncQuestion } from "@pwragent/shared";
import { operatorQuestionItemKey } from "@pwragent/shared";
import type { AsyncQuestionStatus } from "@pwragent/owner-core/operator-request-storage";
import { OperatorRequestStore as SharedStore } from "@pwragent/sqlite-storage/operator-request-store";
import { StateDb } from "@pwragent/sqlite-storage/state-db";
import { OperatorRequestStore as DesktopStore } from "../storage/operator-request-store";
import { createOperatorRequestStorage } from "../storage/desktop-operator-request-storage";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { createTempStateDb, openInMemoryStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

const active = vi.hoisted(() => ({ db: undefined as StateDb | undefined }));
vi.mock("../state/app-state", () => ({ getAppStateDb: () => {
  if (!active.db) throw new Error("No invented profile selected");
  return active.db;
} }));
afterEach(() => { active.db = undefined; vi.unstubAllEnvs(); });

const bindings = [SharedStore, DesktopStore];
const retention = 30 * 24 * 60 * 60 * 1_000;
const backends = ["codex", "claude", "acp:kimi"] as const;
const ids = ["same", "other", "id' ); DROP TABLE meta; -- 雪"];
const identityKey = (backend: AppServerBackendKind, threadId: string, messageId: string) =>
  JSON.stringify([backend, threadId, messageId]);
type Question = { record: OperatorAsyncQuestion; status: AsyncQuestionStatus; resolvedAt: number | null };
type Card = { id: string; kind: "todo" | "review"; backend: AppServerBackendKind; threadId: string; open: boolean; exists: boolean };
const cardKey = (card: Card) => card.kind === "review" ? `todo:review:${card.id}` : `todo:${card.id}`;

it("binds generated concrete and actual profile factory choices to one portable implementation", () => {
  fc.assert(fc.property(fc.integer({ min: 0, max: 1 }), fc.boolean(), (host, useFactory) => {
    const db = openInMemoryStateDb();
    try {
      active.db = db;
      const store = useFactory ? createOperatorRequestStorage() : new bindings[host]!(db);
      expect(Object.getPrototypeOf(store)).toBe(SharedStore.prototype);
      // A factory captures its selected profile, rather than consulting it on
      // every later operation or exposing the database on its public port.
      active.db = undefined;
      expect(store.markSeen(["invented-portable-key"], 42)).toBe(1);
      expect(new SharedStore(db).listSeenKeys()).toEqual(["invented-portable-key"]);
    } finally { db.close(); }
  }));
});

// The oracle is a map of first records and first-seen times. Closed text is
// erased immediately. Retention expires closed identities and old marks only
// after their exact deadline, and never makes still-open work unread.
it("matches independent question, seen and open-work retention models across WAL hosts and reopens", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  await fc.assert(fc.asyncProperty(fc.array(fc.record({
    host: fc.integer({ min: 0, max: 1 }), backend: fc.constantFrom(...backends),
    threadId: fc.constantFrom(...ids), messageId: fc.constantFrom(...ids),
    messageIds: fc.array(fc.constantFrom(...ids), { maxLength: 4 }),
    kind: fc.constantFrom("insert", "answer", "dismiss", "dismissAll", "seen", "prune", "card", "read"),
    text: fc.string({ maxLength: 24 }), card: fc.integer({ min: 0, max: 5 }),
    cardState: fc.constantFrom("open", "closed", "missing"), reopen: fc.boolean(),
    advance: fc.constantFrom(1, retention - 1, retention, retention + 1),
  }), { minLength: 1, maxLength: 30 }), async commands => {
    const fixture = createTempStateDb("shared-operator-model-");
    const dbs = bindings.map(() => StateDb.open(fixture.dbPath));
    const stores = dbs.map((db, index) => new bindings[index]!(db));
    const questions = new Map<string, Question>();
    const seen = new Map<string, number>();
    const cards: Card[] = backends.flatMap((backend, index) => [
      { id: `task-${index}`, kind: "todo", backend, threadId: ids[index]!, open: true, exists: true },
      { id: `review-${index}`, kind: "review", backend, threadId: ids[index]!, open: true, exists: true },
    ]);
    let now = 0;
    const writeCard = (card: Card, db: StateDb) => {
      if (card.kind === "todo") {
        db.raw.prepare("DELETE FROM thread_todos WHERE todo_id = ?").run(card.id);
        if (card.exists) db.raw.prepare(`INSERT INTO thread_todos
          (todo_id, backend, thread_id, kind, status, title, created_at, updated_at)
          VALUES (?, ?, ?, 'task', ?, 'Invented card', 0, 0)`)
          .run(card.id, card.backend, card.threadId, card.open ? "open" : "done");
      } else {
        db.raw.prepare("DELETE FROM thread_reviews WHERE review_id = ?").run(card.id);
        if (card.exists) db.raw.prepare(`INSERT INTO thread_reviews
          (review_id, backend, thread_id, status, updated_at, payload) VALUES (?, ?, ?, ?, 0, '{}')`)
          .run(card.id, card.backend, card.threadId, card.open ? "open" : "handled");
      }
    };
    try {
      for (const card of cards) writeCard(card, dbs[0]!);
      // Every run starts with old seen open cards of both kinds. This ensures
      // the review preservation invariant is exercised even by a shrunk run.
      stores[0]!.markSeen(cards.map(cardKey), 0);
      for (const card of cards) seen.set(cardKey(card), 0);
      for (const command of commands) {
        now += command.advance;
        const store = stores[command.host]!;
        const identity = { backend: command.backend, threadId: command.threadId, messageId: command.messageId };
        const key = identityKey(command.backend, command.threadId, command.messageId);
        const previous = questions.get(key);
        const text: CodexAsyncQuestion[] = [{ title: `Invented ${command.text}`, options: ["Yes", "No"] }];
        const keys = [operatorQuestionItemKey(command.backend, command.threadId, command.messageId),
          ...cards.map(cardKey), "request:gone", "request:gone"];
        let expected: boolean | number | undefined;
        let commits = 0;
        let rows = 0;
        if (command.kind === "insert") {
          expected = !previous;
          commits = 1;
          if (!previous) {
            rows = 1;
            questions.set(key, { record: { ...identity, questions: text, createdAt: now }, status: "open", resolvedAt: null });
          }
        } else if (command.kind === "seen") {
          for (const key of keys) if (!seen.has(key)) { seen.set(key, now); rows++; }
          expected = rows;
          commits = Number(rows > 0);
        } else if (["answer", "dismiss", "dismissAll"].includes(command.kind)) {
          for (const entry of questions.values()) {
            if (entry.status !== "open" || entry.record.backend !== command.backend || entry.record.threadId !== command.threadId) continue;
            const closes = command.kind === "dismissAll" || (command.kind === "dismiss"
              ? entry.record.messageId === command.messageId : command.messageIds.includes(entry.record.messageId));
            if (!closes) continue;
            entry.status = command.kind === "answer" ? "answered" : "dismissed";
            entry.resolvedAt = now;
            entry.record = { ...entry.record, questions: [] };
            rows++;
          }
          expected = rows > 0;
          commits = command.kind === "dismiss" ? Number(expected)
            : command.kind === "answer" && !command.messageIds.length ? 0 : 1;
        } else if (command.kind === "prune") {
          const protectedKeys = new Set(cards.filter(card => card.exists && card.open).map(cardKey));
          for (const entry of questions.values()) if (entry.status === "open") {
            protectedKeys.add(operatorQuestionItemKey(entry.record.backend, entry.record.threadId, entry.record.messageId));
          }
          for (const [key, entry] of questions) if (entry.status !== "open" && entry.resolvedAt! < now - retention) {
            questions.delete(key); rows++;
          }
          for (const [key, at] of seen) if (at < now - retention && !protectedKeys.has(key)) { seen.delete(key); rows++; }
          commits = Number(rows > 0);
        } else if (command.kind === "card") {
          const card = cards[command.card]!;
          card.exists = command.cardState !== "missing";
          card.open = command.cardState === "open";
          writeCard(card, dbs[command.host]!);
        }
        const measured = await measureSqliteWrites(() => {
          if (command.kind === "insert") return store.insertQuestion({ ...identity, questions: text, now });
          if (command.kind === "answer") return store.resolveQuestions({ ...identity, messageIds: command.messageIds, status: "answered", now });
          if (command.kind === "dismiss") return store.dismissQuestion({ ...identity, now });
          if (command.kind === "dismissAll") return store.dismissQuestionsForThread({ ...identity, now });
          if (command.kind === "seen") return store.markSeen(keys, now);
          if (command.kind === "prune") return store.prune(now);
        });
        expect(measured.result).toBe(expected);
        expect({ commits: measured.writes.commits, rows: measured.writes.rowsChanged }).toEqual({ commits, rows });
        if (command.reopen) {
          dbs[command.host]!.close();
          const reopened = await measureSqliteWrites(() => StateDb.open(fixture.dbPath));
          expect(reopened.writes.commits).toBe(0);
          dbs[command.host] = reopened.result;
          stores[command.host] = new bindings[command.host]!(reopened.result);
        }
        const reads = await measureSqliteWrites(() => {
          for (const reader of stores) {
            expect(reader.listOpenQuestions()).toEqual([...questions.values()].filter(entry => entry.status === "open")
              .sort((a, b) => b.record.createdAt - a.record.createdAt).map(entry => entry.record));
            expect(reader.listSeenKeys().sort()).toEqual([...seen.keys()].sort());
            for (const backend of [undefined, ...backends]) for (const threadId of [undefined, ...ids]) {
              expect(reader.listTodoItemKeys({ backend, threadId }).sort()).toEqual(cards
                .filter(card => card.exists && (!backend || card.backend === backend) && (!threadId || card.threadId === threadId))
                .map(cardKey).sort());
              if (backend && threadId) expect(reader.listDismissedQuestionMessageIds({ backend, threadId }).sort())
                .toEqual([...questions.values()].filter(entry => entry.status === "dismissed"
                  && entry.record.backend === backend && entry.record.threadId === threadId).map(entry => entry.record.messageId).sort());
            }
          }
          const actual = dbs[0]!.raw.prepare("SELECT * FROM operator_async_questions ORDER BY backend, thread_id, message_id").all();
          const expected = [...questions.values()].map(entry => ({ backend: entry.record.backend, thread_id: entry.record.threadId,
            message_id: entry.record.messageId, questions_json: JSON.stringify(entry.record.questions), status: entry.status,
            created_at: entry.record.createdAt, resolved_at: entry.resolvedAt }));
          expect(actual).toEqual(expect.arrayContaining(expected));
          expect(actual.length).toBe(expected.length);
          expect(dbs[1]!.raw.prepare("SELECT item_key, seen_at FROM operator_seen_items").all())
            .toEqual(expect.arrayContaining([...seen].map(([item_key, seen_at]) => ({ item_key, seen_at }))));
        });
        expect(reads.writes.commits).toBe(0);
      }
    } finally { for (const db of dbs) db.close(); removeTempStateDbDir(fixture.tempDir); }
  }), { numRuns: 25 });
});

it("retains exact deadlines and first-seen identity for every generated open review and to-do", () => {
  fc.assert(fc.property(fc.integer({ min: 0, max: 1 }), fc.integer({ min: 0, max: 100 }), (host, at) => {
    const db = openInMemoryStateDb();
    const store = new bindings[host]!(db);
    try {
      db.raw.prepare("INSERT INTO thread_reviews(review_id, backend, thread_id, status, updated_at, payload) VALUES ('r', 'codex', 't', 'open', 0, '{}')").run();
      db.raw.prepare(`INSERT INTO thread_todos(todo_id, backend, thread_id, kind, status, title, created_at, updated_at)
        VALUES ('t', 'codex', 't', 'task', 'open', 'Invented task', 0, 0)`).run();
      const keys = ["todo:review:r", "todo:t", "request:closed"];
      store.markSeen(keys, at);
      store.markSeen(keys, at + retention);
      store.prune(at + retention);
      expect(store.listSeenKeys().sort()).toEqual([...keys].sort());
      store.prune(at + retention + 1);
      expect(store.listSeenKeys().sort()).toEqual(["todo:review:r", "todo:t"]);
      db.raw.prepare("UPDATE thread_reviews SET status = 'handled'").run();
      db.raw.prepare("UPDATE thread_todos SET status = 'done'").run();
      store.prune(at + retention + 1);
      expect(store.listSeenKeys()).toEqual([]);
    } finally { db.close(); }
  }), { numRuns: 25 });
});

it("publishes question and batched seen changes atomically, rolling back refused writes on either host", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: 1 }), fc.boolean(), async (host, failSeen) => {
    const fixture = createTempStateDb("shared-operator-atomic-");
    const db = StateDb.open(fixture.dbPath);
    const observer = StateDb.open(fixture.dbPath);
    const writer = new bindings[host]!(db);
    const reader = new bindings[1 - host]!(observer);
    try {
      const identity = { backend: "codex" as const, threadId: "same", messageId: "same" };
      const question = { ...identity, questions: [{ title: "Invented pending text", options: null }], now: 1 };
      db.raw.prepare(`CREATE TRIGGER refuse_seen BEFORE INSERT ON operator_seen_items
        WHEN NEW.item_key = 'refuse' BEGIN SELECT RAISE(ABORT, 'Invented seen refusal'); END`).run();
      const writes = await measureSqliteWrites(() => {
        expect(() => db.raw.transaction(() => {
          writer.insertQuestion(question);
          writer.markSeen(["first", ...(failSeen ? ["refuse"] : [])], 2);
          expect(reader.listOpenQuestions()).toEqual([]);
          expect(reader.listSeenKeys()).toEqual([]);
          if (!failSeen) throw new Error("Invented outer refusal");
        })()).toThrow(/Invented/);
      });
      expect(writes.writes.commits).toBe(0);
      expect(writer.listOpenQuestions()).toEqual([]);
      expect(reader.listSeenKeys()).toEqual([]);
      writer.insertQuestion(question);
      expect(() => db.raw.transaction(() => {
        writer.dismissQuestion({ ...identity, now: 3 });
        expect(reader.listOpenQuestions()[0]!.questions).toEqual(question.questions);
        throw new Error("Invented closure refusal");
      })()).toThrow("Invented closure refusal");
      expect(reader.listOpenQuestions()[0]!.questions).toEqual(question.questions);
      writer.dismissQuestion({ ...identity, now: 4 });
      expect(reader.listOpenQuestions()).toEqual([]);
      expect(observer.raw.prepare("SELECT questions_json FROM operator_async_questions").pluck().get()).toBe("[]");
    } finally { observer.close(); db.close(); removeTempStateDbDir(fixture.tempDir); }
  }), { numRuns: 25 });
});

it("skips malformed question payloads without repair writes and returns detached normalized questions", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: 1 }), fc.constantFrom("{", "null", "{}", "[]", "[false]"), async (host, payload) => {
    const db = openInMemoryStateDb();
    const store = new bindings[host]!(db);
    try {
      db.raw.prepare(`INSERT INTO operator_async_questions
        (backend, thread_id, message_id, questions_json, status, created_at, resolved_at)
        VALUES ('codex', 't', 'bad', ?, 'open', 1, NULL)`).run(payload);
      store.insertQuestion({ backend: "codex", threadId: "t", messageId: "good",
        questions: [{ title: "Invented valid question", options: ["Yes", "No"] }], now: 2 });
      const reads = await measureSqliteWrites(() => {
        const first = store.listOpenQuestions();
        expect(first.map(entry => entry.messageId)).toEqual(["good"]);
        first[0]!.questions[0]!.title = "Changed outside storage";
        first[0]!.questions[0]!.options?.push("Changed option");
        expect(store.listOpenQuestions()[0]!.questions).toEqual([{ title: "Invented valid question", options: ["Yes", "No"] }]);
      });
      expect(reads.writes.commits).toBe(0);
      expect(db.raw.prepare("SELECT questions_json FROM operator_async_questions WHERE message_id = 'bad'").pluck().get()).toBe(payload);
    } finally { db.close(); }
  }), { numRuns: 25 });
});
