import fc from "fast-check";
import { expect, it } from "vitest";
import type { DurableTurnReceipt } from "@pwragent/shared";
import { SqliteDurableTurnRequestStore } from "../storage/durable-turn-request-store";
import { openInMemoryStateDb } from "./sqlite-test-utils";

it("matches an inbox model across claims, expiry and rolled-back work, restoring durability mode", () => {
  const operation = fc.record({
    kind: fc.constantFrom("admit", "claim", "expire", "rollback"),
    scope: fc.constantFrom("first", "second"),
    id: fc.constantFrom("one", "two", "three"),
    now: fc.integer({ min: 0, max: 200 }),
  });
  // Rule: synchronous transactions commit exactly their inbox mutations or
  // none of them; dispatch is never inside one, and the prior pragma survives.
  fc.assert(fc.property(fc.array(operation, { maxLength: 40 }), (operations) => {
    const db = openInMemoryStateDb();
    const store = new SqliteDurableTurnRequestStore(db);
    const model = new Map<string, { scope: string; receipt: DurableTurnReceipt }>();
    db.raw.pragma("synchronous = NORMAL");
    try {
      for (const op of operations) {
        const key = JSON.stringify([op.scope, op.id]);
        const current = model.get(key)?.receipt;
        const receipt: DurableTurnReceipt = current
          ? { ...current, state: "dispatching", updatedAt: op.now }
          : { version: 1, id: op.id, backend: "codex", threadId: "thread", ownerInstanceId: "owner",
            payloadHash: "hash", queueEntryId: key, state: "accepted", acceptedAt: op.now,
            updatedAt: op.now, expiresAt: op.now + 100 };
        const change = () => {
          expect(db.raw.inTransaction).toBe(true);
          expect(db.raw.pragma("synchronous", { simple: true })).toBe(2);
          if (current) store.write(op.scope, receipt);
          else store.insert(op.scope, receipt);
        };
        if (op.kind === "rollback") {
          expect(() => store.transaction(() => { change(); throw new Error("rollback"); })).toThrow("rollback");
        } else if (op.kind === "expire") {
          store.transaction(() => store.pruneExpired(op.now));
          for (const [id, entry] of model) if (entry.receipt.expiresAt <= op.now) model.delete(id);
        } else {
          store.transaction(change);
          model.set(key, { scope: op.scope, receipt });
        }
        expect(db.raw.inTransaction).toBe(false);
        expect(db.raw.pragma("synchronous", { simple: true })).toBe(1);
        expect(store.count()).toBe(model.size);
        for (const scope of ["first", "second"]) {
          expect(store.count(scope)).toBe([...model.values()].filter((entry) => entry.scope === scope).length);
          for (const id of ["one", "two", "three"]) {
            const key = JSON.stringify([scope, id]);
            expect(store.read(scope, id)).toEqual(model.get(key)?.receipt);
            expect(store.readQueueReceipt(key)).toEqual(model.get(key)?.receipt);
            expect(store.findQueueReceipt(key)).toEqual(model.get(key));
          }
        }
      }
    } finally { db.close(); }
  }), { numRuns: 25 });
});
