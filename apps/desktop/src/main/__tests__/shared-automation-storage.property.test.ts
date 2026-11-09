import fc from "fast-check";
import { afterEach, expect, it, vi } from "vitest";
import type { AutomationRunStatus, AutomationRunTranscriptEvent, AutomationTriggerDefinition } from "@pwragent/shared";
import { mergeTranscriptEvents as sharedMerge } from "@pwragent/owner-core/automation-transcript-merge";
import { AutomationStore as SharedStore } from "@pwragent/sqlite-storage/automation-store";
import { StateDb } from "@pwragent/sqlite-storage/state-db";
import { AutomationStore as DesktopStore } from "../storage/automation-store";
import { mergeTranscriptEvents as desktopMerge } from "../automations/transcript-merge";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { createTempStateDb, openInMemoryStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

const host = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../log", () => ({ getMainLogger: () => host }));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
const bindings = [SharedStore, DesktopStore];
const backends = ["codex", "acp:kimi"] as const;
const schedule = { kind: "interval", every: 5, unit: "minutes" } as const;

it("binds every desktop automation instance and transcript policy to shared implementations", () => {
  fc.assert(fc.property(fc.constantFrom("prototype", "instance", "policy"), entry => {
    if (entry === "policy") expect(desktopMerge).toBe(sharedMerge);
    else if (entry === "prototype") expect(DesktopStore.prototype instanceof SharedStore).toBe(true);
    else {
      const db = openInMemoryStateDb();
      try { expect(new DesktopStore(db) instanceof SharedStore).toBe(true); }
      finally { db.close(); }
    }
  }));
});

// The first terminal result is authoritative. Late acknowledgements may fill
// identities, but cannot rewind lifecycle times or overwrite that outcome.
it("matches an independent run model across host WAL connections and reopens without extra writes", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  await fc.assert(fc.asyncProperty(fc.array(fc.record({
    host: fc.integer({ min: 0, max: 1 }), slot: fc.integer({ min: 0, max: 3 }),
    event: fc.constantFrom("queued", "started", "completed", "failed", "cancelled", "skipped"),
    reopen: fc.boolean(),
  }), { minLength: 1, maxLength: 30 }), async commands => {
    const fixture = createTempStateDb("shared-automation-runs-");
    const dbs = bindings.map(() => StateDb.open(fixture.dbPath));
    const stores = dbs.map((db, i) => new bindings[i]!(db));
    const model = new Map<number, { status: AutomationRunStatus; queuedAt?: number; startedAt?: number;
      completedAt?: number; backendTurnId?: string; backendThreadId?: string; queueEntryId?: string; errorMessage?: string }>();
    try {
      for (const backend of backends) stores[0]!.createAutomation({ id: backend, backend,
        threadId: "same-owner-id", name: backend, taskPrompt: "Invented task", schedule, now: 0 });
      for (const [index, command] of commands.entries()) {
        const now = index + 1;
        const store = stores[command.host]!;
        const id = `run-${command.slot}`;
        const backend = backends[command.slot % 2]!;
        let expected = model.get(command.slot);
        if (!expected) {
          store.createRun({ id, automationId: backend, trigger: "manual", now: 0 });
          expected = { status: "pending" };
          model.set(command.slot, expected);
        }
        const before = { ...expected };
        const live = ["pending", "queued", "running"].includes(expected.status);
        let commits = 0;
        if (command.event === "queued") {
          expected.queueEntryId = `queue-${command.slot}`;
          if (["pending", "queued"].includes(expected.status)) {
            expected.status = "queued";
            expected.queuedAt ??= now;
          }
        } else if (command.event === "started") {
          expected.backendTurnId ??= "same-turn-id";
          expected.backendThreadId ??= `execution-${command.slot}`;
          if (live) { expected.status = "running"; expected.startedAt ??= now; }
        } else if (live) {
          expected.status = command.event;
          expected.completedAt = now;
          expected.errorMessage = `Outcome ${now}`;
          commits = 2;
        }
        if (commits === 0 && JSON.stringify(before) !== JSON.stringify(expected)) commits = 1;
        const written = await measureSqliteWrites(() => {
          if (command.event === "queued") store.markRunQueued({ runId: id, queueEntryId: `queue-${command.slot}`, now });
          else if (command.event === "started") store.markRunStarted({ runId: id,
            backendTurnId: "same-turn-id", backendThreadId: `execution-${command.slot}`, now });
          else store.markRunTerminal({ runId: id, status: command.event, errorMessage: `Outcome ${now}`, now });
        });
        expect(written.writes.commits).toBe(commits);
        if (command.reopen) {
          dbs[command.host]!.close();
          const reopened = await measureSqliteWrites(() => StateDb.open(fixture.dbPath));
          expect(reopened.writes.commits).toBe(0);
          dbs[command.host] = reopened.result;
          stores[command.host] = new bindings[command.host]!(reopened.result);
        }
        const reads = await measureSqliteWrites(() => {
          for (const observer of stores) {
            for (const [slot, state] of model) {
              const result = observer.getRun(`run-${slot}`)!;
              expect(result).toMatchObject({ id: `run-${slot}`, automationId: backends[slot % 2],
                backend: backends[slot % 2], trigger: "manual", scheduledWindows: [], ...state });
              for (const field of ["queuedAt", "startedAt", "completedAt", "errorMessage"]) {
                expect(result[field as keyof typeof result]).toEqual(state[field as keyof typeof state]);
              }
            }
            for (const backendKind of backends) {
              expect(observer.listRunsForThread({ backend: backendKind, threadId: "same-owner-id" }).map(run => run.id).sort())
                .toEqual([...model.keys()].filter(slot => backends[slot % 2] === backendKind).map(slot => `run-${slot}`).sort());
              for (const [turnId, run] of observer.findRunsByBackendTurnIds({ backend: backendKind, backendTurnIds: ["same-turn-id"] })) {
                expect(run.backend).toBe(backendKind);
                expect(run.backendTurnId).toBe(turnId);
              }
            }
          }
        });
        expect([reads.writes.commits, reads.writes.statements, reads.writes.rowsChanged]).toEqual([0, 0, 0]);
      }
    } finally { for (const db of dbs) db.close(); removeTempStateDbDir(fixture.tempDir); }
  }), { numRuns: 25 });
});

// Rebuild the policy with positional scans: ids keep their first insertion
// position and their last value; equal trimmed final text appears only once.
function transcriptOracle(events: AutomationRunTranscriptEvent[]): AutomationRunTranscriptEvent[] {
  const ids = events.map(event => event.id).filter((id, i, all) => all.indexOf(id) === i);
  const latest = ids.map(id => events.findLast(event => event.id === id)!)
    .sort((a, b) => a.at - b.at);
  return latest.filter((event, i) => event.kind !== "assistant_final" || !event.text?.trim()
    || !latest.slice(0, i).some(prior => prior.kind === "assistant_final" && prior.text?.trim() === event.text?.trim()));
}

it("retains independently merged artifacts across shared/desktop WAL reads and pruning", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const event = fc.record({ id: fc.integer({ min: 0, max: 4 }).map(String),
    at: fc.integer({ min: 0, max: 5 }), kind: fc.constantFrom("assistant_final", "lifecycle"),
    text: fc.constantFrom("", "Invented result", " Invented result ", "Other result") });
  await fc.assert(fc.asyncProperty(fc.array(fc.array(event, { maxLength: 8 }), { minLength: 1, maxLength: 10 }),
    fc.integer({ min: 1, max: 4 }), async (batches, limit) => {
      const fixture = createTempStateDb("shared-automation-artifacts-");
      const dbs = bindings.map(() => StateDb.open(fixture.dbPath));
      const stores = dbs.map((db, i) => new bindings[i]!(db, { runHistoryLimit: limit }));
      try {
        stores[0]!.createAutomation({ id: "automation", backend: "codex", threadId: "owner",
          name: "Fixture", taskPrompt: "Invented task", schedule, now: 0 });
        stores[0]!.createRun({ id: "run", automationId: "automation", trigger: "manual", now: 0 });
        let expected: AutomationRunTranscriptEvent[] = [];
        for (const [i, batch] of batches.entries()) {
          expected = transcriptOracle([...expected, ...batch]);
          const write = await measureSqliteWrites(() => stores[i % 2]!.appendRunTranscriptEvents({ runId: "run", events: batch, now: i }));
          expect(write.writes.commits).toBe(1);
          for (const store of stores) expect(store.getRunArtifact("run")?.transcriptEvents).toEqual(expected);
        }
        for (let i = 1; i <= limit + 1; i++) {
          stores[i % 2]!.createRun({ id: `new-${i}`, automationId: "automation", trigger: "manual", now: 100 + i });
        }
        for (const store of stores) {
          expect(store.getRun("run")).toBeUndefined();
          expect(store.getRunArtifact("run")).toBeUndefined();
          expect(store.listRunsForAutomation("automation").map(run => run.id))
            .toEqual(Array.from({ length: limit }, (_, i) => `new-${limit + 1 - i}`));
        }
      } finally { for (const db of dbs) db.close(); removeTempStateDbDir(fixture.tempDir); }
    }), { numRuns: 25 });
});

it("keeps startup reconciliation atomic and outer transactions authoritative over run/artifact changes", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 5 }), async count => {
    const db = openInMemoryStateDb();
    try {
      const portable = new SharedStore(db);
      const desktop = new DesktopStore(db);
      for (let i = 0; i < count; i++) {
        portable.createAutomation({ id: `a-${i}`, backend: "codex", threadId: `owner-${i}`,
          name: "Fixture", taskPrompt: "Invented task", schedule, now: 0 });
        portable.createRun({ id: `r-${i}`, automationId: `a-${i}`, trigger: "manual", now: 0 });
        portable.markRunStarted({ runId: `r-${i}`, backendTurnId: `turn-${i}`, now: 1 });
      }
      const original = db.raw.prepare("SELECT * FROM automation_runs ORDER BY run_id").all();
      db.raw.exec("CREATE TRIGGER refuse_reconcile BEFORE UPDATE ON automations BEGIN SELECT RAISE(ABORT, 'fixture refusal'); END");
      expect(() => desktop.reconcileStartup({ now: 10 })).toThrow("fixture refusal");
      expect(db.raw.prepare("SELECT * FROM automation_runs ORDER BY run_id").all()).toEqual(original);
      db.raw.exec("DROP TRIGGER refuse_reconcile");
      expect(() => db.raw.transaction(() => {
        portable.markRunTerminal({ runId: "r-0", status: "completed", now: 10 });
        desktop.appendRunTranscriptEvent({ runId: "r-0", event: { id: "event", kind: "lifecycle", at: 10 }, now: 10 });
        throw new Error("outer refusal");
      }).immediate()).toThrow("outer refusal");
      expect(db.raw.prepare("SELECT * FROM automation_runs ORDER BY run_id").all()).toEqual(original);
      expect(portable.getRunArtifact("r-0")).toBeUndefined();
      desktop.reconcileStartup({ now: 20, nextRunAtByAutomationId: { "a-0": 30 } });
      for (let i = 0; i < count; i++) expect(portable.getRun(`r-${i}`))
        .toMatchObject({ status: "cancelled", completedAt: 20, backendTurnId: `turn-${i}` });
      expect(portable.getAutomation("a-0")?.nextRunAt).toBe(30);
    } finally { db.close(); }
  }), { numRuns: 25 });
});

it("preserves both host warning sites and keeps corrupt/future rows unchanged", () => {
  const db = openInMemoryStateDb();
  try {
    const sharedWarn = vi.fn();
    const portable = new SharedStore(db, { warn: sharedWarn });
    const desktop = new DesktopStore(db);
    portable.createAutomation({ id: "bad", backend: "codex", threadId: "owner", name: "Bad fixture",
      taskPrompt: "Invented task", schedule, now: 0 });
    db.raw.prepare("UPDATE automations SET payload = ? WHERE automation_id = ?").run("{", "bad");
    const original = db.raw.prepare("SELECT * FROM automations").all();
    for (const store of [portable, desktop]) {
      expect(store.listAutomations()).toEqual([]);
      expect(store.listAutomations()).toEqual([]);
      expect(store.getAutomationLoadIssues()).toMatchObject([{ id: "bad", name: "Bad fixture" }]);
    }
    const malformed = { id: "inbound", kind: "inbound_message", conversation: { channel: "telegram", conversationId: "fixture" },
      conditionGroup: { join: "future-join", conditions: [] } } as unknown as AutomationTriggerDefinition;
    for (const store of [portable, desktop]) store.createAutomation({ id: "future", backend: "codex", threadId: "owner",
      name: "Future fixture", taskPrompt: "Invented task", triggers: [malformed], schedule, now: 1 });
    for (const warn of [sharedWarn, host.warn]) {
      expect(warn.mock.calls.map(call => call[0])).toEqual([
        "skipping automation that could not be loaded", "dropping inbound trigger with an unparseable condition group",
      ]);
      expect(warn.mock.calls[0]![1]).toMatchObject({ automationId: "bad", name: "Bad fixture" });
      expect(warn.mock.calls[1]![1]).toMatchObject({ triggerId: "inbound", channel: "telegram", join: "future-join" });
    }
    expect(db.raw.prepare("SELECT * FROM automations WHERE automation_id = 'bad'").all()).toEqual(original);
  } finally { db.close(); }
});
