import { realpath, stat as fsStat } from "node:fs/promises";
import path from "node:path";
import type { AppServerBackendKind, LinkedDirectorySummary } from "@pwragent/shared/contracts/normalized-app-server";
import type {
  EnsureDirectoryLaunchpadResponse,
  RegisterDirectoryFromDiskFailureReason,
  RegisterDirectoryFromDiskResponse,
} from "@pwragent/shared/contracts/agent";
import { canonicalizeNavigationPath, navigationPathIdentity } from "@pwragent/shared/directory-navigation";
import { parseWorktreeListPaths } from "@pwragent/shared/nested-worktree-pathspec";
import { runGitCommand } from "./git-executable";
import { buildWorktreeLinkedDirectory, toDirectoryId } from "./linked-directory-identity";

/**
 * Validate `path` and seed a launchpad for the project-directory
 * picker (issue #223 — "add a new directory" affordance in the new-thread
 * composer). The renderer hands us a path coming straight out of the
 * system "choose folder" dialog; we owe the renderer a structured
 * pass/fail result so the picker can render an inline error rather than
 * crashing or silently no-op'ing.
 *
 * Validation steps in order:
 *
 *   1. The path exists and is reachable. Failure → `inaccessible` (the
 *      OS dialog can in theory return paths we cannot stat, e.g. a stale
 *      bookmark or a permissions-blocked folder).
 *   2. The path resolves to a directory, not a file. Failure →
 *      `not-a-directory`.
 *
 * On success we call `ensureDirectoryLaunchpad` so the directory is
 * known to the launchpad layer immediately. Git detection is best effort:
 * repositories persist their primary checkout, and other folders persist
 * the selected path (issue #1750).
 */
export type DirectoryRegistrationDeps = {
  ensureDirectoryLaunchpad: (request: {
    directoryKey: string;
    directoryKind: "directory";
    directoryLabel: string;
    directoryPath: string;
    currentBranch?: string;
    preferredBackend?: AppServerBackendKind;
    registeredAt?: number;
  }) => Promise<EnsureDirectoryLaunchpadResponse>;
  listDirectoryLaunchpads?: ListDirectoryLaunchpads;
  /** Test seam — defaults to a real `git` execFile invocation. */
  runGit?: (cwd: string, args: string[]) => Promise<string>;
  /** Test seam — defaults to `node:fs` `stat`. */
  statPath?: (target: string) => Promise<{ isDirectory: () => boolean }>;
};

type ListDirectoryLaunchpads = () => Promise<readonly { directoryKey: string }[]>;

/** Keep a mapped drive, junction or link when realpath resolves a different path. */
async function folderInRealCase(folder: string): Promise<string> {
  const real = await realpath(folder).then(toDirectoryId, () => undefined);
  return real && navigationPathIdentity(real, true) === navigationPathIdentity(folder, true) ? real : folder;
}

/** Keep the key of an existing draft or registration so its metadata stays linked. */
export async function resolveDirectoryRegistrationKey(
  directoryPath: string,
  listDirectoryLaunchpads?: ListDirectoryLaunchpads,
): Promise<string> {
  const key = `directory:${directoryPath}`;
  if (process.platform !== "win32" || !listDirectoryLaunchpads) return key;

  const keys = (await listDirectoryLaunchpads()).map(({ directoryKey }) => directoryKey);
  if (keys.includes(key)) return key;
  const identity = navigationPathIdentity(key, true);
  const variants = keys.filter((existing) => navigationPathIdentity(existing, true) === identity).sort();
  if (variants.length === 0) return key;

  // Windows also supports case-sensitive directories. Confirm that the
  // legacy key still resolves to the same folder before reusing it.
  const real = await realpath(directoryPath).catch(() => undefined);
  if (!real) return key;
  for (const variant of variants) {
    const existing = await realpath(variant.slice("directory:".length)).catch(() => undefined);
    if (existing === real) return variant;
  }
  return key;
}

async function defaultRunGit(cwd: string, args: string[]): Promise<string> {
  return (await runGitCommand(cwd, args)).stdout.trim();
}

async function defaultStat(
  target: string,
): Promise<{ isDirectory: () => boolean }> {
  return await fsStat(target);
}

function failed(
  reason: RegisterDirectoryFromDiskFailureReason,
  message: string,
): Extract<RegisterDirectoryFromDiskResponse, { ok: false }> {
  return { ok: false, reason, message };
}

export type DirectoryRegistrationRoot = {
  /** What registration stores: a repository's primary checkout, else the folder. */
  directoryPath: string;
  /** Set when Git found a repository. */
  repoRoot?: string;
  /** The linked checkout the path was in, when it was not the primary. */
  checkoutPath?: string;
};

/**
 * The folder a path registers as. A path inside a repository registers as
 * the repository's primary checkout; any other folder as itself. Git is
 * best effort: a plain folder, or no Git, still resolves.
 */
export async function resolveDirectoryRegistrationRoot(
  candidatePath: string,
  deps: Pick<DirectoryRegistrationDeps, "runGit" | "statPath"> = {},
): Promise<
  | ({ ok: true } & DirectoryRegistrationRoot)
  | Extract<RegisterDirectoryFromDiskResponse, { ok: false }>
> {
  const candidate = candidatePath?.trim();
  if (!candidate) {
    return failed("inaccessible", "Pick a folder to add it as a directory.");
  }

  const runGit = deps.runGit ?? defaultRunGit;
  const statPath = deps.statPath ?? defaultStat;

  try {
    const info = await statPath(candidate);
    if (!info.isDirectory()) {
      return failed(
        "not-a-directory",
        `${candidate} is not a folder.`,
      );
    }
  } catch (error) {
    return failed(
      "inaccessible",
      `Couldn't open ${candidate}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  // Match navigation keys on Windows, where the native picker uses backslashes.
  let directoryPath = candidate.replace(/\\/g, "/");
  let repoRoot: string | undefined;
  let checkoutPath: string | undefined;
  try {
    const toplevel = (await runGit(candidate, [
      "rev-parse",
      "--show-toplevel",
    ])).trim();
    if (toplevel) {
      // Git lists the primary checkout first even when queried from a linked
      // checkout. A separately cloned repository has its own primary entry.
      const worktrees = await runGit(toplevel, ["worktree", "list", "--porcelain", "-z"]).catch(() => "");
      const [primary] = parseWorktreeListPaths(worktrees);
      const selectedRoot = canonicalizeNavigationPath(toplevel);
      repoRoot = selectedRoot;
      if (primary && canonicalizeNavigationPath(primary) !== selectedRoot) {
        // For a bare or separate Git directory, list can report the admin
        // folder as the first entry. Register only a verified working root.
        const root = await runGit(primary, ["rev-parse", "--show-toplevel"]).catch(() => "");
        if (root && canonicalizeNavigationPath(root.trim()) === canonicalizeNavigationPath(primary)) {
          repoRoot = canonicalizeNavigationPath(primary);
          checkoutPath = selectedRoot;
        }
      }
      directoryPath = repoRoot;
    }
  } catch {
    // Git metadata is optional: a plain folder (or unavailable Git) must
    // not prevent registration after filesystem validation succeeds.
  }

  if (process.platform === "win32") {
    directoryPath = await folderInRealCase(directoryPath);
    if (repoRoot) repoRoot = directoryPath;
    if (checkoutPath) {
      checkoutPath = await folderInRealCase(checkoutPath);
      if (checkoutPath === directoryPath) checkoutPath = undefined;
    }
  }

  return {
    ok: true,
    directoryPath,
    ...(repoRoot ? { repoRoot } : {}),
    ...(checkoutPath ? { checkoutPath } : {}),
  };
}

export async function registerDirectoryFromDisk(
  request: { path: string; preferredBackend?: AppServerBackendKind },
  deps: DirectoryRegistrationDeps,
): Promise<RegisterDirectoryFromDiskResponse> {
  const resolved = await resolveDirectoryRegistrationRoot(request.path, deps);
  if (!resolved.ok) return resolved;
  const { directoryPath, repoRoot, checkoutPath } = resolved;
  const runGit = deps.runGit ?? defaultRunGit;

  // Resolve the current branch only for detected repos (best effort).
  let currentBranch: string | undefined;
  if (repoRoot) {
    try {
      const head = (await runGit(repoRoot, [
        "rev-parse",
        "--abbrev-ref",
        "HEAD",
      ])).trim();
      if (head && head !== "HEAD") {
        currentBranch = head;
      }
    } catch {
      // Brand-new repo with no commits — leave currentBranch undefined.
    }
  }

  const directoryKey = await resolveDirectoryRegistrationKey(directoryPath, deps.listDirectoryLaunchpads);
  const directoryLabel = path.basename(directoryPath) || directoryPath;
  const ensured = await deps.ensureDirectoryLaunchpad({
    directoryKey,
    directoryKind: "directory",
    directoryLabel,
    directoryPath,
    currentBranch,
    preferredBackend: request.preferredBackend,
    registeredAt: Date.now(),
  });

  return {
    ok: true,
    directoryPath,
    ...(checkoutPath ? { checkoutPath } : {}),
    directoryKey,
    directoryLabel,
    currentBranch,
    launchpad: ensured.launchpad,
    defaults: ensured.defaults,
  };
}

/** Thread attachments retain the selected checkout as their working copy. */
export function linkedDirectoryForRegistration(
  registration: Extract<RegisterDirectoryFromDiskResponse, { ok: true }>,
): LinkedDirectorySummary {
  if (registration.checkoutPath) {
    const [directory] = buildWorktreeLinkedDirectory({ repositoryPath: registration.directoryPath,
      worktreePath: registration.checkoutPath, label: registration.directoryLabel });
    if (directory) return { ...directory, id: directory.worktreePath ?? directory.id };
  }
  const directoryPath = toDirectoryId(path.resolve(registration.directoryPath));
  return { id: directoryPath, kind: "local", label: registration.directoryLabel, path: directoryPath };
}
