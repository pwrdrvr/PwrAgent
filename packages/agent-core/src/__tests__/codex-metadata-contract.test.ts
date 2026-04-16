import { describe, expect, it } from "vitest";
import { createTestHarness } from "../testing/test-harness.js";

describe("Codex metadata contract", () => {
  it("returns thread discovery aliases over the same session state", async () => {
    const { server } = createTestHarness();

    await server.request("thread/start", { cwd: "/repo/one", model: "grok-4.20-reasoning" });
    await server.request("thread/name/set", { threadId: "thread-1", name: "Thread one" });

    expect(await server.request("thread/list", { filter: "ignored" })).toEqual(
      await server.request("thread/loaded/list", {}),
    );
  });

  it("returns OpenClaw-compatible model and account metadata", async () => {
    const { server } = createTestHarness();

    const models = await server.request("model/list", {});
    const rateLimits = await server.request("account/rateLimits/read", {});
    const account = await server.request("account/read", { refreshToken: "ignored" });

    expect(models).toEqual({
      data: [
        {
          id: "grok-4.20-reasoning",
          label: "Grok 4.20 Reasoning",
          description: "Default Grok reasoning model for the app-server provider.",
          current: true,
          supportsReasoning: true,
          supportsFast: false,
          provider: "xai",
        },
        {
          id: "grok-4.20-fast",
          label: "Grok 4.20 Fast",
          description: "Lower-latency Grok model for shorter turns.",
          current: false,
          supportsReasoning: false,
          supportsFast: true,
          provider: "xai",
        },
      ],
    });
    expect(rateLimits).toEqual({ data: [] });
    expect(account).toEqual({
      account: {
        type: "apiKey",
        planType: "local-dev",
      },
      requiresOpenaiAuth: false,
    });
  });

  it("returns stable empty-or-derived shapes for skills, features, and MCP status", async () => {
    const { server } = createTestHarness();

    const skills = await server.request("skills/list", {
      cwd: "/repo/workspace",
      cwds: ["/repo/one", "/repo/two"],
    });
    const experimentalFeatures = await server.request("experimentalFeature/list", { limit: 100 });
    const mcpServers = await server.request("mcpServerStatus/list", { limit: 100 });

    expect(skills).toEqual({
      data: [
        { cwd: "/repo/one", skills: [] },
        { cwd: "/repo/two", skills: [] },
        { cwd: "/repo/workspace", skills: [] },
      ],
    });
    expect(experimentalFeatures).toEqual({
      data: [
        {
          name: "grok-responses",
          stage: "beta",
          displayName: "Grok Responses",
          description: "Routes Codex-style turns through the xAI Responses API.",
          enabled: true,
          defaultEnabled: true,
        },
      ],
    });
    expect(mcpServers).toEqual({ data: [] });
  });
});
