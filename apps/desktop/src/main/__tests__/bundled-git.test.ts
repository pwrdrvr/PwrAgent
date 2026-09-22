import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bundledGitDirectory, bundledGitEnvironment, bundledGitExecutable, configureBundledGit } from "../bundled-git";
import { resolveGitExecutable, runGitCommand, streamGitCommand } from "../app-server/git-executable";

afterEach(() => {
  configureBundledGit();
  vi.unstubAllEnvs();
});

describe("bundled Git runtime", () => {
  it("pins the executable, helpers and hook PATH despite inherited overrides", async () => {
    const inherited = { ...process.env, LOCAL_GIT_DIRECTORY: "/foreign/git", GIT_EXEC_PATH: "/foreign/helpers", GIT_TEMPLATE_DIR: "/foreign/templates", Path: "/foreign/bin" };
    const env = bundledGitEnvironment(inherited);
    expect(await resolveGitExecutable(inherited)).toBe(bundledGitExecutable());
    expect(env.LOCAL_GIT_DIRECTORY).toBe(bundledGitDirectory());
    expect(env.GIT_EXEC_PATH).toContain(bundledGitDirectory());
    expect(env.PATH?.split(path.delimiter)[0]).toBe(path.dirname(bundledGitExecutable()));
    expect(Object.keys(env).filter((key) => key.toUpperCase() === "PATH")).toEqual(["PATH"]);
    expect(inherited.GIT_EXEC_PATH).toBe("/foreign/helpers");
    expect((await runGitCommand(os.tmpdir(), ["lfs", "version"], { env: inherited })).stdout).toMatch(/^git-lfs\//);
  });

  it.each(["empty", "inherited"])("ignores ambient helper overrides with an %s supplied environment", async (source) => {
    vi.stubEnv("GIT_EXEC_PATH", path.join(os.tmpdir(), "foreign-git-helpers"));
    vi.stubEnv("LOCAL_GIT_DIRECTORY", path.join(os.tmpdir(), "foreign-git"));
    const supplied = source === "empty" ? {} : process.env;
    const env = bundledGitEnvironment(supplied);
    expect(env.GIT_EXEC_PATH).toContain(bundledGitDirectory() + path.sep);
    expect(env.PATH?.split(path.delimiter)).toContain(env.GIT_EXEC_PATH);
    expect(await resolveGitExecutable(supplied)).toBe(bundledGitExecutable());
    const result = await runGitCommand(os.tmpdir(), ["lfs", "version"], { env: supplied });
    expect(result.stdout).toMatch(/^git-lfs\//);
  });

  it("does not fall back on either buffered or streaming calls when the bundle is absent", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-absent-bundle-"));
    try {
      configureBundledGit(root);
      await expect(runGitCommand(root, ["--version"])).rejects.toMatchObject({ code: "ENOENT" });
      await expect(streamGitCommand(root, ["--version"], { timeout: 1000, onStdout: () => true })).rejects.toThrow();
    } finally {
      configureBundledGit();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("round-trips LFS content through a commit and checkout without system Git or LFS", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-bundled-lfs-"));
    const env = {
      ...process.env,
      PATH: process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32") : "/usr/bin:/bin",
      GIT_CONFIG_GLOBAL: path.join(root, "empty-config"), GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    };
    const git = (args: string[]) => runGitCommand(root, args, { env });
    try {
      await writeFile(env.GIT_CONFIG_GLOBAL, "");
      await git(["init", "-b", "main"]);
      await git(["lfs", "install", "--local"]);
      await writeFile(path.join(root, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n");
      const payload = Buffer.from("bundled LFS fixture\0payload\n");
      await writeFile(path.join(root, "asset.bin"), payload);
      await git(["add", ".gitattributes", "asset.bin"]);
      await git(["-c", "commit.gpgsign=false", "commit", "-m", "LFS fixture"]);
      expect((await git(["show", "HEAD:asset.bin"])).stdout).toContain("version https://git-lfs.github.com/spec/v1");
      await rm(path.join(root, "asset.bin"));
      await git(["checkout", "--", "asset.bin"]);
      expect(await readFile(path.join(root, "asset.bin"))).toEqual(payload);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a bundle missing LFS even when the Git executable is present", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-missing-lfs-"));
    const originalGit = bundledGitExecutable();
    try {
      configureBundledGit(root);
      await mkdir(path.dirname(bundledGitExecutable()), { recursive: true });
      await copyFile(originalGit, bundledGitExecutable());
      await expect(runGitCommand(root, ["lfs", "version"])).rejects.toMatchObject({
        code: "ENOENT", path: expect.stringContaining("git-lfs"),
      });
    } finally {
      configureBundledGit();
      await rm(root, { recursive: true, force: true });
    }
  });
});
