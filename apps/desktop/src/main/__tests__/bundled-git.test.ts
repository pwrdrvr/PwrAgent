import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bundledGitDirectory,
  bundledGitEnvironment,
  bundledGitExecutable,
  configureBundledGit,
  installedKeychainHelper,
} from "../bundled-git";
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

/**
 * A fake Homebrew-shaped Git install: `bin/git` symlinks into a versioned
 * prefix whose libexec holds a keychain helper that answers `get` with fixed
 * credentials. The root has a space in it, like Xcode-beta.app would.
 */
async function fakeKeychainInstall(): Promise<{ root: string; helper: string; bin: string }> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent keychain-")));
  const prefix = path.join(root, "Cellar", "git", "9.9.9");
  const gitCore = path.join(prefix, "libexec", "git-core");
  await mkdir(path.join(prefix, "bin"), { recursive: true });
  await mkdir(gitCore, { recursive: true });
  await mkdir(path.join(root, "bin"));
  await writeFile(path.join(prefix, "bin", "git"), "#!/bin/sh\nexit 0\n");
  await chmod(path.join(prefix, "bin", "git"), 0o755);
  await symlink(path.join(prefix, "bin", "git"), path.join(root, "bin", "git"));
  const helper = path.join(gitCore, "git-credential-osxkeychain");
  await writeFile(
    helper,
    "#!/bin/sh\n[ \"$1\" = get ] && printf 'username=fixture-user\\npassword=fixture-secret\\n'\nexit 0\n",
  );
  await chmod(helper, 0o755);
  return { root, helper, bin: path.join(root, "bin") };
}

function credentialFill(env: NodeJS.ProcessEnv, config: string[] = []) {
  return spawnSync(bundledGitExecutable(), [...config, "credential", "fill"], {
    cwd: os.tmpdir(),
    encoding: "utf8",
    env: { ...env, GIT_TERMINAL_PROMPT: "0" },
    input: "protocol=https\nhost=example.invalid\n\n",
    timeout: 10_000,
  });
}

// The fake install and helper are POSIX shell scripts.
describe.skipIf(process.platform === "win32")("bundled Git keychain credentials", () => {
  it("finds the keychain helper beside the Git first on PATH", async () => {
    const install = await fakeKeychainInstall();
    try {
      const searchPath = [install.bin, "/usr/bin"].join(path.delimiter);
      expect(installedKeychainHelper({ PATH: searchPath })).toBe(install.helper);
      expect(installedKeychainHelper({ PATH: path.join(install.root, "missing") })).toBeUndefined();

      // `brew upgrade git` moves the keg and relinks bin/git mid-session.
      const upgraded = path.join(install.root, "Cellar", "git", "9.9.10");
      await rename(path.join(install.root, "Cellar", "git", "9.9.9"), upgraded);
      await rm(path.join(install.bin, "git"));
      await symlink(path.join(upgraded, "bin", "git"), path.join(install.bin, "git"));
      expect(installedKeychainHelper({ PATH: searchPath }))
        .toBe(path.join(upgraded, "libexec", "git-core", "git-credential-osxkeychain"));
    } finally {
      await rm(install.root, { recursive: true, force: true });
    }
  });

  it("gives the bundle the installed keychain helper at system scope on macOS", async () => {
    const install = await fakeKeychainInstall();
    const globalConfig = path.join(install.root, "global-config");
    try {
      vi.stubEnv("PWRAGENT_HOME", path.join(install.root, "home"));
      await writeFile(globalConfig, "");
      const env = bundledGitEnvironment(
        {
          ...process.env,
          PATH: [install.bin, "/usr/bin", "/bin"].join(path.delimiter),
          GIT_CONFIG_GLOBAL: globalConfig,
        },
        { platform: "darwin" },
      );
      expect(env.GIT_CONFIG_SYSTEM).toContain(path.join(install.root, "home", "git", "gitconfig-"));
      // Dugite's own settings still apply through the include.
      expect(await readFile(env.GIT_CONFIG_SYSTEM!, "utf8")).toContain(
        path.join(bundledGitDirectory(), "etc", "gitconfig"),
      );
      expect(env.PATH?.split(path.delimiter).at(-1)).toBe(path.dirname(install.helper));

      // Homebrew's and Apple's default: the helper comes from system config.
      const fromSystem = credentialFill(env);
      expect(fromSystem.status).toBe(0);
      expect(fromSystem.stdout).toContain("username=fixture-user");
      expect(fromSystem.stdout).toContain("password=fixture-secret");

      // A user-level `credential.helper = osxkeychain` resolves by name.
      const byName = credentialFill(env, ["-c", "credential.helper=", "-c", "credential.helper=osxkeychain"]);
      expect(byName.stderr).not.toContain("is not a git command");
      expect(byName.stdout).toContain("username=fixture-user");

      // Clearing helpers in the global config still opts out, as it would
      // for the installed Git.
      await writeFile(globalConfig, "[credential]\n\thelper =\n");
      expect(credentialFill(env).status).not.toBe(0);
    } finally {
      await rm(install.root, { recursive: true, force: true });
    }
  });

  it("leaves Dugite's config alone off macOS", async () => {
    const install = await fakeKeychainInstall();
    try {
      vi.stubEnv("PWRAGENT_HOME", path.join(install.root, "home"));
      const env = bundledGitEnvironment(
        { ...process.env, PATH: [install.bin, "/usr/bin"].join(path.delimiter) },
        { platform: "linux" },
      );
      expect(env.GIT_CONFIG_SYSTEM).toBe(path.join(bundledGitDirectory(), "etc", "gitconfig"));
      expect(env.PATH).not.toContain(path.dirname(install.helper));
    } finally {
      await rm(install.root, { recursive: true, force: true });
    }
  });
});
