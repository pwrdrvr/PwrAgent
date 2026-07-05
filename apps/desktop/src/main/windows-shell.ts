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
    path.join(programFiles, "Git", "bin", "bash.exe"),
    path.join(programFiles, "Git", "usr", "bin", "bash.exe"),
    path.join(programFilesX86, "Git", "bin", "bash.exe"),
  ];
  if (localAppData) {
    candidates.push(
      path.join(localAppData, "Programs", "Git", "bin", "bash.exe"),
    );
  }
  // Last resort: rely on PATH resolution.
  candidates.push("bash.exe");
  return candidates;
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
