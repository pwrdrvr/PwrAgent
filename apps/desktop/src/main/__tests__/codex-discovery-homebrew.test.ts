import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverCodexCommands } from "@pwrdrvr/codex-discovery";
import { CodexDiscoveryCoordinator } from "../codex-discovery-coordinator";

// Homebrew's Unix layout, rooted entirely in a disposable fixture. The real
// discovery implementation must never scan the host's application installs.
describe.skipIf(process.platform === "win32")("Codex npm launch under a Homebrew prefix", () => {
  let root: string;
  let command: string;
  let nativeCommand: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "pwragent-codex-homebrew-"));
    const prefix = path.join(root, "opt", "homebrew");
    command = path.join(prefix, "bin", "codex");
    nativeCommand = path.join(
      prefix, "lib", "node_modules", "@openai", "codex", "node_modules",
      "@openai", "codex-darwin-arm64", "vendor", "aarch64-apple-darwin",
      "codex", "codex",
    );
    env = { PATH: path.dirname(command) };
    // Reproduce the npm wrapper's nested spawn, rather than mocking an ENOENT
    // on the wrapper itself. The wrapper exists and is executable; its native
    // payload is missing, so --version exits 1 with ENOENT on stderr.
    await writeNodeCommand(command, [
      'const { spawn } = require("node:child_process");',
      `const child = spawn(${JSON.stringify(nativeCommand)}, process.argv.slice(2), { stdio: "inherit" });`,
      'child.on("error", (error) => { console.error(error); process.exit(1); });',
      'child.on("exit", (code) => process.exit(code ?? 1));',
    ].join("\n"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function coordinator(installCandidatePaths: string[] = []): CodexDiscoveryCoordinator {
    return new CodexDiscoveryCoordinator({
      discover: (params) => discoverCodexCommands({
        ...params,
        homeDir: root,
        installCandidatePaths,
      }),
      platform: "darwin",
      resolveEnv: async () => env,
    });
  }

  it("rejects an executable npm wrapper whose native payload is missing", async () => {
    const snapshot = await coordinator().discover();

    expect(snapshot.selectedCommand).toBeUndefined();
    expect(snapshot.candidates).toEqual([
      expect.objectContaining({
        command,
        executable: false,
        selected: false,
        versionProbeOutcome: "failed",
        failureReason: expect.stringContaining(`spawn ${nativeCommand} ENOENT`),
      }),
    ]);
  });

  it("preserves the native ENOENT diagnostic when resolving a broken npm install", async () => {
    await expect(coordinator().resolve()).rejects.toThrow(
      `spawn ${nativeCommand} ENOENT`,
    );
  });

  it("uses a validated fallback when the npm wrapper is broken", async () => {
    const fallback = path.join(root, "standalone", "codex");
    await writeNodeCommand(fallback, 'console.log("codex-cli 0.160.0");');
    const discovery = coordinator([fallback]);

    await expect(discovery.resolve()).resolves.toMatchObject({
      command: fallback,
      source: "application",
      version: "0.160.0",
    });
    const snapshot = await discovery.discover();
    expect(snapshot.candidates.find((candidate) => candidate.command === command))
      .toMatchObject({
        selected: false,
        versionFailureReason: expect.stringContaining(`spawn ${nativeCommand} ENOENT`),
      });
  });
});

async function writeNodeCommand(command: string, source: string): Promise<void> {
  const script = `${command}.cjs`;
  await mkdir(path.dirname(command), { recursive: true });
  await writeFile(script, source);
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(command, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`);
  await chmod(command, 0o755);
}
