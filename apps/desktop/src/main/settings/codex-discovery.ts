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

function getCodexAppCandidatePaths(): string[] {
  return [
    "/Applications/Codex.app/Contents/Resources/codex",
    path.join(os.homedir(), "Applications/Codex.app/Contents/Resources/codex"),
  ];
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

  return discoverCommands<DesktopCodexCandidateSource>({
    env,
    platform: params?.platform,
    fixedCandidates: [
      { command: envOverride, source: "env" },
      { command: configuredCommand, source: "config" },
    ],
    autoCandidates: [
      { command: "codex", source: "path" },
      ...getCodexAppCandidatePaths().map((candidatePath) => ({
        command: candidatePath,
        source: "application" as const,
      })),
    ],
    parseVersion: parseCodexVersionOutput,
    compareVersions: compareCodexCliVersions,
    validateVersion: validateCodexCliVersion,
    preflightCandidate: ({ command, platform }) =>
      inspectCodexCandidateBeforeVersionProbe({ command, platform }),
  }) as Promise<DesktopCodexDiscoverySnapshot>;
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

  return {
    command: params.command.trim() || "codex",
    source: "path",
  };
}
