import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { _electron as electron } from "@playwright/test";
import { afterEach, expect, it, vi } from "vitest";
import { launchElectronApp } from "../../../e2e/fixtures/electron-app";
import { isPathWithin } from "../../shared/path-within";
import { resolveE2eAcpDiscoveryOptions } from "../acp/acp-e2e-discovery";
import { discoverLocalAcpAgentRecords } from "../acp/acp-instance-discovery";
import { createLocalAcpAgentDiscovery } from "../app-server/acp-backend-adapter";
import { normalizeConfigDomains } from "../settings/config-store/config-domains";
import {
  ACP_AGENTS_ANTIGRAVITY_CLI_PATH_ENV,
  ACP_AGENTS_GEMINI_CLI_PATH_ENV,
  E2E_ACP_DISCOVERY_ROOT_ENV,
} from "../settings/desktop-settings-env";

const probe = vi.hoisted(() => vi.fn());
vi.mock("@pwrdrvr/agent-acp/discovery", async (importOriginal) => {
  const kit = await importOriginal<typeof import("@pwrdrvr/agent-acp/discovery")>();
  return {
    ...kit,
    discoverLocalAcpAgentInstances: (options: Parameters<typeof kit.discoverLocalAcpAgentInstances>[0]) =>
      kit.discoverLocalAcpAgentInstances({
        ...options,
        probe: (command, args) => probe(command, args, options?.env),
      }),
  };
});

const stoppedBeforeLaunch = new Error("ACP discovery oracle stops before Electron launch");
const fixturePath = path.resolve(import.meta.dirname, "../../../e2e/fixtures/smoke/replay.fixture.json");

afterEach(() => {
  probe.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function stubWindowsProcessEnv(env: NodeJS.ProcessEnv): void {
  vi.stubGlobal("process", Object.create(process, {
    env: { value: env },
    platform: { value: "win32" },
  }));
}

it("only probes fixture-owned Windows batch shims in PATHEXT order", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "replay-acp-windows-"));
  try {
    const fixtureRoot = path.join(root, "fixture");
    const bin = path.join(fixtureRoot, ".local", "bin");
    const cmd = path.join(bin, "gemini.cmd");
    const bat = path.join(bin, "gemini.bat");
    await mkdir(bin, { recursive: true });
    await Promise.all([cmd, bat, path.join(root, "gemini.cmd")].map((file) =>
      writeFile(file, "@echo off\r\nexit /b 0\r\n"),
    ));
    stubWindowsProcessEnv({
      PWRAGENT_E2E: "1",
      [E2E_ACP_DISCOVERY_ROOT_ENV]: fixtureRoot,
      PATH: root,
      PathExt: ".cmd;.bat",
    });
    // Discovery must pass the absolute shim, which controls the transport's
    // choice of cmd.exe. Stub the version and help probes at that boundary.
    probe.mockImplementation(async (command: string, args: string[]) => {
      if (command !== cmd && command !== bat) throw new Error("Not a fixture shim");
      return { stdout: args[0] === "--version" ? "1.2.3" : "Use --acp " };
    });

    const agents = await discoverLocalAcpAgentRecords({
      ...resolveE2eAcpDiscoveryOptions(false),
      enabledRegistryIds: ["gemini"],
    });

    expect([...new Set(probe.mock.calls.map(([command]) => command))]).toEqual([cmd, bat]);
    expect(agents).toMatchObject([{ installStatus: "installed", activeCommand: cmd }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each(["inherited replay flag", "per-launch replay flag", "per-launch discovery root"] as const)(
  "isolates Windows replay launches with a mixed-case %s",
  async (source) => {
    const homeRoot = await mkdtemp(path.join(os.tmpdir(), "replay-acp-windows-env-"));
    try {
      const replayKey = "PwRaGeNt_RePlAy_FiXtUrE_PaTh";
      const explicitRoot = path.join(homeRoot, "explicit-root");
      stubWindowsProcessEnv({
        ...(source === "inherited replay flag" ? { [replayKey]: fixturePath } : {}),
        [E2E_ACP_DISCOVERY_ROOT_ENV.toLowerCase()]: path.join(homeRoot, "ambient-root"),
        [ACP_AGENTS_GEMINI_CLI_PATH_ENV.toLowerCase()]: path.join(homeRoot, "ambient.cmd"),
      });
      const launch = vi.spyOn(electron, "launch").mockRejectedValue(stoppedBeforeLaunch);

      await expect(launchElectronApp({
        homeRoot,
        ...(source === "per-launch discovery root" ? { fixturePath } : {}),
        env: {
          ...(source === "per-launch replay flag" ? { [replayKey]: fixturePath } : {}),
          ...(source === "per-launch discovery root" ? { [E2E_ACP_DISCOVERY_ROOT_ENV.toLowerCase()]: explicitRoot } : {}),
        },
      })).rejects.toBe(stoppedBeforeLaunch);

      const env = launch.mock.lastCall![0]!.env!;
      expect(env.PWRAGENT_REPLAY_FIXTURE_PATH).toBe(fixturePath);
      expect(env[E2E_ACP_DISCOVERY_ROOT_ENV]).toBe(source === "per-launch discovery root"
        ? explicitRoot
        : path.join(homeRoot, "replay-acp-discovery"));
      expect(Object.keys(env).filter((key) => key.toUpperCase() === E2E_ACP_DISCOVERY_ROOT_ENV))
        .toEqual([E2E_ACP_DISCOVERY_ROOT_ENV]);
      expect(Object.keys(env).some((key) => key.toUpperCase() === ACP_AGENTS_GEMINI_CLI_PATH_ENV)).toBe(false);
    } finally {
      await rm(homeRoot, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform === "win32").each([
  "ambient PATH",
  "ambient CLI override",
  "explicit CLI override",
  "explicit discovery root",
] as const)(
  "confines replay ACP discovery with a sentinel from %s",
  async (source) => {
    const ambientRoot = await mkdtemp(path.join(os.tmpdir(), "replay-acp-ambient-"));
    const homeRoot = await mkdtemp(path.join(os.tmpdir(), "replay-acp-home-"));
    try {
      const explicitRoot = path.join(homeRoot, "explicit-acp-discovery");
      const sentinelBin = source === "explicit discovery root"
        ? path.join(explicitRoot, ".local", "bin")
        : ambientRoot;
      const sentinel = path.join(sentinelBin, "agy");
      await mkdir(sentinelBin, { recursive: true });
      await writeFile(sentinel, [
        "#!/usr/bin/env sh",
        'case "$*" in',
        "  --version) echo 'agy 9.8.7' ;;",
        "  'acp --help') echo 'Usage: agy acp [flags]' ;;",
        "  *) exit 2 ;;",
        "esac",
        "",
      ].join("\n"), { mode: 0o755 });
      probe.mockImplementation(async (command: string, args: string[], env: NodeJS.ProcessEnv) => {
        if (command !== sentinel) throw new Error("The oracle can only execute its sentinel");
        const result = await promisify(execFile)(sentinel, args, { env: { PATH: env.PATH } });
        return { ...result, exitCode: 0 };
      });
      const ambientPath = [source === "ambient PATH" ? ambientRoot : homeRoot, "/bin"].join(path.delimiter);
      const lowerCaseOverride = ACP_AGENTS_ANTIGRAVITY_CLI_PATH_ENV.toLowerCase();
      vi.stubEnv("PATH", ambientPath);
      vi.stubEnv(ACP_AGENTS_ANTIGRAVITY_CLI_PATH_ENV, source === "ambient CLI override" ? sentinel : undefined);
      vi.stubEnv(lowerCaseOverride, sentinel);
      vi.stubEnv(E2E_ACP_DISCOVERY_ROOT_ENV, ambientRoot);
      const launch = vi.spyOn(electron, "launch").mockRejectedValue(stoppedBeforeLaunch);
      await expect(launchElectronApp({
        fixturePath,
        homeRoot,
        ...(source === "explicit CLI override" ? { env: { [ACP_AGENTS_ANTIGRAVITY_CLI_PATH_ENV]: sentinel } } : {}),
        ...(source === "explicit discovery root" ? { env: { [E2E_ACP_DISCOVERY_ROOT_ENV]: explicitRoot } } : {}),
      })).rejects.toBe(stoppedBeforeLaunch);
      const env = launch.mock.lastCall![0]!.env!;
      for (const name of ["HOME", "PATH", "PWRAGENT_E2E", ACP_AGENTS_ANTIGRAVITY_CLI_PATH_ENV, E2E_ACP_DISCOVERY_ROOT_ENV]) {
        vi.stubEnv(name, env[name]);
      }
      const providers = normalizeConfigDomains({ config: { acpAgents: {
        antigravity: { enabled: true },
        gemini: { enabled: false },
        grok: { enabled: false },
        kimi: { enabled: false },
        qwen: { enabled: false },
      } } }).providers;
      const discover = createLocalAcpAgentDiscovery({
        configStore: { read: (() => providers) as never },
        resolveEnv: async () => env,
      });

      const agents = await discover();

      // Even nonexistent candidates must stay inside the discovery root.
      // Only a per-launch override can deliberately select an outside path.
      const expectedRoot = source === "explicit discovery root"
        ? explicitRoot
        : path.join(homeRoot, "replay-acp-discovery");
      const commands = [...new Set(probe.mock.calls.map(([command]) => command as string))];
      expect(agents.filter(({ installStatus }) => installStatus === "installed").map(({ activeCommand }) => activeCommand))
        .toEqual(source.startsWith("explicit") ? [sentinel] : []);
      expect(commands.length).toBeGreaterThan(0);
      expect(commands.filter((command) => !isPathWithin(expectedRoot, command)))
        .toEqual(source === "explicit CLI override" ? [sentinel] : []);
      expect(env[E2E_ACP_DISCOVERY_ROOT_ENV]).toBe(expectedRoot);
      expect(env[lowerCaseOverride]).toBeUndefined();
      expect(env.PATH).toBe(ambientPath);
    } finally {
      await Promise.all([homeRoot, ambientRoot].map((root) => rm(root, { recursive: true, force: true })));
    }
  },
);
