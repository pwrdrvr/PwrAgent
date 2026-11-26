import { describe, expect, it } from "vitest";
import {
  applyContextWindowBudget,
  autoCompactionStatusLine,
  isAutoCompactionActive,
} from "../context-window-budget";

const neonAt400k = {
  modelContextWindow: 1_048_576,
  totalTokens: 400_000,
  usedPercent: (400_000 / 1_048_576) * 100,
  remainingTokens: 648_576,
};

describe("context window budget", () => {
  it("measures a Gemini 4 Neon thread against its 512k budget instead of the reported 1M", () => {
    const { contextWindow, budget } = applyContextWindowBudget({
      contextWindow: neonAt400k,
      savedRules: [],
      backend: "acp:antigravity",
      model: "gemini-4-neon",
    });
    expect(Math.round(contextWindow.usedPercent)).toBe(78);
    expect(contextWindow.modelContextWindow).toBe(512_000);
    expect(contextWindow.remainingTokens).toBe(112_000);
    expect(budget).toEqual({
      reportedContextWindow: 1_048_576,
      effectiveContextWindow: 512_000,
      compactAtPercent: 80,
      triggerTokens: 409_600,
      tokensToTrigger: 9_600,
    });
  });

  it("leaves a thread another instance owns on its reported window, since that owner's rules apply", () => {
    const result = applyContextWindowBudget({
      contextWindow: neonAt400k,
      savedRules: [],
      backend: "acp:antigravity",
      model: "gemini-4-neon",
      ownedElsewhere: true,
    });
    expect(result.contextWindow).toBe(neonAt400k);
    expect(result.budget).toBeUndefined();
  });

  it("leaves a model no rule covers on its reported window", () => {
    const result = applyContextWindowBudget({
      contextWindow: neonAt400k,
      savedRules: [],
      backend: "claude",
      model: "claude-sonnet-5-5",
    });
    expect(result.contextWindow).toBe(neonAt400k);
    expect(result.budget).toBeUndefined();
  });

  it("names a steered compaction and a held one", () => {
    const format = (value: number) => `${Math.round(value / 1000)}k`;
    expect(autoCompactionStatusLine(
      { threadId: "t", phase: "compacting", via: "steer", dispatchedAtTokens: 412_000 },
      format,
    )).toBe("Compacting. PwrAgent steered /compact into this turn at 412k.");
    expect(autoCompactionStatusLine(
      { threadId: "t", phase: "held", heldReason: "no-shrink", triggerTokens: 409_600 },
      format,
    )).toBe("Compaction ran but the context stayed above 410k. PwrAgent will not compact again until it drops.");
    expect(autoCompactionStatusLine(
      { threadId: "t", phase: "verifying", via: "steer", dispatchedAtTokens: 412_000 },
      format,
    )).toBe("Compacted. The context size updates on the next turn.");
    expect(isAutoCompactionActive({ threadId: "t", phase: "verifying" })).toBe(false);
    expect(autoCompactionStatusLine({ threadId: "t", phase: "armed" }, format)).toBeUndefined();
  });
});
