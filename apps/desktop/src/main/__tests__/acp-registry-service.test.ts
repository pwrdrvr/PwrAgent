import { describe, expect, it } from "vitest";
import { AcpAgentAllowlist } from "../acp/acp-agent-allowlist";
import { AcpRegistryService, normalizeRegistry } from "../acp/acp-registry-service";

const registryPayload = {
  agents: [
    {
      id: "codex-acp",
      name: "Codex CLI",
      version: "0.14.0",
      description: "ACP adapter for OpenAI's coding assistant",
      repository: "https://github.com/zed-industries/codex-acp",
      authors: ["OpenAI", "Zed Industries"],
      license: "Apache-2.0",
      distribution: {
        binary: {
          "darwin-aarch64": {
            archive:
              "https://github.com/zed-industries/codex-acp/releases/download/v0.14.0/codex-acp.tar.gz",
            cmd: "./codex-acp",
          },
        },
        npx: {
          package: "@zed-industries/codex-acp@0.14.0",
        },
      },
    },
    {
      id: "blocked-gpl",
      name: "Blocked GPL Agent",
      version: "1.0.0",
      license: "GPL-3.0-or-later",
      distribution: {
        npx: {
          package: "blocked-gpl",
        },
      },
    },
  ],
};

describe("AcpRegistryService", () => {
  it("normalizes registry agents and distribution metadata", () => {
    const agents = normalizeRegistry(registryPayload);

    expect(agents[0]).toMatchObject({
      id: "codex-acp",
      backendId: "acp:codex-acp",
      name: "Codex CLI",
      version: "0.14.0",
      authors: ["OpenAI", "Zed Industries"],
      distributionKinds: ["npx", "binary"],
    });
    expect(agents[0]?.distributions).toEqual([
      {
        kind: "npx",
        packageName: "@zed-industries/codex-acp@0.14.0",
        args: [],
        env: {},
      },
      {
        kind: "binary",
        platform: "darwin-aarch64",
        archiveUrl:
          "https://github.com/zed-industries/codex-acp/releases/download/v0.14.0/codex-acp.tar.gz",
        command: "./codex-acp",
        args: [],
        env: {},
        checksum: undefined,
        signatureUrl: undefined,
      },
    ]);
  });

  it("fetches registry snapshots through an injected fetcher", async () => {
    const service = new AcpRegistryService({
      now: () => 1234,
      fetch: async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => registryPayload,
      }),
    });

    await expect(service.fetchRegistry()).resolves.toMatchObject({
      fetchedAt: 1234,
      agents: [
        expect.objectContaining({ id: "codex-acp" }),
        expect.objectContaining({ id: "blocked-gpl" }),
      ],
    });
  });

  it("applies allowlist rules and unverified binary policy", async () => {
    const service = new AcpRegistryService({
      allowlist: new AcpAgentAllowlist([
        {
          id: "codex-rule",
          registryId: "codex-acp",
          versions: ["0.14.0"],
          distributionKinds: ["npx", "binary"],
          allowedPackageNames: ["@zed-industries/codex-acp@0.14.0"],
          allowedArchiveHosts: ["github.com"],
          allowUnverifiedBinary: true,
        },
        {
          id: "gpl-rule",
          registryId: "blocked-gpl",
          distributionKinds: ["npx"],
          allowedPackageNames: ["blocked-gpl"],
        },
      ]),
    });

    const snapshot = {
      fetchedAt: 1,
      agents: normalizeRegistry(registryPayload),
      raw: registryPayload,
    };

    const entries = service.applyAllowlist(snapshot);

    expect(entries.find((entry) => entry.id === "codex-acp")).toMatchObject({
      installable: true,
      verificationStatus: "unverified-allowed",
      allowlist: { allowed: true, ruleId: "codex-rule" },
    });
    expect(entries.find((entry) => entry.id === "blocked-gpl")).toMatchObject({
      installable: false,
      unavailableReason: "allowlist-rule-mismatch",
      allowlist: { allowed: false },
    });
  });

  it("rejects registry HTTP failures", async () => {
    const service = new AcpRegistryService({
      fetch: async () => ({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
        json: async () => ({}),
      }),
    });

    await expect(service.fetchRegistry()).rejects.toThrow(
      "ACP registry request failed: 503 Service Unavailable",
    );
  });
});
