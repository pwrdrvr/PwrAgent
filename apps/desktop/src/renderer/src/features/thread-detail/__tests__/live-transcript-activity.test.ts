import { describe, expect, it } from "vitest";
import {
  buildLiveToolDetails,
  buildTokenUsageActivityEntry,
} from "../live-transcript-activity";

describe("buildLiveToolDetails", () => {
  it("surfaces collaboration agent activity from live tool items", () => {
    const details = buildLiveToolDetails({
      type: "collabAgentToolCall",
      id: "collab-spawn-1",
      tool: "spawnAgent",
      status: "inProgress",
      senderThreadId: "parent-thread",
      receiverThreadIds: ["019e5630-b147-7980-9f33-3cd7997c235a"],
      prompt: "You are the correctness reviewer.",
      agentsStates: {
        "019e5630-b147-7980-9f33-3cd7997c235a": {
          status: "running",
          message: "Inspecting the diff.\nStill running reviewer output.",
        },
      },
    });

    expect(details).toEqual([
      {
        id: "collab-spawn-1",
        kind: "command",
        label: "Spawning agent 019e5630",
        status: "in_progress",
        command: expect.objectContaining({
          displayCommand: "spawnAgent 019e5630",
          output: expect.stringContaining("Prompt: You are the correctness reviewer."),
        }),
      },
    ]);
    expect(details[0]?.command?.output).toContain("Still running reviewer output.");
  });
});

describe("buildTokenUsageActivityEntry", () => {
  it("summarizes cached, uncached, output, reasoning, and list-price cost", () => {
    const entry = buildTokenUsageActivityEntry({
      id: "usage-1",
      model: "gpt-5.5",
      tokenUsage: {
        last_token_usage: {
          input_tokens: 21_981,
          cached_input_tokens: 2_432,
          output_tokens: 174,
          reasoning_output_tokens: 25,
        },
      },
      turn: { id: "turn-1", status: "in_progress" },
    });

    expect(entry).toMatchObject({
      type: "activity",
      id: "usage-1",
      summary: expect.stringContaining("19,549 uncached in"),
      status: "completed",
      turn: { id: "turn-1" },
    });
    expect(entry?.summary).toContain("2,432 cached");
    expect(entry?.summary).toContain("174 out (25 reasoning)");
    expect(entry?.summary).toContain("$0.11 list price");
    expect(entry?.details.map((detail) => detail.label)).toEqual([
      "Input: 21,981 tokens (19,549 uncached, 2,432 cached)",
      "Output: 174 tokens, including 25 reasoning",
      "Cost: $0.11 list price for gpt-5.5",
    ]);
  });

  it("rounds list-price costs below ten cents to tenths of a penny", () => {
    const entry = buildTokenUsageActivityEntry({
      id: "usage-small-cost",
      model: "gpt-5.4-mini",
      tokenUsage: {
        total: {
          inputTokens: 1_000,
          cachedInputTokens: 0,
          outputTokens: 1_000,
        },
      },
    });

    expect(entry?.summary).toContain("$0.006 list price");
    expect(entry?.details.at(-1)?.label).toBe(
      "Cost: $0.006 list price for gpt-5.4-mini",
    );
  });

  it("reports unavailable cost without dropping token accounting", () => {
    const entry = buildTokenUsageActivityEntry({
      id: "usage-unknown",
      model: "custom-model",
      tokenUsage: {
        total: {
          inputTokens: 100,
          cachedInputTokens: 20,
          outputTokens: 30,
        },
      },
    });

    expect(entry?.summary).toBe("Usage: 80 uncached in · 20 cached · 30 out");
    expect(entry?.details.at(-1)?.label).toBe(
      "Cost unavailable: no local pricing entry for custom-model",
    );
  });
});
