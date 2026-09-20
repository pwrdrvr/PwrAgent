import { ipcMain } from "electron";
import { RUNTIME_IDENTITY_CHANNEL } from "../../shared/ipc";
import type { RuntimeIdentity } from "../../shared/runtime-identity";
import { runGitCommand } from "../app-server/git-executable";

async function readGitValue(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await runGitCommand(cwd, args, {
      timeout: 2_000,
      maxBuffer: 64 * 1024,
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function resolveRuntimeIdentity(cwd = process.cwd()): Promise<RuntimeIdentity> {
  const branch =
    await readGitValue(cwd, ["branch", "--show-current"]) ??
    await readGitValue(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);

  if (branch) {
    return {
      branch,
      cwd,
    };
  }

  const commitSha = await readGitValue(cwd, ["rev-parse", "HEAD"]);

  return {
    commitSha,
    cwd,
    detachedHead: Boolean(commitSha),
  };
}

export function registerRuntimeIdentityIpcHandlers(): void {
  ipcMain.removeHandler(RUNTIME_IDENTITY_CHANNEL);
  ipcMain.handle(
    RUNTIME_IDENTITY_CHANNEL,
    async (): Promise<RuntimeIdentity> => resolveRuntimeIdentity(),
  );
}

export function disposeRuntimeIdentityIpcHandlers(): void {
  ipcMain.removeHandler(RUNTIME_IDENTITY_CHANNEL);
}
