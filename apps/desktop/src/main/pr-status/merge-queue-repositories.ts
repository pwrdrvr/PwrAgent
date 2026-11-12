/**
 * The GitHub repositories PwrAgent has seen merge through a merge queue.
 *
 * A merge in a repository not on this list runs exactly as it did before
 * merge queues were supported, with no extra request. A repository joins the
 * list for free: the status poller already reads `isMergeQueueEnabled` with
 * every PR, and a direct merge that GitHub refuses for want of the queue adds
 * it on the spot. Only a listed repository reads the queue before a merge.
 *
 * In memory only: the poller learns it again within a round of a restart.
 * Never removed: a repository that turns its queue off costs one queue read
 * per merge, which then merges directly.
 */
const repositories = new Set<string>();

function repositoryKey(host: string, owner: string, repo: string): string {
  return `${host}/${owner}/${repo}`.toLowerCase();
}

export function noteMergeQueueRepository(host: string, owner: string, repo: string): void {
  repositories.add(repositoryKey(host, owner, repo));
}

export function isMergeQueueRepository(host: string, owner: string, repo: string): boolean {
  return repositories.has(repositoryKey(host, owner, repo));
}

/** For tests: start from a process that has seen no queue. */
export function forgetMergeQueueRepositories(): void {
  repositories.clear();
}

/**
 * Whether a forge message is about a merge queue or merge train: GitHub's
 * refusal of a direct merge ("Changes must be made through the merge queue"),
 * or `gh pr merge` saying it queued the PR instead of merging it.
 */
export function mentionsMergeQueue(message: string): boolean {
  return /merge queue|merge train/i.test(message);
}
