import { homedir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { discoverLocalAcpAgents, type LocalAcpAgentProbe } from "../acp/acp-local-discovery";

describe("discoverLocalAcpAgents", () => {
  it("discovers Gemini CLI when the local command supports ACP", async () => {
    const probe = vi.fn<LocalAcpAgentProbe>(async (command, args) => {
      if (command !== "gemini") {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
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

  it("prefers a concrete Gemini executable path when it is available", async () => {
    const probe = vi.fn<LocalAcpAgentProbe>(async (command, args) => {
      if (command !== "/opt/homebrew/bin/gemini") {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
      if (args[0] === "--version") {
        return { stdout: "0.45.0\n" };
      }
      if (args[0] === "--help") {
        return { stdout: "Usage: gemini [options]\n  --acp Starts ACP mode\n" };
      }
      throw new Error("unexpected probe");
    });

    const agents = await discoverLocalAcpAgents({ probe, now: () => 1234 });

    expect(agents[0]).toMatchObject({
      backendId: "acp:gemini",
      distributionSource: "/opt/homebrew/bin/gemini --acp --skip-trust",
      launchDescriptor: {
        command: "/opt/homebrew/bin/gemini",
        args: ["--acp", "--skip-trust"],
      },
    });
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
        return {
          stdout:
            "Usage: kimi acp [options]\n\nRun kimi-code as an Agent Client Protocol (ACP) server over stdio.\n",
        };
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

  it("discovers Kimi at its default install path when not on $PATH", async () => {
    const kimiInstallPath = `${homedir()}/.kimi-code/bin/kimi`;
    const seen: string[] = [];
    const probe = vi.fn<LocalAcpAgentProbe>(async (command, args) => {
      seen.push(command);
      // Simulate the GUI-launch case: bare `kimi` is NOT on PATH, but the
      // installer's default location exists.
      if (command !== kimiInstallPath) {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
      if (args[0] === "--version") {
        return { stdout: "kimi, version 1.44.0\n" };
      }
      if (args[0] === "acp" && args[1] === "--help") {
        return {
          stdout:
            "Usage: kimi acp [options]\n\nRun kimi-code as an Agent Client Protocol (ACP) server over stdio.\n",
        };
      }
      throw new Error("unexpected probe");
    });

    const result = await discoverLocalAcpAgents({ probe, now: () => 4242 });
    expect(result).toEqual([
      expect.objectContaining({
        backendId: "acp:kimi",
        registryId: "kimi",
        distributionSource: `${kimiInstallPath} acp`,
        launchDescriptor: expect.objectContaining({
          command: kimiInstallPath,
          args: ["acp"],
        }),
      }),
    ]);
    // Bare `kimi` is probed first (fast path), then the installer location.
    const kimiProbes = seen.filter((command) =>
      command === "kimi" || command.endsWith("/kimi"),
    );
    expect(kimiProbes[0]).toBe("kimi");
    expect(kimiProbes).toContain(kimiInstallPath);
  });

  it("honors a Kimi CLI path override before probing $PATH", async () => {
    const seen: string[] = [];
    const probe = vi.fn<LocalAcpAgentProbe>(async (command, args) => {
      seen.push(command);
      if (command !== "/custom/kimi") {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
      if (args[0] === "--version") {
        return { stdout: "kimi, version 1.44.0\n" };
      }
      if (args[0] === "acp" && args[1] === "--help") {
        return {
          stdout:
            "Usage: kimi acp [options]\n\nRun kimi-code as an Agent Client Protocol (ACP) server over stdio.\n",
        };
      }
      throw new Error("unexpected probe");
    });

    const result = await discoverLocalAcpAgents({
      probe,
      now: () => 1,
      overrides: { kimi: "/custom/kimi" },
    });
    expect(result).toEqual([
      expect.objectContaining({
        backendId: "acp:kimi",
        launchDescriptor: expect.objectContaining({
          command: "/custom/kimi",
        }),
      }),
    ]);
    const kimiProbes = seen.filter((command) =>
      command === "/custom/kimi" || command === "kimi" || command.endsWith("/kimi"),
    );
    expect(kimiProbes[0]).toBe("/custom/kimi");
  });

  it("ignores missing local commands", async () => {
    const probe = vi.fn<LocalAcpAgentProbe>(async () => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });

    await expect(discoverLocalAcpAgents({ probe })).resolves.toEqual([]);
  });

  it("ignores Gemini CLI versions that do not advertise ACP mode", async () => {
    const probe = vi.fn<LocalAcpAgentProbe>(async (command, args) => {
      if (command !== "gemini") {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
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

  it("discovers Qwen Code when the local command supports ACP mode", async () => {
    const probe = vi.fn<LocalAcpAgentProbe>(async (command, args) => {
      if (command !== "qwen") {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
      if (args[0] === "--version") {
        return { stdout: "0.16.2\n" };
      }
      if (args[0] === "--help") {
        return { stdout: "Usage: qwen [options]\n  --acp Enables ACP mode\n" };
      }
      throw new Error("unexpected probe");
    });

    await expect(
      discoverLocalAcpAgents({ probe, now: () => 2468 }),
    ).resolves.toEqual([
      expect.objectContaining({
        backendId: "acp:qwen",
        registryId: "qwen",
        name: "Qwen Code",
        version: "0.16.2",
        distributionKind: "local",
        distributionSource: "qwen --acp",
        installStatus: "installed",
        authStatus: "not-required",
        verificationStatus: "not-applicable",
        allowlistRuleId: "local-qwen-code-cli",
        installedAt: 2468,
        updatedAt: 2468,
        launchDescriptor: expect.objectContaining({
          backendId: "acp:qwen",
          registryId: "qwen",
          distributionKind: "local",
          command: "qwen",
          args: ["--acp"],
        }),
        registryAgent: expect.objectContaining({
          id: "qwen",
          authors: ["Qwen Team"],
          license: "Apache-2.0",
          repositoryUrl: "https://github.com/QwenLM/qwen-code",
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

  it("honors a Qwen Code path override before probing $PATH", async () => {
    const seen: string[] = [];
    const probe = vi.fn<LocalAcpAgentProbe>(async (command, args) => {
      seen.push(command);
      if (command !== "/custom/qwen") {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
      if (args[0] === "--version") {
        return { stdout: "qwen 0.16.2\n" };
      }
      if (args[0] === "--help") {
        return { stdout: "Usage: qwen [options]\n--acp\n" };
      }
      throw new Error("unexpected probe");
    });

    const result = await discoverLocalAcpAgents({
      probe,
      now: () => 1,
      overrides: { qwen: "/custom/qwen" },
    });
    expect(result).toEqual([
      expect.objectContaining({
        backendId: "acp:qwen",
        launchDescriptor: expect.objectContaining({
          command: "/custom/qwen",
        }),
      }),
    ]);
    expect(seen).toContain("/custom/qwen");
    const qwenProbes = seen.filter((command) =>
      command === "/custom/qwen" || command === "qwen" || command.endsWith("/qwen"),
    );
    expect(qwenProbes[0]).toBe("/custom/qwen");
  });

  it("ignores Qwen Code versions that do not advertise ACP mode", async () => {
    const probe = vi.fn<LocalAcpAgentProbe>(async (command, args) => {
      if (command !== "qwen") {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
      if (args[0] === "--version") {
        return { stdout: "0.16.0\n" };
      }
      return { stdout: "Usage: qwen [OPTIONS]\n" };
    });

    await expect(discoverLocalAcpAgents({ probe })).resolves.toEqual([]);
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

  it("ignores Kimi CLI versions without an `acp` subcommand", async () => {
    const probe = vi.fn<LocalAcpAgentProbe>(async (command, args) => {
      if (command !== "kimi") {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
      if (args[0] === "--version") {
        return { stdout: "kimi, version 1.40.0\n" };
      }
      // A kimi build without ACP support exits non-zero for `acp --help`
      // (commander: "error: unknown command 'acp'"), which surfaces as a
      // rejected probe — the capability signal we rely on.
      throw Object.assign(new Error("unknown command 'acp'"), { code: 1 });
    });

    await expect(discoverLocalAcpAgents({ probe })).resolves.toEqual([]);
  });
});
