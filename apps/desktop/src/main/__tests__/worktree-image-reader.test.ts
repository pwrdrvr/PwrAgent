import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WORKTREE_IMAGE_MAX_BYTES } from "@pwragent/shared";
import { readWorktreeImage } from "../app-server/worktree-image-reader";

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2]);
const SHA = "a".repeat(40);

let root: string;
let worktree: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "worktree-image-reader-"));
  worktree = path.join(root, "repo");
  await mkdir(path.join(worktree, "art"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("readWorktreeImage", () => {
  it("reads a working-tree image and returns plain bytes", async () => {
    await writeFile(path.join(worktree, "art", "boiler.png"), PNG_BYTES);
    const result = await readWorktreeImage({
      worktreePath: worktree,
      path: path.join(worktree, "art", "boiler.png"),
      revision: { kind: "worktree" },
    });
    expect(result).toEqual({ kind: "image", mediaType: "image/png", bytes: new Uint8Array(PNG_BYTES) });
  });

  it("treats a vanished working-tree file as the missing side of a delete", async () => {
    const result = await readWorktreeImage({
      worktreePath: worktree,
      path: path.join(worktree, "art", "gone.png"),
      revision: { kind: "worktree" },
    });
    expect(result).toEqual({ kind: "missing" });
  });

  it("refuses paths outside the worktree, including through a symlink", async () => {
    const outside = path.join(root, "secret.png");
    await writeFile(outside, PNG_BYTES);
    await symlink(outside, path.join(worktree, "art", "link.png"));
    const runGit = vi.fn();
    await expect(readWorktreeImage({
      worktreePath: worktree,
      path: outside,
      revision: { kind: "head" },
    }, { runGit })).resolves.toEqual({ kind: "unsupported" });
    await expect(readWorktreeImage({
      worktreePath: worktree,
      path: path.join(worktree, "art", "link.png"),
      revision: { kind: "worktree" },
    })).resolves.toEqual({ kind: "unsupported" });
    expect(runGit).not.toHaveBeenCalled();
  });

  it("refuses non-images and malformed commit shas before running git", async () => {
    const runGit = vi.fn();
    await expect(readWorktreeImage({
      worktreePath: worktree,
      path: path.join(worktree, "src", "main.ts"),
      revision: { kind: "head" },
    }, { runGit })).resolves.toEqual({ kind: "unsupported" });
    await expect(readWorktreeImage({
      worktreePath: worktree,
      path: path.join(worktree, "art", "a.png"),
      revision: { kind: "commit", sha: "HEAD~1" },
    }, { runGit })).resolves.toEqual({ kind: "unsupported" });
    expect(runGit).not.toHaveBeenCalled();
  });

  it("sizes a blob before reading it, and reads the commit's first parent for before", async () => {
    const runGit = vi.fn(async () => `${PNG_BYTES.length}\n`);
    const runGitBinary = vi.fn(async () => PNG_BYTES);
    const result = await readWorktreeImage({
      worktreePath: worktree,
      path: path.join(worktree, "art", "boiler.png"),
      revision: { kind: "commitParent", sha: SHA },
    }, { runGit, runGitBinary });
    expect(runGit).toHaveBeenCalledWith(worktree, ["--no-optional-locks", "cat-file", "-s", `${SHA}^:./art/boiler.png`]);
    expect(runGitBinary).toHaveBeenCalledWith(
      worktree,
      ["--no-optional-locks", "cat-file", "blob", `${SHA}^:./art/boiler.png`],
      PNG_BYTES.length + 1024,
    );
    expect(result).toEqual({ kind: "image", mediaType: "image/png", bytes: new Uint8Array(PNG_BYTES) });
  });

  it("names a blob from the worktree root, which can sit below the repository root", async () => {
    // `HEAD:art/x.png` would resolve from the repository root; `./` resolves
    // from git's cwd, which is the worktree root the renderer named.
    const runGit = vi.fn(async () => `${PNG_BYTES.length}\n`);
    await readWorktreeImage({
      worktreePath: worktree,
      path: path.join(worktree, "art", "boiler.png"),
      revision: { kind: "head" },
    }, { runGit, runGitBinary: async () => PNG_BYTES });
    expect(runGit).toHaveBeenCalledWith(worktree, ["--no-optional-locks", "cat-file", "-s", "HEAD:./art/boiler.png"]);
  });

  it("reports an add's missing parent blob as missing, and never buffers an oversized one", async () => {
    const absent = vi.fn(async () => {
      throw new Error("fatal: path 'art/new.png' does not exist in 'HEAD'");
    });
    await expect(readWorktreeImage({
      worktreePath: worktree,
      path: path.join(worktree, "art", "new.png"),
      revision: { kind: "head" },
    }, { runGit: absent })).resolves.toEqual({ kind: "missing" });

    const runGitBinary = vi.fn();
    await expect(readWorktreeImage({
      worktreePath: worktree,
      path: path.join(worktree, "art", "huge.png"),
      revision: { kind: "head" },
    }, { runGit: async () => `${WORKTREE_IMAGE_MAX_BYTES + 1}`, runGitBinary }))
      .resolves.toEqual({ kind: "tooLarge", sizeBytes: WORKTREE_IMAGE_MAX_BYTES + 1 });
    expect(runGitBinary).not.toHaveBeenCalled();
  });

  it("recognises a Git LFS pointer instead of handing it to an <img>", async () => {
    const pointer = Buffer.from("version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 12\n");
    await expect(readWorktreeImage({
      worktreePath: worktree,
      path: path.join(worktree, "art", "big.png"),
      revision: { kind: "commit", sha: SHA },
    }, { runGit: async () => `${pointer.length}`, runGitBinary: async () => pointer }))
      .resolves.toEqual({ kind: "lfsPointer" });
  });
});
