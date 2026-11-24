import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WINDOWS_JOB_RUNNER_SOURCE } from "../src/main/windows-job-wrapper.ts";

const scriptPath = fileURLToPath(import.meta.url);
const desktop = path.resolve(path.dirname(scriptPath), "..");

export function buildWindowsJobLauncher(directory = path.join(desktop, "out/main")) {
  if (process.platform !== "win32") return;
  const output = path.resolve(directory, "pwragent-windows-job.exe");
  const framework = process.arch === "ia32" ? "Framework" : "Framework64";
  const compiler = path.join(process.env.SystemRoot ?? "C:\\Windows", "Microsoft.NET", framework, "v4.0.30319", "csc.exe");
  mkdirSync(directory, { recursive: true });
  const scratch = mkdtempSync(path.join(directory, "compile-"));
  try {
    const runner = path.join(scratch, "Runner.cs");
    const executable = path.join(scratch, "launcher.exe");
    writeFileSync(runner, WINDOWS_JOB_RUNNER_SOURCE);
    execFileSync(compiler, [
      "/nologo", "/warnaserror", "/optimize+", "/platform:anycpu", "/target:exe", `/out:${executable}`,
      runner, path.join(desktop, "native/windows-job-launcher.cs"),
    ], { stdio: "inherit", windowsHide: true, timeout: 30_000 });
    renameSync(executable, output);
    return output;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) buildWindowsJobLauncher(process.argv[2]);
