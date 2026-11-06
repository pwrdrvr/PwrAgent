import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Fail an E2E run that changes the source checkout's Git hooks.
 *
 * PwrAgent's bundled Git configures the Git LFS filter, and git-lfs installs
 * `post-checkout`, `post-commit`, `post-merge` and `pre-push` hooks into a
 * repository the first time that filter runs there. Each hook exits 2 when
 * `git-lfs` is not on PATH. A spec that points the app at a directory inside
 * the checkout lets the app's Git find the checkout itself, and the hooks then
 * break `git worktree add` and `git push` in the developer's checkout and in
 * every worktree that shares it. `assistant-image-previews.spec.ts` did this
 * whenever an LFS-tracked snapshot was stat-dirty, which made it intermittent.
 *
 * Global setup records the hooks directory and global teardown compares it.
 * Specs that need a repository must create their own.
 */
export const SOURCE_HOOKS_SNAPSHOT_ENV = "PWRAGENT_E2E_SOURCE_HOOKS_SNAPSHOT";

export interface HooksSnapshot {
  hooksDir: string;
  /** Hook file name to a SHA-256 of its contents. */
  files: Record<string, string>;
}

/**
 * Resolve the hooks directory Git uses for `repoRoot`, including a shared
 * worktree's common directory and `core.hooksPath`. Undefined when Git is
 * missing or `repoRoot` is not a repository, as in a source archive.
 */
export function resolveHooksDir(repoRoot: string): string | undefined {
  try {
    const output = execFileSync(
      "git",
      ["-C", repoRoot, "rev-parse", "--path-format=absolute", "--git-path", "hooks"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const hooksDir = output.trim();
    return hooksDir ? path.resolve(hooksDir) : undefined;
  } catch {
    return undefined;
  }
}

export function snapshotHooks(hooksDir: string): HooksSnapshot {
  const files: Record<string, string> = {};
  let entries: string[] = [];
  try {
    entries = readdirSync(hooksDir);
  } catch {
    // A missing hooks directory is an empty one.
  }
  for (const name of entries.sort()) {
    try {
      const contents = readFileSync(path.join(hooksDir, name));
      files[name] = createHash("sha256").update(contents).digest("hex");
    } catch {
      // A directory or an unreadable entry is not a hook Git would run.
    }
  }
  return { hooksDir, files };
}

/** Describe each added, changed or removed hook; empty when none changed. */
export function describeHookChanges(before: HooksSnapshot, after: HooksSnapshot): string[] {
  const changes: string[] = [];
  const names = new Set([...Object.keys(before.files), ...Object.keys(after.files)]);
  for (const name of [...names].sort()) {
    const was = before.files[name];
    const now = after.files[name];
    if (was === now) continue;
    if (was === undefined) changes.push(`added ${name}`);
    else if (now === undefined) changes.push(`removed ${name}`);
    else changes.push(`changed ${name}`);
  }
  return changes;
}

/** Record the checkout's hooks for `checkSourceCheckoutHooks`. */
export function recordSourceCheckoutHooks(repoRoot: string): void {
  const hooksDir = resolveHooksDir(repoRoot);
  if (!hooksDir) {
    delete process.env[SOURCE_HOOKS_SNAPSHOT_ENV];
    return;
  }
  process.env[SOURCE_HOOKS_SNAPSHOT_ENV] = JSON.stringify(snapshotHooks(hooksDir));
}

/** Throw when the hooks recorded in global setup changed during the run. */
export function checkSourceCheckoutHooks(): void {
  const recorded = process.env[SOURCE_HOOKS_SNAPSHOT_ENV];
  if (!recorded) return;
  const before = JSON.parse(recorded) as HooksSnapshot;
  const changes = describeHookChanges(before, snapshotHooks(before.hooksDir));
  if (changes.length === 0) return;
  throw new Error(
    [
      `This E2E run changed the source checkout's Git hooks in ${before.hooksDir}:`,
      ...changes.map((change) => `  - ${change}`),
      "A spec or the app under test ran Git inside this checkout instead of in a",
      "repository the spec owns. Git LFS hooks added this way break `git worktree add`",
      "and `git push` on a machine without git-lfs. Give the spec its own repository,",
      "then delete the added hooks. Another process sharing this repository, such as",
      "a run in a sibling worktree, can also change them.",
    ].join("\n"),
  );
}
