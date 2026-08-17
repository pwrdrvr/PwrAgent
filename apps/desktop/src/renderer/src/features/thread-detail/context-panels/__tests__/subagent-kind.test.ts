import type { ThreadSubAgentSummary } from "@pwragent/shared";
import { describe, expect, it } from "vitest";
import {
  isTokenMiserSubAgent,
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
});
