import { SqliteThreadReviewStorage } from "../storage/thread-review-storage-sqlite";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { operatorTodoItemKey, threadReviewTodo, type ThreadReview } from "@pwragent/shared";
import { OperatorRequestService } from "../operator-requests/operator-request-service";
import { OperatorRequestStore, OPERATOR_REQUEST_RETENTION_MS } from "../storage/operator-request-store";
import { ThreadReviewService } from "../thread-reviews/thread-review-service";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { createTempStateDb, openInMemoryStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

afterEach(() => vi.unstubAllEnvs());

function createFixture(db = openInMemoryStateDb()) {
  const clock = { now: 1_000 };
  const reviews = new ThreadReviewService(new SqliteThreadReviewStorage(db), () => {}, () => clock.now);
  const store = new OperatorRequestStore(db);
  const operator = new OperatorRequestService({
    registry: { getThreadInfo: () => undefined, listPendingServerRequests: () => [], onEvent: () => () => {} },
    store, broadcast: () => {}, now: () => clock.now,
  });
  const record = (sourceKey: string) => reviews.record({ backend: "codex", threadId: "review-owner" }, {
    sourceKey, title: "Review", items: [{ title: "Handle cancellation" }],
  });
  return { db, clock, reviews, store, operator, record };
}

function seenKey(review: ThreadReview): string {
  return operatorTodoItemKey(threadReviewTodo(review).id);
}

describe("operator review seen retention", () => {
  it("keeps an already-viewed open review seen when startup prunes after 30 days", () => {
    const { db, clock, reviews, store, operator, record } = createFixture();
    try {
      const review = record("still-open");
      operator.start();
      operator.markSeen([seenKey(review)]);
      operator.stop();
      clock.now += OPERATOR_REQUEST_RETENTION_MS + 1;
      operator.start();
      expect(reviews.list().map((entry) => entry.id)).toEqual([review.id]);
      expect(store.listSeenKeys()).toEqual([seenKey(review)]);
      expect(operator.list({ backend: "codex", threadId: "review-owner" }).seenKeys).toEqual([seenKey(review)]);
    } finally { operator.stop(); db.close(); }
  });

  it("expires a seen mark only when it is older than retention and its review is closed", () => {
    const operation = fc.record({
      kind: fc.constantFrom("seen", "handled", "dismissed", "open", "prune"),
      slot: fc.constantFrom(0, 1),
      advance: fc.constantFrom(0, 1, OPERATOR_REQUEST_RETENTION_MS, OPERATOR_REQUEST_RETENTION_MS + 1),
    });
    // Model: each review's current status and the first time its card was seen.
    // Advancing the clock alone must never make still-open work unread again.
    fc.assert(fc.property(fc.array(operation, { maxLength: 30 }), (operations) => {
      const { db, clock, reviews, store, operator, record } = createFixture();
      const records = [record("one"), record("two")];
      const statuses = ["open", "open"];
      const seen = new Map(records.map((review) => [seenKey(review), clock.now]));
      operator.markSeen([...seen.keys()]);
      const prune = () => {
        for (const [index, review] of records.entries()) {
          const key = seenKey(review);
          const at = seen.get(key);
          if (at !== undefined && at < clock.now - OPERATOR_REQUEST_RETENTION_MS && statuses[index] !== "open") seen.delete(key);
        }
        store.prune(clock.now);
        expect(store.listSeenKeys().sort()).toEqual([...seen.keys()].sort());
      };
      try {
        for (const op of operations) {
          clock.now += op.advance;
          const review = records[op.slot]!;
          if (op.kind === "prune") { prune(); continue; }
          if (op.kind === "seen") {
            operator.markSeen([seenKey(review)]);
            if (!seen.has(seenKey(review))) seen.set(seenKey(review), clock.now);
          } else {
            if (op.kind === "handled") {
              reviews.update({ id: review.id, itemId: review.items[0]!.id, status: "addressed", note: "Fixed." }, "agent");
            }
            reviews.update({ id: review.id, status: op.kind, note: "Generated lifecycle transition." }, "user");
            statuses[op.slot] = op.kind;
          }
          expect(store.listSeenKeys().sort()).toEqual([...seen.keys()].sort());
        }
        clock.now += OPERATOR_REQUEST_RETENTION_MS + 1;
        prune();
      } finally { operator.stop(); db.close(); }
    }), { numRuns: 25 });
  });

  it("budgets zero writes for open reviews and one cleanup commit for old closed or missing reviews", async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const temp = createTempStateDb("pwragent-review-seen-retention-");
    const { db, clock, reviews, store, operator, record } = createFixture(StateDb.open(temp.dbPath));
    try {
      const open = record("open");
      operator.markSeen([seenKey(open)]);
      clock.now += OPERATOR_REQUEST_RETENTION_MS + 1;
      const protectedOnly = await measureSqliteWrites(() => store.prune(clock.now));
      expect(protectedOnly.writes.commits, JSON.stringify(protectedOnly.writes)).toBe(0);
      expectSqliteWriteBudget({ scenario: "operator-review-retention-open", writes: protectedOnly.writes,
        note: "Startup retains an old seen mark for a still-open review without a write; 0 MB/day at any startup cadence" });

      const handled = record("handled");
      const dismissed = record("dismissed");
      operator.markSeen([seenKey(handled), seenKey(dismissed), "todo:review:missing"]);
      reviews.update({ id: handled.id, itemId: handled.items[0]!.id, status: "addressed", note: "Fixed." }, "agent");
      reviews.update({ id: dismissed.id, status: "dismissed", note: "Superseded." }, "user");
      clock.now += OPERATOR_REQUEST_RETENTION_MS + 1;
      const cleanup = await measureSqliteWrites(() => store.prune(clock.now));
      expect(store.listSeenKeys()).toEqual([seenKey(open)]);
      expect(reviews.get(handled.id)?.status).toBe("handled");
      expect(reviews.get(dismissed.id)?.status).toBe("dismissed");
      expectSqliteWriteBudget({ scenario: "operator-review-retention-closed", writes: cleanup.writes,
        note: "One startup transaction removes three expired seen marks for handled, dismissed and missing reviews; about 0.0082 MB/day at one dirty startup/day, 0 MB/day idle" });
      const repeat = await measureSqliteWrites(() => store.prune(clock.now));
      expectSqliteWriteBudget({ scenario: "operator-review-retention-repeat", writes: repeat.writes,
        note: "Repeated startup after cleanup retains the open review mark without writes; 0 MB/day" });
    } finally { operator.stop(); db.close(); removeTempStateDbDir(temp.tempDir); }
  });
});
