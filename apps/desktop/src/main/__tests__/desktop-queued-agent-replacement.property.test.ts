import fc from "fast-check";
import { expect, it } from "vitest";
import { ThreadTurnQueue, type ThreadTurnQueueEntry, type ThreadTurnQueueLifecycleEvent } from "@pwragent/owner-core/thread-turn-queue";
import { ThreadCorrespondenceStore } from "../app-server/thread-correspondence-store";

const ref = { backend: "codex" as const, threadId: "recipient" };
const origin = (threadId: string) => ({ kind: "agent" as const, sourceThread: { backend: "codex" as const, threadId, instanceId: "sender-instance" } });
const input = (text: string) => [{ type: "text" as const, text }];
const drain = async () => { for (let n = 0; n < 4; n++) await new Promise<void>(resolve => setImmediate(resolve)); };

it("a sender retires every receipt sharing the replaced remote batch without rewriting any accepted prompt", () => {
  // The production agent-message caller requires a nonempty prompt.
  fc.assert(fc.property(fc.array(fc.string({ minLength: 1, maxLength: 80 }).filter(text => Boolean(text.trim())), { minLength: 2, maxLength: 6 }), texts => {
    // A remote owner cannot update this sender's local correspondence files.
    // Its acceptance response must retire every contribution to the old batch.
    const store = new ThreadCorrespondenceStore();
    const source = { backend: "codex" as const, threadId: "alice" };
    const destination = { ...ref, instanceId: "remote-owner" };
    texts.forEach((text, index) => store.record({ id: `receipt-${index}`, source, destination, input: input(text),
      createdAt: index, state: "queued", queueEntryId: "old-batch" }));
    store.record({ id: "other-owner", source, destination: { ...ref, instanceId: "other-owner" }, input: input("other"),
      createdAt: texts.length, state: "queued", queueEntryId: "old-batch" });
    store.cancelQueuedInput(source, destination, "old-batch");
    const replay = store.appendToReplay(source, { entries: [], messages: [], pagination: { supportsPagination: false, hasPreviousPage: false } });
    texts.forEach((text, index) => {
      const receipt = replay.messages.find(message => message.id === `receipt-${index}`)!;
      expect(receipt.text).toContain("Cancelled");
      expect(receipt.text.endsWith(`\n\n${text}`)).toBe(true);
    });
    expect(replay.messages.find(message => message.id === "other-owner")!.text).toContain("Queued");
  }), { examples: [[["!", "!"]]] });
});

it("sender receipts retain original accepted input while cancellation and fresh acceptance use separate records", () => {
  fc.assert(fc.property(fc.string(), fc.string(), (original, replacement) => {
    const store = new ThreadCorrespondenceStore();
    const source = { backend: "codex" as const, threadId: "alice" };
    const accepted = { id: "old-receipt", source, destination: ref, input: input(original), createdAt: 1,
      state: "queued" as const, queueEntryId: "old-acceptance" };
    store.record(accepted);
    expect(store.cancelQueuedInput(source, { ...ref, threadId: "other" }, accepted.queueEntryId)).toEqual([]);
    expect(store.cancelQueuedInput(source, ref, accepted.queueEntryId)).toEqual([{ ...accepted, state: "cancelled" }]);
    store.record({ ...accepted, id: "new-receipt", input: input(replacement), createdAt: 2, queueEntryId: "new-acceptance" });
    const replay = store.appendToReplay(source, { entries: [], messages: [], pagination: { supportsPagination: false, hasPreviousPage: false } });
    expect(replay.messages.map(message => message.id)).toEqual(["old-receipt", "new-receipt"]);
    expect(replay.messages[0]!.text.endsWith(`\n\n${original}`)).toBe(true);
    expect(replay.messages[1]!.text.endsWith(`\n\n${replacement}`)).toBe(true);
    expect(accepted.input).toEqual(input(original));
  }));
});

it("replacement preserves generated FIFO positions, grouped neighbors, independent holds and pause revisions under a new identity", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: 4 }), fc.integer({ min: 0, max: 4 }), fc.boolean(), fc.boolean(),
    fc.array(fc.string({ minLength: 1, maxLength: 80 }), { minLength: 1, maxLength: 5 }), async (before, after, grouped, paused, edits) => {
      const events: ThreadTurnQueueLifecycleEvent[] = [], sends: ThreadTurnQueueEntry[] = [];
      let busy = true;
      const queue = new ThreadTurnQueue({ isThreadActive: () => busy, startTurn: async entry => {
        sends.push(entry); return { ...ref, turnId: entry.id };
      }, onLifecycle: event => { events.push(event); } });
      try {
        for (let n = 0; n < before; n++) await queue.submit({ ...ref, origin: "manual", id: `before-${n}`, input: input(`before-${n}`) });
        let accepted = grouped
          ? await queue.submitGroupedSteer({ ...ref, origin: "manual", input: input("alice-original"), messageOrigin: origin("alice") })
          : await queue.submit({ ...ref, origin: "manual", input: input("alice-original"), messageOrigin: origin("alice") });
        if (grouped) {
          await queue.submitGroupedSteer({ ...ref, origin: "manual", input: input("bob-evidence"), messageOrigin: origin("bob") });
          await queue.submitGroupedSteer({ ...ref, origin: "manual", input: input("alice-overlap"), messageOrigin: origin("alice") });
        }
        for (let n = 0; n < after; n++) await queue.submit({ ...ref, origin: "manual", id: `after-${n}`, input: input(`after-${n}`) });
        if (paused) await queue.setEntryPaused(accepted.entry.id, true);
        await queue.submitHeld({ ...ref, id: "review", origin: "manual", input: input("review") }, "independent review");
        await queue.submitHeld({ ...ref, id: "lock", origin: "manual", input: input("lock") }, "independent lock");
        for (const text of edits) {
          const entries = queue.getQueuedEntries(ref), old = entries.find(entry => entry.id === accepted.entry.id)!;
          const snapshot = structuredClone(old), index = entries.indexOf(old), offset = events.length;
          const next = await queue.replaceQueuedAgentInput(old.id, input(text), origin("alice").sourceThread, origin("alice"));
          expect(next).toBeDefined();
          expect(next!.id).not.toBe(old.id);
          expect(old).toEqual(snapshot);
          expect(queue.getQueuedEntries(ref).map(entry => entry.id)).toEqual(entries.map(entry => entry.id === old.id ? next!.id : entry.id));
          expect(queue.getQueuedEntries(ref).filter(entry => entry.id !== next!.id)).toEqual(entries.filter(entry => entry.id !== old.id));
          expect(next).toMatchObject({ manualReleaseRequired: old.manualReleaseRequired, holdReason: old.holdReason,
            ...(paused ? { paused: true, pauseRevision: 1 } : {}) });
          expect(next!.agentMessages?.map(message => [message.origin?.sourceThread?.threadId, message.input])).toEqual(grouped
            ? [["alice", input(text)], ["bob", input("bob-evidence")]] : undefined);
          expect(events.slice(offset).map(event => [event.type, event.entry.id])).toEqual([["cancelled", old.id], ["queued", next!.id]]);
          expect(events.at(-1)).toMatchObject({ position: index + 1 });
          expect(await queue.replaceQueuedAgentInput(old.id, input("stale"), origin("alice").sourceThread)).toBeUndefined();
          expect(await queue.replaceQueuedAgentInput(next!.id, input("foreign"), origin("intruder").sourceThread)).toBeUndefined();
          expect(sends).toEqual([]);
          accepted = { status: "queued", entry: next!, position: index + 1 };
        }
        await queue.releaseHold(ref, reason => reason === "independent lock");
        expect(queue.getQueuedEntries(ref).filter(entry => entry.id !== "lock").every(entry => entry.manualReleaseRequired)).toBe(true);
        await drain(); expect(sends).toEqual([]);
        await queue.releaseHold(ref, () => true);
        if (paused) await queue.setEntryPaused(accepted.entry.id, false);
        const waiting = queue.getQueuedEntries(ref);
        busy = false;
        queue.drainAll();
        await drain();
        for (const expected of waiting) {
          expect(sends.at(-1)).toEqual(expected);
          await queue.releaseThread({ ...ref, turnId: expected.id, status: "completed" });
          await drain();
        }
        expect(sends.map(entry => entry.id)).toEqual(waiting.map(entry => entry.id));
      } finally { queue.close(); }
    }), { numRuns: 50 });
});

it("replacement event positions agree with the live FIFO after retirement observers cancel neighbors", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.boolean(), { minLength: 1, maxLength: 5 }),
    fc.integer({ min: 0, max: 3 }), async (cancelled, after) => {
      const events: ThreadTurnQueueLifecycleEvent[] = [];
      let retiredId: string | undefined;
      const queue = new ThreadTurnQueue({ isThreadActive: () => true,
        startTurn: async entry => ({ ...ref, turnId: entry.id }), onLifecycle: event => {
          events.push(event);
          if (event.type === "cancelled" && event.entry.id === retiredId) {
            for (const [index, cancel] of cancelled.entries()) if (cancel) queue.cancelEntry(`before-${index}`);
          }
        } });
      try {
        for (const index of cancelled.keys()) await queue.submit({ ...ref, origin: "manual", id: `before-${index}`, input: input("neighbor") });
        const original = await queue.submit({ ...ref, origin: "manual", input: input("original"), messageOrigin: origin("alice") });
        for (let index = 0; index < after; index++) await queue.submit({ ...ref, origin: "manual", id: `after-${index}`, input: input("neighbor") });
        retiredId = original.entry.id;
        const replacement = await queue.replaceQueuedAgentInput(retiredId, input("replacement"), origin("alice").sourceThread);
        expect(replacement).toBeDefined();
        const waiting = queue.getQueuedEntries(ref);
        expect(events.at(-1)).toMatchObject({ type: "queued", entry: replacement,
          position: waiting.findIndex(entry => entry.id === replacement!.id) + 1 });
        expect(waiting.some(entry => entry.id === retiredId)).toBe(false);
      } finally { queue.close(); }
    }), { numRuns: 50, examples: [[[true], 0], [[true, true], 1]] });
});

it("a fresh-admission observer refusal never restores the old accepted identity or resends its input", async () => {
  await fc.assert(fc.asyncProperty(fc.string({ minLength: 1, maxLength: 80 }), async text => {
    let refuse = false;
    const queue = new ThreadTurnQueue({ isThreadActive: () => true, startTurn: async entry => ({ ...ref, turnId: entry.id }),
      onLifecycle: event => { if (refuse && event.type === "queued") throw new Error("Publication refused"); } });
    try {
      const old = await queue.submit({ ...ref, origin: "manual", input: input("accepted"), messageOrigin: origin("alice") });
      refuse = true;
      await expect(queue.replaceQueuedAgentInput(old.entry.id, input(text), origin("alice").sourceThread)).rejects.toThrow("Publication refused");
      expect(queue.getQueuedEntries(ref)).toHaveLength(1);
      expect(queue.getQueuedEntries(ref)[0]).toMatchObject({ input: input(text) });
      expect(queue.getQueuedEntries(ref)[0]!.id).not.toBe(old.entry.id);
      expect(await queue.replaceQueuedAgentInput(old.entry.id, input("retry"), origin("alice").sourceThread)).toBeUndefined();
      expect(old.entry.input).toEqual(input("accepted"));
    } finally { queue.close(); }
  }), { numRuns: 25 });
});

it("serialized replacement rereads earlier controls and cannot restore cancelled or closed work", async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom("replace", "cancel", "pause", "close", "move"), async control => {
    const queue = new ThreadTurnQueue({ isThreadActive: () => true, startTurn: async entry => ({ ...ref, turnId: entry.id }) });
    try {
      const old = await queue.submit({ ...ref, origin: "manual", input: input("original"), messageOrigin: origin("alice") });
      await queue.submit({ ...ref, id: "neighbor", origin: "manual", input: input("neighbor") });
      let release!: () => void;
      const lock = queue.withDispatchSuspended(ref, () => new Promise<void>(resolve => { release = resolve; }));
      await Promise.resolve();
      let earlier: Promise<unknown> = Promise.resolve();
      if (control === "replace") earlier = queue.replaceQueuedAgentInput(old.entry.id, input("earlier"), origin("alice").sourceThread);
      if (control === "cancel") queue.cancelEntry(old.entry.id);
      if (control === "pause") earlier = queue.setEntryPaused(old.entry.id, true);
      if (control === "close") queue.close();
      if (control === "move") earlier = queue.moveEntry(old.entry.id);
      const replacement = queue.replaceQueuedAgentInput(old.entry.id, input("later"), origin("alice").sourceThread);
      release(); await lock; await earlier;
      const next = await replacement;
      expect(Boolean(next)).toBe(control === "pause" || control === "move");
      if (control === "pause") expect(next).toMatchObject({ paused: true, pauseRevision: 1 });
      if (control === "move") expect(queue.getQueuedEntries(ref).map(entry => entry.id)).toEqual(["neighbor", next!.id]);
    } finally { queue.close(); }
  }), { numRuns: 25 });
});

it("untouched grouped senders retain their returned replacement handles through arbitrary peer replacements", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom("alice", "bob", "carol"), { minLength: 2, maxLength: 12 }), fc.boolean(), async (senders, admit) => {
    let busy = true;
    const sends: ThreadTurnQueueEntry[] = [];
    const queue = new ThreadTurnQueue({ isThreadActive: () => busy, startTurn: async entry => {
      sends.push(entry); return { ...ref, turnId: entry.id };
    } });
    const handles = new Map<string, string>(), expected = new Map<string, string>();
    try {
      for (const sender of ["alice", "bob", "carol"]) {
        const accepted = await queue.submitGroupedSteer({ ...ref, origin: "manual", input: input(sender), messageOrigin: origin(sender) });
        handles.set(sender, accepted.entry.id); expected.set(sender, sender);
      }
      for (const [index, sender] of senders.entries()) {
        const previous = queue.getQueuedEntries(ref)[0]!, snapshot = structuredClone(previous);
        const text = `${sender}-${index}`, oldHandle = handles.get(sender)!;
        const next = await queue.replaceQueuedAgentInput(oldHandle, input(text), origin(sender).sourceThread, origin(sender));
        expect(next, `${sender}'s returned handle still names its waiting contribution`).toBeDefined();
        handles.set(sender, next!.id); expected.set(sender, text);
        expect(next!.id).not.toBe(previous.id);
        expect(previous).toEqual(snapshot);
        expect(queue.getQueuedEntries(ref).find(entry => entry.id === previous.id)).toBeUndefined();
        expect(queue.cancelEntry(previous.id)).toBeUndefined();
        expect(new Map(next!.agentMessages!.map(message => [message.origin!.sourceThread!.threadId,
          message.input.flatMap(item => item.type === "text" ? [item.text] : []).join("")]))).toEqual(expected);
        expect(await queue.replaceQueuedAgentInput(oldHandle, input("stale own retry"), origin(sender).sourceThread)).toBeUndefined();
        expect(await queue.replaceQueuedAgentInput(handles.get("bob")!, input("forged"), { ...origin("bob").sourceThread, instanceId: "wrong-instance" })).toBeUndefined();
      }
      if (admit) { busy = false; queue.drainAll(); await drain(); }
      else queue.cancelEntry(queue.getQueuedEntries(ref)[0]!.id);
      for (const [sender, handle] of handles) expect(await queue.replaceQueuedAgentInput(handle, input("retired"), origin(sender).sourceThread)).toBeUndefined();
      await drain();
      expect(queue.getQueuedEntries(ref)).toEqual([]);
      expect(sends).toHaveLength(admit ? 1 : 0);
    } finally { queue.close(); }
  }), { numRuns: 30, examples: [[["alice", "bob", "alice", "carol", "bob"], false], [["alice", "bob"], true]] });
});
