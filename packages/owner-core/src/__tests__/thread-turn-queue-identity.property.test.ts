import fc from "fast-check";
import { expect, it } from "vitest";
import { ThreadTurnQueue, type ThreadTurnQueueEntry } from "../thread-turn-queue";

const THREAD = { backend: "codex" as const, threadId: "identity" };
const input = (text: string) => [{ type: "text" as const, text }];
const drain = async () => await new Promise<void>(resolve => setImmediate(resolve));

it("ordinary waiting retries preserve the model's single acceptance, FIFO and control revisions", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.record({
    slot: fc.integer({ min: 0, max: 5 }),
    operation: fc.constantFrom("admit", "retry", "change", "pause", "cancel"),
  }), { minLength: 1, maxLength: 40 }), async commands => {
    const sends: string[] = [];
    const observed = new Map<string, string>();
    const model = new Map<number, { id: string; paused: boolean; revision: number }>();
    const versions = new Map<number, number>();
    const queue = new ThreadTurnQueue({ isThreadActive: () => true,
      startTurn: async entry => { sends.push(entry.id); return { ...THREAD, turnId: entry.id }; },
      onLifecycle: event => {
        if (event.type === "queued") observed.set(event.entry.id, JSON.stringify(event.entry.input));
        if (event.type === "cancelled") observed.delete(event.entry.id);
      } });
    try {
      for (const command of commands) {
        const current = model.get(command.slot);
        if (!current) {
          const version = (versions.get(command.slot) ?? 0) + 1;
          versions.set(command.slot, version);
          const id = `${command.slot}:${version}`;
          await queue.submit({ ...THREAD, id, origin: "manual", input: input(id) });
          model.set(command.slot, { id, paused: false, revision: 0 });
        } else if (command.operation === "change") {
          await expect(queue.submit({ ...THREAD, id: current.id, origin: "manual", input: input(`changed ${current.id}`) }))
            .rejects.toThrow(/reused/);
        } else if (command.operation === "pause") {
          current.paused = !current.paused;
          current.revision++;
          await queue.setEntryPaused(current.id, current.paused);
        } else if (command.operation === "cancel") {
          expect(queue.cancelEntryWithDisposition(current.id).disposition).toBe("cancelled");
          model.delete(command.slot);
        } else {
          const result = await queue.submit({ ...THREAD, id: current.id, origin: "manual", input: input(current.id) });
          expect(result.status).toBe("queued");
          expect(result.entry.pauseRevision ?? 0).toBe(current.revision);
        }
        expect(queue.getQueuedEntries(THREAD).map(entry => ({ id: entry.id, paused: Boolean(entry.paused), revision: entry.pauseRevision ?? 0 })))
          .toEqual([...model.values()]);
        expect([...observed.keys()]).toEqual([...model.values()].map(entry => entry.id));
        for (const entry of queue.getQueuedEntries(THREAD)) expect(JSON.stringify(entry.input)).toBe(observed.get(entry.id));
      }
      await drain();
      expect(sends).toEqual([]);
    } finally { queue.close(); }
  }));
});

it("ordinary admission refuses colliding sender, provider, delivery and settings identities", async () => {
  await fc.assert(fc.asyncProperty(fc.string(), fc.constantFrom(
    "backend", "threadId", "origin", "messageOrigin", "input", "model", "fastMode", "automationRunId", "delivery",
  ), async (suffix, field) => {
    const queue = new ThreadTurnQueue({ isThreadActive: () => true, startTurn: async entry => ({ ...entry, turnId: "unused" }) });
    const entry = { ...THREAD, id: "same", origin: "manual" as const, input: input(`original ${suffix}`) };
    const changes: Partial<ThreadTurnQueueEntry> = {
      backend: "claude", threadId: "other", origin: "scheduled", input: input(`changed ${suffix}`), model: "other-model",
      fastMode: true, automationRunId: "other-run", delivery: "queued-steer",
      messageOrigin: { kind: "agent", sourceThread: { backend: "codex", threadId: "other-sender" } },
    };
    try {
      await queue.submit(entry);
      await expect(queue.submit({ ...entry, [field]: changes[field] })).rejects.toThrow(/reused/);
      expect(queue.getQueuedEntries(THREAD)).toHaveLength(1);
      expect(queue.getQueuedEntries(THREAD)[0]).toMatchObject(entry);
    } finally { queue.close(); }
  }));
});

it("matching concurrent admissions share one row before queued publication returns", async () => {
  let publish!: () => void;
  const published = new Promise<void>(resolve => { publish = resolve; });
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const queue = new ThreadTurnQueue({ isThreadActive: () => true, startTurn: async entry => ({ ...entry, turnId: "unused" }),
    onLifecycle: async event => { if (event.type === "queued") { publish(); await pending; } } });
  const entry = { ...THREAD, id: "same", origin: "manual" as const, input: input("original") };
  try {
    const first = queue.submit(entry);
    await published;
    const retries = await Promise.all([queue.submit(entry), queue.submit(entry)]);
    expect(retries.map(result => result.entry)).toEqual([queue.getQueuedEntries(THREAD)[0], queue.getQueuedEntries(THREAD)[0]]);
    expect(queue.getQueuedEntries(THREAD)).toHaveLength(1);
    await expect(queue.submit({ ...entry, input: input("different") })).rejects.toThrow(/reused/);
    finish();
    await first;
  } finally { finish(); queue.close(); }
});

it("matching storage and wire inputs ignore object prototypes and object-key order", async () => {
  const queue = new ThreadTurnQueue({ isThreadActive: () => true, startTurn: async entry => ({ ...entry, turnId: "unused" }) });
  try {
    const original = { ...THREAD, id: "same", origin: "scheduled" as const, input: input("original") };
    await queue.submit(original);
    const item = Object.assign(Object.create(null) as { type: "text"; text: string }, { text: "original", type: "text" as const });
    const retry = await queue.submit({ ...original, input: [item] });
    expect(retry.entry).toBe(queue.getQueuedEntries(THREAD)[0]);
    expect(queue.getQueuedEntries(THREAD)).toHaveLength(1);
  } finally { queue.close(); }
});

it.each([false, true])("ordinary native identity cannot be readmitted after acceptance despite publication failure=%s", async rejectPublication => {
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const sends: string[] = [];
  const queue = new ThreadTurnQueue({ startTurn: async entry => {
    sends.push(entry.id);
    await pending;
    return { ...THREAD, turnId: "native" };
  }, onLifecycle: event => { if (rejectPublication && event.type === "started") throw new Error("Publication unavailable"); } });
  const entry = { ...THREAD, id: "native-identity", origin: "manual" as const, input: input("original") };
  try {
    const first = queue.submit(entry);
    const outcome = first.catch(error => error);
    await expect(queue.submit(entry)).rejects.toThrow(/already admitted/);
    finish();
    await outcome;
    await expect(queue.submit(entry)).rejects.toThrow(/already admitted/);
    expect(sends).toEqual([entry.id]);
    expect(queue.getQueuedEntries(THREAD)).toEqual([]);
  } finally { finish(); queue.close(); }
});
