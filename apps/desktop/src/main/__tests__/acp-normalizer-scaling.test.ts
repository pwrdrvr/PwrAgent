import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { AcpSessionReplayNormalizer } from "../acp/acp-session-normalizer";

function apply(
  normalizer: AcpSessionReplayNormalizer,
  kind: string,
  fields: Record<string, unknown> = {},
) {
  return normalizer.apply({
    sessionId: "synthetic",
    receivedAt: 1000,
    update: { kind, ...fields },
  });
}

function seed(history: number) {
  const normalizer = new AcpSessionReplayNormalizer();
  for (let index = 0; index < history; index += 1) {
    apply(normalizer, "user_message_chunk", { messageId: `u${index}`, text: `Prompt ${index}` });
    apply(normalizer, "agent_message_chunk", { messageId: `a${index}`, text: "Answer" });
    apply(normalizer, "tool_call", { toolCallId: `t${index}`, title: "Read", status: "completed" });
  }
  return normalizer;
}

// Count actual array-slot reads, including iteration/spread and find/filter.
// Wrap replacement arrays too: a filter must not silently disable the probe.
// This is test-only instrumentation; there are no counters on the live path.
function countHistoryReads(normalizer: AcpSessionReplayNormalizer) {
  let reads = 0;
  for (const field of ["messages", "entries"] as const) {
    const wrap = (array: unknown[]) => new Proxy(array, {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property)) {
          reads += 1;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    let value = wrap(normalizer.replay()[field]);
    Object.defineProperty(normalizer, field, {
      configurable: true,
      get: () => value,
      set: (array: unknown[]) => {
        value = wrap(array);
      },
    });
  }
  reads = 0;
  return () => reads;
}

function measure(history: number, chunks: number, instrument = true) {
  const normalizer = seed(history);
  normalizer.recordUserPrompt({
    sessionId: "synthetic", prompt: "Live prompt", turnId: "live", waitingForAgent: true,
  });
  apply(normalizer, "tool_call", { toolCallId: "live-tool", title: "Read" });
  apply(normalizer, "agent_message_chunk", { text: "Start" });
  const readCount = instrument ? countHistoryReads(normalizer) : () => 0;
  const started = performance.now();
  for (let index = 0; index < chunks; index += 1) {
    apply(normalizer, "agent_message_chunk", { text: " x" });
    apply(normalizer, "tool_call_update", { toolCallId: "live-tool", status: "in_progress" });
    apply(normalizer, "session_info_update", { title: "Synthetic" });
  }
  const ms = performance.now() - started;
  const reads = readCount();
  expect(normalizer.replay().lastAssistantMessage).toBe(`Start${" x".repeat(chunks)}`);
  return { history, chunks, reads, ms };
}

describe("ACP normalizer history scaling", () => {
  it("keeps text, late tool progress, metadata and replay work independent of old history", () => {
    const small = measure(100, 100);
    const large = measure(1000, 100);
    const twice = measure(1000, 200);
    if (process.env.ACP_NORMALIZER_BENCHMARK === "1") {
      process.stdout.write(`${JSON.stringify({ operations: [small, large, twice] })}\n`);
      const timings = [100, 1000, 5000].map((history) =>
        measure(history, 1000, false),
      );
      process.stdout.write(`${JSON.stringify({ timings })}\n`);
    }
    expect(large.reads).toBe(small.reads);
    expect(twice.reads).toBe(large.reads * 2);
    expect(large.reads).toBeLessThanOrEqual(1500);
  });

  it("does not scan history for echoed prompts or repeated absent waiting indicators", () => {
    const normalizer = seed(1000);
    normalizer.recordUserPrompt({ sessionId: "synthetic", prompt: "Live", turnId: "live" });
    const readCount = countHistoryReads(normalizer);
    for (let index = 0; index < 100; index += 1) {
      apply(normalizer, "user_message_chunk", { text: "Live" });
      apply(normalizer, "agent_message_chunk", { messageId: "live-answer", text: "x" });
    }
    expect(readCount()).toBeLessThanOrEqual(700);
  });

  it("hydrates growing history without revisiting earlier slots per update", () => {
    const normalizer = new AcpSessionReplayNormalizer();
    const readCount = countHistoryReads(normalizer);
    for (let index = 0; index < 1000; index += 1) {
      apply(normalizer, "user_message_chunk", { messageId: `u${index}`, text: `Prompt ${index}` });
      apply(normalizer, "agent_thought_chunk", { messageId: `thought${index}`, text: "Thinking" });
      apply(normalizer, "agent_message_chunk", { messageId: `a${index}`, text: "Answer" });
      apply(normalizer, "tool_call", { toolCallId: `t${index}`, title: "Read" });
    }
    expect(readCount()).toBeLessThanOrEqual(10_000);
  });

  it("keeps latest summaries in replay order when explicit IDs revisit older messages", () => {
    const normalizer = seed(2);
    apply(normalizer, "agent_message_chunk", { messageId: "a0", text: " extended" });
    let replay = normalizer.replay();
    expect(replay.lastAssistantMessage).toBe("Answer");
    expect(replay.messages[1]?.text).toBe("Answer extended");
    expect(replay.entries[1]).toMatchObject({ text: "Answer extended" });
    normalizer.rewindToPromptIndex(1);
    replay = apply(normalizer, "agent_message_chunk", { messageId: "a0", text: " retained" });
    expect(replay.lastAssistantMessage).toBe("Answer extended retained");
    expect(replay.messages).toHaveLength(2);
    expect(replay.entries).toHaveLength(3);
    normalizer.rewindToPromptIndex(9, { missingTarget: "clear" });
    expect(normalizer.replay().lastAssistantMessage).toBeUndefined();
    expect(normalizer.replay().lastUserMessage).toBeUndefined();
    replay = apply(normalizer, "agent_message_chunk", { messageId: "a0", text: "Fresh" });
    expect(replay.messages).toHaveLength(1);
    expect(replay.lastAssistantMessage).toBe("Fresh");
  });

  it.each(["complete", "fail"])("uses current entry objects after %s and waiting removal", (terminal) => {
    const normalizer = seed(2);
    normalizer.recordUserPrompt({ sessionId: "synthetic", prompt: "Live", turnId: "live", waitingForAgent: true });
    apply(normalizer, "agent_message_chunk", { messageId: "answer", text: "Live answer" });
    apply(normalizer, "tool_call", { toolCallId: "tool", title: "Read" });
    if (terminal === "complete") {
      normalizer.recordTurnFinished("live", 2000);
    } else {
      normalizer.recordTurnFailed({ sessionId: "synthetic", turnId: "live", error: "Synthetic", receivedAt: 2000 });
    }
    apply(normalizer, "tool_call_update", { toolCallId: "tool", status: "completed" });
    const replay = apply(normalizer, "agent_message_chunk", { messageId: "answer", text: " late" });
    expect(replay.entries.find((entry) => entry.id === "answer")).toMatchObject({
      text: "Live answer late", turn: { status: terminal === "complete" ? "completed" : "failed" },
    });
    expect(replay.entries.find((entry) => entry.id === "tool")).toMatchObject({ status: "completed" });
    expect(replay.entries.some((entry) => entry.id === "agent-waiting:live")).toBe(false);
  });

  it("preserves first-match and typed lookup behavior for cross-type ID collisions", () => {
    const normalizer = new AcpSessionReplayNormalizer();
    apply(normalizer, "agent_message_chunk", { messageId: "shared", text: "Answer" });
    apply(normalizer, "tool_call", { toolCallId: "shared", title: "Read" });
    apply(normalizer, "plan", { planId: "shared", steps: ["Plan"] });
    apply(normalizer, "agent_message_chunk", { messageId: "shared", text: " continued" });
    apply(normalizer, "tool_call_update", { toolCallId: "shared", status: "completed" });
    const replay = normalizer.replay();
    expect(replay.entries.map((entry) => entry.type)).toEqual(["plan", "activity", "message"]);
    expect(replay.entries[1]).toMatchObject({ status: "completed" });
    expect(replay.entries[2]).toMatchObject({ text: " continued" });
    expect(replay.lastAssistantMessage).toBe("Answer continued");
  });

  it("refreshes role summaries when a local prompt replaces a reused provider ID", () => {
    const normalizer = new AcpSessionReplayNormalizer();
    apply(normalizer, "agent_message_chunk", { messageId: "earlier", text: "Earlier" });
    apply(normalizer, "agent_message_chunk", { messageId: "user:live", text: "Replaced" });
    const replay = normalizer.recordUserPrompt({
      sessionId: "synthetic", prompt: "Prompt", turnId: "live", waitingForAgent: true,
    });
    expect(replay.lastAssistantMessage).toBe("Earlier");
    expect(replay.lastUserMessage).toBe("Prompt");
    normalizer.recordTurnFinished("live", 2000);
    normalizer.recordUserPrompt({
      sessionId: "synthetic", prompt: "Next prompt", turnId: "next", waitingForAgent: true,
    });
    const next = apply(normalizer, "agent_message_chunk", { text: "Next answer" });
    expect(next.lastAssistantMessage).toBe("Next answer");
    expect(next.lastUserMessage).toBe("Next prompt");
    expect(next.entries.at(-1)).toMatchObject({
      type: "message", text: "Next answer", turn: { id: "next", status: "in_progress" },
    });
    expect(next.entries.some((entry) => entry.id.startsWith("agent-waiting:"))).toBe(false);
  });
});
