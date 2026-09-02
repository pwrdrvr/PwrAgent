/**
 * The operator's chosen `git`, for every main-process git spawn.
 *
 * Before this existed, all eight direct git spawns used the bare word
 * `"git"` and let `PATH` decide, and `resolveGitExecutable` walked only
 * the hard-coded discovery candidates. That made the Settings git picker
 * decoration: an operator could see that Apple's git and Homebrew's git
 * were both installed, and selecting one would have changed a label and
 * nothing else.
 *
 * The resolver is a pull, not a push. `DesktopSettingsService` owns the
 * env-override / config precedence and reads it from an in-memory config
 * store, so asking it per spawn costs nothing and can never serve a value
 * a config write has already superseded. Until `setGitCommandResolver` is
 * installed — early main-process startup, and every unit test that does
 * not care — there is no preference and callers fall back to exactly the
 * behaviour this replaced.
 */
export type GitCommandResolver = () => string | undefined;

const DEFAULT_GIT_COMMAND = "git";

let resolver: GitCommandResolver | undefined;

export function setGitCommandResolver(next: GitCommandResolver | undefined): void {
  resolver = next;
}

/**
 * The configured or env-overridden git path, or `undefined` when the
 * operator has expressed no preference. Callers that build a candidate
 * list want this, so they can keep their own fallbacks behind it.
 */
export function getConfiguredGitCommand(): string | undefined {
  try {
    return resolver?.()?.trim() || undefined;
  } catch {
    // A git spawn must not fail because settings could not be read.
    return undefined;
  }
}

/** The command to spawn, falling back to `PATH` resolution of `git`. */
export function getGitCommand(): string {
  return getConfiguredGitCommand() ?? DEFAULT_GIT_COMMAND;
}
