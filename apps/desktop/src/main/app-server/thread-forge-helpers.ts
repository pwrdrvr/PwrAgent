import { type PullRequestRepositoryRef } from "../pr-status/forge-reference";
import { normalizePullRequestProvider } from "@pwragent/shared";



export function parseGitRemoteRepositoryUrl(
  value: string | undefined,
): PullRequestRepositoryRef | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const sshMatch = /^git@([^:]+):(.+)$/.exec(trimmed);
  const rawPath = sshMatch ? sshMatch[2] : undefined;
  const provider = sshMatch?.[1]
    ? normalizePullRequestProvider(sshMatch[1])
    : undefined;
  if (rawPath && provider) {
    return parseGitRemotePath(provider, rawPath, `https://${provider}`);
  }
  try {
    const parsed = new URL(trimmed);
    return parseGitRemotePath(
      normalizePullRequestProvider(parsed.hostname),
      parsed.pathname,
      `${parsed.protocol}//${parsed.host}`,
    );
  } catch {
    return undefined;
  }
}

export function parseGitRemotePath(
  provider: string,
  rawPath: string,
  urlBase: string,
): PullRequestRepositoryRef | undefined {
  const segments = rawPath
    .replace(/^\/+/, "")
    .replace(/\.git$/i, "")
    .split("/")
    .filter(Boolean);
  if (segments.length < 2) {
    return undefined;
  }
  const repo = segments.at(-1);
  const org = segments.slice(0, -1).join("/");
  if (!org || !repo) {
    return undefined;
  }
  return { provider, org, repo, urlBase };
}

export function pullRequestRepositoryKey(ref: PullRequestRepositoryRef): string {
  return `${normalizePullRequestProvider(ref.provider)}/${ref.org.toLowerCase()}/${ref.repo.toLowerCase()}`;
}

export function normalizePositivePullRequestNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return undefined;
  }
  return value;
}
