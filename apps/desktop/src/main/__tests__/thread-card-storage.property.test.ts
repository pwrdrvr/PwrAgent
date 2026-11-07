import fc from "fast-check";
import { afterEach, expect, it, vi } from "vitest";
import type { ThreadTodoStorage } from "@pwragent/owner-core/thread-todo-storage";
import type { ThreadTodo, ThreadTodoStatus } from "@pwragent/shared";
import { ThreadTodoStore } from "../storage/thread-todo-store";
import { SqliteThreadReviewStorage } from "../storage/thread-review-storage-sqlite";
import { ThreadReviewService } from "../thread-reviews/thread-review-service";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { openInMemoryStateDb } from "./sqlite-test-utils";

afterEach(() => vi.unstubAllEnvs());

it("preserves card state, checklist ticks and atomic rollback through the to-do storage port", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const operation = fc.record({
    kind: fc.constantFrom("status", "error", "tick", "rollback"),
    slot: fc.integer({ min: 0, max: 2 }),
    status: fc.constantFrom<ThreadTodoStatus>("open", "done", "dismissed"),
    checked: fc.boolean(),
  });
  type Card = { status: ThreadTodoStatus; resolvedAt?: number; error?: string; checked: boolean; updatedAt: number };
  const view = (todo: ThreadTodo): Card => ({ status: todo.status, resolvedAt: todo.resolvedAt,
    error: todo.error, checked: todo.items![0]!.checked, updatedAt: todo.updatedAt });
  await fc.assert(fc.asyncProperty(fc.array(operation, { minLength: 1, maxLength: 40 }), async (operations) => {
    const db = openInMemoryStateDb();
    const storage: ThreadTodoStorage = new ThreadTodoStore(db);
    const model: Card[] = [0, 1, 2].map(() => ({ status: "open", checked: false, updatedAt: 1_000 }));
    try {
      for (const slot of [0, 1, 2]) storage.insert({ id: `todo-${slot}`, backend: "codex", threadId: "owner",
        title: "Fixture card", kind: "reminder", key: `key-${slot}`, now: 1_000,
        items: [{ id: "step", text: "Verify", checked: false }] });
      for (const [index, op] of operations.entries()) {
        const now = 2_000 + index;
        const id = `todo-${op.slot}`;
        const card = model[op.slot]!;
        if (op.kind === "status") {
          storage.setStatus({ id, status: op.status, now });
          card.status = op.status;
          card.resolvedAt = op.status === "open" ? undefined : now;
          if (op.status !== "open") card.error = undefined;
          card.updatedAt = now;
        } else if (op.kind === "error") {
          storage.setError({ id, error: `Failure ${index}`, now });
          card.error = `Failure ${index}`;
          card.updatedAt = now;
        } else if (op.kind === "tick") {
          storage.transaction(() => storage.setItems({ id, now,
            items: [{ id: "step", text: "Verify", checked: op.checked }] }));
          card.checked = op.checked;
          card.updatedAt = now;
        } else {
          expect(() => storage.transaction(() => {
            storage.setStatus({ id, status: "done", now });
            storage.setError({ id: `todo-${(op.slot + 1) % 3}`, error: "Rolled back", now });
            throw new Error("Model rollback");
          })).toThrow("Model rollback");
        }
        const reads = await measureSqliteWrites(() => {
          for (const slot of [0, 1, 2]) {
            expect(view(storage.get(`todo-${slot}`)!)).toEqual(model[slot]);
            expect(storage.findOpenByKey({ backend: "codex", threadId: "owner", key: `key-${slot}` })?.id)
              .toBe(model[slot]!.status === "open" ? `todo-${slot}` : undefined);
          }
          expect(storage.countOpen({ backend: "codex", threadId: "owner" }))
            .toBe(model.filter(card => card.status === "open").length);
          expect(storage.list({ status: "all" })).toHaveLength(3);
        });
        expect(reads.writes.commits).toBe(0);
      }
    } finally { db.close(); }
  }), { numRuns: 100 });
});

it("keeps review replay immutable and settles only findings that are still open through the storage port", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const operation = fc.record({
    kind: fc.constantFrom("resolve", "reported", "replay", "restart"),
    slot: fc.integer({ min: 0, max: 3 }),
    status: fc.constantFrom("open" as const, "addressed" as const, "declined" as const, "deferred" as const),
    outcome: fc.constantFrom("fixed" as const, "no_change_needed" as const, "skipped" as const),
  });
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 4 }),
    fc.array(operation, { minLength: 1, maxLength: 40 }), async (count, operations) => {
      const db = openInMemoryStateDb();
      const storage = new SqliteThreadReviewStorage(db);
      const identity = { backend: "codex" as const, threadId: "owner" };
      let now = 1_000;
      let service = new ThreadReviewService(storage, () => {}, () => now);
      const input = { sourceKey: "fixture-review", title: "Fixture review",
        items: Array.from({ length: count }, (_, index) => ({ title: `Finding ${index}` })) };
      const model: Array<"open" | "addressed" | "declined" | "deferred"> = input.items.map(() => "open");
      let status: "open" | "handled" = "open";
      try {
        const original = service.record(identity, input);
        for (const op of operations) {
          now += 1;
          const slot = op.slot % count;
          if (op.kind === "resolve") {
            service.update({ id: original.id, itemId: original.items[slot]!.id, status: op.status,
              ...(op.status === "open" ? {} : { note: "Model resolution" }),
              ...(op.status === "deferred" ? { todoId: "follow-up" } : {}),
            }, "agent", identity, { id: "follow-up", title: "Follow up" });
            model[slot] = op.status;
            status = op.status === "open" || model.some(item => item === "open") ? "open" : "handled";
          } else if (op.kind === "reported") {
            service.applyReportedOutcomes(identity, input.sourceKey, [{ index: slot, outcome: op.outcome }]);
            if (model[slot] === "open") model[slot] = op.outcome === "fixed" ? "addressed" : "declined";
            if (model.every(item => item !== "open")) status = "handled";
          } else {
            const noOp = await measureSqliteWrites(() => {
              if (op.kind === "replay") service.record(identity, { ...input, title: "Replayed replacement" });
              else service = new ThreadReviewService(storage, () => {}, () => now);
            });
            expect(noOp.writes.commits).toBe(0);
          }
          const reads = await measureSqliteWrites(() => {
            const review = service.get(original.id)!;
            expect(review.title).toBe(input.title);
            expect(review.items.map(item => item.id)).toEqual(original.items.map(item => item.id));
            expect(review.items.map(item => item.status)).toEqual(model);
            expect(review.status).toBe(status);
            expect(service.list()).toHaveLength(status === "open" ? 1 : 0);
            expect(service.list({ status: "all" })).toHaveLength(1);
          });
          expect(reads.writes.commits).toBe(0);
        }
      } finally { db.close(); }
    }), { numRuns: 100 });
});
