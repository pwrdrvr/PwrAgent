import type { ThreadSubAgentSummary } from "@pwragent/shared";
import { describe, expect, it } from "vitest";
import {
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
