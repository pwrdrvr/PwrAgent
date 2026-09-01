import { describe, expect, it, vi } from "vitest";
import { normalizeConfigDomains } from "../settings/config-store/config-domains";

const discoverLocalAcpAgentRecords = vi.hoisted(() => vi.fn(async () => []));
const readDesktopSettingsConfigSafe = vi.hoisted(() => vi.fn(() => {
  throw new Error("raw config parsing must not run");
}));

vi.mock("../acp/acp-instance-discovery", () => ({
  discoverLocalAcpAgentRecords,
}));

vi.mock("../settings/desktop-config", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readDesktopSettingsConfigSafe,
}));

import { createLocalAcpAgentDiscovery } from "../app-server/acp-backend-adapter";

describe("ACP config-store discovery", () => {
  it("selects providers and overrides without reparsing config.toml", async () => {
    const providers = normalizeConfigDomains({
      config: {
        acpAgents: {
          gemini: { enabled: false },
          grok: {
            cliPath: "/opt/pwragent/grok",
            enabled: true,
            managedBuilds: false,
          },
          kimi: { enabled: true },
          qwen: {
            cliPath: "/opt/pwragent/qwen",
            enabled: true,
          },
        },
      },
    }).providers;
    const discover = createLocalAcpAgentDiscovery({
      configStore: {
        read: (() => providers) as never,
      },
      resolveEnv: async () => ({ PATH: "/usr/bin" }),
    });

    await discover();

    expect(readDesktopSettingsConfigSafe).not.toHaveBeenCalled();
    expect(discoverLocalAcpAgentRecords).toHaveBeenCalledWith(
      expect.objectContaining({
        enabledRegistryIds: ["grok", "kimi", "qwen"],
        managedGrok: expect.objectContaining({ enabled: false }),
        preferences: {
          grok: { overridePath: "/opt/pwragent/grok" },
          qwen: { overridePath: "/opt/pwragent/qwen" },
        },
      }),
    );
  });
});
