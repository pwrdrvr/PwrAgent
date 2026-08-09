import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearGitHubRemoteCache,
  hasGitHubRemoteForDirectory,
  parseGitHubRemote,
  resolveGitHubRepoForDirectory,
  resolveGitHubReposForDirectory,
} from "../pr-status/git-remote";

describe("parseGitHubRemote", () => {
  it.each([
    ["git@github.com:pwrdrvr/PwrAgent.git", "pwrdrvr", "PwrAgent"],
    ["git@github.com:pwrdrvr/PwrAgent", "pwrdrvr", "PwrAgent"],
    ["https://github.com/pwrdrvr/PwrAgent.git", "pwrdrvr", "PwrAgent"],
    ["https://github.com/pwrdrvr/PwrAgent", "pwrdrvr", "PwrAgent"],
    ["https://github.com/pwrdrvr/PwrAgent/", "pwrdrvr", "PwrAgent"],
    ["ssh://git@github.com/pwrdrvr/PwrAgent.git", "pwrdrvr", "PwrAgent"],
    ["git://github.com/pwrdrvr/PwrAgent.git", "pwrdrvr", "PwrAgent"],
  ])("parses %s", (url, owner, repo) => {
    expect(parseGitHubRemote(url)).toEqual({
      host: "github.com",
      owner,
      repo,
    });
  });

  it.each([
    [
      "preserves owner/repo casing, since GitHub keys are case-preserving",
      "git@github.com:PwrDrvr/PwrAgent.git",
      { host: "github.com", owner: "PwrDrvr", repo: "PwrAgent" },
    ],
    [
      "parses scp-style SSH aliases without an explicit user",
      "github-work:pwrdrvr/PwrAgent.git",
      { host: "github-work", owner: "pwrdrvr", repo: "PwrAgent" },
    ],
    [
      "reports non-github hosts so the caller can skip them",
      "git@gitlab.com:group/proj.git",
      { host: "gitlab.com", owner: "group", repo: "proj" },
    ],
  ])("%s", (_name, remote, expected) => {
    expect(parseGitHubRemote(remote)).toEqual(expected);
  });

  it("strips embedded credentials and keeps the host", () => {
    expect(
      parseGitHubRemote("https://user:token@github.com/pwrdrvr/PwrAgent.git"),
    ).toEqual({ host: "github.com", owner: "pwrdrvr", repo: "PwrAgent" });
  });

  it("rejects remotes that are not a repo root", () => {
    expect(parseGitHubRemote("")).toBeUndefined();
    expect(parseGitHubRemote("   ")).toBeUndefined();
    expect(parseGitHubRemote("not a url")).toBeUndefined();
    // Too many path segments to be owner/repo.
    expect(
      parseGitHubRemote("https://github.com/pwrdrvr/PwrAgent/tree/main"),
    ).toBeUndefined();
    // Missing the repo half.
    expect(parseGitHubRemote("https://github.com/pwrdrvr")).toBeUndefined();
  });
});

describe("resolveGitHubRepoForDirectory", () => {
  beforeEach(() => {
    clearGitHubRemoteCache();
  });

  it("resolves a directory through its origin remote", async () => {
    const readRemotes = vi.fn(async () => [
      { name: "origin", url: "git@github.com:pwrdrvr/PwrAgent.git" },
    ]);
    await expect(
      resolveGitHubRepoForDirectory("/repo", { readRemotes }),
    ).resolves.toEqual({ host: "github.com", owner: "pwrdrvr", repo: "PwrAgent" });
  });

  it("caches so a sweep does not re-shell per directory", async () => {
    const readRemotes = vi.fn(async () => [
      { name: "origin", url: "git@github.com:pwrdrvr/PwrAgent.git" },
    ]);
    await resolveGitHubRepoForDirectory("/repo", { readRemotes });
    await hasGitHubRemoteForDirectory("/repo", { readRemotes });
    expect(readRemotes).toHaveBeenCalledTimes(1);
  });

  it("caches the negative result too, so a non-git dir does not re-shell", async () => {
    const readRemotes = vi.fn(async () => []);
    await expect(
      resolveGitHubRepoForDirectory("/plain", { readRemotes }),
    ).resolves.toBeUndefined();
    await expect(
      hasGitHubRemoteForDirectory("/plain", { readRemotes }),
    ).resolves.toBe(false);
    expect(readRemotes).toHaveBeenCalledTimes(1);
  });

  it("returns an authoritative negative result when git throws", async () => {
    const readRemotes = vi.fn(async () => {
      throw new Error("not a git repository");
    });
    await expect(
      resolveGitHubRepoForDirectory("/broken", { readRemotes }),
    ).resolves.toBeUndefined();
    await expect(
      hasGitHubRemoteForDirectory("/broken", { readRemotes }),
    ).resolves.toBe(false);
  });

  it("recognizes GitHub on a non-origin configured remote", async () => {
    const readRemotes = vi.fn(async () => [
      { name: "origin", url: "git@gitlab.com:group/project.git" },
      { name: "upstream", url: "git@github.com:pwrdrvr/PwrAgent.git" },
    ]);

    await expect(
      hasGitHubRemoteForDirectory("/repo", { readRemotes }),
    ).resolves.toBe(true);
    await expect(
      resolveGitHubRepoForDirectory("/repo", { readRemotes }),
    ).resolves.toEqual({ host: "gitlab.com", owner: "group", repo: "project" });
    await expect(
      resolveGitHubReposForDirectory("/repo", { readRemotes }),
    ).resolves.toEqual([
      { host: "github.com", owner: "pwrdrvr", repo: "PwrAgent" },
    ]);
  });

  it("recognizes a GitHub SSH HostName behind a remote host alias", async () => {
    const readRemotes = vi.fn(async () => [
      { name: "origin", url: "git@github-work:pwrdrvr/PwrAgent.git" },
    ]);
    const resolveSshHostname = vi.fn(async (host: string) =>
      host === "github-work" ? "github.com" : host,
    );

    await expect(
      hasGitHubRemoteForDirectory("/repo", {
        readRemotes,
        resolveSshHostname,
      }),
    ).resolves.toBe(true);
    await expect(
      resolveGitHubRepoForDirectory("/repo", {
        readRemotes,
        resolveSshHostname,
      }),
    ).resolves.toEqual({ host: "github.com", owner: "pwrdrvr", repo: "PwrAgent" });
    expect(resolveSshHostname).toHaveBeenCalledOnce();
    expect(resolveSshHostname).toHaveBeenCalledWith("github-work");
  });

  it("resolves every distinct GitHub fork and upstream remote", async () => {
    const readRemotes = vi.fn(async () => [
      { name: "origin", url: "git@github.com:operator/PwrAgent.git" },
      { name: "upstream", url: "git@github.com:pwrdrvr/PwrAgent.git" },
      { name: "backup", url: "https://github.com/pwrdrvr/PwrAgent.git" },
    ]);

    await expect(
      resolveGitHubReposForDirectory("/repo", { readRemotes }),
    ).resolves.toEqual([
      { host: "github.com", owner: "operator", repo: "PwrAgent" },
      { host: "github.com", owner: "pwrdrvr", repo: "PwrAgent" },
    ]);
  });

  it("does not apply SSH host aliases to HTTPS remotes", async () => {
    const readRemotes = vi.fn(async () => [
      { name: "origin", url: "https://github-work/pwrdrvr/PwrAgent.git" },
    ]);
    const resolveSshHostname = vi.fn(async () => "github.com");

    await expect(
      hasGitHubRemoteForDirectory("/repo", {
        readRemotes,
        resolveSshHostname,
      }),
    ).resolves.toBe(false);
    expect(resolveSshHostname).not.toHaveBeenCalled();
  });

  it("rejects a repo whose configured remotes do not point to GitHub", async () => {
    const readRemotes = vi.fn(async () => [
      { name: "origin", url: "git@gitlab.com:group/project.git" },
      { name: "backup", url: "/srv/git/project.git" },
    ]);

    await expect(
      hasGitHubRemoteForDirectory("/repo", { readRemotes }),
    ).resolves.toBe(false);
  });

  it("re-probes once the cache entry ages out", async () => {
    const readRemotes = vi.fn(async () => [
      { name: "origin", url: "git@github.com:pwrdrvr/PwrAgent.git" },
    ]);
    let clock = 1_000_000;
    const now = () => clock;

    await resolveGitHubRepoForDirectory("/repo", { readRemotes, now });
    clock += 10 * 60_000;
    await resolveGitHubRepoForDirectory("/repo", { readRemotes, now });

    expect(readRemotes).toHaveBeenCalledTimes(2);
  });
});
