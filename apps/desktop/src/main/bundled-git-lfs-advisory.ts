import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { installedGitLfs } from "./bundled-git";
import { gitCommandPreference } from "./git-runtime";

/**
 * Warn once when PwrAgent's bundled Git LFS has set a repository up that the
 * operator's own Git then cannot push.
 *
 * The bundle configures the LFS filter, and git-lfs installs its hooks into
 * the repository the first time that filter runs. Those hooks are shared with
 * every worktree and with the operator's own checkout, and each one begins by
 * requiring `git-lfs` on PATH. PwrAgent always satisfies that; a shell without
 * an installed git-lfs does not, so `git push` there fails with an exit code
 * and a message about a repository "configured for Git LFS".
 *
 * Detection runs after the Git commands that can install those hooks, once per
 * working directory. A repository only the agent's own Git commands touch is
 * seen the next time PwrAgent itself runs one of them there; Settings → Git
 * carries the same warning for an operator who never hits this path.
 */
export type BundledGitLfsAdvisory = (repositoryPath: string) => void;

let publish: BundledGitLfsAdvisory | undefined;
const inspected = new Set<string>();

export function setBundledGitLfsAdvisory(next: BundledGitLfsAdvisory | undefined): void {
  publish = next;
  inspected.clear();
}

/** Git commands that can run the LFS filter, and so install its hooks. */
const HOOK_INSTALLING_COMMANDS = new Set([
  "add",
  "checkout",
  "clone",
  "commit",
  "merge",
  "pull",
  "reset",
  "restore",
  "stash",
  "switch",
  "worktree",
]);

export function noteBundledGitCommand(
  cwd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): void {
  if (!publish || !cwd || inspected.has(cwd)) return;
  if (!args.some((arg) => HOOK_INSTALLING_COMMANDS.has(arg))) return;
  // One entry per working directory PwrAgent has checked, cleared wholesale
  // rather than grown without bound. A repeat check costs a few stats.
  if (inspected.size > 256) inspected.clear();
  inspected.add(cwd);
  try {
    // An operator running their own Git keeps their own Git LFS setup, and
    // PwrAgent's bundled filter is not configured for it.
    if (gitCommandPreference(env)) return;
    const repositoryPath = repositoryWithLfsHooks(cwd);
    // The hooks' own test: `command -v git-lfs` against the operator's PATH.
    if (!repositoryPath || installedGitLfs(env)) return;
    publish(repositoryPath);
  } catch {
    // An advisory must never fail the Git command that triggered it.
  }
}

function repositoryWithLfsHooks(cwd: string): string | undefined {
  const repository = resolveRepository(cwd);
  if (!repository) return undefined;
  const hook = path.join(repository.commonDir, "hooks", "pre-push");
  if (!existsSync(hook)) return undefined;
  return readFileSync(hook, "utf8").includes("git lfs")
    ? repository.repositoryPath
    : undefined;
}

/**
 * The common `.git` directory and the checkout that owns it. A worktree's
 * `.git` is a file pointing into `<common>/worktrees/<name>`, and the hooks
 * that break the operator's push live in the common directory they share.
 */
function resolveRepository(
  cwd: string,
): { commonDir: string; repositoryPath: string } | undefined {
  let current = path.resolve(cwd);
  for (;;) {
    const dotGit = path.join(current, ".git");
    if (existsSync(dotGit)) {
      if (statSync(dotGit).isDirectory()) {
        return { commonDir: dotGit, repositoryPath: current };
      }
      const gitdir = readFileSync(dotGit, "utf8").match(/^\s*gitdir:\s*(.+?)\s*$/m)?.[1];
      if (!gitdir) return undefined;
      const linked = path.resolve(current, gitdir);
      const commonDir = /[\\/]worktrees[\\/][^\\/]+$/.test(linked)
        ? path.dirname(path.dirname(linked))
        : linked;
      return { commonDir, repositoryPath: path.dirname(commonDir) };
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}
