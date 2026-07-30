import { describe, expect, it, vi } from "vitest";
import {
  resolveLiveAgentCoreSkipReason,
  resolveLiveAgentCoreTestConfig,
} from "../testing/live-test-gate.js";

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

  it("does not resolve ambient runtime config during ordinary workspace tests", () => {
    const resolveRuntimeConfig = vi.fn(() => {
      throw new Error("ambient runtime config must not be parsed");
    });

    expect(
      resolveLiveAgentCoreTestConfig({
        lifecycleEvent: "test",
        resolveRuntimeConfig,
      }),
    ).toEqual({
      skipReason: expect.stringContaining(
        "only through the explicit agent-core test:live script",
      ),
    });
    expect(resolveRuntimeConfig).not.toHaveBeenCalled();
  });

  it("resolves and validates runtime config for the explicit live script", () => {
    const runtimeConfig = {
      configPath: "/home/test/.config/grok-app-server/config.toml",
    };
    const resolveRuntimeConfig = vi.fn(() => runtimeConfig);

    expect(
      resolveLiveAgentCoreTestConfig({
        lifecycleEvent: "test:live",
        resolveRuntimeConfig,
      }),
    ).toEqual({
      runtimeConfig,
      skipReason: expect.stringContaining("XAI_API_KEY is not set"),
    });
    expect(resolveRuntimeConfig).toHaveBeenCalledOnce();
  });
});
