/**
 * Whether the Codex installation a running app server was launched from is
 * still the one a launch would use now.
 *
 * A package manager can replace Codex under a running app server. Homebrew
 * repoints `/opt/homebrew/bin/codex` at the new Caskroom version and deletes
 * the old version's directory, companion helpers (`codex-code-mode-host`)
 * included. The process keeps running from its unlinked executable, so turns
 * still work, but every helper it spawns from beside that executable is gone:
 * Code Mode fails closed, and a restart is the only way back. npm and app
 * bundle updates replace files in place instead, which changes the file's
 * identity without changing its path.
 *
 * The rule, in full. A change is reported only for the same configured
 * command; a different command is a Settings selection change, which its own
 * lifecycle owns.
 *
 * - `executable-missing`: the file the server was launched from is gone.
 * - `executable-moved`: the command now resolves to a different file.
 * - `executable-replaced`: the same path now holds a different file (device,
 *   inode, size or modification time changed).
 *
 * Anything not known on either side is not evidence. Pure: no I/O.
 */
export type CodexExecutableIdentity = {
  /** The command as configured or discovered, before symlinks. */
  command: string;
  /** `command` with every symlink resolved; absent when it does not exist. */
  realPath?: string;
  dev?: number;
  ino?: number;
  size?: number;
  mtimeMs?: number;
  /** The Codex version, when the path or the server reported one. */
  version?: string;
};

export type CodexInstallationChangeReason =
  | "executable-missing"
  | "executable-moved"
  | "executable-replaced";

export function decideCodexInstallationChange(
  launched: CodexExecutableIdentity | undefined,
  current: CodexExecutableIdentity | undefined,
): CodexInstallationChangeReason | undefined {
  if (!launched?.realPath || !current || current.command !== launched.command) return undefined;
  if (!current.realPath) return "executable-missing";
  if (current.realPath !== launched.realPath) return "executable-moved";
  const differs = (left: number | undefined, right: number | undefined): boolean =>
    left !== undefined && right !== undefined && left !== right;
  if (differs(launched.dev, current.dev)
    || differs(launched.ino, current.ino)
    || differs(launched.size, current.size)
    || differs(launched.mtimeMs, current.mtimeMs)) {
    return "executable-replaced";
  }
  return undefined;
}

/** What one attempt to retire a replaced app server found. */
export type CodexAppServerRetirementOutcome =
  | { kind: "retired" }
  | { kind: "busy"; blocker: string };

/**
 * What a request to move new work onto a newly selected Codex found. A
 * selection change (a Settings path, a managed runtime switched on, off or
 * updated) asks every runtime for this; `selection` numbers the requests so
 * a runtime that already moved does not move again on a retry.
 *
 * - `promoted`: a new generation passed its handshake and takes new work; the
 *   old one drains.
 * - `restarted-lazily`: nothing was running; the next request starts the
 *   selected Codex.
 * - `current`: this runtime already serves that selection.
 * - `failed`: the new generation did not start; the old one keeps serving.
 * - `deferred`: a start for this selection failed recently; not retried yet.
 */
export type CodexAppServerRolloverOutcome =
  | { kind: "promoted"; generation: number }
  | { kind: "restarted-lazily" }
  | { kind: "current" }
  | { kind: "failed"; error: string }
  | { kind: "deferred"; retryAt: number };

/**
 * One outcome for several runtimes: the selection is applied only when every
 * runtime applied it. A failure outranks a deferral, which outranks success.
 */
export function combineCodexAppServerRolloverOutcomes(
  outcomes: readonly CodexAppServerRolloverOutcome[],
): CodexAppServerRolloverOutcome {
  const failed = outcomes.find((outcome) => outcome.kind === "failed");
  if (failed) return failed;
  const deferred = outcomes.filter(
    (outcome): outcome is Extract<CodexAppServerRolloverOutcome, { kind: "deferred" }> => outcome.kind === "deferred",
  );
  if (deferred.length > 0) {
    return { kind: "deferred", retryAt: Math.max(...deferred.map((outcome) => outcome.retryAt)) };
  }
  return outcomes.find((outcome) => outcome.kind === "promoted")
    ?? outcomes.find((outcome) => outcome.kind === "restarted-lazily")
    ?? { kind: "current" };
}
