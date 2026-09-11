import os from "node:os";
import path from "node:path";
import type {
  DesktopGlabCandidateSource,
  DesktopGlabDiscoveryCandidate,
  DesktopGlabDiscoverySnapshot,
} from "@pwragent/shared";
import { GLAB_COMMAND_ENV } from "./desktop-settings-env";
import {
  buildCommandDiscoveryCandidate,
  discoverCommands,
} from "./command-discovery";

export function parseGlabVersionOutput(output: string): string | undefined {
  return output.match(/\bglab(?: version)?\s+v?([0-9]+(?:\.[0-9]+){1,2}(?:-[0-9A-Za-z.-]+)?)/i)?.[1];
}

function glabCandidatePaths(env: NodeJS.ProcessEnv): Array<{
  command: string;
  source: DesktopGlabCandidateSource;
}> {
  const candidates: Array<{ command: string; source: DesktopGlabCandidateSource }> = [
    { command: "/opt/homebrew/bin/glab", source: "homebrew" },
    { command: "/usr/local/bin/glab", source: "homebrew" },
    { command: "/opt/local/bin/glab", source: "macports" },
    { command: path.join(os.homedir(), ".local/bin/glab"), source: "user" },
    { command: path.join(os.homedir(), "bin/glab"), source: "user" },
  ];

  const localAppData = env.LOCALAPPDATA?.trim();
  if (localAppData) {
    candidates.push({
      command: path.join(localAppData, "Programs/GitLab CLI/bin/glab.exe"),
      source: "windows",
    });
  }

  for (const programFiles of [env.ProgramFiles, env["ProgramFiles(x86)"]]) {
    if (programFiles?.trim()) {
      candidates.push({
        command: path.join(programFiles, "GitLab CLI/bin/glab.exe"),
        source: "windows",
      });
    }
  }

  return candidates;
}

export async function discoverGlabCommands(params?: {
  configuredCommand?: string;
  env?: NodeJS.ProcessEnv;
  includeFailedAutoCandidates?: boolean;
  platform?: NodeJS.Platform;
}): Promise<DesktopGlabDiscoverySnapshot> {
  const env = params?.env ?? process.env;
  const envOverride = env[GLAB_COMMAND_ENV]?.trim();
  const configuredCommand = params?.configuredCommand?.trim();

  const discovery = await discoverCommands<DesktopGlabCandidateSource>({
    env,
    platform: params?.platform,
    fixedCandidates: [
      { command: envOverride, source: "env" },
      { command: configuredCommand, source: "config" },
    ],
    autoCandidates: [
      { command: "glab", source: "path" },
      ...glabCandidatePaths(env),
    ],
    parseVersion: parseGlabVersionOutput,
    includeFailedAutoCandidates: params?.includeFailedAutoCandidates ?? "if-none-executable",
  });
  const selected = discovery.candidates.find((candidate) => candidate.selected);
  if (selected && !selected.version) {
    selected.selected = false;
    discovery.selectedCommand = undefined;
    discovery.selectedSource = undefined;
  }
  return discovery;
}

export async function validateGlabCommand(params: {
  command: string;
  env?: NodeJS.ProcessEnv;
}): Promise<DesktopGlabDiscoveryCandidate> {
  const candidate = await buildCommandDiscoveryCandidate<DesktopGlabCandidateSource>(
    { command: params.command, source: "config" },
    {
      env: params.env ?? process.env,
      parseVersion: parseGlabVersionOutput,
    },
  );
  if (!candidate) {
    throw new Error("No glab path was selected.");
  }
  return candidate;
}
