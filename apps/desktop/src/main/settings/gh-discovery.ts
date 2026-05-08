import os from "node:os";
import path from "node:path";
import type {
  DesktopGhCandidateSource,
  DesktopGhDiscoveryCandidate,
  DesktopGhDiscoverySnapshot,
} from "@pwragent/shared";
import { GH_COMMAND_ENV } from "./desktop-settings-env";
import {
  buildCommandDiscoveryCandidate,
  discoverCommands,
} from "./command-discovery";

export function parseGhVersionOutput(output: string): string | undefined {
  return output.match(/\bgh version\s+([0-9]+(?:\.[0-9]+){1,2}(?:-[0-9A-Za-z.-]+)?)/i)?.[1]
    ?? output.match(/\b([0-9]+(?:\.[0-9]+){1,2}(?:-[0-9A-Za-z.-]+)?)\b/)?.[1];
}

function ghCandidatePaths(env: NodeJS.ProcessEnv): Array<{
  command: string;
  source: DesktopGhCandidateSource;
}> {
  const candidates: Array<{ command: string; source: DesktopGhCandidateSource }> = [
    { command: "/opt/homebrew/bin/gh", source: "homebrew" },
    { command: "/usr/local/bin/gh", source: "homebrew" },
    { command: "/opt/local/bin/gh", source: "macports" },
    { command: path.join(os.homedir(), ".local/bin/gh"), source: "user" },
    { command: path.join(os.homedir(), "bin/gh"), source: "user" },
  ];

  const localAppData = env.LOCALAPPDATA?.trim();
  if (localAppData) {
    candidates.push({
      command: path.join(localAppData, "Programs/GitHub CLI/bin/gh.exe"),
      source: "windows",
    });
  }

  for (const programFiles of [env.ProgramFiles, env["ProgramFiles(x86)"]]) {
    if (programFiles?.trim()) {
      candidates.push({
        command: path.join(programFiles, "GitHub CLI/bin/gh.exe"),
        source: "windows",
      });
    }
  }

  return candidates;
}

export async function discoverGhCommands(params?: {
  configuredCommand?: string;
  env?: NodeJS.ProcessEnv;
  includeFailedAutoCandidates?: boolean;
  platform?: NodeJS.Platform;
}): Promise<DesktopGhDiscoverySnapshot> {
  const env = params?.env ?? process.env;
  const envOverride = env[GH_COMMAND_ENV]?.trim();
  const configuredCommand = params?.configuredCommand?.trim();

  return discoverCommands<DesktopGhCandidateSource>({
    env,
    platform: params?.platform,
    fixedCandidates: [
      { command: envOverride, source: "env" },
      { command: configuredCommand, source: "config" },
    ],
    autoCandidates: [
      { command: "gh", source: "path" },
      ...ghCandidatePaths(env),
    ],
    parseVersion: parseGhVersionOutput,
    includeFailedAutoCandidates: params?.includeFailedAutoCandidates ?? "if-none-executable",
  }) as Promise<DesktopGhDiscoverySnapshot>;
}

export async function validateGhCommand(params: {
  command: string;
  env?: NodeJS.ProcessEnv;
}): Promise<DesktopGhDiscoveryCandidate> {
  const candidate = await buildCommandDiscoveryCandidate<DesktopGhCandidateSource>(
    { command: params.command, source: "config" },
    {
      env: params.env ?? process.env,
      parseVersion: parseGhVersionOutput,
    },
  );
  if (!candidate) {
    throw new Error("No gh path was selected.");
  }
  return candidate;
}
