/** Explicit operator selection. Undefined means the bundled runtime. */
export type GitCommandResolver = () => string | undefined;
let resolver: GitCommandResolver | undefined;
export function setGitCommandResolver(next: GitCommandResolver | undefined): void {
  resolver = next;
}
export function getConfiguredGitCommand(): string | undefined {
  return resolver?.()?.trim() || undefined;
}

/**
 * The downloaded PwrDrvr Git release the operator chose with Use, by its
 * generation id. Consulted only when no explicit command (environment or
 * manual path) is set; undefined means the bundled runtime.
 */
export type ManagedGitSelectionResolver = () => string | undefined;
let managedResolver: ManagedGitSelectionResolver | undefined;
export function setManagedGitSelectionResolver(next: ManagedGitSelectionResolver | undefined): void {
  managedResolver = next;
}
export function getSelectedManagedGit(): string | undefined {
  return managedResolver?.()?.trim() || undefined;
}
