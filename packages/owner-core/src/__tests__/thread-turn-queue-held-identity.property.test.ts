import fc from "fast-check";
import { expect, it } from "vitest";
import { ThreadTurnQueue, type ThreadTurnQueueEntry } from "../thread-turn-queue";

const THREAD = { backend: "codex" as const, threadId: "held-identity" };
const input = (text: string) => [{ type: "text" as const, text }];

it("a held admission cannot claim an ordinary acceptance even when its FIFO is already held", async () => {
  await fc.assert(fc.asyncProperty(fc.string({ maxLength: 30 }), fc.boolean(), async (suffix, heldFifo) => {
    const events: string[] = [];
    const queue = new ThreadTurnQueue({ isThreadActive: () => true,
      startTurn: async entry => ({ ...entry, turnId: "unused" }), onLifecycle: event => { events.push(event.type); } });
    const entry = { ...THREAD, id: "same", origin: "manual" as const, input: input(`Accepted ${suffix}`) };
    try {
      if (heldFifo) await queue.submitHeld({ ...THREAD, id: "review", origin: "scheduled", input: input("Review") }, "Review required");
      await queue.submit(entry);
      const before = structuredClone(queue.getQueuedEntries(THREAD));
      const offset = events.length;
      await expect(queue.submitHeld({ ...entry, origin: "scheduled" }, "Scheduled review required")).rejects.toThrow(/reused|identity/);
      expect(queue.getQueuedEntries(THREAD)).toEqual(before);
      expect(events.slice(offset)).toEqual([]);
    } finally { queue.close(); }
  }));
});

it("a FIFO hold does not turn an ordinary acceptance into the held caller's acceptance", async () => {
  const queue = new ThreadTurnQueue({ isThreadActive: () => true, startTurn: async entry => ({ ...entry, turnId: "unused" }) });
  try {
    await queue.submitHeld({ ...THREAD, id: "review", origin: "scheduled", input: input("Review") }, "Same review");
    const entry = { ...THREAD, id: "ordinary", origin: "scheduled" as const, input: input("Same text") };
    await queue.submit(entry);
    await expect(queue.submitHeld(entry, "Same review")).rejects.toThrow(/reused|identity/);
  } finally { queue.close(); }
});

it("held retries refuse changed acceptance facts or a different independent cause", async () => {
  const changes: Partial<ThreadTurnQueueEntry> = {
    backend: "claude", threadId: "other", origin: "manual", input: input("Changed"), delivery: "queued-steer",
    messageOrigin: { kind: "agent", sourceThread: { backend: "codex", threadId: "bob" } },
    executionMode: "plan", approvalPolicy: "on-request", sandbox: "read-only", model: "other-model",
    collaborationMode: { mode: "plan", settings: { model: "other-model", reasoning_effort: null, developer_instructions: null } },
    serviceTier: "fast", reasoningEffort: "high", fastMode: true, automationRunId: "other-run", automationName: "Other",
    agentMessages: [{ input: input("Other grouped input"), receivedAt: 1 }],
    agentMessageOrigins: [{ kind: "agent", sourceThread: { backend: "codex", threadId: "bob" } }], restartContinuation: true,
  };
  await fc.assert(fc.asyncProperty(fc.constantFrom(...Object.keys(changes) as (keyof typeof changes)[], "reason"), async field => {
    const queue = new ThreadTurnQueue({ isThreadActive: () => true, startTurn: async entry => ({ ...entry, turnId: "unused" }) });
    const entry = { ...THREAD, id: "same", origin: "scheduled" as const, input: input("Accepted"),
      messageOrigin: { kind: "agent" as const, sourceThread: { backend: "codex" as const, threadId: "alice" } } };
    try {
      await queue.submitHeld(entry, "Alice review");
      const before = queue.getQueuedEntries(THREAD);
      await expect(queue.submitHeld(field === "reason" ? entry : { ...entry, [field]: changes[field] },
        field === "reason" ? "Bob review" : "Alice review")).rejects.toThrow(/reused|identity/);
      expect(queue.getQueuedEntries(THREAD)).toEqual(before);
    } finally { queue.close(); }
  }));
});

it("matching held retries retain current controls and independent causes after the original cause is released", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), fc.boolean(), async (releaseOriginal, pause) => {
    const sends: string[] = [], events: string[] = [];
    const queue = new ThreadTurnQueue({ isThreadActive: () => true,
      startTurn: async entry => { sends.push(entry.id); return { ...THREAD, turnId: entry.id }; },
      onLifecycle: event => { events.push(`${event.type}:${event.entry.id}`); } });
    const request = { ...THREAD, id: "review", origin: "scheduled" as const, input: input("Original") };
    try {
      await queue.submit({ ...THREAD, id: "paused", origin: "manual", input: input("Neighbor") });
      await queue.setEntryPaused("paused", true);
      await queue.submitHeld(request, "Review");
      await queue.submitHeld({ ...THREAD, id: "lock", origin: "manual", input: input("Lock") }, "Independent lock");
      if (releaseOriginal) await queue.releaseHold(THREAD, reason => reason === "Review");
      if (pause) await queue.setEntryPaused("paused", false);
      const before = queue.getQueuedEntries(THREAD), offset = events.length;
      const retries = await Promise.all([queue.submitHeld(request, "Review"), queue.submitHeld(request, "Review")]);
      expect(retries.map(result => result.entry)).toEqual([before[0], before[0]]);
      expect(queue.getQueuedEntries(THREAD)).toEqual(before);
      expect(events.slice(offset)).toEqual([]);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(sends).toEqual([]);
    } finally { queue.close(); }
  }));
});

it("held admission refuses an identity pending native acceptance or already accepted", async () => {
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const queue = new ThreadTurnQueue({ startTurn: async entry => { await pending; return { ...entry, turnId: "native" }; } });
  const request = { ...THREAD, id: "native", origin: "scheduled" as const, input: input("Original") };
  try {
    const start = queue.submit(request);
    await expect(queue.submitHeld(request, "New review")).rejects.toThrow(/already admitted/);
    finish();
    await start;
    await expect(queue.submitHeld(request, "New review")).rejects.toThrow(/already admitted/);
    expect(queue.getQueuedEntries(THREAD)).toEqual([]);
  } finally { finish(); queue.close(); }
});
