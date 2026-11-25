/**
 * The repositories whose PR labels the GitHub status poll reads: those a
 * project's Forge Automation names in a hands-off rule with a label pattern
 * (`handsOffLabelRepositories`).
 *
 * Labels are a connection, so reading them costs GraphQL rate-limit points.
 * A PR in any other repository is polled exactly as before, with no labels.
 * The owner replaces the set whenever the Forge Automation index changes.
 */
let repositories: ReadonlySet<string> = new Set();

export function setHandsOffLabelRepositories(next: Iterable<string>): void {
  repositories = new Set([...next].map((repository) => repository.toLowerCase()));
}

export function readsHandsOffLabels(owner: string, repo: string): boolean {
  return repositories.size > 0 && repositories.has(`${owner}/${repo}`.toLowerCase());
}

/** For tests: start from a process with no hands-off label rules. */
export function forgetHandsOffLabelRepositories(): void {
  repositories = new Set();
}
