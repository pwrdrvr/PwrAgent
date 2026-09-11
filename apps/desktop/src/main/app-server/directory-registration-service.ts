import { stat as fsStat } from "node:fs/promises";
import path from "node:path";
import type {
  AppServerBackendKind,
  EnsureDirectoryLaunchpadResponse,
  RegisterDirectoryFromDiskFailureReason,
  RegisterDirectoryFromDiskResponse,
} from "@pwragent/shared";
import { runGitCommand } from "./git-executable";

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
 * repositories persist their canonical root so symlinked roots normalize
 * to one launchpad; other folders persist the selected path (issue #1750).
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
  /** Test seam — defaults to a real `git` execFile invocation. */
  runGit?: (cwd: string, args: string[]) => Promise<string>;
  /** Test seam — defaults to `node:fs` `stat`. */
  statPath?: (target: string) => Promise<{ isDirectory: () => boolean }>;
};

async function defaultRunGit(cwd: string, args: string[]): Promise<string> {
  return (await runGitCommand(cwd, args)).stdout;
}

async function defaultStat(
  target: string,
): Promise<{ isDirectory: () => boolean }> {
  return await fsStat(target);
}

function failed(
  reason: RegisterDirectoryFromDiskFailureReason,
  message: string,
): RegisterDirectoryFromDiskResponse {
  return { ok: false, reason, message };
}

/**
 * If `target` lives inside `<repo>/.worktrees/<hash>/<project>` —
 * pwragent's own auxiliary-worktree convention — return `<repo>` so
 * the picker's directoryKey matches the canonical-repo entry that
 * already exists in the navigation snapshot.
 *
 * Without this, picking a path under `.worktrees/<hash>/<project>`
 * generates `directory:/repo/.worktrees/<hash>/<project>` while the
 * rest of the system uses `directory:/repo`, producing a duplicate
 * entry in the picker's "Recent directories" list. This mirrors the
 * `repoWorktreeMatch` branch in
 * `packages/shared/src/directory-navigation.ts`, which
 * is the read-side of the same normalization. We deliberately do NOT
 * canonicalize `.codex/worktrees/...` paths — those are intentionally
 * tracked as their own directory entries by the directory-navigation
 * builder.
 */
function canonicalizeRepoWorktreePath(target: string): string {
  const match = target.match(
    /^(.*)[\\/]\.worktrees[\\/][^\\/]+(?:[\\/][^\\/]+)?(?:[\\/].*)?$/,
  );
  return match ? match[1] : target;
}

export async function registerDirectoryFromDisk(
  request: { path: string; preferredBackend?: AppServerBackendKind },
  deps: DirectoryRegistrationDeps,
): Promise<RegisterDirectoryFromDiskResponse> {
  const candidate = request.path?.trim();
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
  try {
    const toplevel = (await runGit(candidate, [
      "rev-parse",
      "--show-toplevel",
    ])).trim();
    if (toplevel) {
      // Only Git roots use repository/worktree normalization. Plain folders
      // keep their selected path, even when it contains `.worktrees`.
      repoRoot = canonicalizeRepoWorktreePath(toplevel);
      directoryPath = repoRoot;
    }
  } catch {
    // Git metadata is optional: a plain folder (or unavailable Git) must
    // not prevent registration after filesystem validation succeeds.
  }

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

  const directoryKey = `directory:${directoryPath}`;
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
    directoryKey,
    directoryLabel,
    currentBranch,
    launchpad: ensured.launchpad,
    defaults: ensured.defaults,
  };
}
