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
});
