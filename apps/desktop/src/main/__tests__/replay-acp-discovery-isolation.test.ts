import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { _electron as electron } from "@playwright/test";
import { afterEach, expect, it, vi } from "vitest";
import { launchElectronApp } from "../../../e2e/fixtures/electron-app";
import { isPathWithin } from "../../shared/path-within";
import { createLocalAcpAgentDiscovery } from "../app-server/acp-backend-adapter";
import { normalizeConfigDomains } from "../settings/config-store/config-domains";
import {
  ACP_AGENTS_ANTIGRAVITY_CLI_PATH_ENV,
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
});

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
