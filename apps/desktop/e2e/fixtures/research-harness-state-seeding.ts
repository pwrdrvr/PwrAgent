import { ResearchStore } from "@pwragent/sqlite-storage/research-store";
import { RESEARCH_HARNESS_REVISION, type ResearchActor, type ResearchEvent } from "@pwragent/shared";
import { normalizeHarnessRecords } from "@pwragent/owner-core/research-harness-records";
import { StateDb } from "../../src/main/state/state-db";
import { harnessRecords } from "../../src/main/__tests__/fixtures/research-harness-records";
import { discoveryRecords } from "../../src/main/__tests__/fixtures/research-discovery-records";
import { normalizeHarnessDiscovery } from "@pwragent/owner-core/research-harness-discovery";

export function seedDiscoveryResearchState(stateDbPath: string): void {
  const db = StateDb.open(stateDbPath);
  const store = new ResearchStore(db);
  const actor: ResearchActor = { backend: "codex", threadId: "thread-smoke", kind: "operator" };
  const state = { version: 1, source: "discovery", mode: "import", project: "fixture-project", session: "", swarm: "fixture-run", problem: "fixture_problem",
    workspace: "/fixture/research", upstreamRevision: RESEARCH_HARNESS_REVISION, state: "pending", cursor: 0, members: [], cancelSupported: false, note: "Contrived discovery observation." } as const;
  try {
    store.create("discovery-fixture", "discovery-fixture", { seq: 1, commandId: "start", signature: "fixture", at: 1000, actor, data: {
      type: "created", objective: "Inspect invented discovery ancestry", coordinator: actor, ownerId: "fixture-owner", ownerPid: 1, deadlineAt: 10_000,
      workspaceMode: "none", harness: { ...state, members: [] }, approaches: [{ id: "a1", title: "Source observation", task: "Observe recorded ancestry", state: "stopped" }],
    } });
    const normalized = normalizeHarnessDiscovery(store.get("discovery-fixture")!, discoveryRecords(31), 1000);
    const events: ResearchEvent[] = normalized.events.map((entry, i) => ({ ...entry, seq: i + 2, commandId: `discovery:${i}`, signature: entry.provenance.digest, at: 1000, actor }));
    events.push({ seq: events.length + 2, commandId: "snapshot", signature: "fixture", at: 1000, actor, data: { type: "harness", state: {
      ...state, members: [], state: "imported", discovery: normalized.snapshot,
    } } });
    events.push({ seq: events.length + 2, commandId: "retained", signature: "fixture", at: 1000, actor, data: { type: "status", status: "interrupted", reason: "Retained read-only discovery snapshot." } });
    store.appendBatch("discovery-fixture", 1, events);
  } finally { db.close(); }
}

/** Contrived service prefix and an unresolved stop. No provider or user records. */
export function seedHarnessResearchState(stateDbPath: string): void {
  const db = StateDb.open(stateDbPath);
  const store = new ResearchStore(db);
  const actor: ResearchActor = { backend: "codex", threadId: "thread-smoke", kind: "operator" };
  const state = { version: 1, mode: "execute", project: "fixture-project", session: "fixture-session", swarm: "fixture-swarm", workspace: "/fixture/research",
    upstreamRevision: RESEARCH_HARNESS_REVISION, state: "running", cursor: 0, members: [], cancelSupported: true, note: "Observing a contrived Harness run." } as const;
  try {
    store.create("harness-fixture", "harness-fixture", { seq: 1, commandId: "start", signature: "fixture", at: Date.UTC(2026, 10, 1, 14), actor,
      data: { type: "created", objective: "Compare invented queue hypotheses with Harness", coordinator: actor, ownerId: "fixture-owner", ownerPid: 1,
        deadlineAt: Date.UTC(2026, 10, 1, 14, 30), workspaceMode: "none", harness: { ...state, members: [] }, approaches: [
          { id: "a1", title: "Insertion order", task: "Trace reply admission and release.", state: "unknown" },
          { id: "a2", title: "Owner changes", task: "Test one-owner reproductions.", state: "unknown" },
        ] } });
    const run = store.get("harness-fixture")!;
    const normalized = normalizeHarnessRecords(run, harnessRecords().slice(0, 10));
    const events: ResearchEvent[] = normalized.events.map((entry, i) => ({ ...entry, seq: i + 2, commandId: `source-${i}`, signature: entry.provenance.digest, at: entry.provenance.at, actor }));
    events.push({ seq: events.length + 2, commandId: "unknown", signature: "unknown", at: 2000, actor, data: { type: "harness", state: {
      ...normalized.state, state: "unknown", note: "Cancellation acknowledgement was lost. Source execution may still be running. Reconcile records before starting new work.",
    } } });
    events.push({ seq: events.length + 2, commandId: "stopping", signature: "stopping", at: 2001, actor,
      data: { type: "status", status: "stopping", reason: "Remote stop is unconfirmed. Evidence and source verdicts are retained." } });
    store.appendBatch(run.id, run.revision, events);
  } finally { db.close(); }
}
