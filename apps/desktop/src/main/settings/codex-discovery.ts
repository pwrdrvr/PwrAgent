import os from "node:os";
import path from "node:path";
import { realpath } from "node:fs/promises";
import type {
  DesktopCodexCandidateSource,
  DesktopCodexDiscoveryCandidate,
  DesktopCodexDiscoverySnapshot,
} from "@pwragent/shared";
import { CODEX_COMMAND_ENV } from "./desktop-settings-env";
import {
  discoverCommands,
  pathIsExecutable,
  type ResolvedCommandCandidate,
} from "./command-discovery";

export const MINIMUM_CODEX_CLI_VERSION = "0.125.0";

export type ResolvedCodexCommandCandidate = {
  command: string;
  source: DesktopCodexCandidateSource;
  version?: string;
};
export { pathIsExecutable };

function parseCodexVersionOutput(output: string): string | undefined {
  return output.match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/)?.[1];
}

function parseVersion(value?: string): {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
} | undefined {
  const match = value?.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) {
    return undefined;
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split(".") ?? [],
  };
}

function comparePrerelease(left: string[], right: string[]): number {
  if (left.length === 0 && right.length === 0) {
    return 0;
  }
  if (left.length === 0) {
    return 1;
  }
  if (right.length === 0) {
    return -1;
  }

  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined) {
      return -1;
    }
    if (rightPart === undefined) {
      return 1;
    }

    const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : undefined;
    const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : undefined;
    if (leftNumber !== undefined && rightNumber !== undefined) {
      if (leftNumber !== rightNumber) {
        return Math.sign(leftNumber - rightNumber);
      }
      continue;
    }
    if (leftNumber !== undefined) {
      return -1;
    }
    if (rightNumber !== undefined) {
      return 1;
    }
    if (leftPart !== rightPart) {
      return leftPart.localeCompare(rightPart);
    }
  }

  return 0;
}

export function compareCodexCliVersions(left?: string, right?: string): number {
  const leftVersion = parseVersion(left);
  const rightVersion = parseVersion(right);
  if (!leftVersion && !rightVersion) {
    return 0;
  }
  if (!leftVersion) {
    return -1;
  }
  if (!rightVersion) {
    return 1;
  }

  for (const key of ["major", "minor", "patch"] as const) {
    if (leftVersion[key] !== rightVersion[key]) {
      return Math.sign(leftVersion[key] - rightVersion[key]);
    }
  }

  return comparePrerelease(leftVersion.prerelease, rightVersion.prerelease);
}

function validateCodexCliVersion(version: string): string | undefined {
  return compareCodexCliVersions(version, MINIMUM_CODEX_CLI_VERSION) < 0
    ? "codex_too_old"
    : undefined;
}

/**
 * Well-known install locations for the Codex CLI, used as auto-candidates
 * alongside the PATH lookup. Platform-aware: macOS gets `Codex.app`
 * resource bundles, Linux gets the standard FHS dirs plus the common
 * user-local Node/Rust/Bun toolchain locations that aren't typically on
 * an Electron-spawned process's PATH. Returned in priority order
 * (system-wide first, user-local second) so the discovery prefers the
 * canonical install when both are present.
 */
function getCodexInstallCandidatePaths(platform: NodeJS.Platform): string[] {
  const homeDir = os.homedir();
  if (platform === "darwin") {
    return [
      "/Applications/Codex.app/Contents/Resources/codex",
      path.join(homeDir, "Applications/Codex.app/Contents/Resources/codex"),
    ];
  }
  if (platform === "linux") {
    return [
      // System-wide installs (the typical "apt install", "rpm install",
      // or homebrew-on-linux destination).
      "/usr/bin/codex",
      "/usr/local/bin/codex",
      "/opt/codex/bin/codex",
      // Ubuntu Snap installs land here when installed via `snap install
      // codex`. The snap-wrapper exec is a shim that delegates to the
      // real binary under `/snap/codex/current/`, but `/snap/bin/codex`
      // is what shows up on PATH for a normal shell.
      "/snap/bin/codex",
      // User-local installs. Electron's spawned-process PATH on Linux
      // does NOT typically include `~/.local/bin` or any of the per-
      // language toolchain bin dirs (npm-global, pnpm, bun, cargo),
      // so these need explicit auto-candidates to be discoverable
      // without the operator setting CODEX_COMMAND or `PATH`.
      path.join(homeDir, ".local/bin/codex"),
      path.join(homeDir, ".npm-global/bin/codex"),
      path.join(homeDir, ".local/share/pnpm/codex"),
      path.join(homeDir, ".bun/bin/codex"),
      path.join(homeDir, ".cargo/bin/codex"),
      // Linuxbrew on Linux. Two common prefixes:
      "/home/linuxbrew/.linuxbrew/bin/codex",
      path.join(homeDir, ".linuxbrew/bin/codex"),
    ];
  }
  if (platform === "win32") {
    // Windows isn't a user-reported gap yet, but include the obvious
    // npm + LOCALAPPDATA installs so the discovery snapshot is
    // symmetric. The npm-global `.cmd` shim is what gets executed by
    // `spawn` on win32.
    return [
      path.join(homeDir, "AppData/Roaming/npm/codex.cmd"),
      path.join(homeDir, "AppData/Local/Programs/codex/codex.exe"),
    ];
  }
  // Other Unix flavors (freebsd, openbsd, sunos) — fall back to the FHS
  // basics, no user-local guesses.
  return ["/usr/bin/codex", "/usr/local/bin/codex"];
}

async function inspectCodexCandidateBeforeVersionProbe(params: {
  command: string;
  platform: NodeJS.Platform;
}): Promise<{
  version?: string;
  failureReason?: string;
  skipVersionProbe?: boolean;
} | undefined> {
  if (params.platform !== "darwin") {
    return undefined;
  }

  const version = await readHomebrewCodexVersionWithoutExecution(params.command);
  if (!version) {
    return undefined;
  }

  return {
    version,
    failureReason: validateCodexCliVersion(version),
    skipVersionProbe: true,
  };
}

async function readHomebrewCodexVersionWithoutExecution(command: string): Promise<string | undefined> {
  const candidatePaths = [command];
  try {
    const resolved = await realpath(command);
    if (resolved !== command) {
      candidatePaths.push(resolved);
    }
  } catch {
    // The caller already checked existence. If realpath fails, fall back to the
    // original path and the normal version probe.
  }

  for (const candidatePath of candidatePaths) {
    const homebrewVersion = readHomebrewCodexVersionFromPath(candidatePath);
    if (homebrewVersion) {
      return homebrewVersion;
    }
  }

  return undefined;
}

function readHomebrewCodexVersionFromPath(candidatePath: string): string | undefined {
  const normalized = candidatePath.replace(/\\/g, "/");
  const match = normalized.match(
    /\/(?:Caskroom|Cellar)\/codex\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\/|$)/,
  );
  return match?.[1];
}

export async function discoverCodexCommands(params?: {
  configuredCommand?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): Promise<DesktopCodexDiscoverySnapshot> {
  const env = params?.env ?? process.env;
  const envOverride = env[CODEX_COMMAND_ENV]?.trim();
  const configuredCommand = params?.configuredCommand?.trim();

  const resolvedPlatform = params?.platform ?? process.platform;
  return discoverCommands<DesktopCodexCandidateSource>({
    env,
    platform: params?.platform,
    fixedCandidates: [
      { command: envOverride, source: "env" },
      { command: configuredCommand, source: "config" },
    ],
    autoCandidates: [
      { command: "codex", source: "path" },
      ...getCodexInstallCandidatePaths(resolvedPlatform).map(
        (candidatePath) => ({
          command: candidatePath,
          source: "application" as const,
        }),
      ),
    ],
    parseVersion: parseCodexVersionOutput,
    compareVersions: compareCodexCliVersions,
    validateVersion: validateCodexCliVersion,
    preflightCandidate: ({ command, platform }) =>
      inspectCodexCandidateBeforeVersionProbe({ command, platform }),
  }) as Promise<DesktopCodexDiscoverySnapshot>;
}

/**
 * Thrown by `resolveCodexCommand` when discovery finds no executable
 * Codex CLI on this machine. Callers catch this to surface a clean
 * "Codex CLI not installed" state instead of attempting a spawn that
 * would `ENOENT` (the previous fallback behavior on Linux without
 * Codex). The wizard's Step 0 backend-requirements check also uses
 * the discovery output directly and decorates this with install
 * instructions.
 */
export class CodexCliNotInstalledError extends Error {
  constructor(message = "codex CLI not found on PATH or in known install locations") {
    super(message);
    this.name = "CodexCliNotInstalledError";
  }
}

export async function resolveCodexCommand(params: {
  command: string;
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): Promise<ResolvedCommandCandidate<DesktopCodexCandidateSource>> {
  const configuredCommand =
    params.command.trim() && params.command.trim() !== "codex"
      ? params.command.trim()
      : undefined;
  const discovery = await discoverCodexCommands({
    configuredCommand,
    env: params.env,
    platform: params.platform,
  });
  const selected = discovery.candidates.find((candidate) => candidate.selected);
  const rejectedOldCodex = discovery.candidates.find(
    (candidate) => candidate.failureReason === "codex_too_old",
  );

  if (selected) {
    return {
      command: selected.command,
      source: selected.source,
      version: selected.version,
    };
  }

  if (rejectedOldCodex) {
    throw new Error(
      `Codex CLI ${rejectedOldCodex.version ?? "unknown"} is older than the minimum supported version ${MINIMUM_CODEX_CLI_VERSION}: ${rejectedOldCodex.command}`,
    );
  }

  // No selected candidate and no version-rejected candidate — discovery
  // turned up nothing usable. Throw a typed error so the transport can
  // refuse to spawn cleanly instead of attempting `spawn("codex")` and
  // letting it `ENOENT`. Pre-fix behavior was to fall back to `"codex"`
  // (PATH lookup); discovery already searched PATH plus the
  // platform-specific install locations, so a fallback would just
  // repeat the same lookup that already failed.
  throw new CodexCliNotInstalledError();
}
