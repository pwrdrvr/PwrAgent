import type { ResearchActor, ResearchEvent } from "@pwragent/shared";
import { ResearchStore } from "@pwragent/sqlite-storage/research-store";
import { StateDb } from "../../src/main/state/state-db";

/** 1,000 contributions across 10 recorded thread identities; at most 8 concurrent slots. */
export function seedResearchPerformanceState(stateDbPath: string): void {
  const db = StateDb.open(stateDbPath);
  const store = new ResearchStore(db);
  const actor: ResearchActor = { backend: "codex", threadId: "thread-smoke", kind: "agent" };
  const events: ResearchEvent[] = [];
  const add = (data: ResearchEvent["data"], author = actor) => events.push({ seq: events.length + 2, commandId: `perf:${events.length}`, signature: "fixture", at: 1_000 + events.length, actor: author, data });
  try {
    store.create("research-performance", "research-performance", { seq: 1, commandId: "created", signature: "fixture", at: 1000, actor,
      data: { type: "created", objective: "Inspect 1,000 invented research contributions", coordinator: actor, ownerId: "fixture-owner", ownerPid: 1,
        deadlineAt: 2_000_000, workspaceMode: "none", approaches: Array.from({ length: 8 }, (_, id) => ({ id: `a${id}`, title: `Approach ${id}`, task: "Inspect invented queue evidence", state: "pending" })) } });
    for (let id = 0; id < 8; id++) add({ type: "worker", approachId: `a${id}`, state: "ended", worker: { backend: "codex", threadId: `fixture-worker-${id}` } });
    for (let id = 0; id < 2; id++) add({ type: "finding", finding: { id: `seed-${id}`, approachId: `a${id}`, kind: "note", text: "Seed assignment", paths: [] } });
    for (let id = 8; id < 10; id++) add({ type: "assignment", itemId: `seed-${id - 8}`, task: "Inspect a focused follow-up", approach: {
      id: `a${id}`, title: `Approach ${id}`, task: "Inspect a focused follow-up", itemId: `seed-${id - 8}`, state: "ended", worker: { backend: "codex", threadId: `fixture-worker-${id}` },
    } });
    for (let id = 0; id < 1_000; id++) {
      const author = { ...actor, threadId: `fixture-worker-${id % 10}` };
      add({ type: "finding", finding: { id: `finding-${id}`, approachId: `a${id % 10}`, author, kind: "experiment", text: `Invented contribution ${id}: deterministic queue evidence across ten worker identities.`, paths: [] } }, author);
    }
    add({ type: "status", status: "exhausted", reason: "All fixture workers ended; evidence retained." });
    store.appendBatch("research-performance", 1, events);
  } finally { db.close(); }
}
