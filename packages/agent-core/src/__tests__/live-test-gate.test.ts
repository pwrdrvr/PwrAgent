import { describe, expect, it } from "vitest";
import { resolveLiveAgentCoreSkipReason } from "../testing/live-test-gate.js";

describe("Grok live test gate", () => {
  it("skips ambient credentials during the ordinary workspace test lifecycle", () => {
    expect(
      resolveLiveAgentCoreSkipReason({
        apiKey: "ambient-key",
        configPath: "/home/test/.config/grok-app-server/config.toml",
        lifecycleEvent: "test",
      }),
    ).toContain("only through the explicit agent-core test:live script");
  });

  it("runs when the explicit live script has a credential", () => {
    expect(
      resolveLiveAgentCoreSkipReason({
        apiKey: "live-key",
        configPath: "/home/test/.config/grok-app-server/config.toml",
        lifecycleEvent: "test:live",
      }),
    ).toBeUndefined();
  });

  it("still skips the explicit live script when credentials are missing", () => {
    expect(
      resolveLiveAgentCoreSkipReason({
        configPath: "/home/test/.config/grok-app-server/config.toml",
        lifecycleEvent: "test:live",
      }),
    ).toContain("XAI_API_KEY is not set");
  });
});
