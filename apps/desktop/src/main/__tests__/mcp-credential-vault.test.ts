import { describe, expect, it, vi } from "vitest";
import {
  McpCredentialVault,
} from "../mcp-connections/mcp-credential-vault";

function createSettings(initial?: string) {
  let value = initial;
  return {
    clearMcpConnectionCredentials: vi.fn(async () => {
      value = undefined;
    }),
    resolveMcpConnectionCredentials: vi.fn(async () => value),
    resolvePwrSnapMcpCredential: vi.fn(
      async (): Promise<string | undefined> => undefined,
    ),
    saveMcpConnectionCredentials: vi.fn(async (next: string) => {
      value = next;
    }),
  };
}

describe("McpCredentialVault", () => {
  it("serializes connection updates into one encrypted envelope", async () => {
    const settings = createSettings();
    const vault = new McpCredentialVault({ settings });

    await Promise.all([
      vault.write("datadog", {
        resourceUrl: "https://mcp.datadoghq.com/mcp",
        tokens: { access_token: "dog", token_type: "bearer" },
      }),
      vault.write("rovo", {
        resourceUrl: "https://mcp.atlassian.com/mcp",
        tokens: { access_token: "rovo", token_type: "bearer" },
      }),
    ]);

    await expect(
      vault.read("datadog", "https://mcp.datadoghq.com/mcp"),
    ).resolves.toMatchObject({ tokens: { access_token: "dog" } });
    await expect(
      vault.read("rovo", "https://mcp.atlassian.com/mcp"),
    ).resolves.toMatchObject({ tokens: { access_token: "rovo" } });
    expect(settings.saveMcpConnectionCredentials).toHaveBeenCalledTimes(2);
  });

  it("rejects a silent secret-storage write failure", async () => {
    const settings = createSettings();
    settings.saveMcpConnectionCredentials.mockImplementation(async () => undefined);
    const vault = new McpCredentialVault({ settings });

    await expect(vault.write("datadog", {
      resourceUrl: "https://mcp.datadoghq.com/mcp",
      tokens: { access_token: "not-durable", token_type: "bearer" },
    })).rejects.toThrow("could not durably save");
  });

  it("lazily copies a legacy PwrSnap credential into the generic vault", async () => {
    const settings = createSettings();
    settings.resolvePwrSnapMcpCredential.mockResolvedValue(JSON.stringify({
      tokens: {
        access_token: "legacy-access",
        refresh_token: "legacy-refresh",
        token_type: "bearer",
      },
    }));
    const vault = new McpCredentialVault({ settings });

    await expect(
      vault.read("pwrsnap", "http://127.0.0.1:51729/mcp"),
    ).resolves.toMatchObject({
      resourceUrl: "http://127.0.0.1:51729/mcp",
      tokens: { access_token: "legacy-access" },
    });
    expect(settings.saveMcpConnectionCredentials).toHaveBeenCalledOnce();
  });
});
