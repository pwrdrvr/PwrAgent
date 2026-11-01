import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function buildMcpIpcRelay({ arch = process.arch, outputRoot = root, packaged = false, identityTest = false } = {}) {
  if (!["darwin", "linux", "win32"].includes(process.platform)) {
    throw new Error(`MCP IPC peer verification is unsupported on ${process.platform}.`);
  }
  const directory = join(outputRoot, "build", "mcp-ipc-relay", packaged ? "packaged" : `${process.platform}-${arch}`);
  mkdirSync(directory, { recursive: true });
  const output = join(directory, `mcp-ipc-${identityTest ? "identity-test" : "relay"}${process.platform === "win32" ? ".exe" : ""}`);
  // A failed rebuild must not leave a stale security helper usable in dev.
  rmSync(output, { force: true });
  const source = join(root, "native", "mcp-ipc-relay", identityTest ? "identity-test.c" : "main.c");
  let command;
  let args;
  if (process.platform === "win32") {
    if (arch !== process.arch) throw new Error("Build the Windows IPC relay on its target architecture.");
    command = "cl.exe";
    args = ["/nologo", "/W4", "/WX", "/O2", "/MT", "/DUNICODE", "/D_UNICODE", source,
      `/Fo${join(directory, "main.obj")}`, `/Fe${output}`, "/link", "Advapi32.lib"];
    // Packaging and CI need not inherit a developer prompt. Locate the
    // installed toolchain using Microsoft's own locator; never download one.
    if (!process.env.VCINSTALLDIR) {
      const locator = join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft Visual Studio", "Installer", "vswhere.exe");
      if (!existsSync(locator)) throw new Error("Install Visual Studio C++ tools to build the MCP IPC relay.");
      const found = spawnSync(locator, ["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"], { encoding: "utf8" });
      if (found.status !== 0 || !found.stdout.trim()) throw new Error("Visual Studio C++ tools were not found.");
      const vcvars = join(found.stdout.trim(), "VC", "Auxiliary", "Build", "vcvarsall.bat");
      const response = join(directory, "compile.rsp");
      const script = join(directory, "compile.cmd");
      for (const path of [vcvars, response, script]) {
        if (/[\r\n%!?&|<>^]/.test(path)) throw new Error("The native build path contains unsupported command characters.");
      }
      writeFileSync(response, args.map((arg) => `"${arg}"`).join("\n"));
      writeFileSync(script, `@echo off\r\ncall "${vcvars}" ${arch === "x64" ? "x64" : "arm64"} >nul\r\nif errorlevel 1 exit /b 1\r\ncl.exe @"${response}"\r\n`);
      command = process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe";
      args = ["/d", "/c", `"${script}"`];
    }
  } else {
    if (process.platform === "linux" && arch !== process.arch) throw new Error("Build the Linux IPC relay on its target architecture.");
    command = "cc";
    args = ["-std=c11", "-Wall", "-Wextra", "-Werror", "-O2",
      ...(process.platform === "darwin" ? ["-arch", arch === "x64" ? "x86_64" : arch] : []), source, "-o", output];
  }
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error || result.status !== 0) {
    throw new Error(`MCP IPC relay build failed: ${result.error?.message ?? result.status}. Windows builds require a Visual Studio developer environment.`);
  }
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    buildMcpIpcRelay({ identityTest: process.argv.includes("--identity-test") });
  } catch (error) {
    if (!process.argv.includes("--optional")) throw error;
    // Native IPC fails closed when its helper is missing; absence of a C
    // toolchain must not block ordinary network HTTP or stdio development.
    console.warn(`Local MCP IPC is unavailable: ${error.message}`);
  }
}
