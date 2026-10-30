import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";
import { runGitCommand } from "../app-server/git-executable";
import { ForgeReadError, validateArtifactRelativePath, type ForgeReadArgs } from "./forge-tool-contract";

/** Trusted project selection, kept separate from the agent's destination argument. */
export type ForgeArtifactDestination = { directory: string; relativePath: string; worktreeRoot: string };

async function inspectDestination(destination: ForgeArtifactDestination, signal?: AbortSignal): Promise<string> {
  validateArtifactRelativePath(destination.relativePath);
  const directory = await realpath(destination.directory);
  if (directory !== destination.directory) throw new ForgeReadError("forbidden", "The selected project directory changed after validation.");
  let parent = directory;
  let existingParent = directory;
  for (const part of destination.relativePath.split("/").slice(0, -1)) {
    parent = path.join(parent, part);
    const info = await lstat(parent).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (info && !info.isDirectory()) throw new ForgeReadError("forbidden", "Artifact parent paths must be directories, without symlinks or junctions.");
    if (info) existingParent = parent;
  }
  const archivePath = path.join(directory, ...destination.relativePath.split("/"));
  if (await lstat(archivePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  })) throw new ForgeReadError("destination_exists", "The destination already exists. Select a different ZIP path or remove the old download explicitly.");
  try {
    const actual = await runGitCommand(existingParent, ["rev-parse", "--show-toplevel"], { signal, timeout: 5000, maxBuffer: 4096 });
    if (await realpath(actual.stdout.trim()) !== destination.worktreeRoot) throw new ForgeReadError("forbidden", "Artifact paths cannot enter another repository or its Git metadata.");
    // A tracked file is not considered ignored. No --no-index or ignore edits.
    await runGitCommand(directory, ["check-ignore", "--quiet", "--", destination.relativePath], { signal, timeout: 5000, maxBuffer: 4096 });
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof ForgeReadError) throw error;
    throw new ForgeReadError("destination_not_ignored", "The ZIP destination must be Git-ignored. Select an ignored path or add a project ignore rule before downloading.");
  }
  return archivePath;
}

/** No ambient cwd or profile fallback: the target thread must own this project. */
export async function resolveForgeArtifactDestination(args: ForgeReadArgs, directories: readonly string[], signal?: AbortSignal): Promise<ForgeArtifactDestination> {
  const roots = [...new Set(await Promise.all(directories.map((directory) => realpath(directory))))];
  let directory: string;
  if (args.directory) {
    if (!path.isAbsolute(args.directory)) throw new ForgeReadError("invalid_arguments", "directory must be an absolute linked project path on the thread owner's machine.");
    const requested = await realpath(args.directory).catch(() => undefined);
    if (!requested || !roots.includes(requested)) throw new ForgeReadError("forbidden", "directory must select one of the target thread's linked project directories.");
    directory = requested;
  } else {
    if (roots.length !== 1) throw new ForgeReadError("ambiguous_directory", "Select directory from the target thread's linked projects. Downloads require exactly one project destination.");
    directory = roots[0]!;
  }
  // Reject Git metadata directories and bare repositories, even if linked.
  let worktreeRoot: string;
  try { worktreeRoot = await realpath((await runGitCommand(directory, ["rev-parse", "--show-toplevel"], { signal, timeout: 5000, maxBuffer: 4096 })).stdout.trim()); }
  catch {
    signal?.throwIfAborted();
    throw new ForgeReadError("invalid_arguments", "Artifact downloads require a linked Git working directory.");
  }
  const destination = { directory, worktreeRoot, relativePath: args.destination ?? `.local/ci-artifacts/${args.runId}/${args.artifactId}/artifact.zip` };
  await inspectDestination(destination, signal);
  return destination;
}

/** Recheck after the network request, then reserve the output exclusively. */
export async function openForgeArtifactDestination(destination: ForgeArtifactDestination, signal: AbortSignal) {
  const archivePath = await inspectDestination(destination, signal);
  let parent = destination.directory;
  for (const part of destination.relativePath.split("/").slice(0, -1)) {
    signal.throwIfAborted();
    parent = path.join(parent, part);
    await mkdir(parent, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    if (!(await lstat(parent)).isDirectory()) throw new ForgeReadError("forbidden", "Artifact parent paths must not contain symlinks or junctions.");
  }
  await inspectDestination(destination, signal);
  signal.throwIfAborted();
  const file = await open(archivePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST") throw new ForgeReadError("destination_exists", "The destination was created by another writer. Select another ZIP path.");
    throw error;
  });
  return { file, archivePath };
}
