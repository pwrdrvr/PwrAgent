import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createCommandInvocation } from "@pwrdrvr/agent-transport";
import { isValidatedDiscoveryCandidate } from "@pwragent/shared";
import {
  CODEX_COMMAND_ENV,
  compareCodexCliVersions,
  MINIMUM_CODEX_CLI_VERSION,
  type CodexDiscoveryCandidate,
} from "@pwrdrvr/codex-discovery";

/**
 * Anchored to Codex's own `--version` banner (`codex-cli 0.146.0`).
 *
 * A bare `\d+\.\d+\.\d+` matches anything in the combined output — a node
 * deprecation notice, an npm warning, even a version-shaped directory in an
 * error message. That was survivable while a junk version only mislabeled a
 * row, but selection now ranks automatic candidates by version descending, so
 * an unanchored match can outrank a genuine install and become the launched
 * command.
 */
const CODEX_VERSION_PATTERN =
  /\bcodex(?:-cli)?[\s/v]+(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/i;
const VERSION_PROBE_TIMEOUT_MS = 10_000;

const POWERSHELL_SHIM_EXTENSION = ".ps1";

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

function isPowerShellScript(command: string): boolean {
  return path.win32.extname(command).toLowerCase() === POWERSHELL_SHIM_EXTENSION;
}

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
        reject(error);
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

async function inspectCandidate(params: {
  command: string;
  env: NodeJS.ProcessEnv;
  runner: CodexCommandRunner;
  source: CodexDiscoveryCandidate["source"];
}): Promise<CodexDiscoveryCandidate> {
  try {
    const invocation = createCommandInvocation({
      command: params.command,
      args: ["--version"],
      env: params.env,
      platform: "win32",
    });
    const result = await params.runner(invocation.command, invocation.args, {
      env: params.env,
      timeout: VERSION_PROBE_TIMEOUT_MS,
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    const output = `${result.stdout?.toString() ?? ""}\n${
      result.stderr?.toString() ?? ""
    }`;
    const version = output.match(CODEX_VERSION_PATTERN)?.[1];
    const tooOld =
      version && compareCodexCliVersions(version, MINIMUM_CODEX_CLI_VERSION) < 0;
    return {
      command: params.command,
      source: params.source,
      executable: Boolean(version) && !tooOld,
      selected: false,
      ...(version
        ? { version }
        : { versionFailureReason: "version_not_reported" }),
      ...(tooOld ? { failureReason: "codex_too_old" } : {}),
    };
  } catch (error) {
    return {
      command: params.command,
      source: params.source,
      executable: false,
      selected: false,
      failureReason: classifyProbeFailure(error),
    };
  }
}

/**
 * `execFile`'s error shape is not what the obvious `code === "ENOENT"` test
 * expects here. A `.cmd` probe runs through the cmd.exe wrapper, and cmd.exe
 * always exists, so `code` arrives as a numeric exit status (49, say) and a
 * timeout arrives as `code: null` with `killed: true` and `signal: "SIGTERM"`.
 * Classifying on the errno string alone left `not_found` unreachable and made
 * every timeout render as a generic launch failure.
 */
function classifyProbeFailure(error: unknown): string {
  const failure = error as NodeJS.ErrnoException & {
    killed?: boolean;
    signal?: string;
  };
  // `killed` alone. Node sets it only when it terminated the child itself,
  // which for execFile means the timeout fired. An externally-sent SIGTERM
  // (EDR, Defender, a job-object kill) arrives as killed:false with the same
  // signal, and reporting that as a timeout points the operator at a latency
  // problem that does not exist.
  if (failure?.killed === true) {
    return "version_probe_timed_out";
  }
  const code = failure?.code;
  if (code === "ENOENT" || code === "ENOTDIR") {
    return "not_found";
  }
  return error instanceof Error ? error.message : String(error);
}

type SiblingTarget = {
  command: string;
  source: CodexDiscoveryCandidate["source"];
};

/**
 * A candidate the desktop is willing to launch. `executable` alone is not
 * that test: upstream derives it from `fs.access(X_OK)`, which succeeds for
 * any existing file on Windows, so an sh shim scores `executable: true`.
 */
export function isValidatedCandidate(
  candidate: Pick<
    CodexDiscoveryCandidate,
    "executable" | "failureReason" | "version" | "versionFailureReason"
  >,
): boolean {
  return isValidatedDiscoveryCandidate(candidate);
}

/**
 * Supplements shared Codex discovery on Windows.
 *
 * The shared PATH scan walks `[command, ...PATHEXT]` in that order, so in an
 * npm/nvm-windows bin directory it stops on the extensionless sh shim and
 * never reaches `codex.cmd`. That is why a machine with a perfectly good
 * Codex reports "Missing". Here we take every discovered command Windows
 * cannot start and probe its spawnable sibling instead.
 *
 * Fixed `env`/`config` paths are probed the same way so an operator who typed
 * a `.ps1` still ends up on a launchable command.
 */
export async function discoverWindowsCodexCandidates(params: {
  candidates: readonly CodexDiscoveryCandidate[];
  configuredCommand?: string;
  env: NodeJS.ProcessEnv;
  exists?: (candidate: string) => boolean;
  runner?: CodexCommandRunner;
}): Promise<CodexDiscoveryCandidate[]> {
  const runner = params.runner ?? runCodexOneShot;
  const exists = params.exists ?? defaultExists;
  // Only a *validated* candidate should suppress a re-probe. Upstream probes
  // with a 2s budget, and a `.cmd` shim needs ~1.5s warm, so a plain
  // npm-global layout leaves its own `%APPDATA%\npm\codex.cmd` sitting in the
  // candidate list as executable-but-versionless. Keying `known` on every
  // command let that entry suppress the sibling lookup that would have
  // re-probed the same path on this module's longer budget, and discovery
  // still reported Missing.
  const known = new Set(
    params.candidates
      .filter(isValidatedCandidate)
      .map((candidate) => candidate.command.toLowerCase()),
  );
  const fixedInputs: { command?: string; source: SiblingTarget["source"] }[] = [
    { command: params.env[CODEX_COMMAND_ENV]?.trim(), source: "env" },
    { command: params.configuredCommand?.trim(), source: "config" },
  ];
  const fixed: SiblingTarget[] = fixedInputs.flatMap((entry) =>
    entry.command ? [{ command: entry.command, source: entry.source }] : [],
  );

  const targets: SiblingTarget[] = [];
  const unsupported: CodexDiscoveryCandidate[] = [];
  const seen = new Set<string>();
  for (const entry of [
    ...fixed,
    ...params.candidates.map((candidate) => ({
      command: candidate.command,
      source: candidate.source,
    })),
  ]) {
    const sibling = resolveWindowsCodexSibling({ command: entry.command, exists });
    if (!sibling) {
      // A `.ps1` with no sibling is a launch dead end; say so rather than
      // letting it look merely "not executable". Dedupe on the same key the
      // sibling path uses: one `.ps1` reachable from both env and config must
      // not emit two rows, because the merge matches by command and would
      // rewrite one while leaving the other clickable.
      const unsupportedKey = entry.command.trim().toLowerCase();
      if (isPowerShellScript(entry.command) && !seen.has(unsupportedKey)) {
        seen.add(unsupportedKey);
        unsupported.push({
          command: entry.command,
          source: entry.source,
          executable: false,
          selected: false,
          failureReason: "powershell_shim_unsupported",
        });
      }
      continue;
    }
    const key = sibling.toLowerCase();
    if (seen.has(key) || known.has(key)) {
      continue;
    }
    seen.add(key);
    targets.push({ command: sibling, source: entry.source });
  }

  const probed = await Promise.all(
    targets.map(
      async (target) =>
        await inspectCandidate({
          command: target.command,
          env: params.env,
          runner,
          source: target.source,
        }),
    ),
  );
  return [...probed, ...unsupported];
}
