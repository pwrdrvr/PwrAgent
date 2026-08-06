export type GithubPrAccessTarget = {
  kind: "github-repository";
  owner: string;
  repo: string;
};

export type GithubPrSamlEnforcementEvent = {
  branch?: string;
  occurredAt: number;
  target: GithubPrAccessTarget;
};

export type GithubPrAuthenticationFailureEvent = {
  occurredAt: number;
  detail?: string;
};

export function githubPrAccessTargetKey(target: GithubPrAccessTarget): string {
  return `github:${target.owner.toLowerCase()}/${target.repo.toLowerCase()}`;
}
