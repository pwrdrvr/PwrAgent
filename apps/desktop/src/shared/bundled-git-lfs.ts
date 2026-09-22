/**
 * PwrAgent's bundled Git LFS set this repository up, and the operator's own
 * Git cannot push it: their PATH carries no git-lfs for the hooks to find.
 */
export type BundledGitLfsAdvisoryEvent = {
  occurredAt: number;
  repositoryPath: string;
};
