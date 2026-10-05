import path from "node:path";
import { readFile, realpath, stat } from "node:fs/promises";
import {
  WORKTREE_IMAGE_MAX_BYTES,
  worktreeImageMediaType,
  type ReadWorktreeImageRequest,
  type ReadWorktreeImageResponse,
  type WorktreeImageRevision,
} from "@pwragent/shared";
import { runGitCommand, runGitCommandBinary } from "./git-executable";

/**
 * Bytes for one side of an image diff in the Edits rail: the working-tree
 * file, or a blob at HEAD, a commit, or a commit's first parent.
 *
 * Ported from PwrGit's `image-preview.ts`. The renderer names the worktree and
 * the path, exactly as it does for the text diffs beside it, so every read is
 * confined to that worktree: by `path.relative` for blobs (git resolves
 * `<rev>:<path>` inside the repository on its own) and by `realpath` for the
 * working tree, where a symlink could otherwise point anywhere on disk.
 */

/** Git LFS stores a small text pointer in place of the blob, and neither
 *  `cat-file` nor the working tree of an un-smudged checkout runs the filter. */
const LFS_POINTER_PREFIX = "version https://git-lfs";
const LFS_SNIFF_BYTES = 64;
const SHA_PATTERN = /^[0-9a-f]{40}$/i;

export type WorktreeImageReaderDeps = {
  runGit?: (cwd: string, args: string[]) => Promise<string>;
  runGitBinary?: (cwd: string, args: string[], maxBuffer: number) => Promise<Buffer>;
};

/**
 * `<rev>:<path>` names a path from the repository root; `<rev>:./<path>`
 * names it from git's working directory. Git runs in the worktree root the
 * renderer named, which can sit below the repository root, and `relativePath`
 * is relative to it — so the `./` is what makes the two agree.
 */
function revisionSpec(revision: WorktreeImageRevision, relativePath: string): string | undefined {
  const local = `./${relativePath}`;
  switch (revision.kind) {
    case "head":
      return `HEAD:${local}`;
    case "commit":
      return SHA_PATTERN.test(revision.sha) ? `${revision.sha}:${local}` : undefined;
    case "commitParent":
      return SHA_PATTERN.test(revision.sha) ? `${revision.sha}^:${local}` : undefined;
    default:
      return undefined;
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function imageOf(mediaType: string, bytes: Buffer): ReadWorktreeImageResponse {
  if (bytes.subarray(0, LFS_SNIFF_BYTES).toString("latin1").startsWith(LFS_POINTER_PREFIX)) {
    return { kind: "lfsPointer" };
  }
  // A plain Uint8Array view, not the Buffer: structured clone across IPC
  // copies the view's bytes either way, but a Buffer from the pool would carry
  // its whole backing slab.
  return { kind: "image", mediaType, bytes: new Uint8Array(bytes) };
}

async function readWorkingTreeImage(
  worktreePath: string,
  absolutePath: string,
  mediaType: string,
): Promise<ReadWorktreeImageResponse> {
  try {
    const [root, target] = await Promise.all([
      realpath(worktreePath),
      realpath(absolutePath),
    ]);
    if (!isInside(root, target)) {
      return { kind: "unsupported" };
    }
    const info = await stat(target);
    if (!info.isFile()) {
      return { kind: "missing" };
    }
    if (info.size > WORKTREE_IMAGE_MAX_BYTES) {
      return { kind: "tooLarge", sizeBytes: info.size };
    }
    return imageOf(mediaType, await readFile(target));
  } catch {
    // Gone between `git status` and this read: the after side of a delete.
    return { kind: "missing" };
  }
}

export async function readWorktreeImage(
  request: ReadWorktreeImageRequest,
  deps: WorktreeImageReaderDeps = {},
): Promise<ReadWorktreeImageResponse> {
  const worktreePath = request.worktreePath?.trim();
  if (!worktreePath || !request.path?.trim()) {
    return { kind: "unsupported" };
  }
  const absolutePath = path.resolve(request.path);
  const mediaType = worktreeImageMediaType(absolutePath);
  if (!mediaType || !isInside(worktreePath, absolutePath)) {
    return { kind: "unsupported" };
  }
  if (request.revision.kind === "worktree") {
    return await readWorkingTreeImage(worktreePath, absolutePath, mediaType);
  }

  const relativePath = path.relative(worktreePath, absolutePath).replace(/\\/g, "/");
  const spec = revisionSpec(request.revision, relativePath);
  if (!spec) {
    return { kind: "unsupported" };
  }
  const runGit = deps.runGit
    ?? (async (cwd: string, args: string[]) => (await runGitCommand(cwd, args)).stdout);
  const runGitBinary = deps.runGitBinary
    ?? (async (cwd: string, args: string[], maxBuffer: number) =>
      await runGitCommandBinary(cwd, args, { maxBuffer }));

  // Size first: `cat-file -s` reads only the object header, so an oversized
  // asset is refused without being buffered. A non-zero exit is the path not
  // existing at that revision — the before of an add.
  let size: number;
  try {
    size = Number.parseInt(
      (await runGit(worktreePath, ["--no-optional-locks", "cat-file", "-s", spec])).trim(),
      10,
    );
  } catch {
    return { kind: "missing" };
  }
  if (!Number.isFinite(size)) {
    return { kind: "missing" };
  }
  if (size > WORKTREE_IMAGE_MAX_BYTES) {
    return { kind: "tooLarge", sizeBytes: size };
  }
  try {
    const bytes = await runGitBinary(
      worktreePath,
      ["--no-optional-locks", "cat-file", "blob", spec],
      size + 1024,
    );
    return imageOf(mediaType, bytes);
  } catch {
    return { kind: "missing" };
  }
}
