import type { ThreadSubAgentSummary } from "@pwragent/shared";
import { describe, expect, it } from "vitest";
import {
  isSystemQueuedMessageTitleHelperSubAgent,
  isTokenMiserSubAgent,
  subAgentLens,
  subAgentOriginLabel,
  subAgentPricingUsageTitle,
  subAgentUsageLabel,
} from "../subagent-kind";

describe("Token Miser sub-agent presentation", () => {
  it("identifies gate helpers in Sub-agents and Pricing", () => {
    const subAgent = {
      monitorId: "system:token-miser:gate-1",
    } as ThreadSubAgentSummary;

    expect(isTokenMiserSubAgent(subAgent)).toBe(true);
    expect(subAgentOriginLabel(subAgent)).toBe("PwrAgent Token Miser gate");
    expect(subAgentUsageLabel(subAgent)).toBe("Gate");
    expect(subAgentPricingUsageTitle(subAgent)).toBe("Token Miser gate");
  });

  it("presents the queued-message title row as a PwrAgent system helper", () => {
    const subAgent = {
      monitorId: "system:queued-message-titles:codex:thread-1",
    } as ThreadSubAgentSummary;

    expect(isSystemQueuedMessageTitleHelperSubAgent(subAgent)).toBe(true);
    expect(subAgentOriginLabel(subAgent)).toBe("PwrAgent system helper");
    expect(subAgentUsageLabel(subAgent)).toBe("System");
    expect(subAgentPricingUsageTitle(subAgent)).toBe("Queued message titles");
    expect(subAgentLens(subAgent)).toBe("pwragent");
  });

  it("groups sub-agents by lifecycle owner", () => {
    expect(subAgentLens({
      monitorId: "codex-native:child-1",
    } as ThreadSubAgentSummary)).toBe("harness");
    expect(subAgentLens({
      monitorId: "system:token-miser:gate-1",
    } as ThreadSubAgentSummary)).toBe("token-miser");
    expect(subAgentLens({
      monitorId: "review:review-1",
    } as ThreadSubAgentSummary)).toBe("pwragent");
    expect(subAgentLens({
      monitorId: "monitor-1",
    } as ThreadSubAgentSummary)).toBe("pwragent");
  });
});
