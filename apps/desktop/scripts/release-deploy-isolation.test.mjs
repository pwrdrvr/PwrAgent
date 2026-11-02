import { spawnSync } from "node:child_process";
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

const { packageManager } = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
const pinnedPnpmVersion = packageManager.match(/^pnpm@([^+]+)/)[1];

function requirePinnedNativePnpm(pnpmCli, cwd, { platform = process.platform, run = spawnSync } = {}) {
  const fail = (reason) => {
    throw new Error(`Run deployment isolation tests through pnpm test: ${reason}`);
  };
  if (!pnpmCli || !isAbsolute(pnpmCli) || !/^pnpm(?:-native)?(?:\.exe)?$/.test(basename(pnpmCli))) {
    fail("npm_execpath must name an absolute native pnpm executable");
  }

  // pnpm 12.13 installs the native binary as pnpm (pnpm.exe on Windows),
  // replacing a script placeholder. A filename alone cannot distinguish them.
  const header = Buffer.alloc(4);
  try {
    const fd = openSync(pnpmCli, "r");
    try {
      readSync(fd, header, 0, header.length, 0);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    fail(`cannot read ${pnpmCli}: ${error.message}`);
  }
  const magic = header.toString("hex");
  const native = platform === "win32"
    ? magic.startsWith("4d5a")
    : platform === "darwin"
      ? ["feedface", "cefaedfe", "feedfacf", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"].includes(magic)
      : platform === "linux" && magic === "7f454c46";
  if (!native) {
    fail(`${pnpmCli} is not a native ${platform} executable`);
  }

  // The empty fixture cwd has no packageManager pin that could select a
  // different pnpm. Probe and deploy with this exact executable, without a shell.
  const version = run(pnpmCli, ["--version"], { cwd, encoding: "utf8", shell: false, timeout: 10_000 });
  if (version.error || version.status !== 0 || version.stdout?.trim() !== pinnedPnpmVersion) {
    fail(`expected pnpm ${pinnedPnpmVersion} at ${pnpmCli}; ${version.error?.message ?? version.stderr ?? ""} ${version.stdout ?? ""}`);
  }
  return pnpmCli;
}

describe("deployment pnpm executable guard", () => {
  const roots = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function fixture(name, content) {
    const root = mkdtempSync(join(tmpdir(), "pwragent-pnpm-guard-"));
    roots.push(root);
    const cli = join(root, name);
    writeFileSync(cli, content);
    return { root, cli };
  }

  it.each([
    ["linux", "pnpm", "7f454c46"],
    ["linux", "pnpm-native", "7f454c46"],
    ["win32", "pnpm.exe", "4d5a9000"],
    ["win32", "pnpm", "4d5a9000"],
    ["win32", "pnpm-native.exe", "4d5a9000"],
    ["darwin", "pnpm", "cffaedfe"],
    ["darwin", "pnpm-native", "cffaedfe"],
    ["darwin", "pnpm", "cafebabe"],
  ])("accepts native %s %s with the pinned version (%s)", (platform, name, magic) => {
    const { root, cli } = fixture(name, Buffer.from(magic, "hex"));
    const run = vi.fn(() => ({ status: 0, stdout: `${pinnedPnpmVersion}\n` }));
    expect(requirePinnedNativePnpm(cli, root, { platform, run })).toBe(cli);
    expect(run).toHaveBeenCalledExactlyOnceWith(cli, ["--version"], {
      cwd: root, encoding: "utf8", shell: false, timeout: 10_000,
    });
  });

  it.each([
    ["pnpm.cmd", "@echo off\r\n"],
    ["pnpm.ps1", "#!/usr/bin/env pwsh\n"],
    ["pnpm.cjs", "#!/usr/bin/env node\n"],
    ["pnpm.mjs", "#!/usr/bin/env node\n"],
    ["pnpm", "#!/bin/sh\n"],
    ["pnpm", "# pnpm's native binary placeholder\n"],
    ["pnpm-native", "#!/usr/bin/env node\n"],
    ["pnpm.exe", "@echo off\r\n"],
    ["pnpm", ""],
    ["not-pnpm-native", Buffer.from("7f454c46", "hex")],
  ])("rejects wrappers and non-native files before execution: %s (case %#)", (name, content) => {
    const { root, cli } = fixture(name, content);
    const run = vi.fn();
    expect(() => requirePinnedNativePnpm(cli, root, { run })).toThrow("Run deployment isolation tests through pnpm test");
    expect(run).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "pnpm", "./pnpm-native"])("rejects missing or relative npm_execpath: %s", (cli) => {
    expect(() => requirePinnedNativePnpm(cli, tmpdir())).toThrow("absolute native pnpm");
  });

  it.each([
    ["linux", "4d5a9000"],
    ["win32", "7f454c46"],
    ["darwin", "7f454c46"],
  ])("rejects another platform's binary before execution: %s (%s)", (platform, magic) => {
    const { root, cli } = fixture("pnpm", Buffer.from(magic, "hex"));
    const run = vi.fn();
    expect(() => requirePinnedNativePnpm(cli, root, { platform, run })).toThrow(`not a native ${platform} executable`);
    expect(run).not.toHaveBeenCalled();
  });

  it("reports an unreadable executable before execution", () => {
    const { root, cli } = fixture("pnpm", "");
    rmSync(cli);
    const run = vi.fn();
    expect(() => requirePinnedNativePnpm(cli, root, { run })).toThrow(`cannot read ${cli}`);
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    { status: 0, stdout: "0.0.0\n" },
    { status: 1, stdout: `${pinnedPnpmVersion}\n`, stderr: "failed" },
    { status: null, stdout: "", error: new Error("spawn failed") },
    { status: null, stdout: "", signal: "SIGTERM" },
  ])("rejects a wrong version or failed native probe: %j", (result) => {
    const { root, cli } = fixture("pnpm", Buffer.from("7f454c46", "hex"));
    expect(() => requirePinnedNativePnpm(cli, root, { platform: "linux", run: () => result }))
      .toThrow(`expected pnpm ${pinnedPnpmVersion}`);
  });
});

it("keeps both release stages out of repeated paired pnpm deployments", () => {
  const root = mkdtempSync(join(tmpdir(), "pwragent-deploy-isolation-"));
  try {
    const pnpmCli = requirePinnedNativePnpm(process.env.npm_execpath, root);
    const desktop = join(root, "desktop");
    mkdirSync(desktop);
    writeFileSync(join(root, "package.json"), JSON.stringify({ private: true }));
    cpSync(fileURLToPath(new URL("../../../patches/playwright@1.63.0.patch", import.meta.url)), join(root, "development.patch"));
    writeFileSync(join(root, "pnpm-workspace.yaml"), [
      "packages:", "  - desktop", "globalPnpmfile: null",
      "patchedDependencies:", "  playwright@1.63.0: development.patch", "",
    ].join("\n"));
    writeFileSync(join(desktop, "package.json"), JSON.stringify({
      name: "deploy-isolation-fixture",
      version: "1.0.0",
      private: true,
      devDependencies: { playwright: "1.63.0" },
    }));
    // The patch is valid in a full workspace install; --prod excludes its
    // package from the deployed graph, which pnpm 12 otherwise rejects.
    const install = spawnSync(pnpmCli, ["install", "--offline", "--ignore-scripts"], {
      cwd: root, encoding: "utf8", timeout: 30_000,
    });
    expect(install.error).toBeUndefined();
    expect(install.status, `${install.stdout}\n${install.stderr}`).toBe(0);
    expect(readFileSync(join(desktop, "node_modules/playwright/lib/worker/workerProcessEntry.js"), "utf8")).toContain("pwragent.playwrightShutdownDiagnostics");
    const release = readFileSync(new URL("./release.mjs", import.meta.url), "utf8");
    const deploySource = release.slice(release.indexOf("  const deployArgs = ["), release.indexOf("  step(`pnpm ${win"));
    cpSync(fileURLToPath(new URL("../.npmignore", import.meta.url)), join(desktop, ".npmignore"));
    writeFileSync(join(desktop, "runtime.js"), "export const ready = true;\n");
    const stages = ["release-stage", "release-stage-arm64"];
    mkdirSync(join(desktop, ".local", "debug-artifacts"), { recursive: true });
    writeFileSync(join(desktop, ".local", "debug-artifacts", "private-debug.tar.gz"), "outside the app");
    for (const stage of stages) {
      mkdirSync(join(desktop, stage));
      writeFileSync(join(desktop, stage, "previous-build.txt"), "must not be deployed");
    }

    // Both preparation orders matter: the universal stage exists before the
    // arm64 stage in CI, and the arm64 stage survives into the next build.
    for (const stage of [...stages, ...stages]) {
      const target = join(desktop, stage);
      rmSync(target, { recursive: true, force: true });
      // Run the pinned native executable directly; no Windows .cmd handoff.
      const args = runInNewContext(`${deploySource}\ndeployArgs`, {
        win: false, linux: true, macArch: "universal", stageDir: target,
      }).map((arg) => arg === "@pwragent/desktop" ? "deploy-isolation-fixture" : arg);
      const result = spawnSync(pnpmCli, [...args, "--offline", "--ignore-scripts"], {
        cwd: root,
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(readFileSync(join(target, "runtime.js"), "utf8")).toContain("ready = true");
      expect(existsSync(join(target, ".local"))).toBe(false);
      expect(existsSync(join(target, "node_modules/playwright"))).toBe(false);
      for (const sibling of stages) {
        expect(existsSync(join(target, sibling))).toBe(false);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
