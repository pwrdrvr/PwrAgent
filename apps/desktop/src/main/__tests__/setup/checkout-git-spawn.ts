// Classifies a child-process launch as Git reading the repository checkout the
// suite runs in. Pure, so `checkout-git-spawn-guard.test.ts` can state the rule
// as a property without spawning anything; the guard in
// `checkout-git-spawn-guard.ts` applies it to every real launch.
import path from "node:path";

export type GitSpawn = {
  /** Every argument, starting with argv0, as `ChildProcess#spawn` sees it. */
  args: readonly string[];
  /** The directory the child starts in; `undefined` means the parent's. */
  cwd?: string;
  /** The executable launched. */
  file: string;
};

/** `git`, `/usr/bin/git`, `C:\Program Files\Git\cmd\git.exe`, … */
export function isGitExecutable(file: string): boolean {
  const basename = file.split(/[\\/]/).pop() ?? "";
  return /^git(\.exe)?$/i.test(basename);
}

/**
 * Commands that never open a repository, so their starting directory is
 * irrelevant. `git --version` from the checkout reads nothing in it.
 */
const REPOSITORY_FREE_COMMANDS = new Set(["help", "version"]);

/** Global options that consume the following argument. */
const OPTIONS_WITH_VALUE = new Set([
  "-c",
  "--config-env",
  "--exec-path",
  "--namespace",
  "--super-prefix",
]);

/**
 * The directories a Git launch would treat as its repository: the `-C` chain
 * applied to the starting directory, plus any explicit `--git-dir` and
 * `--work-tree`. Returns an empty list for a launch that is not Git or that
 * never opens a repository.
 */
export function gitRepositoryTargets(
  spawn: GitSpawn,
  parentCwd: string,
): string[] {
  if (!isGitExecutable(spawn.file)) {
    return [];
  }
  const args = spawn.args.slice(1);
  let directory = path.resolve(parentCwd, spawn.cwd ?? ".");
  const explicit: string[] = [];
  let command: string | undefined;
  let index = 0;
  for (; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-C") {
      directory = path.resolve(directory, args[index + 1] ?? ".");
      index += 1;
    } else if (arg === "--git-dir" || arg === "--work-tree") {
      explicit.push(args[index + 1] ?? ".");
      index += 1;
    } else if (arg.startsWith("--git-dir=") || arg.startsWith("--work-tree=")) {
      explicit.push(arg.slice(arg.indexOf("=") + 1));
    } else if (OPTIONS_WITH_VALUE.has(arg)) {
      index += 1;
    } else if (!arg.startsWith("-")) {
      command = arg;
      break;
    }
  }
  if (command === undefined || REPOSITORY_FREE_COMMANDS.has(command)) {
    return [];
  }
  if (command === "init" || command === "clone") {
    // These create a repository instead of opening the one they start in.
    // The target is the directory they write: the final argument when it is
    // a path (`git init <dir>`, `git clone <source> <dir>`), else where they
    // start. `git clone <source>` alone is read as `<source>`.
    const last = args[args.length - 1];
    if (index < args.length - 1 && !last.startsWith("-")) {
      directory = path.resolve(directory, last);
    }
  }
  return [directory, ...explicit.map((entry) => path.resolve(directory, entry))];
}

/**
 * The first repository target inside `repositoryRoot` (or equal to it), or
 * `undefined` when the launch stays out of the checkout. `resolve` maps a path
 * to its realpath; the root must already be resolved.
 */
export function checkoutGitTarget(
  spawn: GitSpawn,
  options: {
    parentCwd: string;
    repositoryRoot: string;
    resolve: (target: string) => string;
  },
): string | undefined {
  return gitRepositoryTargets(spawn, options.parentCwd).find((target) =>
    isSameOrWithin(options.repositoryRoot, options.resolve(target)));
}

function isSameOrWithin(root: string, candidate: string): boolean {
  // Windows paths compare without case; POSIX paths are compared as written.
  const fold = (value: string) =>
    process.platform === "win32" ? value.toLowerCase() : value;
  const relative = path.relative(fold(root), fold(candidate));
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}
