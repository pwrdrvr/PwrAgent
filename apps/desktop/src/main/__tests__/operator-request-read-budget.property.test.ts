import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { AppServerBackendKind, AppServerPendingRequestNotification } from "@pwragent/shared/contracts/normalized-app-server";
import type { ListOperatorRequestsRequest } from "@pwragent/shared/contracts/operator-requests";
import {
  operatorQuestionItemKey,
  operatorServerRequestItemKey,
  operatorTodoItemKey,
} from "@pwragent/shared/contracts/operator-requests";
import { OperatorRequestService } from "../operator-requests/operator-request-service";
import { OperatorRequestStore } from "../storage/operator-request-store";
import { SqliteThreadReviewStorage } from "../storage/thread-review-storage-sqlite";
import { ThreadReviewService } from "../thread-reviews/thread-review-service";
import { openInMemoryStateDb } from "./sqlite-test-utils";

afterEach(() => vi.restoreAllMocks());

const root = { backend: "codex", threadId: "root" } as const;
const rootQuestion = {
  ...root, messageId: "root-question", questions: [{ title: "Choose a color", options: ["Blue", "Green"] }],
};
const reviewInput = { sourceKey: "report", title: "Fixture review", items: [{ title: "Settle the finding" }] };

function fixture(db: ReturnType<typeof openInMemoryStateDb>) {
  const store = new OperatorRequestStore(db);
  const reviewStorage = new SqliteThreadReviewStorage(db);
  let now = 100;
  const reviews = new ThreadReviewService(reviewStorage, undefined, () => ++now);
  const pending: Array<{
    backend: typeof root.backend | "acp:fixture";
    notification: AppServerPendingRequestNotification;
  }> = [];
  const requests = new OperatorRequestService({
    registry: {
      getThreadInfo: (identity) => identity.threadId === root.threadId ? { title: "Root thread" } : undefined,
      listPendingServerRequests: () => pending,
      onEvent: () => () => {},
    },
    store,
    broadcast: () => {},
    now: () => now,
  });
  const insertTodo = db.raw.prepare(`INSERT INTO thread_todos
    (todo_id, backend, thread_id, kind, status, title, created_at, updated_at, resolved_at)
    VALUES (?, ?, ?, 'reminder', ?, 'Fixture to-do', 100, 100, ?)`);
  const addTodo = (id: string, filter: { backend: string; threadId: string }, status: "open" | "done") => {
    insertTodo.run(id, filter.backend, filter.threadId, status, status === "done" ? 100 : null);
    return operatorTodoItemKey(id);
  };
  return { store, reviews, reviewStorage, requests, addTodo, pending };
}

function growUnrelated(db: ReturnType<typeof openInMemoryStateDb>, start: number, size: number, backend: AppServerBackendKind) {
  // Half of the unrelated questions are open, half have already been answered.
  const rows = `WITH RECURSIVE numbers(i) AS (SELECT ? UNION ALL SELECT i + 1 FROM numbers WHERE i < ?),
    noise AS (SELECT i, ? AS backend, 'unrelated-' || i AS thread_id FROM numbers) `;
  db.raw.transaction(() => {
    db.raw.prepare(rows + `INSERT INTO operator_async_questions
      SELECT backend, thread_id, 'question', CASE WHEN i % 2 = 0 THEN ? ELSE '[]' END,
        CASE WHEN i % 2 = 0 THEN 'open' ELSE 'answered' END, i,
        CASE WHEN i % 2 = 0 THEN NULL ELSE i + 1 END FROM noise`)
      .run(start, size - 1, backend, JSON.stringify(rootQuestion.questions));
    db.raw.prepare(rows + `INSERT INTO operator_seen_items
      SELECT 'question:' || backend || ':' || thread_id || ':question', i FROM noise`).run(start, size - 1, backend);
    db.raw.prepare(rows + `INSERT INTO thread_todos
      (todo_id, backend, thread_id, kind, status, title, created_at, updated_at, resolved_at)
      SELECT 'todo-' || i, backend, thread_id, 'reminder', 'done', 'Unrelated to-do', i, i, i FROM noise`)
      .run(start, size - 1, backend);
    db.raw.prepare(rows + `INSERT INTO thread_reviews
      SELECT 'review-' || i, backend, thread_id, 'handled', i,
        json_object('id', 'review-' || i, 'backend', backend, 'threadId', thread_id, 'status', 'handled',
          'updatedAt', i, 'createdAt', i, 'sourceKey', 'report', 'title', 'Unrelated review',
          'origin', 'explicit', 'items', json_array()) FROM noise`).run(start, size - 1, backend);
  })();
}

/** Observe the statements executed by the service using the same native SQLite connection. */
function observeReads(db: ReturnType<typeof openInMemoryStateDb>) {
  const prepare = db.raw.prepare.bind(db.raw);
  const reads: Array<{ sql: string; args: unknown[]; rows: number; plan: string[] }> = [];
  const spy = vi.spyOn(db.raw, "prepare").mockImplementation((sql) => {
    const statement = prepare(sql);
    if (!/^\s*(SELECT|WITH)\b/i.test(sql)) return statement;
    const record = (args: unknown[]) => {
      const plan = (prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as Array<{ detail: string }>)
        .map((entry) => entry.detail);
      const read = { sql, args, plan, rows: 0 };
      reads.push(read);
      return read;
    };
    const all = statement.all.bind(statement);
    vi.spyOn(statement, "all").mockImplementation((...args: unknown[]) => {
      const result = all(...args);
      record(args).rows = result.length;
      return result;
    });
    const iterate = statement.iterate.bind(statement);
    vi.spyOn(statement, "iterate").mockImplementation(function* (...args: unknown[]) {
      const read = record(args);
      for (const row of iterate(...args)) {
        read.rows++;
        yield row;
      }
    });
    return statement;
  });
  return { reads, stop: () => spy.mockRestore() };
}

// Optional native VM-step replay of the actual SQL and bindings on a copy of the fixture.
async function report(name: string, db: ReturnType<typeof openInMemoryStateDb>, workloads: Record<string, ReturnType<typeof observeReads>["reads"]>) {
  const directory = process.env.PWRAGENT_OPERATOR_REQUEST_READ_REPORT_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  await db.raw.backup(path.join(directory, `${name}.db`));
  writeFileSync(path.join(directory, `${name}.json`), JSON.stringify(workloads, null, 2));
}

function expectScopedBudget(reads: ReturnType<typeof observeReads>["reads"], scope: ListOperatorRequestsRequest, maxQueries: number, maxRows: number) {
  expect.soft(reads.length).toBeGreaterThan(0);
  expect.soft(reads.length).toBeLessThanOrEqual(maxQueries);
  const broadReads = reads.flatMap((read) => read.plan).filter((line) => {
    if (/^(SCAN|SEARCH) operator_seen_items\b/.test(line)) return !line.includes("item_key=?");
    if (!/^(SCAN|SEARCH) (operator_async_questions|thread_todos|thread_reviews)\b/.test(line)) return false;
    return (scope.backend !== undefined && !line.includes("backend=?"))
      || (scope.threadId !== undefined && !line.includes("thread_id=?"));
  });
  expect.soft(broadReads).toEqual([]);
  expect.soft(reads.reduce((count, read) => count + read.rows, 0)).toBeLessThanOrEqual(maxRows);
}

it.each(["thread", "backend"] as const)("keeps native work bounded as unrelated owner rows grow outside the %s scope", async (dimension) => {
  const db = openInMemoryStateDb();
  try {
    const { store, reviews, requests, addTodo } = fixture(db);
    store.insertQuestion({ ...rootQuestion, now: 100 });
    const todoKey = addTodo("root-todo", root, "open");
    const review = reviews.record(root, reviewInput);
    const seenKeys = [operatorQuestionItemKey(root.backend, root.threadId, rootQuestion.messageId), todoKey];
    store.markSeen(seenKeys, 100);
    let start = 0;
    const scopes = dimension === "thread" ? [root, { threadId: root.threadId }] : [{ backend: root.backend }];
    for (const size of [1_000, 2_000, 50_000]) {
      growUnrelated(db, start, size, dimension === "thread" ? root.backend : "acp:fixture");
      start = size;
      const workloads: Record<string, ReturnType<typeof observeReads>["reads"]> = {};
      for (const scope of scopes) {
        const { reads, stop } = observeReads(db);
        try {
          const response = requests.list(scope);
          const label = "backend" in scope ? ("threadId" in scope ? "combined" : "backend") : "thread";
          const requestReads = reads.splice(0);
          workloads[`${label}-requests`] = requestReads;
          expect(response).toEqual({
            serverRequests: [], questions: [{ ...rootQuestion, createdAt: 100, threadTitle: "Root thread" }], seenKeys,
          });
          expectScopedBudget(requestReads, scope, 3, 5);
          for (const status of ["open", "all"] as const) {
            expect(reviews.list({ ...scope, status })).toEqual([review]);
            const reviewReads = reads.splice(0);
            workloads[`${label}-review-${status}`] = reviewReads;
            expectScopedBudget(reviewReads, scope, 1, 1);
          }
        } finally { stop(); }
      }
      await report(`${size}-${dimension}-scope`, db, workloads);
    }
  } finally { db.close(); }
}, process.env.PWRAGENT_OPERATOR_REQUEST_READ_REPORT_DIR ? 30_000 : undefined);

it("preserves seen marks for every matching card type and all unscoped owner-wide marks", () => {
  const db = openInMemoryStateDb();
  try {
    const { store, reviews, reviewStorage, requests, addTodo, pending } = fixture(db);
    const owners = [root, { ...root, threadId: "other" }, { ...root, backend: "acp:fixture" as const }];
    const cards = owners.map((owner, index) => {
      const messageId = `question-${index}`;
      store.insertQuestion({ ...rootQuestion, ...owner, messageId, now: index });
      const requestId = `approval-${index}`;
      pending.push({ backend: owner.backend, notification: {
        method: "item/commandExecution/requestApproval",
        params: { threadId: owner.threadId, turnId: "turn", requestId, command: "test" },
      } as AppServerPendingRequestNotification });
      const review = reviews.record(owner, reviewInput);
      const handled = reviews.update({ id: review.id, itemId: review.items[0]!.id, status: "addressed", note: "Fixed" }, "agent");
      const seen = [operatorQuestionItemKey(owner.backend, owner.threadId, messageId),
        operatorServerRequestItemKey(owner.backend, owner.threadId, requestId),
        addTodo(`done-${index}`, owner, "done"), operatorTodoItemKey(`review:${review.id}`)];
      return { owner, messageId, requestId, seen, handled };
    });
    const detached = reviews.record(root, {
      ...reviewInput, sourceKey: "detached", context: {
        workspacePath: "/fixture", pullRequest: {
          provider: "github.com", org: "example", repo: "fixture", number: 1, url: "https://github.com/example/fixture/pull/1",
        },
      },
    }, "automatic");
    const detachedKey = operatorTodoItemKey(`review:${detached.id}`);
    const dismissed = reviews.update({ id: reviews.record(root, { ...reviewInput, sourceKey: "closed" }).id,
      status: "dismissed", note: "Superseded" }, "user");
    const rootReviewKeys = [detachedKey, operatorTodoItemKey(`review:${dismissed.id}`)];
    store.insertQuestion({ ...rootQuestion, messageId: "answered", now: 3 });
    store.resolveQuestions({ ...root, messageIds: ["answered"], status: "answered", now: 4 });
    const retained = [operatorQuestionItemKey(root.backend, root.threadId, "answered"), "todo:removed"];
    const activeMarks = [...rootReviewKeys, ...cards.flatMap((card) => card.seen)];
    store.markSeen([...retained, ...activeMarks], 100);

    const filters: ListOperatorRequestsRequest[] = [{ backend: root.backend }, { threadId: root.threadId }, root,
      { threadId: "missing" }];
    for (const filter of filters) {
      const matches = (owner: typeof owners[number]) => Object.entries(filter).every(([field, value]) =>
        owner[field as "backend" | "threadId"] === value);
      const selected = cards.filter((card) => matches(card.owner));
      const response = requests.list(filter);
      expect(response.questions.map((question) => question.messageId)).toEqual(selected.map((card) => card.messageId).reverse());
      expect(response.serverRequests.map((request) => request.notification.params.requestId))
        .toEqual(selected.map((card) => card.requestId));
      expect(response.seenKeys).toEqual([
        ...selected.flatMap((card) => card.seen), ...(matches(root) ? rootReviewKeys : []),
      ].sort());
      const handled = selected.map((card) => card.handled).reverse();
      expect(reviews.list(filter)).toEqual([]);
      expect(reviews.list({ ...filter, status: "handled" })).toEqual(handled);
      expect(reviews.list({ ...filter, status: "all" })).toEqual(matches(root) ? [dismissed, detached, ...handled] : handled);
      expect([...reviewStorage.iterate(filter)]).toEqual(matches(root) ? [detached] : []);
    }
    expect(reviews.list(root, { includeDetached: true })).toEqual([detached]);
    // The unscoped queue keeps every stored mark, even after its card has gone.
    const unscoped = requests.list();
    expect(unscoped.questions.map((question) => question.messageId)).toEqual(cards.map((card) => card.messageId).reverse());
    expect(unscoped.serverRequests.map((request) => request.notification.params.requestId)).toEqual(cards.map((card) => card.requestId));
    expect(unscoped.seenKeys).toEqual([...retained, ...activeMarks].sort());
    expect(reviews.list({ status: "all" })).toEqual([dismissed, detached, ...cards.map((card) => card.handled).reverse()]);
  } finally { db.close(); }
});
