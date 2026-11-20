import fc from "fast-check";
import { expect, it } from "vitest";
import type { ThreadSubAgentSummary } from "@pwragent/shared";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { openInMemoryStateDb } from "./sqlite-test-utils";

const identity = { backend: "codex", threadId: "parent" } as const;
const monitorId = "system:queued-message-titles:codex:parent";

function failure(attemptId: string, updatedAt: number): ThreadSubAgentSummary & { attemptId: string } {
  // The clock can report the same millisecond for two distinct attempts.
  return { monitorId, attemptId, task: "Name queued messages", status: "failed",
    createdAt: 1, updatedAt, completedAt: 1 };
}

function dismiss(store: SqliteOverlayStore, attemptId: string) {
  return store.dismissFailedThreadSubAgents({ ...identity, attempts: [{ monitorId, attemptId }] });
}

it("dismisses only the displayed attempt across retries, delayed clicks and metadata updates", async () => {
  const db = openInMemoryStateDb();
  const store = new SqliteOverlayStore(db);
  try {
    await fc.assert(fc.asyncProperty(fc.array(fc.boolean(), { minLength: 2, maxLength: 9 }), async (dismissBeforeRetry) => {
      db.raw.exec("DELETE FROM thread_sub_agents");
      for (const [index, early] of dismissBeforeRetry.entries()) {
        const first = failure(`attempt-${index}-first`, 2 * index + 2);
        const retry = failure(`attempt-${index}-retry`, first.updatedAt);
        await store.upsertThreadSubAgent({ ...identity, subAgent: first });
        if (early) {
          expect(await dismiss(store, first.attemptId)).toBe(1);
          expect(await store.listActiveThreadSubAgents(identity)).toEqual([]);
        }
        await store.upsertThreadSubAgent({ ...identity, subAgent: retry });
        expect(await dismiss(store, first.attemptId)).toBe(0);
        expect(await store.listActiveThreadSubAgents(identity)).toEqual([retry]);
        expect(await dismiss(store, retry.attemptId)).toBe(1);
        await store.upsertThreadSubAgent({ ...identity, subAgent: { ...retry, updatedAt: retry.updatedAt + 1 } });
        expect(await store.listActiveThreadSubAgents(identity)).toEqual([]);
      }
    }), { numRuns: 25 });
  } finally { db.close(); }
});

it("keeps the owner's history revision stable when dismissing a composer failure", async () => {
  const db = openInMemoryStateDb();
  const store = new SqliteOverlayStore(db);
  const card = failure("attempt", 2);
  try {
    await store.upsertThreadSubAgent({ ...identity, subAgent: card });
    const history = await store.readThreadSubAgentRevision(identity);
    expect(await dismiss(store, card.attemptId)).toBe(1);
    expect(await store.listThreadSubAgents(identity)).toEqual([card]);
    expect(await store.readThreadSubAgentRevision(identity)).toEqual(history);
  } finally { db.close(); }
});

it("rejects a delayed dismissal when a newer failure has the same monitor and timestamps", async () => {
  const db = openInMemoryStateDb();
  const store = new SqliteOverlayStore(db);
  const retry = failure("retry", 2);
  try {
    await store.upsertThreadSubAgent({ ...identity, subAgent: failure("original", 2) });
    await store.upsertThreadSubAgent({ ...identity, subAgent: retry });
    expect(await dismiss(store, "original")).toBe(0);
    expect(await store.listActiveThreadSubAgents(identity)).toEqual([retry]);
  } finally { db.close(); }
});
