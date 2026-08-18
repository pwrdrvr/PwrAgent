import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Extensions Windows can start directly, or through the cmd.exe wrapper that
 * `createCommandInvocation` already builds for `.cmd`/`.bat`.
 *
 * `.ps1` is deliberately absent. npm writes three shims next to each other
 * (`codex`, `codex.cmd`, `codex.ps1`) and only the first two are usable here:
 *
 * - the extensionless shim is an sh script, unusable on Windows;
 * - the `.ps1` shim branches on `$MyInvocation.ExpectingInput`, and a
 *   long-lived JSON-RPC child is spawned with stdin as an open pipe, which
 *   makes that branch `$input | & node …`. Routing a bidirectional stdio
 *   server through PowerShell's object pipeline never completes the
 *   `initialize` handshake — verified on the Windows lab guest, where the
 *   PowerShell launch times out while `codex.cmd` answers in ~1.5s and the
 *   native `codex.exe` in ~0.3s. A one-shot `--version` probe survives it
 *   only because that path closes stdin, taking the other branch.
 *
 * So `.ps1` is a discovery signal, never a launch target.
 */
const WINDOWS_SPAWNABLE_EXTENSIONS = [".exe", ".com", ".cmd", ".bat"];

type CodexCommandRunner = (
  command: string,
  args: string[],
  options: {
    env: NodeJS.ProcessEnv;
    timeout: number;
    windowsHide: boolean;
    windowsVerbatimArguments?: boolean;
  },
) => Promise<{ stderr?: string | Buffer; stdout?: string | Buffer }>;

export function isWindowsSpawnableCommand(command: string): boolean {
  return WINDOWS_SPAWNABLE_EXTENSIONS.includes(
    path.win32.extname(command).toLowerCase(),
  );
}

function defaultExists(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Given `…\codex` or `…\codex.ps1`, find the sibling Windows can actually
 * start (`…\codex.exe`, then `…\codex.cmd`). Returns undefined when the
 * command is already spawnable, is not an absolute path, or has no sibling.
 */
export function resolveWindowsCodexSibling(params: {
  command: string;
  exists?: (candidate: string) => boolean;
}): string | undefined {
  const exists = params.exists ?? defaultExists;
  const trimmed = params.command.trim();
  if (!trimmed || !path.win32.isAbsolute(trimmed)) {
    return undefined;
  }
  const normalized = path.win32.normalize(trimmed);
  if (isWindowsSpawnableCommand(normalized)) {
    return undefined;
  }
  const extension = path.win32.extname(normalized);
  const base = extension
    ? normalized.slice(0, normalized.length - extension.length)
    : normalized;
  if (!base) {
    return undefined;
  }
  return WINDOWS_SPAWNABLE_EXTENSIONS.map((candidate) => `${base}${candidate}`)
    .find(exists);
}

/**
 * Last line of defence on the launch path: a command that reached us from
 * config, `PWRDRVR_CODEX_COMMAND`, or a stale cache may still be a `.ps1`.
 * Swap it for its spawnable sibling rather than starting a server that can
 * never answer.
 */
export function resolveWindowsCodexLaunchCommand(params: {
  command: string;
  exists?: (candidate: string) => boolean;
  platform?: NodeJS.Platform;
}): string {
  const platform = params.platform ?? process.platform;
  if (platform !== "win32") {
    return params.command;
  }
  return (
    resolveWindowsCodexSibling({
      command: params.command,
      ...(params.exists ? { exists: params.exists } : {}),
    }) ?? params.command
  );
}

export async function runCodexOneShot(
  command: string,
  args: string[],
  options: Parameters<CodexCommandRunner>[2],
): Promise<{ stderr?: string | Buffer; stdout?: string | Buffer }> {
  return await new Promise((resolve, reject) => {
    const child = execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        // execFile's message is the invocation, which on Windows is the
        // cmd.exe wrapper plus `^` escapes — ~90 characters of boilerplate
        // that crowds out the child's own diagnostic in any clipped surface.
        // Carry stdout/stderr on the error the way promisify(execFile) does
        // so a caller can report what the command actually said.
        reject(Object.assign(error, { stderr, stdout }));
        return;
      }
      resolve({ stderr, stdout });
    });
    // A `--version` probe reads to EOF and never writes, so close stdin.
    if (child.stdin) {
      child.stdin.on("error", () => undefined);
      child.stdin.end();
    }
  });
}
