import os from "node:os";
import path from "node:path";
import type {
  DesktopGitCandidateSource,
  DesktopGitDiscoveryCandidate,
  DesktopGitDiscoverySnapshot,
} from "@pwragent/shared";
import { buildCommandDiscoveryCandidate } from "./command-discovery";

export const GIT_COMMAND_ENV = "PWRAGENT_GIT_PATH";
const XCODE_LICENSE_COMMAND = "sudo xcodebuild -license";

export function parseGitVersionOutput(output: string): string | undefined {
  return output.match(/\bgit version\s+([^\s]+)/i)?.[1]
    ?? output.match(/\b([0-9]+(?:\.[0-9]+){1,2}(?:-[0-9A-Za-z.-]+)?)\b/)?.[1];
}

export function isXcodeLicenseFailure(reason?: string): boolean {
  return Boolean(
    reason?.includes("Xcode license")
      || reason?.includes("license agreements")
      || reason?.includes("xcodebuild -license"),
  );
}

export function xcodeLicenseRemediationCommand(): string {
  return XCODE_LICENSE_COMMAND;
}

export function gitCandidateInputs(env: NodeJS.ProcessEnv): Array<{
  command: string | undefined;
  source: DesktopGitCandidateSource;
}> {
  return [
    { command: env[GIT_COMMAND_ENV]?.trim(), source: "env" },
    { command: "git", source: "path" },
    { command: "/opt/homebrew/bin/git", source: "homebrew" },
    { command: "/usr/local/bin/git", source: "homebrew" },
    { command: path.join(os.homedir(), ".local/bin/git"), source: "user" },
    { command: path.join(os.homedir(), "bin/git"), source: "user" },
    { command: "/usr/bin/git", source: "xcode" },
  ];
}

async function buildGitCandidate(
  input: { command: string | undefined; source: DesktopGitCandidateSource },
  options: {
    env: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
  },
): Promise<DesktopGitDiscoveryCandidate | undefined> {
  const candidate = await buildCommandDiscoveryCandidate<DesktopGitCandidateSource>(
    input,
    {
      env: options.env,
      platform: options.platform,
      parseVersion: parseGitVersionOutput,
    },
  );
  if (!candidate) {
    return undefined;
  }

  if (candidate.version) {
    return candidate;
  }

  const failureReason =
    candidate.versionFailureReason
    ?? candidate.failureReason
    ?? "version_not_reported";
  return {
    ...candidate,
    executable: false,
    failureReason,
    versionFailureReason: undefined,
  };
}

function dedupeGitCandidates(
  candidates: Array<DesktopGitDiscoveryCandidate | undefined>,
): DesktopGitDiscoveryCandidate[] {
  const deduped: DesktopGitDiscoveryCandidate[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate.command)) {
      continue;
    }
    seen.add(candidate.command);
    deduped.push(candidate);
  }
  return deduped;
}

export async function discoverGitCommands(params?: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): Promise<DesktopGitDiscoverySnapshot> {
  const env = params?.env ?? process.env;
  const candidates = dedupeGitCandidates(
    await Promise.all(
      gitCandidateInputs(env).map((candidate) =>
        buildGitCandidate(candidate, {
          env,
          platform: params?.platform,
        }),
      ),
    ),
  );
  const selected =
    candidates.find((candidate) => candidate.source === "env" && candidate.executable)
    ?? candidates.find((candidate) => candidate.executable);

  if (selected) {
    selected.selected = true;
  }

  return {
    selectedCommand: selected?.command,
    selectedSource: selected?.source,
    candidates,
  };
}
