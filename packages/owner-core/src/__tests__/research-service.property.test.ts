import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { projectResearchRun, RESEARCH_MAX_EVENTS, sameResearchThread, searchResearchItems, type ResearchActor, type ResearchEvent, type ResearchThread, type StartResearchRequest, type ResearchSearchQuery } from "@pwragent/shared/research";
import { ResearchService, validateStartResearch, type ResearchPorts } from "../research-service";
import type { ResearchStorage } from "../research-storage";

class MemoryResearchStorage implements ResearchStorage {
  readonly records = new Map<string, ResearchEvent[]>();
  readonly keys = new Map<string, string>();
  findByStartKey(key: string) { const id = this.keys.get(key); return id ? this.get(id) : undefined; }
  get(id: string) { const records = this.records.get(id); return records ? projectResearchRun(id, structuredClone(records)) : undefined; }
  list(thread?: ResearchThread) { return [...this.records.keys()].map((id) => this.get(id)!).filter((r) => !thread || sameResearchThread(r.coordinator, thread) || r.approaches.some((a) => a.worker && sameResearchThread(a.worker, thread))); }
  header(id: string) { return this.get(id); }
  summaries(thread: ResearchThread) { return this.list(thread); }
  members(id: string) { const run = this.get(id)!; return [run.coordinator, ...run.approaches.flatMap((a) => a.worker ? [a.worker] : [])]; }
  isMember(id: string, thread: ResearchThread) { const run = this.get(id); return Boolean(run && (sameResearchThread(run.coordinator, thread) || run.approaches.some((a) => a.worker && sameResearchThread(a.worker, thread)))); }
  readItem(id: string, itemId: string) { return this.get(id)?.items.find((item) => item.id === itemId); }
  search(id: string, query: ResearchSearchQuery) { const run = this.get(id)!; return searchResearchItems(id, run.items, run.revision, query); }
  findCommand(id: string, commandId: string) { return this.records.get(id)?.find((e) => e.commandId === commandId); }
  create(id: string, key: string, event: ResearchEvent) { if (this.keys.has(key)) throw new Error("duplicate start"); this.keys.set(key, id); this.records.set(id, [structuredClone(event)]); }
  append(id: string, revision: number, event: ResearchEvent) {
    const records = this.records.get(id)!;
    const prior = records.find((e) => e.commandId === event.commandId);
    if (prior) { if (prior.signature !== event.signature) throw new Error("duplicate command"); return; }
    if (records.length !== revision) throw new Error("conflict");
    records.push(structuredClone(event));
  }
  appendBatch(id: string, revision: number, events: ResearchEvent[]) {
    for (const event of events) this.append(id, revision++, event);
  }
}

const context = { kind: "agent", backend: "codex", threadId: "coordinator", turnId: "parent-turn", callId: "start" } as const;
const request: StartResearchRequest = { objective: "Investigate a queue race", minutes: 10, workspaceMode: "none",
  approaches: [{ title: "Events", task: "Trace event order" }, { title: "Lifetime", task: "Check owner lifetime" }, { title: "Persistence", task: "Check durable state" }] };

function fixture(overrides: Partial<ResearchPorts> = {}, storage = new MemoryResearchStorage()) {
  let counter = 0;
  const ports: ResearchPorts = {
    ownerId: "owner", ownerPid: 123, ownerStartedAt: 500, isOwnerAlive: () => false, now: () => 1000,
    schedule: () => () => {}, changed: vi.fn(), onError: vi.fn(), stop: vi.fn(async () => {}), notify: vi.fn(async () => ({})), cancelQueued: vi.fn(async () => ({})),
    spawn: vi.fn(async (_context, _task, _title, _mode, created) => { const worker = { backend: "codex" as const, threadId: `worker-${++counter}`, turnId: `turn-${counter}` }; created(worker); return worker; }),
    ...overrides,
  };
  return { storage, ports, service: new ResearchService(storage, ports) };
}

describe("research lifecycle model", () => {
  it("synthetic pending notifications never own a worker or its cancellation", async () => {
    await fc.assert(fc.asyncProperty(fc.boolean(), async (cancelAtDeadline) => {
      let deadline!: () => void;
      const { service, ports } = fixture({ schedule: (callback) => { deadline = callback; return () => {}; } });
      ports.spawn = async (_c, _task, _title, _mode, created) => {
        const worker = { backend: "codex" as const, threadId: "created-child" };
        created(worker);
        await service.observeStart(worker, `pending:${worker.threadId}`);
        return { ...worker, turnId: "accepted-real-turn" };
      };
      const run = await service.start({ ...request, approaches: [request.approaches[0]!] }, context);
      expect(run.approaches[0]?.worker?.turnId).toBe("accepted-real-turn");
      expect(run.events.some((e) => e.data.type === "worker" && e.data.worker?.turnId?.startsWith("pending:"))).toBe(false);
      if (cancelAtDeadline) { deadline(); await vi.waitFor(() => expect(ports.stop).toHaveBeenCalled()); }
      else await service.stop(run.id, context, "stopped", "Operator stop");
      expect(ports.stop).toHaveBeenCalledExactlyOnceWith({ backend: "codex", threadId: "created-child", turnId: "accepted-real-turn" });
      service.close();
    }), { numRuns: 4 });
  });

  it("ambiguous start errors retain the worker reservation and deadline", async () => {
    const cancelTimer = vi.fn();
    let deadline!: () => void;
    const { service } = fixture({ schedule: (callback) => { deadline = callback; return cancelTimer; },
      spawn: async (_c, _task, _title, _mode, created) => { created({ backend: "codex", threadId: "possibly-admitted" }); throw new Error("Provider accepted the turn but its response was lost"); },
    });
    const run = await service.start({ ...request, approaches: [request.approaches[0]!] }, context);
    expect(run.status).toBe("running");
    expect(run.activeWorkers).toBe(1);
    expect(run.approaches[0]?.state).toBe("unknown");
    expect(cancelTimer).not.toHaveBeenCalled();
    const item = service.readItem(run.id, "a1", context).item;
    await expect(service.assign({ runId: run.id, itemId: "a1", expectedVersion: item.version, task: "Must not spend a second slot" }, { ...context, callId: "extra" })).rejects.toThrow("worker limit");
    deadline();
    await vi.waitFor(() => expect(service.read(run.id, context).status).toBe("stopping"));
    service.close();
  });

  it("revision admission cannot spend a slot already reused by a focused child", async () => {
    const { service, ports } = fixture();
    const run = await service.start({ ...request, approaches: [request.approaches[0]!] }, context);
    await service.update(run.id, "candidate", { action: "submit", approachId: "a1", text: "Candidate", paths: [] }, context);
    const submission = service.read(run.id, context).submissions[0]!;
    service.observeEnd(run.approaches[0]!.worker!, run.approaches[0]!.worker!.turnId!);
    const item = service.readItem(run.id, submission.id, context).item;
    await service.assign({ runId: run.id, itemId: item.id, expectedVersion: item.version, task: "Investigate this candidate" }, { ...context, callId: "child" });
    const before = service.read(run.id, context);
    await expect(service.update(run.id, "revise", { action: "review", submissionId: item.id, decision: "revision_requested", reason: "Revise the original candidate" }, context)).rejects.toThrow("worker limit");
    expect(service.read(run.id, context).revision).toBe(before.revision);
    expect(ports.notify).not.toHaveBeenCalled();
    service.close();
  });

  it.each(["pending", "queued", "unknown", "started"] as const)("revision reservations survive worker end and reconstruction while %s", async (state) => {
    const { service, ports, storage } = fixture();
    let release!: (value: { queueEntryId?: string; turnId?: string }) => void;
    const gate = new Promise<{ queueEntryId?: string; turnId?: string }>((resolve) => { release = resolve; });
    ports.notify = async () => await gate;
    const run = await service.start({ ...request, approaches: [request.approaches[0]!] }, context);
    await service.update(run.id, "candidate", { action: "submit", approachId: "a1", text: "Candidate", paths: [] }, context);
    const itemId = service.read(run.id, context).submissions[0]!.id;
    const revision = service.update(run.id, "revise", { action: "review", submissionId: itemId, decision: "revision_requested", reason: "Check it" }, context);
    if (state !== "pending") { release(state === "queued" ? { queueEntryId: "queued-revision" } : state === "started" ? { turnId: "revision-turn" } : {}); await revision; }
    service.observeEnd(run.approaches[0]!.worker!, run.approaches[0]!.worker!.turnId!);
    const rebuilt = fixture({}, storage).service;
    const current = rebuilt.read(run.id, context);
    expect(current.activeWorkers).toBe(1);
    const item = rebuilt.readItem(run.id, itemId, context).item;
    await expect(rebuilt.assign({ runId: run.id, itemId, expectedVersion: item.version, task: "Competing child" }, { ...context, callId: "extra" })).rejects.toThrow("worker limit");
    if (state === "started") {
      service.observeEnd(run.approaches[0]!.worker!, "revision-turn");
      expect(service.read(run.id, context).activeWorkers).toBe(0);
      expect(service.read(run.id, context).deliveries[0]?.state).toBe("ended");
    }
    if (state === "pending") { release({ queueEntryId: "queued-revision" }); await revision; }
    service.close(); rebuilt.close();
  });

  it("focused approach cancellation settles the selected approach and can be reopened", async () => {
    await fc.assert(fc.asyncProperty(fc.boolean(), async (cancelSourceFirst) => {
      let stops = 0;
      const { service, ports } = fixture({ stop: vi.fn(async () => { if (cancelSourceFirst && ++stops === 1) throw new Error("Lost first cancellation receipt"); }) });
      const run = await service.start({ ...request, approaches: [request.approaches[0]!] }, context);
      await service.update(run.id, "source", { action: "finding", approachId: "a1", kind: "note", text: "Source evidence", paths: [] }, context);
      const sourceId = service.read(run.id, context).findings[0]!.id;
      service.observeEnd(run.approaches[0]!.worker!, run.approaches[0]!.worker!.turnId!);
      const source = service.readItem(run.id, sourceId, context).item;
      const child = await service.assign({ runId: run.id, itemId: sourceId, expectedVersion: source.version, task: "Focused child" }, { ...context, callId: "child" });
      if (cancelSourceFirst) {
        const current = service.readItem(run.id, sourceId, context).item;
        expect((await service.work(run.id, "cancel-source", { action: "work", itemId: sourceId, expectedVersion: current.version, state: "cancelled", reason: "Cancel source" }, context)).work.state).toBe("cancel_requested");
      }
      const approach = service.readItem(run.id, child.assignmentId, context).item;
      const cancelled = await service.work(run.id, "cancel-approach", { action: "work", itemId: approach.id, expectedVersion: approach.version, state: "cancelled", reason: "Cancel this approach" }, context);
      expect(cancelled.work.state).toBe("cancelled");
      expect(ports.stop).toHaveBeenCalledTimes(cancelSourceFirst ? 2 : 1);
      expect(ports.stop).toHaveBeenLastCalledWith(child.worker);
      expect(service.readItem(run.id, sourceId, context).item.work.state).toBe(cancelSourceFirst ? "cancelled" : "assigned");
      expect(service.readItem(run.id, sourceId, context).item.record).toEqual(source.record);
      const reopened = await service.work(run.id, "reopen-approach", { action: "work", itemId: approach.id, expectedVersion: cancelled.version, state: "open", reason: "Retain for another investigation" }, context);
      expect(reopened.work.state).toBe("open");
      service.close();
    }), { numRuns: 6 });
  });

  it("revision capacity follows the queue owner's terminal oracle under generated delivery order", async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom("started", "terminal", "unrelated", "wrong_thread"), { minLength: 1, maxLength: 12 }), async (events) => {
      const { service, storage } = fixture({ notify: async () => ({ queueEntryId: "revision-entry" }) });
      const run = await service.start({ ...request, approaches: [request.approaches[0]!] }, context);
      const worker = run.approaches[0]!.worker!;
      await service.update(run.id, "candidate", { action: "submit", approachId: "a1", text: "Candidate", paths: [] }, context);
      await service.update(run.id, "revise", { action: "review", submissionId: service.read(run.id, context).submissions[0]!.id, decision: "revision_requested", reason: "Check it" }, context);
      service.observeEnd(worker, worker.turnId!);
      let reserved = true;
      for (const event of events) {
        if (event === "terminal") reserved = false;
        await service.observeQueue(event === "wrong_thread" ? { ...worker, threadId: "other" } : worker,
          event === "unrelated" ? "other-entry" : "revision-entry", event === "started" ? "started" : "terminal", "revision-turn");
        expect(service.read(run.id, context).activeWorkers).toBe(Number(reserved));
        expect(projectResearchRun(run.id, storage.records.get(run.id)!).activeWorkers).toBe(Number(reserved));
      }
      service.close();
    }), { numRuns: 25 });
  });

  it.each(["before_receipt", "after_receipt"] as const)("exact queue receipts release revision capacity %s", async (order) => {
    const { service, ports } = fixture();
    const run = await service.start({ ...request, approaches: [request.approaches[0]!] }, context);
    const worker = run.approaches[0]!.worker!;
    await service.update(run.id, "candidate", { action: "submit", approachId: "a1", text: "Candidate", paths: [] }, context);
    const itemId = service.read(run.id, context).submissions[0]!.id;
    ports.notify = async () => {
      if (order === "before_receipt") {
        await service.observeQueue(worker, "exact-entry", "started", "revision-turn");
        await service.observeQueue(worker, "exact-entry", "terminal", "revision-turn");
      }
      return { queueEntryId: "exact-entry" };
    };
    await service.update(run.id, "revise", { action: "review", submissionId: itemId, decision: "revision_requested", reason: "Check evidence" }, context);
    service.observeEnd(worker, worker.turnId!);
    if (order === "after_receipt") {
      expect(service.read(run.id, context).activeWorkers).toBe(1);
      await expect(service.update(run.id, "overlapping-revision", { action: "review", submissionId: itemId, decision: "revision_requested", reason: "Another request" }, context)).rejects.toThrow("already pending");
      await service.observeQueue(worker, "unrelated-entry", "terminal", "unrelated-turn");
      await service.observeQueue({ ...worker, threadId: "stranger" }, "exact-entry", "terminal", "revision-turn");
      expect(service.read(run.id, context).activeWorkers).toBe(1);
      await service.observeQueue(worker, "exact-entry", "started", "revision-turn");
      await service.observeQueue(worker, "exact-entry", "terminal", "different-turn");
      expect(service.read(run.id, context).activeWorkers).toBe(1);
      await service.observeQueue(worker, "exact-entry", "terminal", "revision-turn");
    }
    const settled = service.read(run.id, context);
    expect(settled.activeWorkers).toBe(0);
    expect(settled.deliveries[0]).toMatchObject({ state: "ended", turnId: "revision-turn", queueEntryId: "exact-entry" });
    await service.observeQueue(worker, "exact-entry", "started", "revision-turn");
    await service.observeQueue(worker, "exact-entry", "terminal", "revision-turn");
    expect(service.read(run.id, context).revision).toBe(settled.revision);
    const item = service.readItem(run.id, itemId, context).item;
    await service.assign({ runId: run.id, itemId, expectedVersion: item.version, task: "Use the released slot" }, { ...context, callId: "child" });
    service.close();
  });

  it("cancelling source evidence fences a late queued revision of its focused child", async () => {
    const { service, ports } = fixture();
    const run = await service.start({ ...request, approaches: [request.approaches[0]!] }, context);
    await service.update(run.id, "source", { action: "finding", approachId: "a1", kind: "note", text: "Source", paths: [] }, context);
    service.observeEnd(run.approaches[0]!.worker!, run.approaches[0]!.worker!.turnId!);
    const source = service.readItem(run.id, service.read(run.id, context).findings[0]!.id, context).item;
    const child = await service.assign({ runId: run.id, itemId: source.id, expectedVersion: source.version, task: "Investigate" }, { ...context, callId: "child" });
    await service.update(run.id, "candidate", { action: "submit", approachId: child.assignmentId, text: "Candidate", paths: [] }, context);
    let release!: (receipt: { queueEntryId: string }) => void;
    const gate = new Promise<{ queueEntryId: string }>((resolve) => { release = resolve; });
    ports.notify = async () => await gate;
    const revision = service.update(run.id, "revise", { action: "review", submissionId: service.read(run.id, context).submissions[0]!.id, decision: "revision_requested", reason: "Check it" }, context);
    const item = service.readItem(run.id, source.id, context).item;
    expect((await service.work(run.id, "cancel", { action: "work", itemId: item.id, expectedVersion: item.version, state: "cancelled", reason: "Cancel source assignment" }, context)).work.state).toBe("cancel_requested");
    release({ queueEntryId: "late-revision" });
    await revision;
    expect(ports.cancelQueued).toHaveBeenCalledExactlyOnceWith("late-revision");
    expect(service.readItem(run.id, source.id, context).item.work.state).toBe("cancelled");
    expect(service.read(run.id, context).activeWorkers).toBe(0);
    service.close();
  });

  it.each(["acknowledged", "lost"] as const)("an exact queue terminal event wins over a late cancellation result: %s", async (outcome) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { service } = fixture({ notify: async () => ({ queueEntryId: "revision-entry" }), cancelQueued: async () => { await gate; if (outcome === "lost") throw new Error("Lost cancellation response"); return {}; } });
    const run = await service.start({ ...request, approaches: [request.approaches[0]!] }, context);
    const worker = run.approaches[0]!.worker!;
    await service.update(run.id, "candidate", { action: "submit", approachId: "a1", text: "Candidate", paths: [] }, context);
    await service.update(run.id, "revise", { action: "review", submissionId: service.read(run.id, context).submissions[0]!.id, decision: "revision_requested", reason: "Check it" }, context);
    service.observeEnd(worker, worker.turnId!);
    const item = service.readItem(run.id, "a1", context).item;
    const cancelling = service.work(run.id, "cancel", { action: "work", itemId: item.id, expectedVersion: item.version, state: "cancelled", reason: "Cancel this approach" }, context);
    await service.observeQueue(worker, "revision-entry", "terminal", "revision-turn");
    release();
    expect((await cancelling).work.state).toBe("cancelled");
    expect(service.read(run.id, context).deliveries[0]?.state).toBe("ended");
    expect(service.read(run.id, context).activeWorkers).toBe(0);
    service.close();
  });

  it("cancelling a focused approach before binding prevents its admission", async () => {
    const { service, ports } = fixture();
    const run = await service.start({ ...request, approaches: [request.approaches[0]!] }, context);
    service.observeEnd(run.approaches[0]!.worker!, run.approaches[0]!.worker!.turnId!);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let admitted = false;
    ports.spawn = async (_c, _task, _title, _mode, created) => { await gate; created({ backend: "codex", threadId: "focused" }); admitted = true; return { backend: "codex", threadId: "focused", turnId: "must-not-start" }; };
    const source = service.readItem(run.id, "a1", context).item;
    const assigning = service.assign({ runId: run.id, itemId: source.id, expectedVersion: source.version, task: "Focused work" }, { ...context, callId: "child" });
    const focusedId = service.readItem(run.id, "a1", context).item.work.assignmentId!;
    const focused = service.readItem(run.id, focusedId, context).item;
    expect((await service.work(run.id, "cancel-focused", { action: "work", itemId: focusedId, expectedVersion: focused.version, state: "cancelled", reason: "Do not admit this child" }, context)).work.state).toBe("cancel_requested");
    release(); await assigning;
    expect(admitted).toBe(false);
    expect(service.readItem(run.id, focusedId, context).item.work.state).toBe("cancelled");
    service.close();
  });

  it("supports search, a focused child, optimistic progress and compact item identity", async () => {
    const { service, ports } = fixture();
    const run = await service.start(request, context);
    const posted = await service.update(run.id, "source", { action: "finding", approachId: "a1", kind: "counterexample", text: "A reversed queue needs investigation", paths: [] }, context);
    const source = posted.findings[0]!;
    const hits = service.search(run.id, { query: "REVERSED", kind: "counterexample", limit: 1 }, context);
    expect(hits.items.map((item) => item.id)).toEqual([source.id]);
    expect(JSON.stringify(hits)).not.toContain("events");
    const focused = service.readItem(run.id, source.id, context);
    await expect(service.assign({ runId: run.id, itemId: source.id, expectedVersion: focused.item.version, task: "Investigate this counterexample" }, context)).rejects.toThrow("worker limit");
    expect(ports.spawn).toHaveBeenCalledTimes(3);
    service.observeEnd(run.approaches[0]!.worker!, run.approaches[0]!.worker!.turnId!);
    const assignmentContext = { ...context, callId: "assign" };
    const assignment = { runId: run.id, itemId: source.id, expectedVersion: focused.item.version, task: "Investigate this counterexample" };
    const [first, duplicate] = await Promise.all([service.assign(assignment, assignmentContext), service.assign(assignment, assignmentContext)]);
    expect(first.assignmentId).toBe(duplicate.assignmentId);
    expect(ports.spawn).toHaveBeenCalledTimes(4);
    const child: ResearchActor = { ...first.worker!, kind: "agent", callId: "claim" };
    const item = service.readItem(run.id, source.id, child);
    expect(item.item.work).toMatchObject({ state: "assigned", assignmentId: first.assignmentId, assignee: { threadId: child.threadId } });
    const claims = await Promise.allSettled(["one", "two"].map((id) => service.update(run.id, id, { action: "work", itemId: source.id, expectedVersion: item.item.version, state: "claimed", reason: "Taking this item" }, child)));
    expect(claims.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(claims.filter((result) => result.status === "rejected")).toHaveLength(1);
    const claimed = service.readItem(run.id, source.id, child).item;
    await expect(service.work(run.id, "stale-progress", { action: "work", itemId: source.id, expectedVersion: item.item.version, state: "in_progress", reason: "An outdated reader must not overwrite a claim" }, child)).rejects.toThrow("changed");
    expect(service.readItem(run.id, source.id, child).item).toEqual(claimed);
    await service.update(run.id, "working", { action: "work", itemId: source.id, expectedVersion: claimed.version, state: "in_progress", reason: "Reproducing the failure" }, child);
    const current = service.readItem(run.id, source.id, child).item;
    await service.update(run.id, "complete", { action: "work", itemId: source.id, expectedVersion: current.version, state: "completed", reason: "Reproduced and recorded the cause" }, child);
    expect(service.search(run.id, { state: "completed" }, context).items.map((item) => item.id)).toEqual([source.id]);
    await expect(service.update(run.id, "wrong-approach", { action: "finding", approachId: "a1", kind: "note", text: "Outside the child assignment", paths: [] }, child)).rejects.toThrow();
    expect(() => service.readItem(run.id, source.id, { ...child, threadId: "stranger" })).toThrow("member");
    service.close();
  });

  it("search agrees with a simple filter oracle and cursors reject a changed board", async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom("queue", "owner", "counterexample"), { minLength: 1, maxLength: 15 }), async (texts) => {
      const { service } = fixture();
      const run = await service.start(request, context);
      for (const [i, text] of texts.entries()) await service.update(run.id, `post-${i}`, { action: "finding", approachId: "a1", kind: "note", text, paths: [] }, context);
      const expected = service.read(run.id, context).findings.filter((f) => f.text.includes("queue")).reverse().map((f) => f.id);
      const actual: string[] = [];
      let page = service.search(run.id, { query: "queue", type: "finding", limit: 2 }, context);
      actual.push(...page.items.map((item) => item.id));
      while (page.nextCursor) { page = service.search(run.id, { query: "queue", type: "finding", limit: 2, cursor: page.nextCursor }, context); actual.push(...page.items.map((item) => item.id)); }
      expect(actual).toEqual(expected);
      const first = service.search(run.id, { type: "finding", limit: 1 }, context);
      await service.update(run.id, "extra", { action: "finding", approachId: "a1", kind: "note", text: "New evidence", paths: [] }, context);
      if (first.nextCursor) expect(() => service.search(run.id, { type: "finding", limit: 1, cursor: first.nextCursor }, context)).toThrow("restart");
      service.close();
    }), { numRuns: 15 });
  });

  it.each(["before_binding", "after_binding", "after_admission"] as const)("item cancellation fences a delayed child %s", async (stage) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let admissions = 0;
    const { service, ports } = fixture();
    const run = await service.start({ ...request, approaches: [request.approaches[0]!] }, context);
    await service.update(run.id, "source", { action: "finding", approachId: "a1", kind: "note", text: "Focused work", paths: [] }, context);
    const source = service.read(run.id, context).findings[0]!;
    service.observeEnd(run.approaches[0]!.worker!, run.approaches[0]!.worker!.turnId!);
    expect(service.read(run.id, context).status).toBe("exhausted");
    ports.spawn = async (_c, _task, _title, _mode, created) => {
      const worker = { backend: "codex" as const, threadId: "focused-child", turnId: "focused-turn" };
      if (stage !== "before_binding") created({ backend: worker.backend, threadId: worker.threadId });
      if (stage === "after_admission") { admissions++; await service.observeStart(worker, worker.turnId); }
      await gate;
      if (stage === "before_binding") created({ backend: worker.backend, threadId: worker.threadId });
      return worker;
    };
    const initial = service.readItem(run.id, source.id, context).item;
    const assigning = service.assign({ runId: run.id, itemId: source.id, expectedVersion: initial.version, task: "Handle this ID" }, { ...context, callId: "focused" });
    const pending = service.readItem(run.id, source.id, context).item;
    const cancellation = await service.work(run.id, "cancel", { action: "work", itemId: source.id, expectedVersion: pending.version, state: "cancelled", reason: "Operator cancellation" }, context);
    expect(cancellation.work.state).toBe(stage === "after_admission" ? "cancelled" : "cancel_requested");
    release();
    const assignment = await assigning;
    expect(service.readItem(run.id, source.id, context).item.work.state).toBe("cancelled");
    expect(admissions).toBe(stage === "after_admission" ? 1 : 0);
    if (stage === "after_admission") expect(ports.stop).toHaveBeenCalledWith({ backend: "codex", threadId: "focused-child", turnId: "focused-turn" });
    expect(["failed", "stopped"]).toContain(assignment.state);
    service.close();
  });

  it("unknown item cancellation retains ownership until exact evidence and rejects stale assignees", async () => {
    const { service, ports } = fixture({ stop: async () => { throw new Error("Lost acknowledgement"); } });
    const run = await service.start({ ...request, approaches: [request.approaches[0]!] }, context);
    await service.update(run.id, "source", { action: "finding", approachId: "a1", kind: "note", text: "Focused work", paths: [] }, context);
    const source = service.read(run.id, context).findings[0]!;
    service.observeEnd(run.approaches[0]!.worker!, run.approaches[0]!.worker!.turnId!);
    const item = service.readItem(run.id, source.id, context).item;
    const assignment = await service.assign({ runId: run.id, itemId: item.id, expectedVersion: item.version, task: "Investigate" }, { ...context, callId: "first" });
    const current = service.readItem(run.id, source.id, context).item;
    const unknown = await service.work(run.id, "cancel", { action: "work", itemId: source.id, expectedVersion: current.version, state: "cancelled", reason: "Cancel" }, context);
    expect(unknown.work.state).toBe("cancel_requested");
    await expect(service.work(run.id, "unsafe-release", { action: "work", itemId: source.id, expectedVersion: unknown.version, state: "open", reason: "Try again" }, context)).rejects.toThrow();
    service.observeEnd(assignment.worker!, "unrelated-turn");
    expect(service.readItem(run.id, source.id, context).item.work.state).toBe("cancel_requested");
    service.observeEnd(assignment.worker!, assignment.worker!.turnId!);
    const settled = service.readItem(run.id, source.id, context).item;
    expect(settled.work.state).toBe("cancelled");
    const opened = await service.work(run.id, "release", { action: "work", itemId: source.id, expectedVersion: settled.version, state: "open", reason: "Assign another worker" }, context);
    ports.stop = async () => {};
    await service.assign({ runId: run.id, itemId: source.id, expectedVersion: opened.version, task: "Fresh attempt" }, { ...context, callId: "second" });
    const fresh = service.readItem(run.id, source.id, context).item;
    await expect(service.work(run.id, "old-worker", { action: "work", itemId: source.id, expectedVersion: fresh.version, state: "claimed", reason: "Old assignment" }, { ...assignment.worker!, kind: "agent" })).rejects.toThrow("assignee");
    service.close();
  });

  it("cancels an original approach by ID and keeps a reopened old turn inside the worker limit", async () => {
    const { service, ports } = fixture();
    const run = await service.start({ ...request, approaches: [request.approaches[0]!] }, context);
    const item = service.readItem(run.id, "a1", context).item;
    const cancelled = await service.work(run.id, "cancel-original", { action: "work", itemId: item.id, expectedVersion: item.version, state: "cancelled", reason: "Use this slot for focused work" }, context);
    expect(cancelled.work.state).toBe("cancelled");
    expect(ports.stop).toHaveBeenCalledExactlyOnceWith(run.approaches[0]!.worker);
    const opened = await service.work(run.id, "open", { action: "work", itemId: item.id, expectedVersion: cancelled.version, state: "open", reason: "New focused assignment" }, context);
    const child = await service.assign({ runId: run.id, itemId: item.id, expectedVersion: opened.version, task: "Focus on this approach" }, { ...context, callId: "child" });
    await service.observeStart(run.approaches[0]!.worker!, "old-thread-restarted");
    expect(ports.stop).toHaveBeenLastCalledWith({ ...run.approaches[0]!.worker!, turnId: "old-thread-restarted" });
    expect(service.read(run.id, context).approaches.find((a) => a.id === child.assignmentId)?.state).toBe("running");
    service.close();
  });

  it("reserves the last worker slot before concurrent assignment side effects", async () => {
    const { service, ports } = fixture();
    const run = await service.start({ ...request, approaches: [request.approaches[0]!] }, context);
    for (const text of ["First", "Second"]) await service.update(run.id, text, { action: "finding", approachId: "a1", kind: "note", text, paths: [] }, context);
    service.observeEnd(run.approaches[0]!.worker!, run.approaches[0]!.worker!.turnId!);
    const items = service.search(run.id, { type: "finding" }, context).items;
    const outcomes = await Promise.allSettled(items.map((item) => service.assign({ runId: run.id, itemId: item.id, expectedVersion: item.version, task: "Investigate" }, { ...context, callId: item.id })));
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(ports.spawn).toHaveBeenCalledTimes(2);
    expect(service.read(run.id, context).activeWorkers).toBe(1);
    service.close();
  });

  it("work-state input cannot rewrite evidence, review or assignee provenance", async () => {
    const { service } = fixture();
    const run = await service.start(request, context);
    await service.update(run.id, "source", { action: "submit", approachId: "a1", text: "Original candidate", paths: [] }, context);
    const source = service.read(run.id, context).submissions[0]!;
    await service.update(run.id, "review", { action: "review", submissionId: source.id, decision: "rejected", reason: "Counterexample remains" }, context);
    const before = service.readItem(run.id, source.id, context).item;
    const result = await service.work(run.id, "claim", { action: "work", itemId: before.id, expectedVersion: before.version, state: "claimed", reason: "Revise it",
      assignee: { backend: "codex", threadId: "forged" }, record: { text: "Replacement", review: { decision: "accepted" } },
    } as never, context);
    expect(result.record).toEqual(before.record);
    expect(result.work.assignee).toEqual({ backend: context.backend, threadId: context.threadId });
    service.close();
  });

  it("matches a board model under generated posts, redeliveries, and cancellation", async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom("post", "duplicate", "stop"), { size: "max", maxLength: 35 }), async (operations) => {
      const { service } = fixture();
      const run = await service.start(request, context);
      const worker: ResearchActor = { ...run.approaches[0]!.worker!, kind: "agent" };
      let stopped = false;
      let count = 0;
      let previous: { id: string; text: string } | undefined;
      for (const [index, op] of operations.entries()) {
        if (op === "stop") {
          await service.update(run.id, `stop-${index}`, { action: "stop", reason: "Operator cancellation" }, context);
          stopped = true;
        } else {
          const item = op === "duplicate" && previous ? previous : { id: `post-${index}`, text: `Evidence ${index}` };
          const command = { action: "finding", approachId: "a1", kind: "note", text: item.text, paths: [] } as const;
          if (stopped && item !== previous) await expect(service.update(run.id, item.id, { ...command, paths: [] }, worker)).rejects.toThrow();
          else if (stopped && item === previous) await service.update(run.id, item.id, { ...command, paths: [] }, worker);
          else {
            await service.update(run.id, item.id, { ...command, paths: [] }, worker);
            if (item !== previous) count++;
            previous = item;
          }
        }
        const current = service.read(run.id, context);
        expect(current.findings).toHaveLength(count);
        expect(current.status).toBe(stopped ? "stopped" : "running");
        expect(new Set(current.events.map((e) => e.commandId)).size).toBe(current.events.length);
      }
      service.close();
    }), { numRuns: 30 });
  });

  it("checks the worker cap across and beyond the boundary", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 12 }), (workers) => {
      const input = { ...request, approaches: Array.from({ length: workers }, (_, i) => ({ title: `Approach ${i}`, task: "Explore" })) };
      if (workers >= 1 && workers <= 8) expect(() => validateStartResearch(input)).not.toThrow();
      else expect(() => validateStartResearch(input)).toThrow();
    }));
    expect(() => validateStartResearch({ ...request, approaches: Array.from({ length: 9 }, (_, i) => ({ title: `Direction ${i}`, task: "Explore" })) })).toThrow();
  });

  it("a duplicate start never starts additional model work, even after reconstruction", async () => {
    const { service, ports, storage } = fixture();
    const [first, second] = await Promise.all([service.start(request, context), service.start(request, context)]);
    expect(first.id).toBe(second.id);
    expect(ports.spawn).toHaveBeenCalledTimes(3);
    const restarted = fixture({ ownerId: "replacement" }, storage);
    restarted.service.initialize();
    const retained = await restarted.service.start(request, context);
    expect(retained.status).toBe("interrupted");
    expect(restarted.ports.spawn).not.toHaveBeenCalled();
    await expect(restarted.service.start({ ...request, objective: "different" }, context)).rejects.toThrow();
  });

  it("cancellation fences remaining starts and waits for an admitted start to settle", async () => {
    let release!: () => void;
    let created!: ResearchPorts["spawn"] extends (...args: infer A) => unknown ? A[4] : never;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { service, ports, storage } = fixture({ spawn: vi.fn(async (_c, _task, _title, _mode, bind) => {
      created = bind;
      await gate;
      const worker = { backend: "codex" as const, threadId: "late-worker", turnId: "late-turn" };
      bind(worker);
      return worker;
    }) });
    const start = service.start(request, context);
    expect(created).toBeDefined();
    const run = storage.list()[0]!;
    expect((await service.update(run.id, "stop", { action: "stop", reason: "Cancel" }, context)).status).toBe("stopping");
    release();
    const result = await start;
    expect(ports.spawn).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("stopped");
    expect(result.approaches[0]?.state).toBe("failed");
  });

  it("does not confuse acceptance with verification or copy a verdict to a later candidate", async () => {
    const { service } = fixture();
    const run = await service.start(request, context);
    await service.update(run.id, "s1", { action: "submit", approachId: "a1", text: "Candidate", paths: [] }, context);
    const submission = service.read(run.id, context).submissions[0]!;
    await service.update(run.id, "v1", { action: "review", submissionId: submission.id, decision: "accepted", reason: "Evidence supports this" }, context);
    const result = await service.update(run.id, "s2", { action: "submit", approachId: "a1", text: "Revised candidate", paths: [] }, context);
    expect(result.submissions[0]?.review?.decision).toBe("accepted");
    expect(result.submissions[1]?.review).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('"verified"');
  });

  it("workers cannot review, post under another approach, or read a foreign run", async () => {
    const { service } = fixture();
    const run = await service.start(request, context);
    const worker: ResearchActor = { ...run.approaches[0]!.worker!, kind: "agent" };
    await expect(service.update(run.id, "wrong", { action: "finding", approachId: "a2", kind: "note", text: "Claim", paths: [] }, worker)).rejects.toThrow();
    await expect(service.update(run.id, "review", { action: "review", submissionId: "s", decision: "accepted", reason: "yes" }, worker)).rejects.toThrow();
    expect(() => service.read(run.id, { ...worker, threadId: "stranger" })).toThrow();
  });

  it("only the exact assigned turn retires a worker", async () => {
    const { service } = fixture();
    const run = await service.start(request, context);
    const worker = run.approaches[0]!.worker!;
    service.observeEnd(worker, "different-turn");
    expect(service.read(run.id, context).approaches[0]?.state).toBe("running");
    service.observeEnd(worker, worker.turnId!);
    service.observeEnd(worker, worker.turnId!);
    expect(service.read(run.id, context).approaches[0]?.state).toBe("ended");
    expect(service.read(run.id, context).events.filter((e) => e.commandId.startsWith("ended:"))).toHaveLength(1);
  });

  it("does not reclaim another live process's run", async () => {
    const { service, storage } = fixture();
    const run = await service.start(request, context);
    const viewer = fixture({ ownerId: "viewer", isOwnerAlive: () => true }, storage);
    viewer.service.initialize();
    expect(viewer.service.read(run.id, context).status).toBe("running");
    await expect(viewer.service.update(run.id, "stop", { action: "stop", reason: "Cancel" }, context)).rejects.toThrow();
  });

  it("recovery follows the complete process identity rather than a reused PID", async () => {
    const owner = { ownerId: "runtime-v2-owner", ownerPid: 123, ownerStartedAt: 500 };
    for (const changed of ["none", "instance", "pid", "start"] as const) {
      const { service, storage } = fixture(owner);
      const run = await service.start(request, context);
      const marker = { ...owner,
        ...(changed === "instance" ? { ownerId: "runtime-v2-unrelated" } : {}),
        ...(changed === "pid" ? { ownerPid: 124 } : {}),
        ...(changed === "start" ? { ownerStartedAt: 501 } : {}),
      };
      const viewer = fixture({ ownerId: "viewer", isOwnerAlive: (value: unknown) => {
        // Model the old PID-only adapter as well as the identity-aware port.
        if (typeof value === "number") return value === marker.ownerPid;
        const candidate = value as typeof owner;
        return candidate.ownerId === marker.ownerId && candidate.ownerPid === marker.ownerPid && candidate.ownerStartedAt === marker.ownerStartedAt;
      } }, storage);
      viewer.service.initialize();
      expect(viewer.service.read(run.id, context).status).toBe(changed === "none" ? "running" : "interrupted");
      expect(viewer.ports.spawn).not.toHaveBeenCalled();
      service.close();
      viewer.service.close();
    }
  });

  it("cancels a revision accepted by the queue after cancellation began", async () => {
    let release!: (receipt: { queueEntryId: string }) => void;
    const receipt = new Promise<{ queueEntryId: string }>((resolve) => { release = resolve; });
    const { service, ports } = fixture({ notify: async () => await receipt });
    const run = await service.start(request, context);
    await service.update(run.id, "s", { action: "submit", approachId: "a1", text: "Candidate", paths: [] }, context);
    const submissionId = service.read(run.id, context).submissions[0]!.id;
    const revision = service.update(run.id, "r", { action: "review", submissionId, decision: "revision_requested", reason: "Check evidence" }, { ...context, kind: "operator" });
    const stopping = await service.update(run.id, "stop", { action: "stop", reason: "Stop" }, context);
    expect(stopping.status).toBe("stopping");
    release({ queueEntryId: "late-feedback" });
    const result = await revision;
    expect(ports.cancelQueued).toHaveBeenCalledExactlyOnceWith("late-feedback");
    expect(result.status).toBe("stopped");
  });

  it("never reports a successful stop when revision cancellation is unknown", async () => {
    const { service } = fixture({ notify: async () => ({ queueEntryId: "feedback" }), cancelQueued: async () => { throw new Error("Lost receipt"); } });
    const run = await service.start(request, context);
    await service.update(run.id, "s", { action: "submit", approachId: "a1", text: "Candidate", paths: [] }, context);
    await service.update(run.id, "r", { action: "review", submissionId: service.read(run.id, context).submissions[0]!.id, decision: "revision_requested", reason: "Check evidence" }, { ...context, kind: "operator" });
    const stopped = await service.update(run.id, "stop", { action: "stop", reason: "Stop" }, context);
    expect(stopped.status).toBe("stopping");
    expect(stopped.deliveries[0]?.state).toBe("unknown");
  });

  it("rejects work at the deadline even before the timer runs", async () => {
    let now = 1000;
    const { service } = fixture({ now: () => now });
    const run = await service.start(request, context);
    now = run.deadlineAt;
    await expect(service.update(run.id, "late", { action: "finding", approachId: "a1", kind: "note", text: "Late work", paths: [] }, context)).rejects.toThrow();
    expect((await service.stop(run.id, context, "deadline", "Deadline")).status).toBe("deadline");
  });

  it("the contribution limit never prevents cancelling a recorded revision delivery", async () => {
    const { service, storage } = fixture({ notify: async () => ({ queueEntryId: "feedback" }) });
    const run = await service.start(request, context);
    await service.update(run.id, "s", { action: "submit", approachId: "a1", text: "Candidate", paths: [] }, context);
    await service.update(run.id, "r", { action: "review", submissionId: service.read(run.id, context).submissions[0]!.id, decision: "revision_requested", reason: "Check evidence" }, { ...context, kind: "operator" });
    const records = storage.records.get(run.id)!;
    while (records.length < RESEARCH_MAX_EVENTS) records.push({ seq: records.length + 1, commandId: `prior-boundary:${records.length}`, signature: "prior-boundary", at: 1000, actor: context,
      data: { type: "worker", approachId: "a1", state: "running" } });
    await expect(service.update(run.id, "over-limit", { action: "finding", approachId: "a1", kind: "note", text: "More work", paths: [] }, context)).rejects.toThrow("limit");
    const stopped = await service.update(run.id, "stop", { action: "stop", reason: "Stop" }, context);
    expect(stopped.status).toBe("stopped");
    expect(stopped.deliveries[0]?.state).toBe("cancelled");
  });

  it("settles an unknown revision cancellation only after its exact admitted turn ends", async () => {
    const { service } = fixture({ notify: async () => ({ queueEntryId: "feedback" }),
      cancelQueued: async () => ({ turnId: "revision-turn" }),
      stop: async (worker) => { if (worker.turnId === "revision-turn") throw new Error("Lost cancellation receipt"); },
    });
    const run = await service.start(request, context);
    await service.update(run.id, "s", { action: "submit", approachId: "a1", text: "Candidate", paths: [] }, context);
    await service.update(run.id, "r", { action: "review", submissionId: service.read(run.id, context).submissions[0]!.id, decision: "revision_requested", reason: "Check evidence" }, { ...context, kind: "operator" });
    const stopping = await service.update(run.id, "stop", { action: "stop", reason: "Stop" }, context);
    expect(stopping.status).toBe("stopping");
    expect(stopping.deliveries[0]).toMatchObject({ state: "unknown", turnId: "revision-turn" });
    const worker = run.approaches[0]!.worker!;
    service.observeEnd(worker, "unrelated-turn");
    expect(service.read(run.id, context).status).toBe("stopping");
    service.observeEnd(worker, "revision-turn");
    expect(service.read(run.id, context).status).toBe("stopped");
    expect(service.read(run.id, context).deliveries[0]?.state).toBe("cancelled");
    const revision = service.read(run.id, context).revision;
    service.observeEnd(worker, "revision-turn");
    expect(service.read(run.id, context).revision).toBe(revision);
  });

  it("preserves direction history when abandoned work is redirected", async () => {
    const { service, ports } = fixture();
    const run = await service.start(request, context);
    await service.update(run.id, "abandon", { action: "abandon", approachId: "a1", reason: "Counterexample" }, context);
    await expect(service.update(run.id, "post", { action: "finding", approachId: "a1", kind: "note", text: "More work", paths: [] }, context)).rejects.toThrow();
    const revised = await service.update(run.id, "redirect", { action: "direction", approachId: "a1", title: "Cancellation", task: "Trace cancellation", reason: "Event order is ruled out", overlapsApproachId: "a2" }, context);
    expect(revised.approaches[0]).toMatchObject({ title: "Cancellation", directionState: "active", overlapsApproachId: "a2" });
    expect(revised.events.some((e) => e.data.type === "abandoned")).toBe(true);
    expect(revised.events[0]?.data).toMatchObject({ approaches: [{ title: "Events" }, {}, {}] });
    expect(ports.spawn).toHaveBeenCalledTimes(3);
  });

  it("binds the panel's exact limits to its coordinator and consumes that request once", async () => {
    const { service, ports } = fixture();
    const prepared = service.prepare({ backend: "codex", threadId: "coordinator", objective: request.objective, workers: 3, minutes: request.minutes, workspaceMode: request.workspaceMode });
    await expect(service.start({ ...request, intentId: prepared.intentId, minutes: request.minutes + 1 }, context)).rejects.toThrow("exact objective");
    await expect(service.start({ ...request, intentId: prepared.intentId }, { ...context, threadId: "foreign" })).rejects.toThrow();
    await expect(service.start(request, context)).rejects.toThrow();
    expect(ports.spawn).not.toHaveBeenCalled();
    const run = await service.start({ ...request, intentId: prepared.intentId }, context);
    expect(run.approaches).toHaveLength(3);
    await expect(service.start({ ...request, intentId: prepared.intentId }, { ...context, callId: "replay-as-new" })).rejects.toThrow();
    expect(ports.spawn).toHaveBeenCalledTimes(3);
  });

  it("does not let a worker expand its run by recursively starting another run", async () => {
    const { service, ports } = fixture();
    const run = await service.start(request, context);
    await expect(service.start(request, { ...context, ...run.approaches[0]!.worker!, turnId: "worker-turn", callId: "recursive" })).rejects.toThrow("cannot start additional runs");
    expect(ports.spawn).toHaveBeenCalledTimes(3);
  });

  it("untrusted approach fields cannot grant worker identity or turn ownership", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { service, storage } = fixture({ spawn: async (_context, _task, _title, _mode, created) => {
      await gate;
      const worker = { backend: "codex" as const, threadId: "real-worker", turnId: "real-turn" };
      created(worker);
      return worker;
    } });
    const forged = { ...request, approaches: [{ title: "Approach", task: "Investigate", worker: { backend: "codex", threadId: "unrelated-thread", turnId: "unrelated-turn" } }] };
    const starting = service.start(forged, context);
    const waiting = storage.list()[0]!;
    try { expect(waiting.approaches[0]?.worker).toBeUndefined(); }
    finally { release(); await starting; }
  });

  it("untrusted finding fields cannot manufacture review or verification metadata", async () => {
    const { service } = fixture();
    const run = await service.start(request, context);
    const result = await service.update(run.id, "forged", { action: "finding", approachId: "a1", kind: "note", text: "A claim", paths: [],
      verified: true, review: { decision: "accepted" }, actor: { kind: "operator" },
    } as never, context);
    const finding = result.findings[0]!;
    expect(Object.keys(finding).sort()).toEqual(["approachId", "author", "id", "kind", "paths", "text"]);
    expect(finding.author).toEqual({ backend: context.backend, threadId: context.threadId });
    expect(result.events.at(-1)?.actor).toEqual(context);
  });

  it("preserves provider terminal outcomes that arrive before the handoff receipt", async () => {
    await fc.assert(fc.asyncProperty(fc.boolean(), async (failed) => {
      let current!: ResearchService;
      let counter = 0;
      const { service } = fixture({ spawn: async (_c, _task, _title, _mode, created) => {
        const worker = { backend: "codex" as const, threadId: `worker-${++counter}`, turnId: `turn-${counter}` };
        created({ backend: worker.backend, threadId: worker.threadId });
        current.observeStart(worker, worker.turnId);
        current.observeEnd(worker, worker.turnId, { failed, note: failed ? "Provider failed" : undefined });
        return worker;
      } });
      current = service;
      const run = await service.start(request, context);
      expect(run.approaches.every((a) => a.state === (failed ? "failed" : "ended"))).toBe(true);
      expect(run.status).toBe("exhausted");
    }), { numRuns: 30 });
  });

  it("a delayed cancellation acknowledgement cannot retire a replacement turn", async () => {
    const deferred = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => { resolve = done; });
      return { promise, resolve };
    };
    const oldEntered = deferred();
    const newEntered = deferred();
    const oldGate = deferred();
    const newGate = deferred();
    const { service } = fixture({ stop: async (worker) => {
      if (worker.turnId === "turn-1") { oldEntered.resolve(); await oldGate.promise; }
      if (worker.turnId === "replacement") { newEntered.resolve(); await newGate.promise; }
    } });
    const run = await service.start(request, context);
    const worker = run.approaches[0]!.worker!;
    const stopping = service.update(run.id, "stop", { action: "stop", reason: "Operator stop" }, context);
    await oldEntered.promise;
    service.observeEnd(worker, "turn-1");
    const replacement = service.observeStart(worker, "replacement");
    await newEntered.promise;
    oldGate.resolve();
    await stopping;
    expect(service.read(run.id, context).approaches[0]).toMatchObject({ state: "running", worker: { turnId: "replacement" } });
    newGate.resolve();
    await replacement;
    expect(service.read(run.id, context).status).toBe("stopped");
  });

  it("handoff receipts cannot replace the latest provider-observed turn", async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 4 }), fc.boolean(), fc.boolean(), async (followups, terminal, cancel) => {
      let current!: ResearchService;
      const worker = { backend: "codex" as const, threadId: "worker", turnId: "initial" };
      const latest = `followup-${followups}`;
      const { service, ports } = fixture({ spawn: async (_c, _task, _title, _mode, created) => {
        created({ backend: worker.backend, threadId: worker.threadId });
        await current.observeStart(worker, worker.turnId);
        current.observeEnd(worker, worker.turnId);
        for (let i = 1; i <= followups; i++) {
          await current.observeStart(worker, `followup-${i}`);
          if (i < followups || terminal) current.observeEnd(worker, `followup-${i}`);
        }
        return worker;
      } });
      current = service;
      const run = await service.start({ ...request, approaches: [request.approaches[0]!] }, context);
      expect(run.approaches[0]).toMatchObject({ worker: { turnId: latest }, state: terminal ? "ended" : "running" });
      if (!terminal && cancel) {
        await service.stop(run.id, context, "stopped", "Cancel");
        expect(ports.stop).toHaveBeenCalledExactlyOnceWith({ ...worker, turnId: latest });
      } else {
        if (!terminal) service.observeEnd(worker, latest);
        expect(service.read(run.id, context).status).toBe("exhausted");
      }
      service.close();
    }), { numRuns: 30 });
  });
});
