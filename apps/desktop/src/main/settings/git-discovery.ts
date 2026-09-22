import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { bundledGitEnvironment, bundledGitExecutable, validateBundledGit } from "../bundled-git";
import { customGitEnvironment, GIT_COMMAND_ENV } from "../git-runtime";
export { GIT_COMMAND_ENV } from "../git-runtime";
import path from "node:path";
import type {
  DesktopGitCandidateSource,
  DesktopGitDiscoveryCandidate,
  DesktopGitDiscoverySnapshot,
} from "@pwragent/shared";
import { buildCommandDiscoveryCandidate } from "./command-discovery";

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
  const probeEnv = input.source === "bundled" ? bundledGitEnvironment(options.env) : customGitEnvironment(options.env, input.command ?? "git");
  const candidate = await buildCommandDiscoveryCandidate<DesktopGitCandidateSource>(
    input,
    {
      env: probeEnv,
      platform: options.platform,
      parseVersion: parseGitVersionOutput,
    },
  );
  if (!candidate) {
    return undefined;
  }

  if (candidate.version) {
    try {
      if (input.source === "bundled") await validateBundledGit();
      const { stdout } = await promisify(execFile)(candidate.command, ["lfs", "version"], {
        env: probeEnv, cwd: os.tmpdir(), timeout: 5000, maxBuffer: 64 * 1024,
        encoding: "utf8", windowsHide: true,
      });
      const lfsVersion = stdout.match(/git-lfs\/([^\s]+)/)?.[1];
      if (!lfsVersion) throw new Error("Git LFS did not report a version.");
      return { ...candidate, lfsVersion };
    } catch {
      return { ...candidate, executable: false, failureReason: "Git LFS is unavailable for this Git installation." };
    }
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

  const inputs = gitCandidateInputs(env);
  const candidates = dedupeGitCandidates(await Promise.all([
    build(inputs[0]),
    build({ command: configuredCommand, source: "config" }),
    build({ command: bundledGitExecutable(), source: "bundled" }),
    ...inputs.slice(1).map(build),
  ]));
  const requested = env[GIT_COMMAND_ENV]?.trim() || configuredCommand || bundledGitExecutable();
  // An explicit but broken selection remains selected; never silently switch.
  const selected = candidates.find((candidate) => candidate.command === requested)
    ?? candidates.find((candidate) => candidate.source === (env[GIT_COMMAND_ENV]?.trim() ? "env" : configuredCommand ? "config" : "bundled"));
  if (selected) selected.selected = true;
  return { selectedCommand: selected?.command, selectedSource: selected?.source, candidates };
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
