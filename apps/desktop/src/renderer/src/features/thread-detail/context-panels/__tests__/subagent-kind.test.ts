import type { ThreadSubAgentSummary } from "@pwragent/shared/contracts/navigation";
import { projectActiveThreadSubAgents } from "@pwragent/shared/subagent-visibility";
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
      monitorId: "claude-native:task-1",
    } as ThreadSubAgentSummary)).toBe("harness");
    expect(subAgentLens({
      monitorId: "acp-native:call-1",
      backend: "acp:antigravity",
      task: "Audit",
      status: "running",
      createdAt: 0,
      updatedAt: 0,
    })).toBe("harness");
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

  it("labels Claude and ACP native sub-agents by their provider", () => {
    const antigravity: ThreadSubAgentSummary = {
      monitorId: "acp-native:call-1",
      backend: "acp:antigravity",
      task: "Audit",
      status: "running",
      createdAt: 0,
      updatedAt: 0,
    };
    const grok: ThreadSubAgentSummary = {
      monitorId: "acp-native:sub-1",
      backend: "acp:grok",
      task: "Research",
      status: "running",
      createdAt: 0,
      updatedAt: 0,
    };
    const claude: ThreadSubAgentSummary = {
      monitorId: "claude-native:task-1",
      backend: "claude",
      task: "Explore",
      status: "running",
      createdAt: 0,
      updatedAt: 0,
    };

    expect(subAgentOriginLabel(antigravity)).toBe("Antigravity");
    expect(subAgentUsageLabel(antigravity)).toBe("Antigravity");
    expect(subAgentPricingUsageTitle(antigravity)).toBe("Antigravity sub-agent usage");

    expect(subAgentOriginLabel(grok)).toBe("Grok");
    expect(subAgentUsageLabel(grok)).toBe("Grok");
    expect(subAgentPricingUsageTitle(grok)).toBe("Grok sub-agent usage");

    expect(subAgentOriginLabel(claude)).toBe("Claude");
    expect(subAgentUsageLabel(claude)).toBe("Claude");
    expect(subAgentPricingUsageTitle(claude)).toBe("Claude sub-agent usage");
  });

  it("preserves displayTitle for ACP native sub-agents in projectActiveThreadSubAgents", () => {
    const projected = projectActiveThreadSubAgents([
      {
        monitorId: "acp-native:call-no-role",
        backend: "acp:antigravity",
        displayTitle: "Audit streaming parser bounds",
        task: "Inspect the streaming parser for quadratic loops across 10k-event sessions and summarize every offending pass.",
        status: "running",
        createdAt: 1_000,
        updatedAt: 1_000,
      },
    ]);

    expect(projected).toEqual([
      expect.objectContaining({
        monitorId: "acp-native:call-no-role",
        displayTitle: "Audit streaming parser bounds",
      }),
    ]);
  });
});
