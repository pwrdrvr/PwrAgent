import { spawnSync } from "node:child_process";
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bundledGitDirectory,
  bundledGitEnvironment,
  bundledGitExecutable,
  bundledGitLfsExecutable,
  configureBundledGit,
  installedGitLfs,
  installedKeychainHelper,
  linuxCaBundleFallback,
  operatorSearchPath,
} from "../bundled-git";
import { resolveGitExecutable, runGitCommand, streamGitCommand } from "../app-server/git-executable";

afterEach(() => {
  configureBundledGit();
  vi.unstubAllEnvs();
});

/** What launchd hands an app the operator opened from Finder or the Dock. */
const LAUNCHD_SEARCH_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(path.delimiter);

describe("operator search path", () => {
  const installDirectories = ["/opt/homebrew/bin", ".local/bin"];
  const home = path.join(path.sep, "Users", "dana");
  const repair = (searchPath: string, platform: NodeJS.Platform = "darwin") =>
    operatorSearchPath(searchPath, { home, installDirectories, platform });

  it("searches what the operator installed, and launchd's directories last", () => {
    expect(repair(LAUNCHD_SEARCH_PATH)).toBe([
      "/opt/homebrew/bin",
      path.join(home, ".local", "bin"),
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ].join(path.delimiter));
  });

  it("leaves every other PATH exactly as it stands", () => {
    // A shell has already searched what the operator installed, in their own
    // order. A fixture directory is the same case: neither is rewritten.
    for (const searchPath of [
      ["/opt/homebrew/bin", "/usr/bin", "/bin"].join(path.delimiter),
      ["/usr/bin", path.join(os.tmpdir(), "fixture", "bin")].join(path.delimiter),
    ]) {
      expect(repair(searchPath)).toBe(searchPath);
    }
    // A Windows PATH comes from the registry, which already holds what an
    // installer put there.
    expect(repair(LAUNCHD_SEARCH_PATH, "win32")).toBe(LAUNCHD_SEARCH_PATH);
  });

  it("names each directory once", () => {
    expect(operatorSearchPath(["/usr/bin", "/usr/bin"].join(path.delimiter), {
      home,
      installDirectories: ["/usr/bin", ".local/bin"],
      platform: "darwin",
    })).toBe(["/usr/bin", path.join(home, ".local", "bin")].join(path.delimiter));
  });
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

  it("enables LFS for an operator with no LFS setup, and yields to one who opted out", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-lfs-defaults-")));
    const repo = path.join(root, "repo");
    // No system LFS, no global filter, no `git lfs install` in the repository.
    const env = {
      ...process.env,
      PATH: process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32") : "/usr/bin:/bin",
      GIT_CONFIG_GLOBAL: path.join(root, "global-config"),
      GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    };
    const git = async (cwd: string, args: string[]) => (await runGitCommand(cwd, args, { env })).stdout.trim();
    try {
      await writeFile(env.GIT_CONFIG_GLOBAL, "");
      await mkdir(repo);
      await git(repo, ["init", "-b", "main"]);
      // Dugite sets this on every platform, so it proves the bundle's own
      // system config is still read beneath PwrAgent's defaults.
      expect(await git(repo, ["config", "--get", "credential.https://dev.azure.com.usehttppath"])).toBe("true");
      await writeFile(path.join(repo, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n");
      const payload = Buffer.from("bundled LFS defaults\0payload\n");
      await writeFile(path.join(repo, "asset.bin"), payload);
      await git(repo, ["add", ".gitattributes", "asset.bin"]);
      await git(repo, ["-c", "commit.gpgsign=false", "commit", "-m", "LFS fixture"]);
      const pointer = await git(repo, ["show", "HEAD:asset.bin"]);
      expect(pointer).toMatch(/^version https:\/\/git-lfs.github.com\/spec\/v1\n/);
      // git-lfs installs its hooks the first time the filter runs, so a push
      // uploads the objects a commit stored.
      await expect(access(path.join(repo, ".git", "hooks", "pre-push"))).resolves.toBeUndefined();
      await rm(path.join(repo, "asset.bin"));
      await git(repo, ["checkout", "--", "asset.bin"]);
      expect(await readFile(path.join(repo, "asset.bin"))).toEqual(payload);

      // Global config outranks the bundle's system defaults.
      await git(root, ["lfs", "install", "--skip-smudge"]);
      await rm(path.join(repo, "asset.bin"));
      await git(repo, ["checkout", "--", "asset.bin"]);
      expect((await readFile(path.join(repo, "asset.bin"), "utf8")).trim()).toBe(pointer);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("looks past its own bundle for the operator's git-lfs", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-installed-lfs-")));
    const executable = path.join(root, process.platform === "win32" ? "git-lfs.exe" : "git-lfs");
    try {
      // The bundle's own git-lfs joins PATH inside PwrAgent's children only,
      // so finding it there would say nothing about the operator's shell.
      const bundled = path.dirname(bundledGitLfsExecutable());
      expect(installedGitLfs({ PATH: bundled })).toBeUndefined();
      expect(installedGitLfs({ PATH: root })).toBeUndefined();
      await writeFile(executable, "");
      expect(installedGitLfs({ PATH: [bundled, root].join(path.delimiter) })).toBe(executable);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it.skipIf(process.platform === "win32")("finds the operator's git-lfs when PwrAgent was opened from Finder", async () => {
    // Apple ships no git-lfs, so launchd's PATH alone reports one installed
    // nowhere, and the warning about a repository the bundle set Git LFS up
    // in would reach every operator who has one.
    const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-launchd-home-")));
    try {
      await mkdir(path.join(home, "bin"));
      await writeFile(path.join(home, "bin", "git-lfs"), "");
      expect(installedGitLfs({ PATH: LAUNCHD_SEARCH_PATH, HOME: home })).toBeDefined();
    } finally {
      await rm(home, { force: true, recursive: true });
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

  it("searches past launchd's PATH for the helper that stored the keychain items", async () => {
    const install = await fakeKeychainInstall();
    try {
      vi.stubEnv("PWRAGENT_HOME", path.join(install.root, "home"));
      // An app opened from Finder inherits launchd's PATH and nothing else.
      // Whatever it finds there is not the Git the operator runs, so it is not
      // the helper whose keychain items open without an access prompt.
      const launchdOnly = installedKeychainHelper({ PATH: LAUNCHD_SEARCH_PATH });
      const env = bundledGitEnvironment(
        { ...process.env, HOME: install.root, PATH: LAUNCHD_SEARCH_PATH },
        { platform: "darwin" },
      );
      const helper = (await readFile(env.GIT_CONFIG_SYSTEM!, "utf8")).match(/helper = "!'([^']+)'"/)?.[1];
      expect(helper).toBeDefined();
      expect(helper).not.toBe(launchdOnly);
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

  it("adds no keychain helper off macOS", async () => {
    const install = await fakeKeychainInstall();
    try {
      vi.stubEnv("PWRAGENT_HOME", path.join(install.root, "home"));
      const env = bundledGitEnvironment(
        { ...process.env, PATH: [install.bin, "/usr/bin"].join(path.delimiter) },
        { platform: "linux" },
      );
      const config = await readFile(env.GIT_CONFIG_SYSTEM!, "utf8");
      expect(config).toContain("[filter \"lfs\"]");
      expect(config).not.toContain("[credential]");
      expect(env.PATH).not.toContain(path.dirname(install.helper));
    } finally {
      await rm(install.root, { recursive: true, force: true });
    }
  });
});

/** One value as the bundled Git resolves it, for an environment built here. */
function configGet(env: NodeJS.ProcessEnv, key: string, cwd = os.tmpdir()): string {
  return spawnSync(bundledGitExecutable(), ["config", "--get", key], {
    cwd,
    encoding: "utf8",
    env,
    timeout: 10_000,
  }).stdout.trim();
}

// Include paths are compared unescaped, which holds for POSIX paths only.
describe.skipIf(process.platform === "win32")("bundled Git system config visibility", () => {
  async function fixture() {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-system-config-")));
    vi.stubEnv("PWRAGENT_HOME", path.join(root, "home"));
    const globalConfig = path.join(root, "global-config");
    await writeFile(globalConfig, "");
    const source: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: globalConfig };
    delete source.GIT_CONFIG_SYSTEM;
    return { root, globalConfig, source };
  }

  it("includes an operator's own GIT_CONFIG_SYSTEM in place of the bundle's", async () => {
    const { root, source } = await fixture();
    try {
      const own = path.join(root, "own-system-config");
      await writeFile(own, "[pwragent]\n\tfixture = own\n");
      const env = bundledGitEnvironment({ ...source, GIT_CONFIG_SYSTEM: own }, { platform: "linux" });
      expect(env.GIT_CONFIG_SYSTEM).not.toBe(own);
      const generated = await readFile(env.GIT_CONFIG_SYSTEM!, "utf8");
      expect(generated).toContain(`path = "${own}"`);
      expect(generated).not.toContain(path.join(bundledGitDirectory(), "etc", "gitconfig"));
      expect(configGet(env, "pwragent.fixture")).toBe("own");
      // PwrAgent's defaults still sit beneath it.
      expect(configGet(env, "filter.lfs.required")).toBe("true");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rebuilds a GIT_CONFIG_SYSTEM that PwrAgent itself set instead of stacking it", async () => {
    const { root, source } = await fixture();
    try {
      const first = bundledGitEnvironment(source, { platform: "linux" });
      const bundleInclude = `path = "${path.join(bundledGitDirectory(), "etc", "gitconfig")}"`;
      // A shell in PwrAgent's terminal carries the generated file.
      const again = bundledGitEnvironment({ ...source, GIT_CONFIG_SYSTEM: first.GIT_CONFIG_SYSTEM }, { platform: "linux" });
      expect(again.GIT_CONFIG_SYSTEM).toBe(first.GIT_CONFIG_SYSTEM);
      // A generated file from another PwrAgent root is recognized by its header.
      const elsewhere = path.join(root, "other-root-gitconfig");
      await copyFile(first.GIT_CONFIG_SYSTEM!, elsewhere);
      const fromOtherRoot = bundledGitEnvironment({ ...source, GIT_CONFIG_SYSTEM: elsewhere }, { platform: "linux" });
      expect(await readFile(fromOtherRoot.GIT_CONFIG_SYSTEM!, "utf8")).toContain(bundleInclude);
      // So is the bundle's own file.
      const bundleFile = path.join(bundledGitDirectory(), "etc", "gitconfig");
      const fromBundle = bundledGitEnvironment({ ...source, GIT_CONFIG_SYSTEM: bundleFile }, { platform: "linux" });
      expect(fromBundle.GIT_CONFIG_SYSTEM).toBe(first.GIT_CONFIG_SYSTEM);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("enables reflink checkouts at system scope, where global config can turn them off", async () => {
    const { root, globalConfig, source } = await fixture();
    try {
      const env = bundledGitEnvironment(source, { platform: "linux" });
      expect(configGet(env, "checkout.reflink")).toBe("true");
      await writeFile(globalConfig, "[checkout]\n\treflink = false\n");
      expect(configGet(env, "checkout.reflink")).toBe("false");
      // Windows keeps Dugite's MinGit, which has no reflink support.
      const windows = bundledGitEnvironment(source, { platform: "win32" });
      expect(await readFile(windows.GIT_CONFIG_SYSTEM!, "utf8")).not.toContain("[checkout]");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("points Linux Git at the distribution's CA bundle only beneath every explicit setting", async () => {
    const { root, globalConfig, source } = await fixture();
    const openSuse = (file: string) => file === "/etc/ssl/ca-bundle.pem";
    try {
      const env = bundledGitEnvironment(source, { platform: "linux", exists: openSuse });
      expect(configGet(env, "http.sslCAInfo")).toBe("/etc/ssl/ca-bundle.pem");
      // Global config wins, as it would over an installed Git's default.
      await writeFile(globalConfig, "[http]\n\tsslCAInfo = /operator/ca.pem\n");
      expect(configGet(env, "http.sslCAInfo")).toBe("/operator/ca.pem");
      // An explicit certificate variable means no fallback is written at all.
      for (const name of ["GIT_SSL_CAINFO", "GIT_SSL_CAPATH", "SSL_CERT_FILE", "SSL_CERT_DIR", "CURL_CA_BUNDLE"]) {
        const explicit = bundledGitEnvironment({ ...source, [name]: "/operator/certs" }, { platform: "linux", exists: openSuse });
        expect(explicit[name]).toBe("/operator/certs");
        expect(await readFile(explicit.GIT_CONFIG_SYSTEM!, "utf8")).not.toContain("[http]");
      }
      // Off Linux, the platform trust store applies.
      const mac = bundledGitEnvironment(source, { platform: "darwin", exists: openSuse });
      expect(await readFile(mac.GIT_CONFIG_SYSTEM!, "utf8")).not.toContain("[http]");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Linux CA bundle fallback", () => {
  const only = (...files: string[]) => (file: string) => files.includes(file);

  it("leaves the runtime libcurl's own default alone when it exists", () => {
    expect(linuxCaBundleFallback({}, only("/etc/ssl/certs/ca-certificates.crt", "/etc/ssl/ca-bundle.pem"))).toBeUndefined();
  });

  it("finds the openSUSE and RHEL-family bundles", () => {
    expect(linuxCaBundleFallback({}, only("/etc/ssl/ca-bundle.pem"))).toBe("/etc/ssl/ca-bundle.pem");
    expect(linuxCaBundleFallback({}, only("/etc/pki/tls/certs/ca-bundle.crt"))).toBe("/etc/pki/tls/certs/ca-bundle.crt");
    expect(linuxCaBundleFallback({}, only("/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem")))
      .toBe("/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem");
  });

  it("returns nothing when no bundle is known", () => {
    expect(linuxCaBundleFallback({}, only())).toBeUndefined();
  });
});
