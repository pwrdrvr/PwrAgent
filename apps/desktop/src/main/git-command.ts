/** Explicit operator selection. Undefined means the bundled runtime. */
export type GitCommandResolver = () => string | undefined;
let resolver: GitCommandResolver | undefined;
export function setGitCommandResolver(next: GitCommandResolver | undefined): void {
  resolver = next;
}
export function getConfiguredGitCommand(): string | undefined {
  return resolver?.()?.trim() || undefined;
}
