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
 *   3. `git rev-parse --show-toplevel` succeeds inside the path. Per
 *      issue #223 acceptance criteria the picker registers git repos
 *      only — a non-repo errors with `not-a-git-repo`.
 *
 * On success we call `ensureDirectoryLaunchpad` so the directory is
 * known to the launchpad layer immediately. The repo's canonical root
 * (rev-parse output) is what we persist — symlinked roots normalize so
 * the same repo accessed via two paths still maps to one launchpad.
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
 * `packages/agent-core/src/domain/directory-navigation.ts:88`, which
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

  let repoRoot: string;
  try {
    const toplevel = (await runGit(candidate, [
      "rev-parse",
      "--show-toplevel",
    ])).trim();
    if (!toplevel) {
      return failed(
        "not-a-git-repo",
        `${candidate} is not inside a git repository.`,
      );
    }
    // If the toplevel is itself a pwragent-managed worktree, walk back
    // to the parent repo so the directoryKey dedupes against the
    // already-tracked directory entry. See `canonicalizeRepoWorktreePath`.
    repoRoot = canonicalizeRepoWorktreePath(toplevel);
  } catch {
    // `git rev-parse --show-toplevel` exits non-zero (with a message on
    // stderr) for any path that isn't tracked. We treat all such
    // failures as "not a git repo" rather than surfacing the raw stderr,
    // which is implementation-y and not useful in the picker UI.
    return failed(
      "not-a-git-repo",
      `${candidate} is not inside a git repository.`,
    );
  }

  // Resolve the current branch (best effort — detached HEADs return an
  // empty string and we just leave `currentBranch` unset).
  let currentBranch: string | undefined;
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

  const directoryKey = `directory:${repoRoot}`;
  const directoryLabel = path.basename(repoRoot) || repoRoot;
  const ensured = await deps.ensureDirectoryLaunchpad({
    directoryKey,
    directoryKind: "directory",
    directoryLabel,
    directoryPath: repoRoot,
    currentBranch,
    preferredBackend: request.preferredBackend,
    registeredAt: Date.now(),
  });

  return {
    ok: true,
    directoryPath: repoRoot,
    directoryKey,
    directoryLabel,
    currentBranch,
    launchpad: ensured.launchpad,
    defaults: ensured.defaults,
  };
}
