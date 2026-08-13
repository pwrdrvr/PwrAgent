import { describe, expect, it, vi } from "vitest";
import type { AcpAgentInstance } from "@pwragent/shared";
import type { LocalAcpDiscoveryOptions } from "@pwrdrvr/agent-acp";
import { resolveActiveAcpInstance } from "../acp/acp-instance-resolver";
import {
  discoverAcpAgentInstances,
  discoverLocalAcpAgentRecords,
  isLegacyPythonKimiCli,
} from "../acp/acp-instance-discovery";
import { resolveBundledGrokCommand } from "../acp/acp-bundled-agent";

function instance(
  command: string,
  source: AcpAgentInstance["source"],
  version?: string,
): AcpAgentInstance {
  return { command, source, ...(version !== undefined ? { version } : {}) };
}

function group(strategyId: string, instances: AcpAgentInstance[]) {
  return {
    strategyId,
    backendId: `acp:${strategyId}`,
    name: strategyId,
    args: ["--acp"],
    env: {},
    instances,
    discoveredAt: 0,
  };
}

describe("resolveActiveAcpInstance", () => {
  const path1 = instance("/usr/bin/qwen", "path", "0.17.0");
  const path2 = instance("/opt/homebrew/bin/qwen", "path", "0.16.0");
  const override = instance("/custom/qwen", "override", "0.18.0");

  it("returns undefined for an empty list", () => {
    expect(resolveActiveAcpInstance([], undefined)).toBeUndefined();
  });

  it("prefers an override instance over everything", () => {
    expect(
      resolveActiveAcpInstance([path1, override, path2], {
        selectedPath: path2.command,
      }),
    ).toBe(override);
  });

  it("honors a picked selectedPath when present", () => {
    expect(
      resolveActiveAcpInstance([path1, path2], { selectedPath: path2.command }),
    ).toBe(path2);
  });

  it("falls back to the first instance when selectedPath is gone", () => {
    expect(
      resolveActiveAcpInstance([path1, path2], { selectedPath: "/nope/qwen" }),
    ).toBe(path1);
  });

  it("falls back to the first instance with no preference", () => {
    expect(resolveActiveAcpInstance([path1, path2], undefined)).toBe(path1);
  });
});

describe("discoverAcpAgentInstances", () => {
  it("maps kit groups to a per-registryId view and resolves the active instance", async () => {
    const discover = vi.fn(async () => [
      group("qwen", [
        instance("/usr/bin/qwen", "path", "0.17.0"),
        instance("/opt/homebrew/bin/qwen", "path", "0.16.0"),
      ]),
      group("kimi", [instance("/Users/me/.kimi-code/bin/kimi", "fallback", "0.11.0")]),
    ]);

    const result = await discoverAcpAgentInstances({ discover });

    expect(result.get("qwen")).toEqual({
      instances: [
        { command: "/usr/bin/qwen", version: "0.17.0", source: "path" },
        { command: "/opt/homebrew/bin/qwen", version: "0.16.0", source: "path" },
      ],
      activeCommand: "/usr/bin/qwen",
    });
    expect(result.get("kimi")?.activeCommand).toBe(
      "/Users/me/.kimi-code/bin/kimi",
    );
  });

  it("passes overridePath preferences to the kit and picks the override", async () => {
    const discover = vi.fn(async () => [
      group("grok", [
        instance("/custom/grok", "override", "0.3.0"),
        instance("/usr/bin/grok", "path", "0.2.0"),
      ]),
    ]);

    const result = await discoverAcpAgentInstances({
      discover,
      preferences: { grok: { overridePath: "  /custom/grok  " } },
    });

    expect(discover).toHaveBeenCalledWith(
      expect.objectContaining({ overrides: { grok: "/custom/grok" } }),
    );
    expect(result.get("grok")?.activeCommand).toBe("/custom/grok");
  });

  it("honors a selectedPath preference for the active instance", async () => {
    const discover = vi.fn(async () => [
      group("qwen", [
        instance("/usr/bin/qwen", "path"),
        instance("/opt/homebrew/bin/qwen", "path"),
      ]),
    ]);

    const result = await discoverAcpAgentInstances({
      discover,
      preferences: { qwen: { selectedPath: "/opt/homebrew/bin/qwen" } },
    });

    expect(result.get("qwen")?.activeCommand).toBe("/opt/homebrew/bin/qwen");
    // No override → kit called without an `overrides` key.
    expect(discover).toHaveBeenCalledWith(expect.not.objectContaining({ overrides: expect.anything() }));
  });

  it("passes only enabled strategies to the kit", async () => {
    const discover = vi.fn(
      async (_options?: LocalAcpDiscoveryOptions) => [
        group("kimi", [instance("/Users/me/.kimi-code/bin/kimi", "fallback")]),
      ],
    );

    await discoverAcpAgentInstances({
      discover,
      enabledRegistryIds: ["kimi", "qwen"],
    });

    const options = discover.mock.calls[0]?.[0];
    expect(options?.strategies?.map((strategy) => strategy.id)).toEqual([
      "kimi",
      "qwen",
    ]);
  });

  it("recognizes current Qwen help without requiring the hidden ACP flag", async () => {
    const discover = vi.fn(
      async (_options?: LocalAcpDiscoveryOptions) => [],
    );

    await discoverLocalAcpAgentRecords({
      discover,
      enabledRegistryIds: ["qwen"],
    });

    const qwen = discover.mock.calls[0]?.[0]?.strategies?.[0];
    expect(qwen?.id).toBe("qwen");
    expect(qwen?.discoveryProbe.helpMatches).toBeDefined();
    expect(
      qwen?.discoveryProbe.helpMatches?.test(
        "Qwen Code - Launch an interactive CLI, use -p/--prompt",
      ),
    ).toBe(true);
  });

  it("passes a hydrated shell environment to the discovery kit", async () => {
    const discover = vi.fn(async () => []);
    const env = {
      PATH: "/opt/homebrew/bin:/usr/bin",
    };

    await discoverLocalAcpAgentRecords({
      discover,
      enabledRegistryIds: ["qwen"],
      env,
    });

    expect(discover).toHaveBeenCalledWith(
      expect.objectContaining({
        env,
      }),
    );
  });

  it("omits agents with no installed instances", async () => {
    const discover = vi.fn(async () => [group("gemini", [])]);
    const result = await discoverAcpAgentInstances({
      discover,
      bundledGrokCommand: null,
    });
    expect(result.has("gemini")).toBe(false);
  });

  it("uses the bundled Grok executable as the last fallback", async () => {
    const discover = vi.fn(async () => [
      group("grok", [instance("/usr/local/bin/grok", "path", "0.2.112")]),
    ]);

    const result = await discoverAcpAgentInstances({
      discover,
      bundledGrokCommand: "/app/resources/agents/grok/grok",
    });

    expect(result.get("grok")).toEqual({
      activeCommand: "/usr/local/bin/grok",
      instances: [
        {
          command: "/usr/local/bin/grok",
          source: "path",
          version: "0.2.112",
        },
        {
          command: "/app/resources/agents/grok/grok",
          source: "fallback",
        },
      ],
    });
  });
});

describe("discoverLocalAcpAgentRecords", () => {
  it("distinguishes the legacy Python CLI from current Kimi Code output", () => {
    expect(
      isLegacyPythonKimiCli({
        output: "kimi, version 1.46.0",
        version: "1.46.0",
      }),
    ).toBe(true);
    expect(
      isLegacyPythonKimiCli({
        output: "kimi-cli version: 1.49.0\npython version: 3.13.7",
        version: "1.49.0",
      }),
    ).toBe(true);
    expect(
      isLegacyPythonKimiCli({
        output: "kimi-code 0.30.0",
        version: "0.30.0",
      }),
    ).toBe(false);
    expect(
      isLegacyPythonKimiCli({
        output: "0.34.0",
        version: "0.34.0",
      }),
    ).toBe(false);
  });

  it("ignores legacy Kimi on PATH and selects a side-by-side Kimi Code install", async () => {
    const legacy = "/Users/me/.local/bin/kimi";
    const current = "/Users/me/.kimi-code/bin/kimi";
    const discover = vi.fn(async () => [
      group("kimi", [
        instance(legacy, "path", "1.46.0"),
        instance(current, "fallback", "0.30.0"),
      ]),
    ]);

    const [record, ...rest] = await discoverLocalAcpAgentRecords({
      discover,
      readVersionOutput: async (command) =>
        command === legacy ? "kimi, version 1.46.0" : "kimi-code 0.30.0",
    });

    expect(rest).toHaveLength(0);
    expect(record).toMatchObject({
      installStatus: "installed",
      version: "0.30.0",
      activeCommand: current,
      instances: [expect.objectContaining({ command: current })],
      incompatibleInstances: [expect.objectContaining({ command: legacy })],
      launchDescriptor: { command: current },
    });
  });

  it("persists a non-launchable diagnostic when only legacy Python kimi-cli exists", async () => {
    const legacy = "/Users/me/.local/bin/kimi";
    const discover = vi.fn(async () => [
      group("kimi", [instance(legacy, "path", "1.46.0")]),
    ]);

    const [record, ...rest] = await discoverLocalAcpAgentRecords({
      discover,
      now: () => 4242,
      readVersionOutput: async () => "kimi, version 1.46.0",
    });

    expect(rest).toHaveLength(0);
    expect(record).toMatchObject({
      backendId: "acp:kimi",
      installStatus: "unavailable",
      installedAt: 4242,
      instances: [],
      incompatibleInstances: [expect.objectContaining({ command: legacy })],
      lastError: expect.stringContaining(
        "Legacy Python kimi-cli v1.46.0 was found",
      ),
    });
    expect(record).not.toHaveProperty("launchDescriptor");
    expect(record).not.toHaveProperty("runtimeCapabilities");
  });

  it("builds installed-agent records with a resolved launch descriptor", async () => {
    const discover = vi.fn(async () => [
      group("qwen", [
        instance("/usr/bin/qwen", "path", "0.17.0"),
        instance("/opt/homebrew/bin/qwen", "path", "0.16.0"),
      ]),
    ]);

    const [record, ...rest] = await discoverLocalAcpAgentRecords({
      discover,
      now: () => 4242,
      preferences: { qwen: { selectedPath: "/opt/homebrew/bin/qwen" } },
    });

    expect(rest).toHaveLength(0);
    expect(record).toMatchObject({
      backendId: "acp:qwen",
      registryId: "qwen",
      installStatus: "installed",
      version: "0.16.0", // the picked instance
      activeCommand: "/opt/homebrew/bin/qwen",
      installedAt: 4242,
      launchDescriptor: {
        command: "/opt/homebrew/bin/qwen", // resolved active feeds the spawn
        args: ["--acp"],
      },
    });
    expect(record?.instances).toEqual([
      { command: "/usr/bin/qwen", version: "0.17.0", source: "path" },
      { command: "/opt/homebrew/bin/qwen", version: "0.16.0", source: "path" },
    ]);
  });

  it("omits agents with no installed instances", async () => {
    const discover = vi.fn(async () => [group("gemini", [])]);
    const records = await discoverLocalAcpAgentRecords({
      discover,
      bundledGrokCommand: null,
    });
    expect(records).toEqual([]);
  });

  it("passes an empty strategy list when every provider is disabled", async () => {
    const discover = vi.fn(async () => []);
    await discoverLocalAcpAgentRecords({
      discover,
      enabledRegistryIds: [],
    });
    expect(discover).toHaveBeenCalledWith(expect.objectContaining({ strategies: [] }));
  });

  it("surfaces bundled Grok when no system installation exists", async () => {
    const discover = vi.fn(async () => []);
    const bundledGrokCommand = "/app/resources/agents/grok/grok";
    const readVersionOutput = vi.fn(async () =>
      "grok 1.0.0-pwragent.1 (297a0c4) [stable]"
    );

    const [record, ...rest] = await discoverLocalAcpAgentRecords({
      discover,
      bundledGrokCommand,
      now: () => 4242,
      enabledRegistryIds: ["grok"],
      readVersionOutput,
    });

    expect(rest).toHaveLength(0);
    expect(record).toMatchObject({
      backendId: "acp:grok",
      registryId: "grok",
      version: "1.0.0-pwragent.1",
      activeCommand: bundledGrokCommand,
      launchDescriptor: {
        command: bundledGrokCommand,
        args: ["agent", "stdio"],
        env: {
          GROK_INSTALLER: "pwragent",
          NO_COLOR: "1",
        },
      },
      instances: [
        {
          command: bundledGrokCommand,
          source: "fallback",
          version: "1.0.0-pwragent.1",
        },
      ],
      registryAgent: {
        version: "1.0.0-pwragent.1",
      },
    });
    expect(readVersionOutput).toHaveBeenCalledWith(
      bundledGrokCommand,
      expect.any(Object),
    );
  });

  it("allows an explicit Grok override to win over the bundle", async () => {
    const discover = vi.fn(async () => [
      group("grok", [instance("/custom/grok", "override", "0.3.0")]),
    ]);

    const [record] = await discoverLocalAcpAgentRecords({
      discover,
      bundledGrokCommand: "/app/resources/agents/grok/grok",
      preferences: { grok: { overridePath: "/custom/grok" } },
    });

    expect(record?.activeCommand).toBe("/custom/grok");
    expect(record?.launchDescriptor?.env).toEqual({ NO_COLOR: "1" });
  });
});

describe("resolveBundledGrokCommand", () => {
  it("resolves the packaged Unix executable", () => {
    const exists = vi.fn(() => true);
    const command = resolveBundledGrokCommand({
      resourcesPath: "/Applications/PwrAgent.app/Contents/Resources",
      platform: "darwin",
      exists,
    });

    expect(command).toBe(
      "/Applications/PwrAgent.app/Contents/Resources/agents/grok/grok",
    );
    expect(exists).toHaveBeenCalledWith(command);
  });

  it("uses Windows path semantics and the executable suffix", () => {
    const exists = vi.fn(() => true);
    const command = resolveBundledGrokCommand({
      resourcesPath: "C:\\PwrAgent\\resources",
      platform: "win32",
      exists,
    });

    expect(command).toBe("C:\\PwrAgent\\resources\\agents\\grok\\grok.exe");
    expect(exists).toHaveBeenCalledWith(command);
  });
});
