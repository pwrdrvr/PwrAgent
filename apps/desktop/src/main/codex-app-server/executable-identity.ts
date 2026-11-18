import path from "node:path";
import { realpath, stat } from "node:fs/promises";
import type { CodexExecutableIdentity } from "@pwragent/owner-core/codex-app-server/app-server-installation";

export type { CodexExecutableIdentity };

/**
 * Which file `command` names right now: its fully resolved path and that
 * file's identity. A missing file has no `realPath`. A bare command name
 * (resolved by `PATH` at spawn) has no fixed file to compare and is returned
 * as just its name. Reads two inodes; never runs the executable.
 */
export async function readCodexExecutableIdentity(
  command: string,
  version?: string,
): Promise<CodexExecutableIdentity> {
  const identity: CodexExecutableIdentity = { command, ...(version ? { version } : {}) };
  if (!path.isAbsolute(command)) return identity;
  try {
    const realPath = await realpath(command);
    const file = await stat(realPath);
    return {
      ...identity,
      realPath,
      dev: file.dev,
      ino: file.ino,
      size: file.size,
      mtimeMs: file.mtimeMs,
    };
  } catch {
    return identity;
  }
}
