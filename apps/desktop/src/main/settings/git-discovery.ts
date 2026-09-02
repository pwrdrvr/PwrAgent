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
  configuredCommand?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): Promise<DesktopGitDiscoverySnapshot> {
  const env = params?.env ?? process.env;
  const configuredCommand = params?.configuredCommand?.trim();
  const build = (input: {
    command: string | undefined;
    source: DesktopGitCandidateSource;
  }): Promise<DesktopGitDiscoveryCandidate | undefined> =>
    buildGitCandidate(input, { env, platform: params?.platform });

  const discovered = await Promise.all(gitCandidateInputs(env).map(build));
  // A configured path that is already one of the well-known locations
  // stays under the source that names it, so the row keeps reading
  // "Apple Git" rather than the far less useful "config". The extra
  // candidate exists only for a path discovery would never have found.
  const configured = configuredCommand
    ? await build({ command: configuredCommand, source: "config" })
    : undefined;
  const configuredIsNew =
    configured
    && !discovered.some((candidate) => candidate?.command === configured.command);

  const candidates = dedupeGitCandidates([
    ...discovered.slice(0, 1),
    ...(configuredIsNew ? [configured] : []),
    ...discovered.slice(1),
  ]);

  const selected =
    candidates.find((candidate) => candidate.source === "env" && candidate.executable)
    ?? (configured
      ? candidates.find(
          (candidate) =>
            candidate.command === configured.command && candidate.executable,
        )
      : undefined)
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

/**
 * Probes one operator-chosen path the same way discovery probes a
 * well-known one, so the manual picker can reject a file that does not
 * answer `git --version` before it is written to config.
 */
export async function validateGitCommand(params: {
  command: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): Promise<DesktopGitDiscoveryCandidate> {
  const candidate = await buildGitCandidate(
    { command: params.command, source: "config" },
    { env: params.env ?? process.env, platform: params.platform },
  );
  if (!candidate) {
    throw new Error("No git path was selected.");
  }
  return candidate;
}
