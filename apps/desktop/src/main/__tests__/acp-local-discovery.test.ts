import { describe, expect, it, vi } from "vitest";
import { discoverLocalAcpAgents, type LocalAcpAgentProbe } from "../acp/acp-local-discovery";

describe("discoverLocalAcpAgents", () => {
  it("discovers Gemini CLI when the local command supports ACP", async () => {
    const probe = vi.fn<LocalAcpAgentProbe>(async (_command, args) => {
      if (args[0] === "--version") {
        return { stdout: "0.42.0\n" };
      }
      if (args[0] === "--help") {
        return { stdout: "Usage: gemini [options]\n  --acp Starts the agent in ACP mode\n" };
      }
      throw new Error("unexpected probe");
    });

    await expect(
      discoverLocalAcpAgents({ probe, now: () => 1234 }),
    ).resolves.toEqual([
      expect.objectContaining({
        backendId: "acp:gemini",
        registryId: "gemini",
        name: "Gemini CLI",
        version: "0.42.0",
        distributionKind: "local",
        distributionSource: "gemini --acp --skip-trust",
        installStatus: "installed",
        authStatus: "not-required",
        verificationStatus: "not-applicable",
        allowlistRuleId: "local-gemini-cli",
        installedAt: 1234,
        updatedAt: 1234,
        launchDescriptor: {
          backendId: "acp:gemini",
          registryId: "gemini",
          distributionKind: "local",
          command: "gemini",
          args: ["--acp", "--skip-trust"],
          env: {
            GEMINI_CLI_TRUST_WORKSPACE: "true",
          },
        },
      }),
    ]);
  });

  it("discovers Kimi Code CLI when the local command supports ACP", async () => {
    const probe = vi.fn<LocalAcpAgentProbe>(async (command, args) => {
      if (command !== "kimi") {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
      if (args[0] === "--version") {
        return { stdout: "kimi, version 1.44.0\n" };
      }
      if (args[0] === "acp" && args[1] === "--help") {
        return { stdout: "Usage: kimi acp [OPTIONS]\nRun Kimi Code CLI ACP server.\n" };
      }
      throw new Error("unexpected probe");
    });

    await expect(
      discoverLocalAcpAgents({ probe, now: () => 5678 }),
    ).resolves.toEqual([
      expect.objectContaining({
        backendId: "acp:kimi",
        registryId: "kimi",
        name: "Kimi Code CLI",
        version: "1.44.0",
        distributionKind: "local",
        distributionSource: "kimi acp",
        installStatus: "installed",
        authStatus: "not-required",
        verificationStatus: "not-applicable",
        allowlistRuleId: "local-kimi-cli",
        installedAt: 5678,
        updatedAt: 5678,
        launchDescriptor: {
          backendId: "acp:kimi",
          registryId: "kimi",
          distributionKind: "local",
          command: "kimi",
          args: ["acp"],
          env: {},
        },
        registryAgent: expect.objectContaining({
          id: "kimi",
          authors: ["Moonshot AI"],
          auth: { required: false, methods: ["agent-managed"] },
        }),
      }),
    ]);
  });

  it("ignores missing local commands", async () => {
    const probe = vi.fn<LocalAcpAgentProbe>(async () => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });

    await expect(discoverLocalAcpAgents({ probe })).resolves.toEqual([]);
  });

  it("ignores Gemini CLI versions that do not advertise ACP mode", async () => {
    const probe = vi.fn<LocalAcpAgentProbe>(async (_command, args) => {
      if (args[0] === "--version") {
        return { stdout: "0.41.0\n" };
      }
      return { stdout: "Usage: gemini [options]\n" };
    });

    await expect(discoverLocalAcpAgents({ probe })).resolves.toEqual([]);
  });

  it("discovers Grok CLI when the local command supports ACP stdio", async () => {
    const probe = vi.fn<LocalAcpAgentProbe>(async (command, args) => {
      if (command !== "grok") {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
      if (args[0] === "--version") {
        return { stdout: "grok 0.2.3 (14d81fd875e) [stable]\n" };
      }
      if (args[0] === "agent" && args[1] === "stdio" && args[2] === "--help") {
        return { stdout: "Run the agent over stdio\n\nUsage: grok agent stdio\n" };
      }
      throw new Error("unexpected probe");
    });

    await expect(
      discoverLocalAcpAgents({ probe, now: () => 9999 }),
    ).resolves.toEqual([
      expect.objectContaining({
        backendId: "acp:grok",
        registryId: "grok",
        name: "Grok",
        version: "0.2.3",
        distributionKind: "local",
        distributionSource: "grok agent stdio",
        installStatus: "installed",
        authStatus: "not-required",
        verificationStatus: "not-applicable",
        allowlistRuleId: "local-grok-cli",
        installedAt: 9999,
        updatedAt: 9999,
        launchDescriptor: expect.objectContaining({
          backendId: "acp:grok",
          registryId: "grok",
          distributionKind: "local",
          command: "grok",
          args: ["agent", "stdio"],
        }),
        registryAgent: expect.objectContaining({
          id: "grok",
          authors: ["xAI"],
        }),
      }),
    ]);
  });

  it("honors a Grok CLI path override before probing $PATH", async () => {
    const seen: string[] = [];
    const probe = vi.fn<LocalAcpAgentProbe>(async (command, args) => {
      seen.push(command);
      if (command !== "/custom/grok") {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
      if (args[0] === "--version") {
        return { stdout: "grok 0.2.3\n" };
      }
      if (args[0] === "agent" && args[1] === "stdio" && args[2] === "--help") {
        return { stdout: "Run the agent over stdio\n" };
      }
      throw new Error("unexpected probe");
    });

    const result = await discoverLocalAcpAgents({
      probe,
      now: () => 1,
      overrides: { grok: "/custom/grok" },
    });
    expect(result).toEqual([
      expect.objectContaining({
        backendId: "acp:grok",
        launchDescriptor: expect.objectContaining({
          command: "/custom/grok",
        }),
      }),
    ]);
    expect(seen).toContain("/custom/grok");
    const grokProbes = seen.filter((command) =>
      command === "/custom/grok" || command === "grok" || command.endsWith("/grok"),
    );
    expect(grokProbes[0]).toBe("/custom/grok");
  });

  it("ignores Grok CLI versions that do not advertise stdio ACP", async () => {
    const probe = vi.fn<LocalAcpAgentProbe>(async (command, args) => {
      if (command !== "grok") {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
      if (args[0] === "--version") {
        return { stdout: "grok 0.1.0\n" };
      }
      return { stdout: "Usage: grok [OPTIONS]\n" };
    });

    await expect(discoverLocalAcpAgents({ probe })).resolves.toEqual([]);
  });

  it("ignores Kimi CLI versions that do not advertise ACP mode", async () => {
    const probe = vi.fn<LocalAcpAgentProbe>(async (command, args) => {
      if (command !== "kimi") {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
      if (args[0] === "--version") {
        return { stdout: "kimi, version 1.40.0\n" };
      }
      return { stdout: "Usage: kimi [OPTIONS] COMMAND [ARGS]...\n" };
    });

    await expect(discoverLocalAcpAgents({ probe })).resolves.toEqual([]);
  });
});
