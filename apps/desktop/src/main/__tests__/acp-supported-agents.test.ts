import { describe, expect, it } from "vitest";
import type { DesktopSettingsSnapshot } from "@pwragent/shared/contracts/settings";
import { isBannedAcpRegistryId } from "../acp/acp-agent-allowlist";
import { ACP_LOCAL_AGENT_STRATEGIES } from "../acp/acp-local-strategies";

// The ACP agents PwrAgent supports, one per key of the settings contract's
// `acpAgents`. The record type makes this list fail typecheck when the
// contract gains or loses an agent; the test below makes it fail when the
// local strategy catalog does.
const CONTRACT_ACP_AGENTS: Record<keyof DesktopSettingsSnapshot["acpAgents"], true> = {
  antigravity: true,
  gemini: true,
  grok: true,
  kimi: true,
  qwen: true,
};

describe("supported ACP agents", () => {
  it("uses the same local agents for discovery and the settings contract", () => {
    const strategies = ACP_LOCAL_AGENT_STRATEGIES
      .map((strategy) => strategy.id)
      .filter((id) => !isBannedAcpRegistryId(id))
      .sort();
    expect(strategies).toEqual(Object.keys(CONTRACT_ACP_AGENTS).sort());
  });
});
