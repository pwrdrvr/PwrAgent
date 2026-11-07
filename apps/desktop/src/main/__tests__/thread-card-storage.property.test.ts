import fc from "fast-check";
import { afterEach, expect, it, vi } from "vitest";
import type { ThreadTodoStorage } from "@pwragent/owner-core/thread-todo-storage";
import type { ThreadTodo, ThreadTodoStatus } from "@pwragent/shared";
import { ThreadTodoStore } from "../storage/thread-todo-store";
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
