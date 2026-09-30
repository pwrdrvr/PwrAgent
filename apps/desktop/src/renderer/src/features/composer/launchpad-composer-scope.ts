/**
 * Composer scopes for launchpads.
 *
 * `launchpad:<directoryKey>` is the directory's one editable draft. Once a
 * draft is submitted it starts a thread, which can take minutes while a
 * worktree and environment setup run. The starting thread moves to its own
 * scope, `launchpad:starting:<creationId>:<directoryKey>`, so follow-ups typed
 * while it starts stay with it and the directory's draft is free for the next
 * thread.
 *
 * A starting scope keeps the `launchpad:` prefix: the draft, queue, and
 * recovery stores treat it as a launchpad. It never resolves to the
 * directory's editable draft, which is what keeps a follow-up from being saved
 * as that directory's next prompt. Directory keys are `directory:` or
 * `workspace:` keys, so the `starting:` segment cannot collide with one.
 */
const LAUNCHPAD_SCOPE_PREFIX = "launchpad:";
const STARTING_LAUNCHPAD_SCOPE_PREFIX = "launchpad:starting:";

export function buildStartingLaunchpadComposerScopeKey(
  creationId: string,
  directoryKey: string,
): string {
  return `${STARTING_LAUNCHPAD_SCOPE_PREFIX}${creationId}:${directoryKey}`;
}

export function isStartingLaunchpadComposerScopeKey(scopeKey: string): boolean {
  return scopeKey.startsWith(STARTING_LAUNCHPAD_SCOPE_PREFIX);
}

/** The directory whose editable launchpad draft this scope is, if any. */
export function getEditableLaunchpadDirectoryKey(
  scopeKey: string,
): string | undefined {
  if (
    !scopeKey.startsWith(LAUNCHPAD_SCOPE_PREFIX)
    || isStartingLaunchpadComposerScopeKey(scopeKey)
  ) {
    return undefined;
  }
  return scopeKey.slice(LAUNCHPAD_SCOPE_PREFIX.length);
}

/** The directory a launchpad scope belongs to, editable or starting. */
export function getLaunchpadScopeDirectoryKey(
  scopeKey: string,
): string | undefined {
  if (isStartingLaunchpadComposerScopeKey(scopeKey)) {
    const rest = scopeKey.slice(STARTING_LAUNCHPAD_SCOPE_PREFIX.length);
    const separator = rest.indexOf(":");
    return separator < 0 ? undefined : rest.slice(separator + 1);
  }
  return getEditableLaunchpadDirectoryKey(scopeKey);
}
