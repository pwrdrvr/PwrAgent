import { runGitCommand } from "../app-server/git-executable";

const GIT_OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;

/**
 * The commit checked out where a thread works on a PR, when it is past the
 * head the status cache last saw: a push the forge has not reported yet.
 *
 * Undefined when the checkout is at that head, is on another branch, does
 * not contain it, was never pushed, or Git cannot tell. The first directory
 * on the PR's branch decides.
 */
export async function readLocalHeadPastPrHead(params: {
  directories: readonly string[];
  cachedHeadSha: string;
  /** The PR's head branch. A checkout on another branch is not this PR's. */
  headRefName?: string;
  timeoutMs?: number;
}): Promise<string | undefined> {
  const options = { timeout: params.timeoutMs ?? 5_000 };
  const cachedHeadSha = params.cachedHeadSha.trim().toLowerCase();
  if (!GIT_OBJECT_ID.test(cachedHeadSha)) return undefined;
  for (const cwd of params.directories) {
    let head: string;
    try {
      const { stdout } = await runGitCommand(
        cwd,
        ["rev-parse", "HEAD", "--abbrev-ref", "HEAD"],
        options,
      );
      const [sha, branch] = stdout.trim().split(/\r?\n/);
      if (!sha || !GIT_OBJECT_ID.test(sha)) continue;
      if (params.headRefName && branch !== params.headRefName) continue;
      head = sha.toLowerCase();
    } catch {
      continue;
    }
    if (head === cachedHeadSha) return undefined;
    try {
      // Exits 0 only when the cached head is an ancestor of HEAD. A checkout
      // behind the PR, or one that never fetched its head, is not ahead.
      await runGitCommand(
        cwd,
        ["merge-base", "--is-ancestor", cachedHeadSha, head],
        options,
      );
    } catch {
      return undefined;
    }
    // A local commit is a push only once a remote-tracking ref holds it. An
    // unpushed commit never reaches the forge, so its CI result never comes.
    return await isOnRemoteTrackingRef({
      cwd,
      head,
      ...(params.headRefName ? { headRefName: params.headRefName } : {}),
      options,
    })
      ? head
      : undefined;
  }
  return undefined;
}

/**
 * Whether a remote-tracking ref contains `head`. With a branch name, only a
 * ref for that branch counts, on any remote: a fork PR pushes to the fork.
 */
async function isOnRemoteTrackingRef(params: {
  cwd: string;
  head: string;
  headRefName?: string;
  options: { timeout: number };
}): Promise<boolean> {
  try {
    const { stdout } = await runGitCommand(
      params.cwd,
      ["for-each-ref", "--contains", params.head, "--format=%(refname)", "refs/remotes/"],
      params.options,
    );
    // refs/remotes/<remote>/<branch>; the remote's HEAD alias is no branch.
    const branches = stdout
      .split(/\r?\n/)
      .map((ref) => ref.trim().slice("refs/remotes/".length).split("/").slice(1).join("/"))
      .filter((branch) => branch.length > 0 && branch !== "HEAD");
    return params.headRefName === undefined
      ? branches.length > 0
      : branches.includes(params.headRefName);
  } catch {
    return false;
  }
}
