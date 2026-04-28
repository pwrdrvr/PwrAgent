import { ipcMain } from "electron";
import { execFileSync } from "node:child_process";
import { RUNTIME_IDENTITY_CHANNEL } from "../../shared/ipc";
import type { RuntimeIdentity } from "../../shared/runtime-identity";

function readGitValue(cwd: string, args: string[]): string | undefined {
  try {
    const value = execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

export function resolveRuntimeIdentity(cwd = process.cwd()): RuntimeIdentity {
  const branch =
    readGitValue(cwd, ["branch", "--show-current"]) ??
    readGitValue(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);

  if (branch) {
    return {
      branch,
      cwd,
    };
  }

  const commitSha = readGitValue(cwd, ["rev-parse", "HEAD"]);

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
