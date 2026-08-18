import { describe, expect, it, vi } from "vitest";
import type {
  AcpAgentInstance,
  AcpRejectedAgentInstance,
} from "@pwragent/shared";
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

function group(
  strategyId: string,
  instances: AcpAgentInstance[],
  rejectedInstances?: AcpRejectedAgentInstance[],
) {
  return {
    strategyId,
    backendId: `acp:${strategyId}`,
    name: strategyId,
    args: ["--acp"],
    env: {},
    instances,
    ...(rejectedInstances !== undefined ? { rejectedInstances } : {}),
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

    const result = await discoverAcpAgentInstances({
      discover,
      readVersionOutput: async () => "kimi-code 0.11.0",
    });

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
      readVersionOutput: async () => "kimi-code 0.30.0",
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
      readVersionOutput: async () => undefined,
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

  it("prefers a managed Grok build after an explicit override and before PATH", async () => {
    const managed = "/pwragent/agents/grok/versions/latest/grok";
    const discover = vi.fn(async () => [
      group("grok", [
        instance("/custom/grok", "override", "3.0.0"),
        instance("/usr/local/bin/grok", "path", "1.0.0"),
      ]),
    ]);

    const result = await discoverAcpAgentInstances({
      discover,
      managedGrok: { enabled: true, checkMode: "once-per-process" },
      resolveManagedGrokCommand: async () => managed,
      readVersionOutput: async (command) =>
        command === managed ? "grok 2.0.0-pwragent.1" : undefined,
    });

    expect(result.get("grok")?.instances.map((entry) => entry.command)).toEqual([
      "/custom/grok",
      managed,
      "/usr/local/bin/grok",
    ]);
    expect(result.get("grok")?.activeCommand).toBe("/custom/grok");
  });

  it("does not resolve a managed Grok build when Grok is disabled", async () => {
    const resolveManagedGrokCommand = vi.fn(async () => "/managed/grok");

    await discoverAcpAgentInstances({
      discover: async () => [],
      enabledRegistryIds: ["qwen"],
      managedGrok: { enabled: true },
      resolveManagedGrokCommand,
    });

    expect(resolveManagedGrokCommand).not.toHaveBeenCalled();
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

  it("preserves rejected candidates alongside a legacy Kimi diagnostic", async () => {
    const legacy = "/Users/me/.local/bin/kimi";
    const rejected = "/Users/me/bin/not-kimi";
    const discover = vi.fn(async () => [
      group(
        "kimi",
        [instance(legacy, "path", "1.46.0")],
        [
          {
            command: rejected,
            source: "override",
            reason: "acp-probe-failed",
          },
        ],
      ),
    ]);

    const [record, ...rest] = await discoverLocalAcpAgentRecords({
      discover,
      now: () => 4242,
      readVersionOutput: async () => "kimi, version 1.46.0",
    });

    expect(rest).toHaveLength(0);
    expect(record).toMatchObject({
      installStatus: "unavailable",
      incompatibleInstances: [expect.objectContaining({ command: legacy })],
      rejectedInstances: [
        {
          command: rejected,
          source: "override",
          reason: "acp-probe-failed",
        },
      ],
    });
    expect(record).not.toHaveProperty("launchDescriptor");
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

  it("retains a detected CLI that failed ACP verification as unavailable", async () => {
    const rejectedPath = "/usr/local/bin/qwen";
    const discover = vi.fn(async () => [
      group("qwen", [], [
        {
          command: rejectedPath,
          version: "0.21.0",
          source: "path",
          reason: "acp-probe-failed",
        },
      ]),
    ]);

    const [record, ...rest] = await discoverLocalAcpAgentRecords({
      discover,
      now: () => 4242,
    });

    expect(rest).toHaveLength(0);
    expect(discover).toHaveBeenCalledWith(
      expect.objectContaining({ includeRejectedCandidates: true }),
    );
    expect(record).toMatchObject({
      backendId: "acp:qwen",
      installStatus: "unavailable",
      installedAt: 4242,
      instances: [],
      rejectedInstances: [
        {
          command: rejectedPath,
          version: "0.21.0",
          source: "path",
          reason: "acp-probe-failed",
        },
      ],
      lastError: `${rejectedPath} was found, but PwrAgent could not verify ACP support.`,
    });
    expect(record).not.toHaveProperty("launchDescriptor");
    expect(record).not.toHaveProperty("runtimeCapabilities");
  });

  it("retains a timed-out ACP verification as retryable", async () => {
    const timedOutPath = "/usr/local/bin/qwen";
    const discover = vi.fn(async () => [
      group("qwen", [], [
        {
          command: timedOutPath,
          version: "0.21.0",
          source: "path",
          reason: "probe-timed-out",
        },
      ]),
    ]);

    const [record, ...rest] = await discoverLocalAcpAgentRecords({
      discover,
      now: () => 4242,
    });

    expect(rest).toHaveLength(0);
    expect(record).toMatchObject({
      backendId: "acp:qwen",
      installStatus: "unavailable",
      instances: [],
      rejectedInstances: [
        {
          command: timedOutPath,
          version: "0.21.0",
          source: "path",
          reason: "probe-timed-out",
        },
      ],
      lastError: `${timedOutPath} was found, but its ACP verification timed out. Refresh to try again.`,
    });
    expect(record).not.toHaveProperty("launchDescriptor");
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
      readVersionOutput: async () => undefined,
    });

    expect(record?.activeCommand).toBe("/custom/grok");
    expect(record?.launchDescriptor?.env).toEqual({ NO_COLOR: "1" });
  });

  it("marks managed Grok launches as PwrAgent-installed", async () => {
    const managedGrokCommand = "/pwragent/agents/grok/versions/latest/grok";
    const [record] = await discoverLocalAcpAgentRecords({
      discover: async () => [
        group("grok", [instance("/usr/local/bin/grok", "path", "1.0.0")]),
      ],
      enabledRegistryIds: ["grok"],
      managedGrok: { enabled: true },
      resolveManagedGrokCommand: async () => managedGrokCommand,
      readVersionOutput: async () => "grok 2.0.0-pwragent.1",
    });

    expect(record).toMatchObject({
      activeCommand: managedGrokCommand,
      version: "2.0.0-pwragent.1",
      launchDescriptor: {
        command: managedGrokCommand,
        env: { GROK_INSTALLER: "pwragent", NO_COLOR: "1" },
      },
    });
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
