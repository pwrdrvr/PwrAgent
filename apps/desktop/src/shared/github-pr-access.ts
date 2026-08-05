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

export function githubPrAccessTargetKey(target: GithubPrAccessTarget): string {
  return `github:${target.owner.toLowerCase()}/${target.repo.toLowerCase()}`;
}
