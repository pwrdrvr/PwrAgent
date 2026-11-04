import { lstat, stat } from "node:fs/promises";
import path from "node:path";
import { REBUILDABLE_OUTPUT_NAMES, type ThreadMaintenanceWorkspace } from "@pwragent/shared";
import { runGitCommand } from "./git-executable";
import { WORKSPACE_KEEP_REASONS } from "./thread-archive-sweeper";

/** Snapshot accounting stops here, matching the archive service's file limit. */
const MAX_MEASURED_FILES = 10_000;
const LARGEST_FILES = 3;

export type MaintenanceWorkspaceInspection =
  | { keep: string }
  | { keep?: undefined; workspace: ThreadMaintenanceWorkspace };

/**
 * Reads one checkout the way a reviewed archive will treat it. It measures the
 * same files a recovery snapshot stages (tracked changes and untracked files
 * that are not ignored), so "changes" and "overLimit" match what archive does.
 * Ignored files are lost when a checkout is removed: rebuildable output is
 * allowed only when the rule says so, and any other ignored path keeps it.
 */
export async function inspectMaintenanceWorkspace(
  cwd: string,
  options: { signal: AbortSignal; limitBytes: number; rebuildableOutputIsClean: boolean },
): Promise<MaintenanceWorkspaceInspection> {
  try {
    await stat(cwd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { workspace: { kind: "missing" } };
    throw error;
  }
  const git = async (args: string[]) => (await runGitCommand(cwd, args, { signal: options.signal, timeout: 15_000 })).stdout;
  try {
    await git(["rev-parse", "--is-inside-work-tree"]);
  } catch (error) {
    // Archive leaves a folder with no repository at or above it in place.
    // A broken worktree link reports a different message and fails closed.
    if (isOutsideAnyGitRepository(error)) return { workspace: { kind: "notGit" } };
    throw error;
  }
  const changedOutput = await git(["diff", "--name-only", "-z", "HEAD", "--", "."]);
  const untracked = (await git(["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
  const ignored = (await git(["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"]))
    .split("\0").filter(Boolean);
  const rebuildable = new Set<string>();
  for (const entry of ignored) {
    const folder = rebuildableOutputFolder(entry);
    if (!folder || !options.rebuildableOutputIsClean) {
      return { keep: options.rebuildableOutputIsClean ? "Other ignored files" : WORKSPACE_KEEP_REASONS.ignored };
    }
    rebuildable.add(folder);
  }
  const retained = (await git(["rev-list", "--count", "HEAD", "--not", "--branches", "--remotes"])).trim();
  if (retained !== "0") return { keep: WORKSPACE_KEEP_REASONS.unretained };
  const rebuildableOutput = rebuildable.size ? [...rebuildable].sort() : undefined;
  const files = new Set([...changedOutput.split("\0").filter(Boolean), ...untracked]);
  if (!files.size) return { workspace: { kind: "clean", ...(rebuildableOutput ? { rebuildableOutput } : {}) } };
  if (files.size > MAX_MEASURED_FILES) return { keep: "Too many changed files" };
  const sizes: { path: string; bytes: number }[] = [];
  let bytes = 0;
  for (const file of files) {
    try {
      const info = await lstat(path.join(cwd, file));
      // A changed directory entry is a submodule with its own work. A
      // recovery snapshot cannot hold that, so the checkout is kept.
      if (info.isDirectory()) return { keep: WORKSPACE_KEEP_REASONS.changes };
      // Do not follow links into dependencies or unrelated directories.
      if (info.isFile() || info.isSymbolicLink()) {
        bytes += info.size;
        sizes.push({ path: file, bytes: info.size });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (bytes > options.limitBytes) {
    return { workspace: { kind: "overLimit", files: files.size, bytes, limitBytes: options.limitBytes,
      largest: sizes.sort((a, b) => b.bytes - a.bytes).slice(0, LARGEST_FILES) } };
  }
  return { workspace: { kind: "changes", files: files.size, bytes, ...(rebuildableOutput ? { rebuildableOutput } : {}) } };
}

function isOutsideAnyGitRepository(error: unknown): boolean {
  const stderr = (error as { stderr?: unknown })?.stderr;
  const text = `${error instanceof Error ? error.message : String(error)}\n${typeof stderr === "string" ? stderr : ""}`;
  return text.includes("not a git repository (or any of the parent directories)");
}

/** The rebuildable folder an ignored path lives in, as a relative path such
 * as `packages/web/node_modules`. Undefined for any other ignored path. */
export function rebuildableOutputFolder(ignoredPath: string): string | undefined {
  const segments = ignoredPath.replace(/\\/g, "/").replace(/\/+$/, "").split("/");
  const index = segments.findIndex((segment) => REBUILDABLE_OUTPUT_NAMES.has(segment));
  return index < 0 ? undefined : segments.slice(0, index + 1).join("/");
}
