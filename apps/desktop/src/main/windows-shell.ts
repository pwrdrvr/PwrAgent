import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Candidate Git-for-Windows `bash.exe` paths, in priority order.
 *
 * PwrAgent already requires Git, and the agent's shell commands are bash
 * (POSIX `-lc` scripts: `set -e`, `[ -s … ]`, nvm sourcing, pipes). Windows
 * has no `/bin/sh`, so we run those scripts through Git-for-Windows' bundled
 * bash instead of cmd.exe (which can't execute bash syntax).
 */
export function windowsBashCandidates(): string[] {
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  const programFilesX86 =
    process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const localAppData = process.env.LOCALAPPDATA;

  const candidates = [
    path.win32.join(programFiles, "Git", "usr", "bin", "bash.exe"),
    path.win32.join(programFiles, "Git", "bin", "bash.exe"),
    path.win32.join(programFilesX86, "Git", "usr", "bin", "bash.exe"),
    path.win32.join(programFilesX86, "Git", "bin", "bash.exe"),
  ];
  if (localAppData) {
    candidates.push(
      path.win32.join(localAppData, "Programs", "Git", "usr", "bin", "bash.exe"),
      path.win32.join(localAppData, "Programs", "Git", "bin", "bash.exe"),
    );
  }
  // Last resort: rely on PATH resolution.
  candidates.push("bash.exe");
  return candidates;
}

/**
 * Prefer Git-for-Windows' stable MSYS bash over its `bin\\bash.exe` launcher.
 * The launcher can exit after spawning a differently-pid'd `usr\\bin\\bash.exe`,
 * which breaks process-tree ownership and leaves detached commands behind.
 */
export function preferStableWindowsBashPath(
  shell: string,
  pathExists: (candidate: string) => boolean = existsSync,
): string {
  const normalized = path.win32.normalize(shell);
  if (path.win32.basename(normalized).toLowerCase() !== "bash.exe") {
    return shell;
  }
  const binDir = path.win32.dirname(normalized);
  if (path.win32.basename(binDir).toLowerCase() !== "bin") {
    return shell;
  }
  const binParent = path.win32.dirname(binDir);
  if (path.win32.basename(binParent).toLowerCase() === "usr") {
    return normalized;
  }
  const stableBash = path.win32.join(binParent, "usr", "bin", "bash.exe");
  return pathExists(stableBash) ? stableBash : shell;
}

/**
 * Resolve a bash shell for running agent commands on Windows. Returns the first
 * Git-for-Windows bash that exists on disk, else `bash.exe` (PATH fallback).
 */
export function resolveWindowsBashShell(): string {
  for (const candidate of windowsBashCandidates()) {
    if (candidate === "bash.exe" || existsSync(candidate)) {
      return candidate;
    }
  }
  return "bash.exe";
}
