import type { WorktreeReflinkCapabilities } from "@pwragent/shared/contracts/worktree-reflink";

export const NO_WORKTREE_REFLINK_CAPABILITIES: WorktreeReflinkCapabilities = Object.freeze({
  reflink: false,
  verifyFilters: false,
});

/**
 * One row of Git's option list for a long option, as parse-options prints it:
 * indented, an optional short alias, then `--name` or `--[no-]name`.
 *
 * Only a row counts. The usage synopsis of 2.56.1-dev-pwrgit.2 also says
 * `[-n | --verify-filters]`, and a description or an "unknown option" error
 * can name an option the command does not take.
 */
function listsOption(help: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^[ \\t]{1,8}(?:-[A-Za-z0-9], )?--(?:\\[no-\\])?${escaped}(?=[ \\t=\\[]|$)`,
    "m",
  ).test(help);
}

/**
 * Capabilities from the output of `git worktree reflink -h`.
 *
 * A Git without the subcommand prints the usage of every other `git worktree`
 * subcommand, so the usage line must name `reflink`, and each option PwrAgent
 * passes must have its own row. `--verify-filters` is offered only with the
 * command itself: its row under some other usage means nothing.
 */
export function parseWorktreeReflinkHelp(help: string): WorktreeReflinkCapabilities {
  const text = help.replace(/\r\n?/g, "\n");
  const reflink = /^usage: git worktree reflink(?=[ \t]|$)/m.test(text)
    && listsOption(text, "dry-run")
    && listsOption(text, "porcelain");
  return {
    reflink,
    verifyFilters: reflink && listsOption(text, "verify-filters"),
  };
}

/** Whether Git answered `-h` with a usage, for this subcommand or its siblings. */
export function isGitUsage(help: string): boolean {
  return /^usage: git /m.test(help);
}

/**
 * The Git a capability answer describes. `key` covers the selection and the
 * binary it resolved to, so it changes on Use, Roll back, a manual path, and
 * a new binary installed over the old path.
 */
export type GitRuntimeIdentity = {
  key: string;
  /** Absent when the selected Git cannot be resolved. */
  executable?: string;
};

export type WorktreeReflinkProbeResult<Identity extends GitRuntimeIdentity = GitRuntimeIdentity> = {
  identity: Identity;
  capabilities: WorktreeReflinkCapabilities;
};

export type WorktreeReflinkProbeDependencies<Identity extends GitRuntimeIdentity> = {
  /** The Git selected right now. */
  identify: () => Promise<Identity>;
  /**
   * Both output streams of `git worktree reflink -h`, run with that
   * identity's own executable inside `cwd`. The exit code carries nothing.
   */
  readHelp: (identity: Identity, cwd: string) => Promise<string>;
};

/** Selection changes under a probe are rare; this only bounds a pathological loop. */
const MAX_PROBE_ATTEMPTS = 4;

/**
 * Capabilities of the selected Git, probed once per Git.
 *
 * The rule: an answer is returned or kept only for the identity whose own
 * executable printed the help, and only when that identity was selected both
 * before and after the help was read. A probe that finishes after the
 * selection moved is discarded and the new selection is probed. When the
 * help cannot be read, or the selection never settles, the answer is "no
 * capabilities" and is not kept.
 */
export class WorktreeReflinkCapabilityProbe<Identity extends GitRuntimeIdentity = GitRuntimeIdentity> {
  private cached?: WorktreeReflinkProbeResult<Identity>;
  private epoch = 0;

  constructor(private readonly dependencies: WorktreeReflinkProbeDependencies<Identity>) {}

  /** Drop the kept answer and reject any probe already running. */
  invalidate(): void {
    this.cached = undefined;
    this.epoch += 1;
  }

  async read(cwd: string): Promise<WorktreeReflinkProbeResult<Identity>> {
    let identity = await this.dependencies.identify();
    for (let attempt = 0; attempt < MAX_PROBE_ATTEMPTS; attempt += 1) {
      // The capabilities are this Git's for good. The identity is the one just
      // read: it carries the environment to run with now, not the one the
      // probe ran with.
      if (this.cached?.identity.key === identity.key) {
        return { identity, capabilities: this.cached.capabilities };
      }
      const epoch = this.epoch;
      let capabilities: WorktreeReflinkCapabilities;
      try {
        if (!identity.executable) throw new Error("The selected Git is unavailable.");
        const help = await this.dependencies.readHelp(identity, cwd);
        // Outside a repository Git prints `fatal: not a git repository` and
        // no usage at all. That says nothing about what this Git can do.
        if (!isGitUsage(help)) throw new Error("Git printed no usage.");
        capabilities = parseWorktreeReflinkHelp(help);
      } catch {
        // Nothing to offer, and nothing learned about this Git: a timeout or
        // a directory that stopped being a repository must not be remembered.
        return { identity, capabilities: NO_WORKTREE_REFLINK_CAPABILITIES };
      }
      const current = await this.dependencies.identify();
      if (current.key === identity.key && epoch === this.epoch) {
        const result = { identity, capabilities };
        this.cached = result;
        return result;
      }
      identity = current;
    }
    return { identity, capabilities: NO_WORKTREE_REFLINK_CAPABILITIES };
  }
}
