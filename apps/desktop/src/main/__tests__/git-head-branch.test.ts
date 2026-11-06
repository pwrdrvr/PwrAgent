import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOT_A_GIT_REPOSITORY, probeCurrentGitBranch } from "../app-server/git-head-branch";
import { isolateProcessGitEnvironment, runIsolatedGit } from "./helpers/isolated-git";

const readObservation = vi.hoisted(() => ({
  afterRead: undefined as ((filePath: unknown) => Promise<void>) | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    async readFile(...args: Parameters<typeof actual.readFile>) {
      const result = await actual.readFile(...args);
      await readObservation.afterRead?.(args[0]);
      return result;
    },
  };
});

let restoreGitEnv: () => void;

beforeEach(() => {
  restoreGitEnv = isolateProcessGitEnvironment();
});

afterEach(() => {
  readObservation.afterRead = undefined;
  restoreGitEnv();
});

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await runIsolatedGit(cwd, args);
  return stdout.trim();
}

describe("probeCurrentGitBranch", () => {
  it("proves no repository up to the filesystem root, and defers at every marker Git would honor", async (context) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-no-repo-head-"));
    const parent = path.join(root, "parent");
    const nested = path.join(parent, "nested");
    try {
      await mkdir(nested, { recursive: true });
      // The walk reaches the filesystem root, so a repository that encloses
      // this machine's temp directory makes the case unreachable here.
      if (await git(nested, ["rev-parse", "--git-dir"]).then(() => true, () => false)) context.skip();
      await expect(git(nested, ["rev-parse", "--abbrev-ref", "HEAD"])).rejects.toThrow(/not a git repository/);
      expect(await probeCurrentGitBranch(nested)).toBe(NOT_A_GIT_REPOSITORY);

      // A HEAD file without objects is not a bare repository to Git.
      await writeFile(path.join(parent, "HEAD"), "ref: refs/heads/main\n");
      await expect(git(nested, ["rev-parse", "--git-dir"])).rejects.toThrow(/not a git repository/);
      expect(await probeCurrentGitBranch(nested)).toBe(NOT_A_GIT_REPOSITORY);

      // With objects and refs beside it, Git discovers a bare repository.
      await mkdir(path.join(parent, "objects"));
      await mkdir(path.join(parent, "refs"));
      await expect(git(nested, ["rev-parse", "--git-dir"])).resolves.toBeTruthy();
      expect(await probeCurrentGitBranch(nested)).toBeUndefined();

      if (process.platform !== "win32") {
        // Git accepts a symbolic-link HEAD by its link text, even dangling.
        await rm(path.join(parent, "HEAD"));
        await symlink("refs/heads/unborn", path.join(parent, "HEAD"));
        await expect(git(nested, ["rev-parse", "--git-dir"])).resolves.toBeTruthy();
        expect(await probeCurrentGitBranch(nested)).toBeUndefined();
      }

      await rm(parent, { recursive: true, force: true });
      await mkdir(nested, { recursive: true });
      expect(await probeCurrentGitBranch(nested)).toBe(NOT_A_GIT_REPOSITORY);
      // Any .git entry ends the walk, even one Git would reject.
      await writeFile(path.join(parent, ".git"), "gitdir: missing\n");
      expect(await probeCurrentGitBranch(nested)).toBeUndefined();
      await rm(path.join(parent, ".git"));

      // These can change what Git discovers. Leave the answer to Git.
      for (const key of ["GIT_CEILING_DIRECTORIES", "GIT_OBJECT_DIRECTORY", "GIT_DIR"]) {
        process.env[key] = root;
        try {
          expect(await probeCurrentGitBranch(nested)).toBeUndefined();
        } finally {
          delete process.env[key];
        }
      }
      expect(await probeCurrentGitBranch(nested)).toBe(NOT_A_GIT_REPOSITORY);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a committed HEAD when Git packs its loose ref during the probe", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-packing-head-")));
    try {
      await git(root, ["init", "-b", "main"]);
      await git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "seed"]);
      const oid = await git(root, ["rev-parse", "HEAD"]);
      await git(root, ["branch", "packed-only"]);
      await git(root, ["pack-refs", "--all"]);
      await git(root, ["update-ref", "-d", "refs/heads/main"]);
      await git(root, ["update-ref", "refs/heads/main", oid]);
      const packedPath = path.join(root, ".git", "packed-refs");
      expect(await readFile(packedPath, "utf8")).not.toContain("refs/heads/main");
      let packedDuringProbe = false;
      readObservation.afterRead = async (filePath) => {
        if (filePath !== packedPath || packedDuringProbe) return;
        packedDuringProbe = true;
        await git(root, ["pack-refs", "--all"]);
      };
      expect(await probeCurrentGitBranch(root)).toEqual({ branch: "main" });
      expect(packedDuringProbe).toBe(true);
      expect(await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
      await expect(readFile(path.join(root, ".git", "refs", "heads", "main"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      readObservation.afterRead = undefined;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("defers at nested bare and administrative repositories instead of selecting the enclosing checkout", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-bare-boundary-"));
    const nested = path.join(root, "nested.git");
    try {
      await git(root, ["init", "-b", "outer"]);
      await git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "seed"]);
      await git(root, ["init", "--bare", "-b", "inner", nested]);
      await git(root, ["push", nested, "HEAD:refs/heads/inner"]);
      expect(await git(nested, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("inner");
      expect(await probeCurrentGitBranch(nested)).toBeUndefined();
      expect(await probeCurrentGitBranch(path.join(nested, "objects"))).toBeUndefined();
      expect(await probeCurrentGitBranch(path.join(root, ".git"))).toBeUndefined();
      expect(await probeCurrentGitBranch(root)).toEqual({ branch: "outer" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves unborn HEAD after fetching remote refs, then reads loose and packed branch refs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-head-probe-"));
    const local = path.join(root, "local");
    const seed = path.join(root, "seed");
    const remote = path.join(root, "origin.git");
    try {
      await mkdir(local);
      await mkdir(seed);
      await git(local, ["init", "-b", "main"]);
      expect(await probeCurrentGitBranch(local)).toEqual({});
      await expect(git(local, ["rev-parse", "--abbrev-ref", "HEAD"])).rejects.toThrow();

      await git(root, ["init", "--bare", "-b", "main", remote]);
      await git(seed, ["init", "-b", "main"]);
      await writeFile(path.join(seed, "README.md"), "seed\n");
      await git(seed, ["add", "README.md"]);
      await git(seed, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "seed"]);
      await git(seed, ["remote", "add", "origin", remote]);
      await git(seed, ["push", "origin", "main"]);
      await git(local, ["remote", "add", "origin", remote]);
      await git(local, ["fetch", "origin", "main:refs/remotes/origin/main"]);
      expect(await probeCurrentGitBranch(local)).toEqual({});
      await expect(git(local, ["rev-parse", "--abbrev-ref", "HEAD"])).rejects.toThrow();

      await writeFile(path.join(local, "README.md"), "local\n");
      await git(local, ["add", "README.md"]);
      await git(local, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "local"]);
      expect(await probeCurrentGitBranch(local)).toEqual({ branch: "main" });
      expect(await git(local, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
      await git(local, ["pack-refs", "--all"]);
      await rm(path.join(local, ".git", "refs", "heads", "main"), { force: true });
      expect(await probeCurrentGitBranch(local)).toEqual({ branch: "main" });
      await git(local, ["tag", "main"]);
      expect(await git(local, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("heads/main");
      expect(await probeCurrentGitBranch(local)).toBeUndefined();
      await git(local, ["pack-refs", "--all"]);
      expect(await probeCurrentGitBranch(local)).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("defers to Git when remote or custom refs make a branch abbreviation ambiguous", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-ambiguous-head-"));
    try {
      await git(root, ["init", "-b", "origin/main"]);
      await writeFile(path.join(root, "README.md"), "seed\n");
      await git(root, ["add", "README.md"]);
      await git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "seed"]);
      const oid = await git(root, ["rev-parse", "HEAD"]);
      await git(root, ["update-ref", "refs/remotes/origin/main", oid]);
      expect(await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("heads/origin/main");
      expect(await probeCurrentGitBranch(root)).toBeUndefined();
      await git(root, ["pack-refs", "--all"]);
      await expect(readFile(path.join(root, ".git", "refs", "remotes", "origin", "main"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await probeCurrentGitBranch(root)).toBeUndefined();

      await git(root, ["update-ref", "-d", "refs/remotes/origin/main"]);
      await git(root, ["branch", "-m", "main"]);
      await git(root, ["update-ref", "refs/main", oid]);
      expect(await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("heads/main");
      expect(await probeCurrentGitBranch(root)).toBeUndefined();
      await git(root, ["pack-refs", "--all"]);
      await expect(readFile(path.join(root, ".git", "refs", "main"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await probeCurrentGitBranch(root)).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reads a linked worktree admin HEAD through a relative gitdir and common packed ref", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-worktree-head-"));
    const local = path.join(root, "local");
    const linked = path.join(root, "linked");
    try {
      await mkdir(local);
      await git(local, ["init", "-b", "main"]);
      await writeFile(path.join(local, "README.md"), "seed\n");
      await git(local, ["add", "README.md"]);
      await git(local, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "seed"]);
      await git(local, ["worktree", "add", "-b", "feature/probe", linked]);
      const dotGit = path.join(linked, ".git");
      const link = await readFile(dotGit, "utf8");
      const match = /^gitdir: ([^\r\n]+)/.exec(link);
      expect(match).toBeTruthy();
      const admin = path.resolve(linked, match![1]);
      expect(await probeCurrentGitBranch(admin)).toBeUndefined();
      expect(await git(linked, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("feature/probe");
      expect(await probeCurrentGitBranch(linked)).toEqual({ branch: "feature/probe" });
      const relative = path.join(root, "relative");
      await mkdir(relative);
      const relativeAdmin = path.relative(await realpath(relative), await realpath(admin));
      await writeFile(path.join(relative, ".git"), "gitdir: " + relativeAdmin + "\n");
      expect(await git(relative, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("feature/probe");
      expect(await probeCurrentGitBranch(relative)).toEqual({ branch: "feature/probe" });
      await git(local, ["pack-refs", "--all"]);
      await rm(path.join(local, ".git", "refs", "heads", "feature", "probe"), { force: true });
      expect(await probeCurrentGitBranch(linked)).toEqual({ branch: "feature/probe" });
      await git(linked, ["switch", "--detach", "HEAD"]);
      expect(await git(linked, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("HEAD");
      expect(await probeCurrentGitBranch(linked)).toEqual({ branch: "HEAD" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reads a detached HEAD as Git abbreviates it, and defers when another HEAD ref is ambiguous", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-detached-head-"));
    try {
      await git(root, ["init", "-b", "main"]);
      await git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "seed"]);
      const oid = await git(root, ["rev-parse", "HEAD"]);
      await git(root, ["switch", "--detach", "HEAD"]);
      const gitDir = path.join(root, ".git");
      const head = path.join(gitDir, "HEAD");
      const abbreviated = async () => await git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);

      // Git reads no object to abbreviate a detached HEAD, so neither may the probe.
      for (const text of [
        oid + "\n",
        oid.toUpperCase(),
        oid + "\r\n",
        "1234567890".repeat(4) + "\n",
      ]) {
        await writeFile(head, text);
        expect(await abbreviated()).toBe("HEAD");
        expect(await probeCurrentGitBranch(root)).toEqual({ branch: "HEAD" });
      }

      // A SHA-256 length object ID is not a SHA-1 repository's HEAD.
      await writeFile(head, oid + "0".repeat(24) + "\n");
      await expect(abbreviated()).rejects.toThrow();
      expect(await probeCurrentGitBranch(root)).toBeUndefined();
      await writeFile(head, oid + "\n");

      // Any other ref Git would also expand `HEAD` to leaves its stdout empty.
      for (const ref of [
        "refs/HEAD",
        "refs/heads/HEAD",
        "refs/tags/HEAD",
        "refs/remotes/HEAD",
        "refs/remotes/HEAD/HEAD",
      ]) {
        const refPath = path.join(gitDir, ...ref.split("/"));
        await mkdir(path.dirname(refPath), { recursive: true });
        await writeFile(refPath, oid + "\n");
        expect(await abbreviated()).toBe("");
        expect(await probeCurrentGitBranch(root)).toBeUndefined();
        await rm(refPath);
        // An empty refs/remotes/HEAD directory would defer the packed case
        // below on its own.
        await rm(path.join(gitDir, "refs", "remotes"), { recursive: true, force: true });
        expect(await probeCurrentGitBranch(root)).toEqual({ branch: "HEAD" });

        await writeFile(path.join(gitDir, "packed-refs"), oid + " " + ref + "\n");
        expect(await abbreviated()).toBe("");
        expect(await probeCurrentGitBranch(root)).toBeUndefined();
        await rm(path.join(gitDir, "packed-refs"));
      }
      expect(await abbreviated()).toBe("HEAD");
      expect(await probeCurrentGitBranch(root)).toEqual({ branch: "HEAD" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses Git fallback for unsupported metadata and honors cancellation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-unsupported-head-"));
    try {
      await git(root, ["init", "-b", "main"]);
      const controller = new AbortController();
      controller.abort();
      await expect(probeCurrentGitBranch(root, controller.signal)).rejects.toThrow();
      const config = path.join(root, ".git", "config");
      const originalConfig = await readFile(config, "utf8");
      await appendFile(config, "\n[extensions]\n\trefStorage = reftable\n");
      expect(await probeCurrentGitBranch(root)).toBeUndefined();
      await writeFile(config, originalConfig);
      await writeFile(config, "[other]\n\trepositoryformatversion = 0\n");
      expect(await probeCurrentGitBranch(root)).toBeUndefined();
      await writeFile(config, originalConfig);
      await appendFile(config, "\n[core]\n\tworktree = elsewhere\n");
      expect(await probeCurrentGitBranch(root)).toBeUndefined();
      await writeFile(config, originalConfig);
      const head = path.join(root, ".git", "HEAD");
      const originalHead = await readFile(head, "utf8");
      await writeFile(head, "invalid HEAD\n");
      expect(await probeCurrentGitBranch(root)).toBeUndefined();
      await writeFile(head, originalHead);
      const prior = process.env.GIT_DIR;
      process.env.GIT_DIR = path.join(root, ".git");
      try {
        expect(await probeCurrentGitBranch(root)).toBeUndefined();
      } finally {
        if (prior === undefined) delete process.env.GIT_DIR;
        else process.env.GIT_DIR = prior;
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts an ordinary Windows remote path and defers malformed config to Git", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-config-head-"));
    try {
      await git(root, ["init", "-b", "main"]);
      await writeFile(path.join(root, "README.md"), "seed\n");
      await git(root, ["add", "README.md"]);
      await git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "seed"]);
      await git(root, ["remote", "add", "origin", path.join(root, "origin.git")]);
      expect(await probeCurrentGitBranch(root)).toEqual({ branch: "main" });
      const config = path.join(root, ".git", "config");
      const ordinaryConfig = await readFile(config, "utf8");

      await writeFile(config, ordinaryConfig + "\n[other]\ninvalid?key = value\n");
      await expect(git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).rejects.toThrow(/bad config line/);
      expect(await probeCurrentGitBranch(root)).toBeUndefined();

      await writeFile(config, ordinaryConfig + "\n[remote \"broken\"]\nurl = \"unterminated\n");
      await expect(git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).rejects.toThrow(/bad config line/);
      expect(await probeCurrentGitBranch(root)).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
