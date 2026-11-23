import { branchRef, isOid, type StackGit } from "./git";

export type StackPublishMove = {
  branch: string;
  /** Exact remote head observed before planning the replay. */
  expected: string;
  /** Local input to the replay, or the current tip for a fast-forward. */
  previous: string;
  next: string;
};

/** A rewrite can replace only history proven to have been in its local input. */
export async function pushStackLayers(git: StackGit, remote: string, moves: readonly StackPublishMove[]): Promise<void> {
  const changed = moves.filter(({ expected, next }) => expected !== next);
  if (!changed.length) return;
  for (const { branch, expected, previous, next } of changed) {
    if (![expected, previous, next].every(isOid) || await git.tip(branch) !== next
      || !await git.ancestor(expected, previous)) {
      throw new Error(`Cannot publish ${branch}: its local or remote history changed`);
    }
  }
  await git.output(["push", "--atomic", "--no-follow-tags", "--recurse-submodules=no",
    ...changed.map(({ branch, expected }) => `--force-with-lease=${branchRef(branch)}:${expected}`),
    "--", remote, ...changed.map(({ branch, next }) => `${next}:${branchRef(branch)}`),
  ]);
}
