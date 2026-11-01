import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const environment = readFileSync(path.join(root, ".codex/environments/environment.toml"), "utf8");
const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it("uses the shared bootstrap for Windows setup and every Windows action", () => {
  const setup = environment.match(/\[setup\.win32\]\s*script = '''([\s\S]*?)'''/)[1];
  expect(setup).toContain(". ./scripts/windows-environment.ps1 -InstallNode");
  expect(setup).toContain("& $pnpmCommand install");
  const windowsActions = [...environment.matchAll(/platform = "win32"\s*command = '''([\s\S]*?)'''/g)];
  expect(windowsActions).toHaveLength(7);
  for (const [, command] of windowsActions) {
    expect(command).toContain(". ./scripts/windows-environment.ps1");
    expect(command).not.toMatch(/corepack|pnpm\.cmd/);
  }
});

describe.skipIf(process.platform !== "win32")("Windows environment bootstrap", () => {
  function fixture({ existingVersion, npmFailure, nvmFailure, nativePnpm = false, nodeVersion = process.versions.node, missingExecutable = false } = {}) {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pwragent bootstrap "));
    directories.push(directory);
    const scripts = path.join(directory, "scripts");
    const nvmHome = path.join(directory, "nvm home");
    const nodeDirectory = path.join(nvmHome, `v${nodeVersion}`);
    const bin = path.join(directory, "bin");
    for (const entry of [scripts, nodeDirectory, bin]) mkdirSync(entry, { recursive: true });
    copyFileSync(path.join(root, "scripts/windows-environment.ps1"), path.join(scripts, "windows-environment.ps1"));
    try {
      linkSync(process.execPath, path.join(nodeDirectory, "node.exe"));
    } catch {
      copyFileSync(process.execPath, path.join(nodeDirectory, "node.exe"));
    }
    writeFileSync(path.join(directory, ".nvmrc"), `v${nodeVersion}\n`);
    writeFileSync(path.join(directory, "package.json"), JSON.stringify({ packageManager: "pnpm@12.13.0+sha512.abcdef" }));
    writeFileSync(path.join(bin, "nvm.cmd"), `@echo off\necho nvm %*>>"%BOOTSTRAP_TRACE%"\nif "%~1"=="${nvmFailure ?? ""}" exit /b 17\nexit /b 0\n`);
    const pnpmStub = (version) => `@echo off\nif "%~1"=="--version" (echo ${version}& exit /b 0)\necho pnpm %*>>"%BOOTSTRAP_TRACE%"\nexit /b 0\n`;
    const source = path.join(directory, "pnpm source.cmd");
    writeFileSync(source, pnpmStub("12.13.0"));
    writeFileSync(path.join(nodeDirectory, "npm.cmd"), [
      "@echo off",
      'echo npm %*>>"%BOOTSTRAP_TRACE%"',
      "if defined BOOTSTRAP_NPM_FAILURE exit /b 23",
      'if not exist "%~4" mkdir "%~4"',
      missingExecutable ? "exit /b 0" : 'copy "%BOOTSTRAP_PNPM_SOURCE%" "%~4\\pnpm.cmd" >nul',
      "exit /b 0",
    ].join("\r\n"));
    const prefix = path.join(directory, ".local/toolchains/pnpm/12.13.0");
    if (existingVersion) {
      mkdirSync(prefix, { recursive: true });
      writeFileSync(path.join(prefix, "pnpm.cmd"), pnpmStub(existingVersion));
    }
    const powershell = path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
    if (nativePnpm) {
      // Produce a real Windows executable so discovery and invocation both run.
      mkdirSync(prefix, { recursive: true });
      const compileScript = path.join(directory, "compile.ps1");
      writeFileSync(compileScript, `Add-Type -OutputType ConsoleApplication -OutputAssembly '${path.join(prefix, "pnpm.exe").replaceAll("'", "''")}' -TypeDefinition @'
using System;
using System.IO;
public class PnpmFixture {
  public static void Main(string[] args) {
    if (args[0] == "--version") Console.WriteLine("12.13.0");
    else File.AppendAllText(Environment.GetEnvironmentVariable("BOOTSTRAP_TRACE"), "native pnpm " + string.Join(" ", args) + "\\n");
  }
}
'@`);
      const compiled = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", compileScript], { encoding: "utf8", timeout: 20_000 });
      expect(compiled.status, compiled.stderr).toBe(0);
    }
    // Execute the actual configured setup, from a path containing spaces, with
    // no Node, npm, pnpm, or Corepack inherited through PATH.
    const setup = environment.match(/\[setup\.win32\]\s*script = '''([\s\S]*?)'''/)[1];
    writeFileSync(path.join(directory, "run.ps1"), setup);
    const trace = path.join(directory, "trace.txt");
    const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(directory, "run.ps1")], {
      cwd: directory,
      encoding: "utf8",
      timeout: 20_000,
      env: {
        ...process.env,
        PATH: `${bin};${process.env.SystemRoot}\\System32;${process.env.SystemRoot}`,
        NVM_HOME: nvmHome,
        NVM_SYMLINK: path.join(directory, "missing symlink"),
        BOOTSTRAP_TRACE: trace,
        BOOTSTRAP_PNPM_SOURCE: source,
        BOOTSTRAP_NPM_FAILURE: npmFailure ? "1" : "",
      },
    });
    if (result.error) throw result.error;
    return { ...result, trace: existsSync(trace) ? readFileSync(trace, "utf8") : "" };
  }

  it("installs the exact pin without Corepack or a working nvm symlink", () => {
    const result = fixture();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.trace).toMatch(/nvm install .+\r?\nnvm use /);
    expect(result.trace).toMatch(/npm install --global --prefix .+ pnpm@12\.13\.0/);
    expect(result.trace).toContain("pnpm install");
    expect(result.trace).not.toContain("sha512");
  });

  it("reuses a matching installation", () => {
    const result = fixture({ existingVersion: "12.13.0" });
    expect(result.status).toBe(0);
    expect(result.trace).not.toContain("npm install --global");
    expect(result.trace).toContain("pnpm install");
  });

  it("reinstalls a mismatched version", () => {
    const result = fixture({ existingVersion: "10.0.0" });
    expect(result.status).toBe(0);
    expect(result.trace).toContain("npm install --global");
    expect(result.trace).toContain("pnpm install");
  });

  it("discovers and invokes pnpm.exe ahead of an old cmd shim", () => {
    const result = fixture({ existingVersion: "10.0.0", nativePnpm: true });
    expect(result.status).toBe(0);
    expect(result.trace).not.toContain("npm install --global");
    expect(result.trace).toContain("native pnpm install");
  });

  it.each(["install", "use"])("stops when nvm %s fails", (nvmFailure) => {
    const result = fixture({ nvmFailure });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`nvm ${nvmFailure} failed`);
    expect(result.trace).not.toContain("npm install --global");
    expect(result.trace).not.toContain("pnpm install");
  });

  it("stops before dependency installation when npm fails", () => {
    const result = fixture({ npmFailure: true });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("npm install of pnpm 12.13.0 failed");
    expect(result.trace).not.toContain("pnpm install");
  });

  it("rejects an install that produced no executable", () => {
    const result = fixture({ missingExecutable: true });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("executable was not found");
    expect(result.trace).not.toContain("pnpm install");
  });

  it("rejects the wrong Node before installing pnpm", () => {
    const result = fixture({ nodeVersion: "0.0.0" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Expected Node 0.0.0");
    expect(result.trace).not.toContain("npm install --global");
  });
});
