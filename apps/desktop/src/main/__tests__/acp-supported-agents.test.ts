import { describe, expect, it } from "vitest";
import { BUILT_IN_ACP_STRATEGIES } from "@pwrdrvr/agent-acp/strategies";
import type { DesktopSettingsSnapshot } from "@pwragent/shared/contracts/settings";
import { isBannedAcpRegistryId } from "../acp/acp-agent-allowlist";

// The ACP agents PwrAgent supports, one per key of the settings contract's
// `acpAgents`. The record type makes this list fail typecheck when the
// contract gains or loses an agent; the test below makes it fail when the
// agent-acp package does.
const CONTRACT_ACP_AGENTS: Record<keyof DesktopSettingsSnapshot["acpAgents"], true> = {
  gemini: true,
  grok: true,
  kimi: true,
  qwen: true,
};

describe("supported ACP agents", () => {
  it("are the same set in @pwrdrvr/agent-acp and the settings contract", () => {
    // Every built-in strategy gets a placeholder entry in listAcpAgents, so
    // Settings → AI providers shows it. Settings can only enable, and guided
    // setup only offers, the agents the contract names. A package update
    // that adds or drops a strategy has to be met with a contract change.
    const strategies = BUILT_IN_ACP_STRATEGIES
      .map((strategy) => strategy.id)
      .filter((id) => !isBannedAcpRegistryId(id))
      .sort();
    expect(strategies).toEqual(Object.keys(CONTRACT_ACP_AGENTS).sort());
  });
});
