import { expect, it } from "vitest";
import fc from "fast-check";
import type { AgentEvent } from "@pwragent/shared";
import { messagingInboundHarness } from "./fixtures/messaging-inbound-harness";

const threadId = "fixture-thread";
const turnId = "stream-turn";

async function streamFixture(enabled: boolean, channel: "telegram" | "discord") {
  let now = 1_000;
  const fixture = await messagingInboundHarness({ channel, clock: () => now });
  const binding = await fixture.store.getBinding("fixture-binding");
  if (!binding) throw new Error("Missing fixture binding");
  await fixture.store.upsertBinding({ ...binding, preferences: {
    streamingResponses: enabled ? "enabled" : "disabled", toolUpdateMode: "show_none", updatedAt: now,
  } });
  const emit = (notification: AgentEvent["notification"]) => fixture.controller.handleBackendEvent({ backend: "codex", notification });
  fixture.setThreadStatus("active");
  await emit({ method: "turn/started", params: { threadId, turnId, turn: { id: turnId } } });
  return {
    ...fixture,
    emit,
    advance: () => { now += 30_000; },
    delta: (delta: string, itemId = "answer") => emit({
      method: "item/agentMessage/delta", params: { threadId, turnId, itemId, delta },
    }),
    finish: () => fixture.finish("completed", turnId),
    streams: () => fixture.deliveries.filter(intent => intent.kind === "stream_update"),
    answers: () => fixture.deliveries.flatMap(intent => intent.kind === "message" && intent.role === "assistant"
      ? intent.parts.flatMap(part => part.type === "text" ? [part.text] : []) : []),
  };
}

const channel = fc.constantFrom("telegram", "discord");
const words = fc.array(fc.stringMatching(/^[a-z]{1,8}$/), { minLength: 2, maxLength: 5 });

it("delivers accumulated stream text with a stable key and increasing sequence", async () => {
  await fc.assert(fc.asyncProperty(channel, words, async (provider, chunks) => {
    const f = await streamFixture(true, provider);
    try {
      for (const [index, chunk] of chunks.entries()) {
        await f.delta(chunk);
        expect(f.streams()).toHaveLength(index);
        if (index > 0) {
          const partial = f.streams().at(-1)!;
          expect(partial.text).toBe(chunks.slice(0, index + 1).join(""));
          expect(partial.stream).toMatchObject({ isFinal: false, sequence: index + 1, turnId });
        }
        f.advance();
      }
      await f.finish();
      const updates = f.streams();
      expect(new Set(updates.map(intent => intent.stream.key)).size).toBe(1);
      expect(updates.at(-1)).toMatchObject({ text: chunks.join(""), stream: { isFinal: true, sequence: chunks.length + 1 } });
      expect(f.answers()).toEqual([]);
    } finally { await f.close(); }
  }), { numRuns: 25 });
});

it("posts buffered output once on completion when streaming is disabled", async () => {
  await fc.assert(fc.asyncProperty(channel, words, async (provider, chunks) => {
    const f = await streamFixture(false, provider);
    try {
      for (const chunk of chunks) {
        await f.delta(chunk);
        f.advance();
      }
      expect(f.streams()).toEqual([]);
      expect(f.answers()).toEqual([]);
      await f.finish();
      await f.finish();
      expect(f.streams()).toEqual([]);
      expect(f.answers()).toEqual([chunks.join("")]);
    } finally { await f.close(); }
  }), { numRuns: 25 });
});

it("discards interim prose accumulators when the provider reveals the item phase", async () => {
  await fc.assert(fc.asyncProperty(channel, fc.boolean(), words, async (provider, enabled, chunks) => {
    const f = await streamFixture(enabled, provider);
    try {
      await f.delta("Interim context", "interim");
      await f.emit({ method: "item/completed", params: {
        threadId, turnId, item: { id: "interim", type: "agentMessage", phase: "commentary", text: "Interim context" },
      } });
      for (const chunk of chunks) await f.delta(chunk);
      await f.finish();
      expect([...f.answers(), ...f.streams().filter(intent => intent.stream.isFinal).map(intent => intent.text)]).toEqual([chunks.join("")]);
    } finally { await f.close(); }
  }), { numRuns: 25 });
});
