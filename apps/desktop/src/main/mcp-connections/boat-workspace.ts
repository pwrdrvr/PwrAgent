import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { create as createTar } from "tar";

/**
 * Moving a thread's working directory to a Boat sandbox, and the sandbox's
 * changes back.
 *
 * Rules held here, whatever the caller passes:
 * - only a directory of the thread is read or written;
 * - a push sends what Git tracks or does not ignore, and never a file named
 *   `.env` or `.env.*`, tracked or not;
 * - a pull changes local files only when every change applies to the files
 *   as they are now. Otherwise it changes nothing and says which files
 *   stood in the way. It never discards an uncommitted local change.
 *
 * A push leaves a Git commit tagged `pwragent-base` in the sandbox copy. A
 * pull is the difference from that tag, so it carries the sandbox's edits
 * and not the whole tree, and then moves the tag.
 */

export type BoatWorkspaceGit = (
  cwd: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

export type BoatWorkspaceTransfer = {
  /** PUTs a local file to a signed URL, with no Boat key attached. */
  upload(url: string, file: string, signal?: AbortSignal): Promise<void>;
  /** GETs a signed URL into a local file, refusing more than `limitBytes`. */
  download(url: string, file: string, limitBytes: number, signal?: AbortSignal): Promise<void>;
};

export type BoatWorkspace = {
  /** The thread's directories, its working directory first. */
  roots: () => Promise<readonly string[]>;
  git: BoatWorkspaceGit;
  transfer: BoatWorkspaceTransfer;
};

export class BoatWorkspaceError extends Error {}

export const WORKSPACE_BASE_TAG = "pwragent-base";
export const PUSH_LIMIT_BYTES = 200 * 1024 * 1024;
export const PULL_LIMIT_BYTES = 100 * 1024 * 1024;
const FILE_LIMIT = 100_000;
const REMOTE_PATH_PATTERN = /^\/(?:home\/user|tmp)\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const REPORT_LIMIT = 200;

/** A `.env` file by name, at any depth: `.env`, `.env.local`, `.env.production`. */
export function isEnvFilePath(file: string): boolean {
  return file.split(/[\\/]/).some((segment) => {
    const name = segment.toLowerCase();
    return name === ".env" || name.startsWith(".env.");
  });
}

/**
 * The thread directory a call names, or its working directory. A path that
 * is not one of the thread's directories is refused, however it is spelled.
 */
export async function resolveWorkspaceRoot(workspace: BoatWorkspace, directory: string | undefined): Promise<string> {
  const roots = (await workspace.roots()).map((root) => path.resolve(root));
  if (roots.length === 0) {
    throw new BoatWorkspaceError("This thread has no directory on the operator's computer to push or pull.");
  }
  if (directory === undefined) return roots[0]!;
  const wanted = path.isAbsolute(directory) ? path.resolve(directory) : undefined;
  const root = roots.find((entry) => entry === wanted);
  if (!root) {
    throw new BoatWorkspaceError(
      `directory must be one of this thread's directories: ${roots.join(", ")}.`,
    );
  }
  return root;
}

/** Where in the sandbox a directory goes: under /home/user or /tmp, in plain characters. */
export function workspaceRemotePath(value: string | undefined, root: string): string {
  if (value === undefined) {
    const name = path.basename(root).replaceAll(/[^A-Za-z0-9._-]/g, "-").replace(/^[.-]+/, "") || "workspace";
    return `/home/user/${name}`;
  }
  if (!REMOTE_PATH_PATTERN.test(value) || value.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new BoatWorkspaceError(
      "remotePath must be an absolute path under /home/user or /tmp, made of letters, digits, dot, dash and underscore.",
    );
  }
  return value;
}

/** What a push sends: tracked and untracked-but-not-ignored files, less `.env` files. */
export async function listWorkspaceFiles(
  root: string,
  git: BoatWorkspaceGit,
): Promise<{ files: string[]; envFilesLeftOut: number }> {
  let listed: string;
  try {
    listed = (await git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])).stdout;
  } catch {
    throw new BoatWorkspaceError(
      `${root} is not a Git working tree. PwrAgent pushes only what Git tracks or does not ignore, so it needs one.`,
    );
  }
  const files: string[] = [];
  let envFilesLeftOut = 0;
  for (const file of new Set(listed.split("\0").filter(Boolean))) {
    if (isEnvFilePath(file)) {
      envFilesLeftOut += 1;
      continue;
    }
    // Deleted in the working tree, or a submodule's directory: not a file to send.
    const stat = await fs.lstat(path.join(root, file)).catch(() => undefined);
    if (!stat || !(stat.isFile() || stat.isSymbolicLink())) continue;
    files.push(file);
  }
  if (files.length > FILE_LIMIT) {
    throw new BoatWorkspaceError(`This directory has more than ${FILE_LIMIT} files to send. Clone it in the sandbox instead.`);
  }
  return { files: files.toSorted(), envFilesLeftOut };
}

/** A gzip tar of exactly `files`, in a new private directory. The caller removes it. */
export async function packWorkspace(root: string, files: readonly string[]): Promise<{ directory: string; archive: string; bytes: number }> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pwragent-boat-push-"));
  const archive = path.join(directory, "workspace.tgz");
  try {
    await createTar(
      // `./` keeps a name that begins with `-` or `@` from being read as an option.
      { gzip: true, file: archive, cwd: root, portable: true, follow: false, noDirRecurse: true },
      files.map((file) => `./${file}`),
    );
    const { size } = await fs.stat(archive);
    if (size > PUSH_LIMIT_BYTES) {
      throw new BoatWorkspaceError(
        `This directory packs to ${Math.ceil(size / (1024 * 1024))} MiB, over the ${PUSH_LIMIT_BYTES / (1024 * 1024)} MiB a push sends. Clone it in the sandbox instead.`,
      );
    }
    return { directory, archive, bytes: size };
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export function transferName(extension: string): string {
  return `/tmp/pwragent-${randomBytes(8).toString("hex")}.${extension}`;
}

/** Unpacks an uploaded archive in the sandbox and records it as the base a pull compares to. */
export function unpackScript(input: { archive: string; remotePath: string; replace: boolean }): string {
  return [
    "set -e",
    `d='${input.remotePath}'`,
    `a='${input.archive}'`,
    "if [ -e \"$d\" ] && [ -n \"$(ls -A \"$d\" 2>/dev/null)\" ]; then",
    input.replace ? "  rm -rf \"$d\"" : "  rm -f \"$a\"; echo PWRAGENT_EXISTS; exit 3",
    "fi",
    "mkdir -p \"$d\"",
    "tar -xzf \"$a\" -C \"$d\"",
    "rm -f \"$a\"",
    "cd \"$d\"",
    "git init -q",
    "git add -A",
    "git -c user.name=PwrAgent -c user.email=pwragent@localhost commit -q --allow-empty -m 'Pushed from PwrAgent'",
    `git tag -f ${WORKSPACE_BASE_TAG} >/dev/null`,
  ].join("\n");
}

/** Writes the sandbox's changes since the base as one patch, and prints its size. */
export function diffScript(input: { patch: string; remotePath: string }): string {
  return [
    "set -e",
    `cd '${input.remotePath}'`,
    `git rev-parse -q --verify refs/tags/${WORKSPACE_BASE_TAG} >/dev/null || { echo PWRAGENT_NO_BASE; exit 4; }`,
    "git add -A",
    `git diff --binary --cached ${WORKSPACE_BASE_TAG} > '${input.patch}'`,
    `wc -c < '${input.patch}'`,
  ].join("\n");
}

/** After a pull lands locally: what was pulled becomes the new base. */
export function rebaseScript(input: { patch: string; remotePath: string }): string {
  return [
    "set -e",
    `cd '${input.remotePath}'`,
    "git -c user.name=PwrAgent -c user.email=pwragent@localhost commit -q --allow-empty -m 'Pulled to PwrAgent'",
    `git tag -f ${WORKSPACE_BASE_TAG} >/dev/null`,
    `rm -f '${input.patch}'`,
  ].join("\n");
}

export type AppliedPatch = {
  files: Array<{ path: string; added?: number; deleted?: number }>;
  filesOmitted: number;
  /** True when the directory had uncommitted changes before the pull. They are still there. */
  localChangesKept: boolean;
};

/**
 * Applies a patch from a sandbox to a thread directory, or changes nothing.
 * `git apply` is all or nothing: one hunk that does not fit the file as it
 * is now refuses the whole patch.
 */
export async function applyWorkspacePatch(root: string, patch: string, git: BoatWorkspaceGit): Promise<AppliedPatch> {
  let listed: string;
  try {
    listed = (await git(root, ["apply", "--numstat", "-z", patch])).stdout;
  } catch (error) {
    throw new BoatWorkspaceError(`The sandbox's changes are not a patch Git can read. Nothing was changed. ${gitSaid(error)}`);
  }
  const files = listed.split("\0").filter(Boolean).flatMap((line) => {
    const [added, deleted, ...rest] = line.split("\t");
    const file = rest.join("\t");
    return file ? [{ path: file, ...count("added", added), ...count("deleted", deleted) }] : [];
  });
  const inside = files.find((file) => file.path.split("/").some((segment) => segment.toLowerCase() === ".git"));
  if (inside) {
    throw new BoatWorkspaceError(`The sandbox's changes include ${inside.path}, inside a Git directory. Nothing was changed.`);
  }
  const localChangesKept = (await git(root, ["status", "--porcelain"])).stdout.trim().length > 0;
  try {
    await git(root, ["apply", "--check", patch]);
  } catch (error) {
    throw new BoatWorkspaceError(
      "Nothing was changed. The sandbox's changes do not fit the local files as they are now, "
      + "most likely because those files changed here after the push. "
      + `Commit or set aside the local changes, or push again and redo the work. Git said: ${gitSaid(error)}`,
    );
  }
  await git(root, ["apply", patch]);
  return {
    files: files.slice(0, REPORT_LIMIT),
    filesOmitted: Math.max(0, files.length - REPORT_LIMIT),
    localChangesKept,
  };
}

function count(name: "added" | "deleted", value: string | undefined): Record<string, number> {
  const parsed = Number(value);
  // Git prints `-` for a binary file.
  return value !== undefined && value !== "-" && Number.isInteger(parsed) ? { [name]: parsed } : {};
}

function gitSaid(error: unknown): string {
  const stderr = (error as { stderr?: unknown } | undefined)?.stderr;
  const text = typeof stderr === "string" && stderr.trim() ? stderr : error instanceof Error ? error.message : "";
  return text.trim().split(/\r?\n/).slice(0, 6).join(" ").slice(0, 600);
}
