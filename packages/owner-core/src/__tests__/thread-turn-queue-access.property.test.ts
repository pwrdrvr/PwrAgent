import fc from "fast-check";
import { expect, it } from "vitest";
import {
  threadExecutionModeExceeds,
  type AppServerThreadMessageOrigin,
  type ThreadExecutionMode,
} from "@pwragent/shared";
import { ThreadTurnQueue, type ThreadTurnQueueEntry } from "../thread-turn-queue";

// Model test for the agent access ceiling across grouped agent messages.
//
// The owner checks each agent message as it is submitted: an override is
// allowed only within the target thread's stored mode at that moment, unless
// the operator approved that message (a to-do card's send). The queue then
// carries the turn settings and the approval to dispatch. So the rule the
// queue owns is that each message keeps its own settings and its own
// approval: none may run under another message's override or exemption, and
// a refused message must not refuse or change any other.

const THREAD = { backend: "codex" as const, threadId: "target" };
const MODES = ["default", "auto", "full-access"] as const satisfies readonly ThreadExecutionMode[];
const SENDERS = ["alice", "bob", "carol"] as const;
const drain = async () => { for (let n = 0; n < 4; n++) await new Promise<void>(resolve => setImmediate(resolve)); };

type Step =
  | { kind: "send"; sender: number; override?: ThreadExecutionMode; approved: boolean }
  | { kind: "setMode"; mode: ThreadExecutionMode }
  | { kind: "replace"; sender: number; approved: boolean };

type ModelMessage = {
  sender: string;
  override?: ThreadExecutionMode;
  approved: boolean;
  /** The target's stored mode when this text was last submitted. */
  modeAtSubmission: ThreadExecutionMode;
  /** Send order. A replacement keeps the place of the text it replaces. */
  order: number;
};

const step: fc.Arbitrary<Step> = fc.oneof(
  { weight: 4, arbitrary: fc.record({
    kind: fc.constant("send" as const),
    sender: fc.nat({ max: SENDERS.length - 1 }),
    override: fc.option(fc.constantFrom(...MODES), { nil: undefined }),
    approved: fc.boolean(),
  }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("setMode" as const), mode: fc.constantFrom(...MODES) }) },
  { weight: 1, arbitrary: fc.record({
    kind: fc.constant("replace" as const),
    sender: fc.nat({ max: SENDERS.length - 1 }),
    approved: fc.boolean(),
  }) },
);

/** The owner's submission check, as `assertAgentMessageWithinThreadAccess` runs it. */
const withinCeiling = (message: Pick<ModelMessage, "override" | "approved">, mode: ThreadExecutionMode) =>
  message.approved || message.override === undefined || !threadExecutionModeExceeds(message.override, mode);

const agentOrigin = (sender: string, approved: boolean): AppServerThreadMessageOrigin => ({
  kind: "agent",
  sourceThread: { backend: "codex", threadId: sender },
  ...(approved ? { operatorApproved: true } : {}),
});

const textOf = (input: ThreadTurnQueueEntry["input"]) =>
  input.flatMap(item => item.type === "text" ? [item.text] : []).join("");

/** Each message an entry carries, with the settings and approval it runs under. */
const deliveredMessages = (entry: ThreadTurnQueueEntry) =>
  (entry.agentMessages ?? [{ input: entry.input, origin: entry.messageOrigin }]).map(message => ({
    text: textOf(message.input),
    override: entry.executionMode,
    approved: Boolean(entry.messageOrigin?.operatorApproved),
  }));

async function runModel(initialMode: ThreadExecutionMode, steps: Step[]): Promise<void> {
  let busy = true;
  const started: ThreadTurnQueueEntry[] = [];
  const queue = new ThreadTurnQueue({
    isThreadActive: () => busy,
    canSteerThread: () => false,
    startTurn: async entry => {
      busy = true;
      started.push(structuredClone(entry));
      return { ...THREAD, turnId: entry.id };
    },
  });
  let mode = initialMode;
  const waiting = new Map<string, ModelMessage>();
  let sequence = 0;
  try {
    for (const next of steps) {
      if (next.kind === "setMode") {
        mode = next.mode;
        continue;
      }
      const sender = SENDERS[next.sender]!;
      if (next.kind === "send") {
        const order = sequence++;
        const message = { sender, override: next.override, approved: next.approved, modeAtSubmission: mode, order };
        // A refused message never reaches the queue.
        if (!withinCeiling(message, mode)) continue;
        const text = `message-${order}`;
        waiting.set(text, message);
        await queue.submitGroupedSteer({
          ...THREAD,
          origin: "manual",
          input: [{ type: "text", text }],
          messageOrigin: agentOrigin(sender, next.approved),
          ...(next.override ? { executionMode: next.override } : {}),
        });
        continue;
      }
      // The sender replaces its whole contribution to the first entry that
      // holds one of its messages, as the owner's replacement does.
      const entry = queue.getQueuedEntries(THREAD).find(candidate =>
        candidate.agentMessages?.some(message => message.origin?.sourceThread?.threadId === sender));
      if (!entry) continue;
      const replacedTexts = entry.agentMessages!
        .filter(message => message.origin?.sourceThread?.threadId === sender)
        .map(message => textOf(message.input));
      const replaced = waiting.get(replacedTexts[0]!)!;
      // A replacement is submitted again, under the override it keeps.
      if (!withinCeiling({ override: replaced.override, approved: next.approved }, mode)) continue;
      const text = `message-${sequence++}`;
      const result = await queue.replaceQueuedAgentInput(
        entry.id,
        [{ type: "text", text }],
        { backend: "codex", threadId: sender },
        agentOrigin(sender, next.approved),
      );
      if (next.approved !== replaced.approved) {
        // The approval belongs to the text the operator approved. A
        // replacement can neither take it nor drop it.
        expect(result).toBeUndefined();
        continue;
      }
      expect(result).toBeDefined();
      for (const replacedText of replacedTexts) waiting.delete(replacedText);
      waiting.set(text, { ...replaced, modeAtSubmission: mode });
    }

    busy = false;
    queue.drainAll();
    await drain();
    for (let index = 0; index < started.length; index++) {
      busy = false;
      await queue.releaseThread({ ...THREAD, turnId: started[index]!.id, status: "turn/completed" });
      await drain();
    }

    const delivered = started.flatMap(entry => deliveredMessages(entry).map(message => ({ ...message, entry })));
    // Every accepted message is delivered once; a refused one never is.
    expect(delivered.map(message => message.text).sort()).toEqual([...waiting.keys()].sort());
    for (const message of delivered) {
      const own = waiting.get(message.text)!;
      // It runs under its own override and its own approval, never another's.
      expect({ text: message.text, override: message.override, approved: message.approved })
        .toEqual({ text: message.text, override: own.override, approved: own.approved });
      // The entry it rides in would pass the owner's check again, under the
      // mode its own submission saw.
      expect(withinCeiling(message, own.modeAtSubmission)).toBe(true);
    }
    // Each sender's messages run in the order it sent them.
    for (const sender of SENDERS) {
      const orders = delivered.flatMap(message => {
        const own = waiting.get(message.text)!;
        return own.sender === sender ? [own.order] : [];
      });
      expect({ sender, orders }).toEqual({ sender, orders: [...orders].sort((left, right) => left - right) });
    }
  } finally {
    queue.close();
  }
}

it("keeps each grouped agent message's override and operator approval with that message", async () => {
  await fc.assert(fc.asyncProperty(
    fc.constantFrom(...MODES),
    fc.array(step, { minLength: 1, maxLength: 12 }),
    async (initialMode, steps) => await runModel(initialMode, steps),
  ), { numRuns: 200 });
});

it("does not run an agent message under an operator-approved to-do's override", async () => {
  await runModel("default", [
    { kind: "send", sender: 0, override: "full-access", approved: true },
    { kind: "send", sender: 1, approved: false },
  ]);
});

it("does not refuse an approved to-do because an agent message joined its batch", async () => {
  await runModel("default", [
    { kind: "send", sender: 0, approved: false },
    { kind: "send", sender: 1, override: "full-access", approved: true },
  ]);
});

it("runs a sender's message after its earlier message with other settings", async () => {
  await runModel("full-access", [
    { kind: "send", sender: 0, approved: false },
    { kind: "send", sender: 0, override: "auto", approved: false },
    { kind: "send", sender: 0, approved: false },
  ]);
});

it("does not let a sender's replacement keep a to-do's approval", async () => {
  await runModel("default", [
    { kind: "send", sender: 0, override: "default", approved: true },
    { kind: "replace", sender: 0, approved: false },
  ]);
});
