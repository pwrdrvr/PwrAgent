import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GithubCommitAuthorIdentityProof } from "@pwragent/shared";
import type {
  GithubCommitAuthorIdentityRemoteCommit,
  GithubCommitAuthorIdentityTransport,
} from "./commit-author-identity-resolver.js";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 10_000;

export type GhCliCommitAuthorIdentityTransportOptions = {
  /** Override command discovery in tests or a non-desktop host. */
  resolveGhCommand?: () => Promise<string | undefined>;
  /** Override process execution in tests. No token is accepted or returned. */
  exec?: (command: string, args: string[]) => Promise<{ stdout: string }>;
  timeoutMs?: number;
};

/**
 * GitHub transport that delegates credentials to the configured `gh` CLI.
 *
 * This intentionally calls `gh api` instead of extracting `gh auth token` or
 * accepting a PAT. The resolver receives only a parsed commit response, so no
 * auth token can enter the persistent cache, public contract, or logs.
 */
export class GhCliCommitAuthorIdentityTransport
  implements GithubCommitAuthorIdentityTransport {
  private readonly resolveGhCommand: () => Promise<string | undefined>;
  private readonly exec: (command: string, args: string[]) => Promise<{ stdout: string }>;

  constructor(options: GhCliCommitAuthorIdentityTransportOptions = {}) {
    this.resolveGhCommand = options.resolveGhCommand ?? defaultResolveGhCommand;
    this.exec = options.exec ?? defaultExec(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  }

  async fetchCommit(
    proof: GithubCommitAuthorIdentityProof,
  ): Promise<GithubCommitAuthorIdentityRemoteCommit> {
    const command = await this.resolveGhCommand();
    if (!command) {
      throw new Error("gh CLI is unavailable");
    }
    const endpoint = [
      "repos",
      encodeURIComponent(proof.owner),
      encodeURIComponent(proof.repo),
      "commits",
      encodeURIComponent(proof.commitSha),
    ].join("/");
    const { stdout } = await this.exec(command, [
      "api",
      "--hostname",
      "github.com",
      endpoint,
      "--method",
      "GET",
      "--header",
      "Accept: application/vnd.github+json",
      "--header",
      "X-GitHub-Api-Version: 2022-11-28",
    ]);
    return parseGithubCommitResponse(JSON.parse(stdout));
  }
}

async function defaultResolveGhCommand(): Promise<string | undefined> {
  // Matches the configured-command discovery boundary used by PwrAgent's PR
  // integrations. Dynamic imports keep this transport usable in plain Node
  // tests without eagerly loading desktop settings/Electron dependencies.
  const [{ discoverGhCommands }, { getDesktopSettingsService }] = await Promise.all([
    import("../settings/gh-discovery.js"),
    import("../settings/desktop-settings-singleton.js"),
  ]);
  const discovery = await discoverGhCommands({
    configuredCommand: getDesktopSettingsService().resolveGhCommandPreference(),
    env: process.env,
  });
  return discovery.selectedCommand;
}

function defaultExec(
  timeoutMs: number,
): (command: string, args: string[]) => Promise<{ stdout: string }> {
  return async (command, args) => {
    const result = await execFileAsync(command, args, {
      timeout: Math.max(1, timeoutMs),
      maxBuffer: 1024 * 1024,
      encoding: "utf8",
    });
    return { stdout: result.stdout };
  };
}

function parseGithubCommitResponse(value: unknown): GithubCommitAuthorIdentityRemoteCommit {
  const response = asRecord(value);
  const commit = asRecord(response?.commit);
  const commitAuthor = asRecord(commit?.author);
  const githubAuthor = response?.author === null
    ? null
    : asRecord(response?.author);

  return {
    sha: readString(response?.sha),
    author: commitAuthor
      ? {
        name: readString(commitAuthor.name),
        email: readString(commitAuthor.email),
      }
      : undefined,
    githubAuthor: githubAuthor
      ? {
        login: readString(githubAuthor.login),
        avatarUrl: readString(githubAuthor.avatar_url),
      }
      : githubAuthor === null
        ? null
        : undefined,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
