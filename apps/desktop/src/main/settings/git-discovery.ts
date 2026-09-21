import os from "node:os";
import type { DesktopGitDiscoveryCandidate, DesktopGitDiscoverySnapshot } from "@pwragent/shared";
import { bundledGitExecutable } from "../bundled-git";
import { runGitCommand } from "../app-server/git-executable";

export function parseGitVersionOutput(output: string): string | undefined {
  return output.match(/\bgit version\s+([^\s]+)/i)?.[1];
}

export async function discoverGitCommands(params?: {
  configuredCommand?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): Promise<DesktopGitDiscoverySnapshot> {
  const command = bundledGitExecutable();
  const candidate: DesktopGitDiscoveryCandidate = {
    command, source: "bundled", selected: true, executable: false,
  };
  try {
    const options = { env: params?.env, timeout: 5_000, maxBuffer: 64 * 1024 };
    const [git, lfs] = await Promise.all([
      runGitCommand(os.tmpdir(), ["--version"], options),
      runGitCommand(os.tmpdir(), ["lfs", "version"], options),
    ]);
    candidate.version = parseGitVersionOutput(git.stdout);
    candidate.lfsVersion = lfs.stdout.match(/git-lfs\/([^\s]+)/)?.[1];
    if (!candidate.version || !candidate.lfsVersion) {
      throw new Error("The bundled Git and Git LFS versions could not be verified.");
    }
    candidate.executable = true;
  } catch (error) {
    candidate.failureReason = error instanceof Error ? error.message : String(error);
  }
  return { selectedCommand: command, selectedSource: "bundled", candidates: [candidate] };
}

/** Kept for older IPC clients. Installed Git is no longer an execution option. */
export async function validateGitCommand(_params: {
  command: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): Promise<DesktopGitDiscoveryCandidate> {
  throw new Error("PwrAgent uses its bundled Git and Git LFS. Custom Git paths are no longer supported.");
}
