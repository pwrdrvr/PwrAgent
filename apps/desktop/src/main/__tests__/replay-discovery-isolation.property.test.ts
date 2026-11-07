import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "@playwright/test";
import { CODEX_COMMAND_ENV as DISCOVERY_COMMAND_ENV, compareCodexCliVersions, discoverCommands } from "@pwrdrvr/codex-discovery";
import { CODEX_MINIMUM_RECOMMENDED_VERSION, parseCodexVersionCore } from "@pwragent/shared";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { launchElectronApp } from "../../../e2e/fixtures/electron-app";
import { buildCodexVersionAdvisory } from "../settings/codex-version-advisory";
import { applyDesktopSettingsPatch } from "../settings/desktop-config";

const roots: string[] = [];
const stoppedBeforeLaunch = new Error("Discovery oracle stops before Electron launch");
const fixturePath = path.resolve(import.meta.dirname, "../../../e2e/fixtures/smoke/replay.fixture.json");

async function root() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "replay discovery "));
  roots.push(directory);
  return directory;
}

async function ambientCommand(directory: string, version: string) {
  const command = path.join(directory, process.platform === "win32" ? "codex.cmd" : "codex");
  await writeFile(command, process.platform === "win32"
    ? `@echo off\r\necho codex-cli ${version}\r\nexit /b 0\r\n`
    : `#!/bin/sh\nprintf '%s\\n' 'codex-cli ${version}'\n`);
  await chmod(command, 0o755);
  return command;
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Replay discovery ownership", () => {
  it("selects fixture-owned discovery regardless of the ambient CLI version", async () => {
    const launch = vi.spyOn(electron, "launch").mockRejectedValue(stoppedBeforeLaunch);
    await fc.assert(fc.asyncProperty(
      fc.tuple(fc.integer({ min: 0, max: 2 }), fc.integer({ min: 125, max: 999 })),
      async ([major, minor]) => {
        const ambient = await ambientCommand(await root(), `${major}.${minor}.0`);
        const homeRoot = await root();
        vi.stubEnv("PWRAGENT_CODEX_COMMAND", ambient);
        vi.stubEnv(DISCOVERY_COMMAND_ENV, ambient);
        await expect(launchElectronApp({ fixturePath, homeRoot })).rejects.toBe(stoppedBeforeLaunch);
        const env = launch.mock.lastCall![0]!.env!;
        const selectedCommand = env.PWRAGENT_CODEX_COMMAND!;
        // The filesystem owner, rather than a version string in the test,
        // distinguishes an isolated fixture from the runner's executable.
        expect(path.relative(homeRoot, selectedCommand)).not.toMatch(/^\.\.(?:[/\\]|$)/);
        // Use the package's discovery engine with absolute fixture candidates;
        // its Codex convenience wrapper also probes the host's bare PATH CLI.
        const discovery = await discoverCommands({
          fixedCandidates: [
            { command: env[DISCOVERY_COMMAND_ENV], source: "env" },
            { command: selectedCommand, source: "config" },
          ],
          autoCandidates: [{ command: ambient, source: "application" }],
          env,
          parseVersion: (output) => parseCodexVersionCore(output)?.join("."),
          compareVersions: compareCodexCliVersions,
        });
        const selected = discovery.candidates.find((candidate) => candidate.selected)!;
        expect(selected.command).toBe(selectedCommand);
        expect(selected.version).toContain(CODEX_MINIMUM_RECOMMENDED_VERSION);
        expect(await buildCodexVersionAdvisory({
          command: selected.command,
          version: selected.version,
        })).toBeUndefined();
      },
    ), { numRuns: 8, examples: [[[0, 125]]] });
  });

  it("preserves explicit CLI fixtures and host-discovery scenarios", async () => {
    const launch = vi.spyOn(electron, "launch").mockRejectedValue(stoppedBeforeLaunch);
    await fc.assert(fc.asyncProperty(fc.integer({ min: 125, max: 158 }), async (minor) => {
      const ambient = await ambientCommand(await root(), "9.999.0");
      const configured = await ambientCommand(await root(), `0.${minor}.0`);
      vi.stubEnv("PWRAGENT_CODEX_COMMAND", ambient);
      vi.stubEnv(DISCOVERY_COMMAND_ENV, ambient);
      for (const mode of ["env", "sdk", "config", "path", "host", "non-replay"] as const) {
        const homeRoot = await root();
        await expect(launchElectronApp({
          homeRoot,
          ...(mode === "non-replay" ? { requiresReplayDriver: false } : { fixturePath }),
          ...(mode === "host" ? { replayCodexDiscovery: "host" } : {}),
          ...(mode === "env" ? { env: { PWRAGENT_CODEX_COMMAND: configured } } : {}),
          ...(mode === "sdk" ? { env: { [DISCOVERY_COMMAND_ENV]: configured } } : {}),
          ...(mode === "path" ? { env: { PWRAGENT_CODEX_COMMAND: undefined } } : {}),
          ...(mode === "config" ? {
            preLaunchHook: async () => {
              applyDesktopSettingsPatch(path.join(homeRoot, ".pwragent/profiles/default/config.toml"), {
                models: { codex: { path: configured } },
              });
            },
          } : {}),
        })).rejects.toBe(stoppedBeforeLaunch);
        const env = launch.mock.lastCall![0]!.env!;
        expect(env.PWRAGENT_CODEX_COMMAND).toBe(
          mode === "env" ? configured
            : mode === "config" || mode === "path" || mode === "sdk" ? undefined : ambient,
        );
        expect(env[DISCOVERY_COMMAND_ENV]).toBe(
          mode === "sdk" ? configured
            : mode === "host" || mode === "non-replay" ? ambient : undefined,
        );
      }
      // Isolation must not suppress an advisory for an explicitly selected old CLI.
      expect(await buildCodexVersionAdvisory({
        command: configured,
        version: `0.${minor}.0`,
      })).toMatchObject({ version: `0.${minor}.0` });
    }), { numRuns: 4, examples: [[125]] });
  });
});
