import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { AppServerThreadMessageOrigin } from "@pwragent/shared";
import {
  isSteerableAgentTraffic,
  planQueuedDeliveries,
  ThreadTurnQueue,
  type ThreadTurnQueueEntry,
  type ThreadTurnQueueLifecycleEvent,
} from "../thread-turn-queue";

/**
 * The rule (ARCHITECTURE.md, "Combined deliveries"): messages from agents,
 * monitors and PwrAgent that wait together in a thread's FIFO reach the
 * model as ONE delivery: one steer into the running turn, or one new turn
 * when the thread is idle. A run stops at anything that cannot share it: a
 * human message (each of those is its own turn), an explicit new turn or
 * settings override, a different operator approval, a paused or held row,
 * or the size cap. Order never changes, and every message keeps its own
 * queue identity until the delivery leaves the FIFO.
 *
 * The model below is the oracle. It knows nothing about the queue's code.
 */

const THREAD = { backend: "codex" as const, threadId: "combined-delivery-thread" };
const MAX_MESSAGES = 20;
const SENDERS = ["lane-a", "lane-b", "lane-c"] as const;

type Kind = "agent" | "sub-agent" | "pwragent" | "human" | "human-steer";

type Spec = {
  kind: Kind;
  /** An agent message that asked for its own turn or its own settings. */
  ownTurn: "none" | "new_turn" | "model";
  approved: boolean;
  paused: boolean;
  sender: number;
  cancel: boolean;
  replace: boolean;
};

const specArb: fc.Arbitrary<Spec> = fc.record({
  kind: fc.constantFrom<Kind>("agent", "agent", "sub-agent", "pwragent", "human", "human-steer"),
  ownTurn: fc.constantFrom<Spec["ownTurn"]>("none", "none", "none", "new_turn", "model"),
  approved: fc.integer({ min: 0, max: 3 }).map((value) => value === 0),
  paused: fc.integer({ min: 0, max: 9 }).map((value) => value === 0),
  sender: fc.integer({ min: 0, max: SENDERS.length - 1 }),
  cancel: fc.integer({ min: 0, max: 9 }).map((value) => value === 0),
  replace: fc.integer({ min: 0, max: 9 }).map((value) => value === 0),
});

function isHuman(spec: Spec): boolean {
  return spec.kind === "human" || spec.kind === "human-steer";
}

/** Joins a running turn or starts one; may share its delivery. */
function isCombinable(spec: Spec): boolean {
  return !isHuman(spec) && spec.ownTurn === "none";
}

function originFor(spec: Spec): AppServerThreadMessageOrigin | undefined {
  if (isHuman(spec)) return undefined;
  return {
    kind: spec.kind as "agent" | "sub-agent" | "pwragent",
    ...(spec.approved ? { operatorApproved: true } : {}),
    ...(spec.kind === "agent"
      ? { sourceThread: { backend: "codex" as const, threadId: SENDERS[spec.sender]! } }
      : {}),
  };
}

async function admit(queue: ThreadTurnQueue, spec: Spec, text: string): Promise<string> {
  const base = {
    ...THREAD,
    input: [{ type: "text" as const, text }],
    ...(spec.paused ? { paused: true } : {}),
  };
  const messageOrigin = originFor(spec);
  if (spec.kind === "human") {
    return (await queue.submit({ ...base, origin: "manual" })).entry.id;
  }
  if (spec.kind === "human-steer") {
    return (await queue.submitSteer({ ...base, origin: "manual" })).entry.id;
  }
  if (spec.ownTurn !== "none") {
    return (await queue.submit({
      ...base,
      origin: "manual",
      messageOrigin,
      ...(spec.ownTurn === "model" ? { model: "gpt-own-turn" } : {}),
    })).entry.id;
  }
  return (await queue.submitSteer({ ...base, origin: "manual", messageOrigin })).entry.id;
}

/** Message ids a dispatched entry carried, in order. */
function deliveredIds(entry: ThreadTurnQueueEntry): string[] {
  return (entry as ThreadTurnQueueEntry & { deliveredEntryIds?: string[] }).deliveredEntryIds ?? [entry.id];
}

function deliveredText(entry: ThreadTurnQueueEntry): string {
  return entry.input.flatMap((item) => item.type === "text" ? [item.text] : []).join("\n");
}

type Waiting = { id: string; spec: Spec; text: string };

/**
 * The oracle: which messages go out together, in order, on a backend that
 * cannot steer. Paused rows never go out and end any run they interrupt.
 */
function expectedDeliveries(waiting: readonly Waiting[]): string[][] {
  const deliveries: string[][] = [];
  let run: Waiting[] | undefined;
  for (const message of waiting) {
    if (message.spec.paused) {
      run = undefined;
      continue;
    }
    if (!isCombinable(message.spec)) {
      run = undefined;
      deliveries.push([message.id]);
      continue;
    }
    if (run && run.length < MAX_MESSAGES && run[0]!.spec.approved === message.spec.approved) {
      run.push(message);
      deliveries[deliveries.length - 1]!.push(message.id);
      continue;
    }
    run = [message];
    deliveries.push([message.id]);
  }
  return deliveries;
}

async function flush(): Promise<void> {
  for (let index = 0; index < 3; index++) await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("combined deliveries", () => {
  it("a backend that cannot steer starts one turn per delivery group, in FIFO order, with every message's own text", async () => {
    await fc.assert(fc.asyncProperty(fc.array(specArb, { minLength: 1, maxLength: 30 }), async (specs) => {
      const starts: ThreadTurnQueueEntry[] = [];
      let active = true;
      let turns = 0;
      const queue = new ThreadTurnQueue({
        startTurn: async (entry) => {
          starts.push(entry);
          return { ...THREAD, turnId: `turn-${++turns}` };
        },
        canSteerThread: () => false,
        isThreadActive: () => active,
      });
      try {
        let waiting: Waiting[] = [];
        for (const [index, spec] of specs.entries()) {
          const text = `message ${index} from ${spec.kind}`;
          waiting.push({ id: await admit(queue, spec, text), spec, text });
        }
        // Edits by id while everything waits: each touches one message only.
        for (const message of [...waiting]) {
          if (message.spec.cancel) {
            queue.cancelEntry(message.id);
            waiting = waiting.filter((other) => other !== message);
          } else if (message.spec.replace && message.spec.kind === "agent" && message.spec.ownTurn === "none") {
            const text = `${message.text} (replaced)`;
            const replaced = await queue.replaceQueuedAgentInput(
              message.id,
              [{ type: "text", text }],
              { backend: "codex", threadId: SENDERS[message.spec.sender]! },
            );
            if (replaced) Object.assign(message, { id: replaced.id, text });
          }
        }
        const expected = expectedDeliveries(waiting);
        // The running turn ends; the FIFO drains one delivery per turn.
        active = false;
        await queue.releaseThread({ ...THREAD });
        for (let released = 0; released < waiting.length + 2; released++) {
          await flush();
          if (starts.length <= released) break;
          await queue.releaseThread({ ...THREAD, turnId: `turn-${released + 1}`, status: "completed" });
        }
        await flush();
        expect(starts.map(deliveredIds)).toEqual(expected);
        const textById = new Map(waiting.map((message) => [message.id, message.text]));
        for (const start of starts) {
          const text = deliveredText(start);
          let cursor = -1;
          for (const id of deliveredIds(start)) {
            const at = text.indexOf(textById.get(id)!, cursor + 1);
            expect(at).toBeGreaterThan(cursor);
            cursor = at;
          }
        }
        // Paused rows are still queued, untouched.
        expect(queue.getQueuedEntries(THREAD).map((entry) => entry.id))
          .toEqual(waiting.filter((message) => message.spec.paused).map((message) => message.id));
      } finally {
        queue.close();
      }
    }), { numRuns: 100 });
  });

  it("messages that wait together during a running turn steer into it once", async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.constantFrom<Kind>("agent", "sub-agent", "pwragent"), { minLength: 2, maxLength: MAX_MESSAGES }),
      async (kinds) => {
        const steers: ThreadTurnQueueEntry[] = [];
        const starts: ThreadTurnQueueEntry[] = [];
        const queue = new ThreadTurnQueue({
          startTurn: async (entry) => {
            starts.push(entry);
            return { ...THREAD, turnId: "never" };
          },
          canSteerThread: () => true,
          steerTurn: async (entry) => {
            steers.push(entry);
            return { ...THREAD, turnId: "running" };
          },
          isThreadActive: () => true,
        });
        try {
          const ids: string[] = [];
          for (const [index, kind] of kinds.entries()) {
            const spec: Spec = { kind, ownTurn: "none", approved: false, paused: false, sender: index % SENDERS.length, cancel: false, replace: false };
            ids.push(await admit(queue, spec, `report ${index}`));
          }
          await flush();
          expect(starts).toEqual([]);
          expect(steers.map(deliveredIds)).toEqual([ids]);
        } finally {
          queue.close();
        }
      },
    ), { numRuns: 100 });
  });

  it("a long run splits at the message cap, and the overflow joins the same turn", async () => {
    await fc.assert(fc.asyncProperty(
      fc.integer({ min: MAX_MESSAGES - 1, max: 3 * MAX_MESSAGES + 1 }),
      async (count) => {
        const steers: ThreadTurnQueueEntry[] = [];
        const queue = new ThreadTurnQueue({
          startTurn: async () => ({ ...THREAD, turnId: "never" }),
          canSteerThread: () => true,
          steerTurn: async (entry) => {
            steers.push(entry);
            return { ...THREAD, turnId: "running" };
          },
          isThreadActive: () => true,
        });
        try {
          const ids: string[] = [];
          for (let index = 0; index < count; index++) {
            ids.push((await queue.submitSteer({
              ...THREAD, origin: "manual", input: [{ type: "text", text: `report ${index}` }],
              messageOrigin: { kind: "sub-agent" },
            })).entry.id);
          }
          for (let index = 0; index < 6; index++) await flush();
          const expected: string[][] = [];
          for (let index = 0; index < ids.length; index += MAX_MESSAGES) {
            expected.push(ids.slice(index, index + MAX_MESSAGES));
          }
          expect(steers.map(deliveredIds)).toEqual(expected);
        } finally {
          queue.close();
        }
      },
    ), { numRuns: 30 });
  });

  it("three queued operator messages start three turns, one message each", async () => {
    const starts: ThreadTurnQueueEntry[] = [];
    let active = true;
    let turns = 0;
    const queue = new ThreadTurnQueue({
      startTurn: async (entry) => {
        starts.push(entry);
        return { ...THREAD, turnId: `turn-${++turns}` };
      },
      canSteerThread: () => false,
      isThreadActive: () => active,
    });
    try {
      const ids: string[] = [];
      for (const text of ["first", "second", "third"]) {
        ids.push((await queue.submit({ ...THREAD, origin: "manual", input: [{ type: "text", text }] })).entry.id);
      }
      active = false;
      await queue.releaseThread({ ...THREAD });
      for (let turn = 1; turn <= 3; turn++) {
        await flush();
        await queue.releaseThread({ ...THREAD, turnId: `turn-${turn}`, status: "completed" });
      }
      await flush();
      expect(starts.map(deliveredIds)).toEqual(ids.map((id) => [id]));
      expect(starts.map(deliveredText)).toEqual(["first", "second", "third"]);
    } finally {
      queue.close();
    }
  });
});

describe("combined delivery bookkeeping", () => {
  it("every member hears started and terminal, even when an observer rejects for one of them", async () => {
    await fc.assert(fc.asyncProperty(
      fc.integer({ min: 2, max: 8 }),
      fc.nat(),
      fc.constantFrom<"started" | "terminal">("started", "terminal"),
      async (count, rejectAt, rejectOn) => {
        const events: ThreadTurnQueueLifecycleEvent[] = [];
        let active = true;
        const queue = new ThreadTurnQueue({
          startTurn: async () => ({ ...THREAD, turnId: "combined-turn" }),
          canSteerThread: () => false,
          isThreadActive: () => active,
          onLifecycle: (event) => {
            events.push(event);
            if (event.type === rejectOn && event.entry.id === ids[rejectAt % count]) {
              throw new Error(`observer refused ${event.type}`);
            }
          },
        });
        const ids: string[] = [];
        try {
          for (let index = 0; index < count; index++) {
            ids.push((await queue.submitSteer({
              ...THREAD, origin: "manual", input: [{ type: "text", text: `report ${index}` }],
              messageOrigin: { kind: "sub-agent" },
            })).entry.id);
          }
          active = false;
          await queue.releaseThread({ ...THREAD });
          await flush();
          await queue.releaseThread({ ...THREAD, turnId: "combined-turn", status: "completed" }).catch(() => undefined);
          await flush();
          const heard = (type: string) => events.filter((event) => event.type === type).map((event) => event.entry.id);
          expect(heard("started")).toEqual(ids);
          expect(heard("terminal")).toEqual(ids);
        } finally {
          queue.close();
        }
      },
    ), { numRuns: 50 });
  });

  it("a named retry finds its original acceptance instead of admitting a second entry", async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 4 }), async (retries) => {
      const queue = new ThreadTurnQueue({
        startTurn: async () => ({ ...THREAD, turnId: "never" }),
        isThreadActive: () => true,
      });
      try {
        const wake = { ...THREAD, id: "decision-batch:one", origin: "automation" as const,
          input: [{ type: "text" as const, text: "Decision batch finished" }], messageOrigin: { kind: "pwragent" as const } };
        const first = await queue.submitSteer(wake);
        for (let attempt = 0; attempt < retries; attempt++) {
          const again = await queue.submitSteer(wake);
          expect(again.entry.id).toBe(first.entry.id);
        }
        expect(queue.getQueuedEntries(THREAD).map((entry) => entry.id)).toEqual(["decision-batch:one"]);
        await expect(queue.submitSteer({ ...wake, input: [{ type: "text", text: "Different" }] })).rejects.toThrow(/reused/);
      } finally {
        queue.close();
      }
    }), { numRuns: 20 });
  });

  it("a review's Auto-fix and PR automation wakes keep their own turns", () => {
    expect(isSteerableAgentTraffic({ kind: "pwragent" })).toBe(true);
    expect(isSteerableAgentTraffic({ kind: "pwragent", reviewAutoFix: { reviewId: "review-1", findingCount: 2 } })).toBe(false);
    expect(isSteerableAgentTraffic({ kind: "pwragent", prAutomation: { kind: "auto-fix", prKey: "github.com/o/r#1", prNumber: 1, headSha: "abc" } })).toBe(false);
    expect(isSteerableAgentTraffic({ kind: "pwragent", systemReason: "app-restart" })).toBe(false);
  });

  it("names a settings difference as settings, not approval", () => {
    const base = { ...THREAD, origin: "manual" as const, delivery: "queued-steer" as const, createdAt: 1, messageOrigin: { kind: "agent" as const } };
    const plan = planQueuedDeliveries([
      { ...base, id: "a", input: [{ type: "text", text: "a" }] },
      { ...base, id: "b", input: [{ type: "text", text: "b" }], reasoningEffort: "high" },
      { ...base, id: "c", input: [{ type: "text", text: "c" }], reasoningEffort: "high", messageOrigin: { kind: "agent", operatorApproved: true } },
    ]);
    expect(plan.map((group) => [group.entryIds, group.boundary])).toEqual([
      [["a"], undefined],
      [["b"], "settings"],
      [["c"], "approval"],
    ]);
  });
});
