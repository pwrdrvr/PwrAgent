import fs from "node:fs";
import path from "node:path";
import {
  researchTurnLimitNote,
  type ResearchActor,
  type ResearchEvent,
  type ResearchEventData,
} from "@pwragent/shared/research";
import { ResearchStore } from "@pwragent/sqlite-storage/research-store";
import { StateDb } from "../../src/main/state/state-db";
import { applyDesktopSettingsPatch } from "../../src/main/settings/desktop-config";
import { configTomlPathForHomeRoot } from "./readme-state-seeding";

export function enableResearchFixture(homeRoot: string): void {
  applyDesktopSettingsPatch(configTomlPathForHomeRoot(homeRoot), { experimental: { researchEnabled: true } });
}

export const RESEARCH_FIXTURE_OBJECTIVE = "Why does the queue occasionally reorder messages?";

/** Invented research, written through the production journal before launching a replay window. */
export function seedResearchState(stateDbPath: string): void {
  const db = StateDb.open(stateDbPath);
  const store = new ResearchStore(db);
  const actor: ResearchActor = { backend: "codex", threadId: "thread-smoke", kind: "agent" };
  let revision = 0;
  const append = (data: ResearchEventData, author = actor) => {
    if (data.type === "finding") data.finding.author = { backend: author.backend, threadId: author.threadId };
    if (data.type === "submission") data.submission.author = { backend: author.backend, threadId: author.threadId };
    const event: ResearchEvent = { seq: ++revision, commandId: `fixture-${revision}`, signature: `fixture-${revision}`,
      at: Date.UTC(2026, 10, 1, 14, 0, revision * 5), actor: author, data };
    if (revision === 1) store.create("research-fixture", "research-fixture", event);
    else store.append("research-fixture", revision - 1, event);
  };
  try {
    append({ type: "created", objective: RESEARCH_FIXTURE_OBJECTIVE, coordinator: actor, ownerId: "historical-fixture", ownerPid: 1,
      deadlineAt: Date.UTC(2026, 10, 1, 14, 30), workspaceMode: "none", approaches: [
        { id: "a1", title: "Event ordering", task: "Trace the order in which replies reach the queue.", state: "pending" },
        { id: "a2", title: "Owner lifetime", task: "Check whether ownership changes reorder messages.", state: "pending" },
        { id: "a3", title: "Persistence", task: "Compare recorded order with the queue presented to the operator.", state: "pending" },
      ] });
    for (let i = 1; i <= 3; i++) append({ type: "worker", approachId: `a${i}`, state: "ended", worker: { backend: "codex", threadId: `thread-research-worker-${i}`, turnId: `research-turn-${i}` } });
    append({ type: "finding", finding: { id: "ordering", approachId: "a1", kind: "experiment", text: "A deterministic replay reproduces the reversal when two held replies are released together.", paths: [] } }, { ...actor, threadId: "thread-research-worker-1" });
    append({ type: "finding", finding: { id: "owner", approachId: "a2", kind: "dead_end", text: "The reversal also occurs without an owner change. Ownership does not explain this reproduction.", paths: [] } }, { ...actor, threadId: "thread-research-worker-2" });
    append({ type: "abandoned", approachId: "a2", reason: "The counterexample keeps one owner for the complete run." });
    append({ type: "finding", finding: { id: "durable", approachId: "a3", kind: "partial", text: "Persisted insertion order agrees with the original input. The reversal happens during release.", paths: [], relatesTo: "ordering", relation: "supports" } }, { ...actor, threadId: "thread-research-worker-3" });
    append({ type: "submission", submission: { id: "candidate-1", approachId: "a1", text: "Release held replies in insertion order.", paths: [] } });
    append({ type: "review", submissionId: "candidate-1", decision: "revision_requested", reason: "Include evidence that independent hold reasons remain intact." });
    append({ type: "submission", submission: { id: "candidate-2", approachId: "a1", text: "Preserve insertion order and retain each reply’s independent hold reasons. The queue model agrees across generated release sequences.", paths: [] } });
    append({ type: "review", submissionId: "candidate-2", decision: "accepted", reason: "The reproducer and queue model support the revised candidate. This is an engineering review, not a formal proof." });
    append({ type: "assignment", itemId: "ordering", task: "Check that both independent hold reasons survive release.", approach: {
      id: "work-fixture", itemId: "ordering", title: "Check independent holds", task: "Check that both independent hold reasons survive release.", state: "pending",
    } });
    append({ type: "worker", approachId: "work-fixture", state: "ended", worker: { backend: "codex", threadId: "thread-research-focused", turnId: "focused-turn" } });
    append({ type: "finding", finding: { id: "focused-result", approachId: "work-fixture", kind: "experiment", text: "Both independent hold reasons remain intact in the focused reproduction.", paths: [], relatesTo: "ordering", relation: "supports" } }, { ...actor, threadId: "thread-research-focused" });
    append({ type: "item_work", itemId: "ordering", work: { state: "completed", assignmentId: "work-fixture", assignee: { backend: "codex", threadId: "thread-research-focused" }, note: "The focused child reproduced the queue behavior and checked both hold reasons." } });
    append({ type: "item_work", itemId: "owner", work: { state: "cancelled", note: "This direction was ruled out by the counterexample." } });
    append({ type: "item_work", itemId: "durable", work: { state: "blocked", note: "Retain this partial result for the next investigation." } });
    append({ type: "status", status: "completed", reason: "Completed after reviewing the queue model and reproduction." });
  } finally { db.close(); }
}

export const LIVE_RESEARCH_OBJECTIVE = "Find a smaller reproducer for the flaky cache invalidation test";

/** The running Electron owner's identity, read from its own profile runtime marker. */
export function readResearchOwnerIdentity(homeRoot: string, processId: number): { ownerId: string; ownerPid: number; ownerStartedAt: number } {
  const markerDir = path.join(homeRoot, ".pwragent/profiles/default/state/runtime-instances");
  for (const entry of fs.readdirSync(markerDir)) {
    // The heartbeat writes through a temporary file; skip anything that is not a complete marker.
    if (!entry.endsWith(".json")) continue;
    let marker: { instanceId?: string; processId?: number; startedAt?: number };
    try { marker = JSON.parse(fs.readFileSync(path.join(markerDir, entry), "utf8")); } catch { continue; }
    if (marker.processId === processId && marker.instanceId && marker.startedAt) return { ownerId: marker.instanceId, ownerPid: processId, ownerStartedAt: marker.startedAt };
  }
  throw new Error("The running owner's runtime marker was not found");
}

/**
 * Invented, live research owned by the running app, so its controls are writable. Seed after launch, then reload.
 * With `bounds`, the run also has a per-worker time limit and total worker time, and one worker stopped at its limit.
 */
export function seedLiveResearchRun(stateDbPath: string, owner: { ownerId: string; ownerPid: number; ownerStartedAt: number }, now = Date.now(),
  bounds?: { turnMinutes: number; totalWorkerMinutes: number }): void {
  const db = StateDb.open(stateDbPath);
  const store = new ResearchStore(db);
  const coordinator: ResearchActor = { backend: "codex", threadId: "thread-smoke", kind: "agent" };
  const worker = (index: number): ResearchActor => ({ ...coordinator, threadId: index === 4 ? "thread-research-focused" : `thread-research-worker-${index}` });
  const runId = "research-live-fixture";
  let revision = 0;
  const append = (data: ResearchEventData, author = coordinator) => {
    if (data.type === "finding") data.finding.author = { backend: author.backend, threadId: author.threadId };
    if (data.type === "submission") data.submission.author = { backend: author.backend, threadId: author.threadId };
    const event: ResearchEvent = { seq: ++revision, commandId: `live-${revision}`, signature: `live-${revision}`,
      at: now - 18 * 60_000 + revision * 25_000, actor: author, data };
    if (revision === 1) store.create(runId, runId, event);
    else store.append(runId, revision - 1, event);
  };
  try {
    append({ type: "created", objective: LIVE_RESEARCH_OBJECTIVE, coordinator, ...owner,
      deadlineAt: now + 22 * 60_000, ...(bounds ?? {}), workspaceMode: "new_worktree", approaches: [
        { id: "a1", title: "Bisect fixture setup", task: "Remove fixture setup steps until the failure disappears.", state: "pending" },
        { id: "a2", title: "Clock skew", task: "Check whether cache timestamps cross a second boundary during the test.", state: "pending" },
        { id: "a3", title: "Parallel workers", task: "Compare the failure rate with one worker and with four.", state: "pending" },
        { id: "a4", title: "Invalidation order", task: "Record the order of invalidation events in failing runs.", state: "pending" },
      ] });
    append({ type: "worker", approachId: "a1", state: "running", worker: { backend: "codex", threadId: "thread-research-worker-1", turnId: "live-turn-1" } });
    append({ type: "worker", approachId: "a2", state: "ended", worker: { backend: "codex", threadId: "thread-research-worker-2", turnId: "live-turn-2" } });
    append({ type: "worker", approachId: "a3", state: "running", worker: { backend: "codex", threadId: "thread-research-worker-3", turnId: "live-turn-3" } });
    append(bounds ? { type: "worker", approachId: "a4", state: "running", worker: { backend: "codex", threadId: "thread-research-worker-4", turnId: "live-turn-4" } }
      : { type: "worker", approachId: "a4", state: "ended" , note: "Worker finished after recording one trace." });
    if (bounds) append({ type: "worker", approachId: "a4", state: "stopped", note: researchTurnLimitNote(bounds.turnMinutes) });
    append({ type: "finding", finding: { id: "f-setup", approachId: "a1", kind: "experiment", text: "The failure still reproduces with only the in-memory store fixture. The database and network fixtures are not needed.", paths: ["test/cache/invalidation.test.ts", "notes/setup-bisect.md"] } }, worker(1));
    append({ type: "finding", finding: { id: "f-clock", approachId: "a2", kind: "dead_end", text: "Freezing the clock does not change the failure rate across 200 runs.", paths: ["notes/clock-freeze.md"] } }, worker(2));
    append({ type: "abandoned", approachId: "a2", reason: "Clock skew is ruled out by the frozen-clock runs." });
    append({ type: "finding", finding: { id: "f-parallel", approachId: "a3", kind: "partial", text: "With one worker the failure rate drops from 1 in 40 to 1 in 400. Shared cache state is likely involved.", paths: ["notes/worker-counts.csv"], relatesTo: "f-setup", relation: "supports" } }, worker(3));
    append({ type: "finding", finding: { id: "f-order", approachId: "a4", kind: "counterexample", text: "One failing trace shows invalidation completing before the write it should follow. Ordering alone does not explain the other failures.", paths: ["traces/failing-run-17.json"], relatesTo: "f-parallel", relation: "contradicts" } });
    append({ type: "finding", finding: { id: "f-key", approachId: "a1", kind: "lemma", text: "Two tests share the cache key \"user:1\". A test that runs later can read the earlier test's entry.", paths: ["test/cache/keys.ts"] } }, worker(1));
    append({ type: "submission", submission: { id: "c-1", approachId: "a3", text: "Run the cache tests with one worker.", paths: [] } }, worker(3));
    append({ type: "review", submissionId: "c-1", decision: "revision_requested", reason: "This hides the failure rather than explaining it. Show which shared state causes it." });
    append({ type: "submission", submission: { id: "c-2", approachId: "a1", text: "Give each test its own cache namespace. The 12-line reproducer in notes/repro.ts fails within 20 runs before the change and passes 2,000 runs after it.", paths: ["notes/repro.ts", "test/cache/keys.ts"] } }, worker(1));
    append({ type: "assignment", itemId: "f-order", task: "Find the second cause of the out-of-order invalidation trace.", approach: {
      id: "work-live", itemId: "f-order", title: "Investigate: out-of-order invalidation", task: "Find the second cause of the out-of-order invalidation trace.", state: "pending",
    } });
    append({ type: "worker", approachId: "work-live", state: "running", worker: { backend: "codex", threadId: "thread-research-focused", turnId: "live-focused-turn" } });
    append({ type: "item_work", itemId: "f-order", work: { state: "in_progress", assignmentId: "work-live", assignee: { backend: "codex", threadId: "thread-research-focused" }, note: "Replaying trace 17 with logging on the invalidation queue." } }, worker(4));
  } finally { db.close(); }
}

export const LONG_RESEARCH_OBJECTIVE = "Which retry path sends a webhook delivery twice?";
export const LONG_RESEARCH_EVENTS = 230;

/** Invented, finished research whose journal spans three Activity pages. It is older than the other fixture runs, so it is never selected first. */
export function seedLongResearchRun(stateDbPath: string): void {
  const db = StateDb.open(stateDbPath);
  const store = new ResearchStore(db);
  const coordinator: ResearchActor = { backend: "codex", threadId: "thread-smoke", kind: "agent" };
  const worker: ResearchActor = { ...coordinator, threadId: "thread-research-worker-1" };
  const runId = "research-long-fixture";
  let revision = 0;
  const append = (data: ResearchEventData, author = coordinator) => {
    if (data.type === "finding") data.finding.author = { backend: author.backend, threadId: author.threadId };
    const event: ResearchEvent = { seq: ++revision, commandId: `long-${revision}`, signature: `long-${revision}`,
      at: Date.UTC(2026, 9, 1, 9, 0, 0) + revision * 15_000, actor: author, data };
    if (revision === 1) store.create(runId, runId, event);
    else store.append(runId, revision - 1, event);
  };
  try {
    append({ type: "created", objective: LONG_RESEARCH_OBJECTIVE, coordinator, ownerId: "historical-fixture", ownerPid: 1,
      deadlineAt: Date.UTC(2026, 9, 1, 11, 0), workspaceMode: "none", approaches: [
        { id: "a1", title: "Retry timing", task: "Record each delivery attempt and the retry that caused it.", state: "pending" },
      ] });
    append({ type: "worker", approachId: "a1", state: "running", worker: { backend: "codex", threadId: worker.threadId, turnId: "long-turn" } });
    while (revision < LONG_RESEARCH_EVENTS - 2) {
      append({ type: "finding", finding: { id: `attempt-${revision}`, approachId: "a1", kind: "experiment",
        text: `Delivery attempt ${revision - 1} completed once after its retry.`, paths: [] } }, worker);
    }
    append({ type: "worker", approachId: "a1", state: "ended" });
    append({ type: "status", status: "exhausted", reason: "The worker ended without a candidate." });
  } finally { db.close(); }
}
