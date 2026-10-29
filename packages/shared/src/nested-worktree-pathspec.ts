/**
 * A checkout can hold another linked worktree of the same repository inside
 * it (Claude Code creates them under `.claude/worktrees/`). `git status`
 * reports that directory as untracked, but it is another checkout, not
 * content of this one. These helpers drop it with pathspec excludes.
 *
 * An independent repository nested in the checkout is not a worktree of this
 * repository, so it is not excluded and keeps showing as untracked.
 */

const EXCLUDE_MAGIC = ":(exclude,top,literal)";

function normalizeWorktreePath(value: string): string {
  const slashed = value.trim().replace(/\\/g, "/");
  const trimmed = slashed.replace(/\/+$/, "");
  // Keep a filesystem root ("/" or "C:/") recognizable as a directory.
  if (!trimmed) return slashed ? "/" : "";
  return /^[a-z]:$/i.test(trimmed) ? `${trimmed}/` : trimmed;
}

/** Windows paths compare without case; POSIX paths compare exactly. */
function comparablePath(value: string): string {
  return /^[a-z]:\//i.test(value) || value.startsWith("//") ? value.toLowerCase() : value;
}

function directoryPrefix(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function isSameOrInside(parent: string, child: string): boolean {
  const comparableParent = comparablePath(parent);
  const comparableChild = comparablePath(child);
  return comparableChild === comparableParent
    || comparableChild.startsWith(directoryPrefix(comparableParent));
}

/** Worktree paths from `git worktree list --porcelain`, with or without `-z`. */
export function parseWorktreeListPaths(porcelain: string): string[] {
  const fields = porcelain.includes("\0") ? porcelain.split("\0") : porcelain.split(/\r?\n/);
  return fields
    .filter((field) => field.startsWith("worktree "))
    .map((field) => field.slice("worktree ".length));
}

/**
 * One `:(exclude,top,literal)<path>` pathspec for each worktree strictly
 * inside `toplevel`, relative to it. `toplevel` itself and worktrees outside
 * it, including siblings that share its name as a prefix, produce nothing.
 */
export function nestedWorktreeExcludePathspecs(params: {
  toplevel: string;
  worktreePaths: string[];
}): string[] {
  const top = normalizeWorktreePath(params.toplevel);
  if (!top) return [];
  const prefix = directoryPrefix(top);
  const excludes = new Set<string>();
  for (const worktreePath of params.worktreePaths) {
    const candidate = normalizeWorktreePath(worktreePath);
    if (!comparablePath(candidate).startsWith(comparablePath(prefix))) continue;
    const relative = candidate.slice(prefix.length);
    if (relative) excludes.add(`${EXCLUDE_MAGIC}${relative}`);
  }
  return [...excludes].sort();
}

/**
 * The worktree that holds `cwd`: the deepest registered worktree that is
 * `cwd` or one of its ancestors. Undefined when none is.
 */
export function containingWorktreePath(cwd: string, worktreePaths: string[]): string | undefined {
  const target = normalizeWorktreePath(cwd);
  if (!target) return undefined;
  let best: string | undefined;
  for (const worktreePath of worktreePaths) {
    const candidate = normalizeWorktreePath(worktreePath);
    if (candidate && isSameOrInside(candidate, target) && (!best || candidate.length > best.length)) {
      best = candidate;
    }
  }
  return best;
}

/**
 * Pathspec arguments for `git status` that keep the whole checkout in scope
 * minus the nested worktrees. Empty when there is nothing to exclude, so the
 * command runs exactly as before.
 */
export function nestedWorktreePathspecArgs(excludes: string[]): string[] {
  return excludes.length > 0 ? ["--", ":(top)", ...excludes] : [];
}

/**
 * True when porcelain v1 output (with or without `-z`) reports an untracked
 * directory. A nested worktree only ever appears that way, as `?? dir/`,
 * under `-unormal` and `-uall` alike.
 */
export function statusReportsUntrackedDirectory(porcelainV1: string): boolean {
  const records = porcelainV1.includes("\0") ? porcelainV1.split("\0") : porcelainV1.split(/\r?\n/);
  // Without -z, Git quotes a path with unusual characters: `?? "a b/"`.
  return records.some((record) => record.startsWith("?? ") && /\/"?$/.test(record));
}

type GitTextRunner = (args: string[]) => Promise<string>;

/**
 * Read the excludes for the checkout that holds `cwd`. Any failed probe means
 * no excludes, so the status reads as it always did. `realpath` resolves both
 * sides alike when the caller can reach a filesystem; Git already reports
 * real paths for its worktrees.
 */
async function readNestedWorktreeExcludes(options: {
  cwd: string;
  git: GitTextRunner;
  realpath?: (value: string) => Promise<string>;
}): Promise<string[]> {
  try {
    const worktreePaths = parseWorktreeListPaths(
      await options.git(["worktree", "list", "--porcelain", "-z"]),
    );
    if (worktreePaths.length < 2) return [];
    const resolve = async (value: string): Promise<string> => {
      if (!options.realpath) return value;
      return await options.realpath(value).catch(() => value);
    };
    const [resolvedCwd, ...resolvedWorktrees] = await Promise.all(
      [options.cwd, ...worktreePaths].map(resolve),
    );
    const toplevel = containingWorktreePath(resolvedCwd!, resolvedWorktrees);
    return toplevel
      ? nestedWorktreeExcludePathspecs({ toplevel, worktreePaths: resolvedWorktrees })
      : [];
  } catch {
    return [];
  }
}

/**
 * Run a porcelain v1 `git status` that does not report linked worktrees of
 * this repository nested inside the checkout. `statusArgs` must not carry a
 * pathspec. Costs nothing extra unless the first status reports an untracked
 * directory; then one `git worktree list`, and a second status only when a
 * nested worktree exists.
 */
export async function readStatusWithoutNestedWorktrees(options: {
  cwd: string;
  git: GitTextRunner;
  statusArgs: string[];
  realpath?: (value: string) => Promise<string>;
}): Promise<string> {
  const output = await options.git(options.statusArgs);
  if (!statusReportsUntrackedDirectory(output)) return output;
  const excludes = await readNestedWorktreeExcludes(options);
  if (excludes.length === 0) return output;
  return await options.git([...options.statusArgs, ...nestedWorktreePathspecArgs(excludes)]);
}
