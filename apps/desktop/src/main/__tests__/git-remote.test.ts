import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type GitRemote,
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

  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    return { promise, resolve, reject };
  }

  const githubRemote = (repo: string): GitRemote[] => [
    { name: "origin", url: `https://github.com/owner/${repo}.git` },
  ];

  it("shares a pending cache miss across all directory lookup APIs", async () => {
    const pending = deferred<GitRemote[]>();
    const readRemotes = vi.fn(() => pending.promise);
    const options = { readRemotes };
    const origin = resolveGitHubRepoForDirectory("/repo", options);
    const eligible = hasGitHubRemoteForDirectory("/repo", options);
    const repos = resolveGitHubReposForDirectory("/repo", options);
    pending.resolve(githubRemote("project"));
    await expect(origin).resolves.toEqual({ host: "github.com", owner: "owner", repo: "project" });
    await expect(eligible).resolves.toBe(true);
    await expect(repos).resolves.toHaveLength(1);
    expect(readRemotes).toHaveBeenCalledTimes(1);
  });

  it("resolves each exact SSH host once while preserving distinct aliases and remotes", async () => {
    const pending = deferred<string | undefined>();
    const readRemotes = vi.fn(async () => [
      { name: "origin", url: "git@work:fork/project.git" },
      { name: "upstream", url: "ssh://git@work/team/project.git" },
      { name: "backup", url: "other:team/project.git" },
    ]);
    const resolveSshHostname = vi.fn((host: string) =>
      host === "work" ? pending.promise : Promise.resolve("gitlab.com"),
    );
    const options = { readRemotes, resolveSshHostname };
    const repos = resolveGitHubReposForDirectory("/repo", options);
    await Promise.resolve();
    const origin = resolveGitHubRepoForDirectory("/repo", options);
    pending.resolve("github.com");
    await expect(repos).resolves.toEqual([
      { host: "github.com", owner: "fork", repo: "project" },
      { host: "github.com", owner: "team", repo: "project" },
    ]);
    await expect(origin).resolves.toMatchObject({ owner: "fork" });
    expect(readRemotes).toHaveBeenCalledTimes(1);
    expect(resolveSshHostname.mock.calls).toEqual([["work"], ["other"]]);
  });

  it.each(["old-first", "new-first"])("isolates invalidated pending work (%s)", async (order) => {
    const old = deferred<GitRemote[]>();
    const fresh = deferred<GitRemote[]>();
    const readRemotes = vi.fn().mockReturnValueOnce(old.promise).mockReturnValue(fresh.promise);
    const options = { readRemotes };
    const first = resolveGitHubRepoForDirectory("/repo", options);
    clearGitHubRemoteCache();
    const second = resolveGitHubRepoForDirectory("/repo", options);
    if (order === "old-first") {
      old.resolve(githubRemote("old"));
      await first;
    } else {
      fresh.resolve(githubRemote("fresh"));
      await second;
    }
    const third = resolveGitHubRepoForDirectory("/repo", options);
    old.resolve(githubRemote("old"));
    fresh.resolve(githubRemote("fresh"));
    await expect(first).resolves.toMatchObject({ repo: "old" });
    await expect(second).resolves.toMatchObject({ repo: "fresh" });
    await expect(third).resolves.toMatchObject({ repo: "fresh" });
    await expect(resolveGitHubRepoForDirectory("/repo", options)).resolves.toMatchObject({ repo: "fresh" });
    expect(readRemotes).toHaveBeenCalledTimes(2);
  });

  it("shares failed work, preserves negative TTL, and retries at expiry", async () => {
    const pending = deferred<GitRemote[]>();
    let clock = 0;
    const readRemotes = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(githubRemote("recovered"));
    const options = { readRemotes, now: () => clock };
    const first = hasGitHubRemoteForDirectory("/repo", options);
    const second = hasGitHubRemoteForDirectory("/repo", options);
    pending.reject(new Error("git failed"));
    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(false);
    clock = 5 * 60_000 - 1;
    await expect(hasGitHubRemoteForDirectory("/repo", options)).resolves.toBe(false);
    expect(readRemotes).toHaveBeenCalledTimes(1);
    clock++;
    await expect(Promise.all([
      hasGitHubRemoteForDirectory("/repo", options),
      hasGitHubRemoteForDirectory("/repo", options),
    ])).resolves.toEqual([true, true]);
    expect(readRemotes).toHaveBeenCalledTimes(2);
  });

  it.each(["undefined", "reject"])("retries SSH %s results after cache expiry and invalidation", async (failure) => {
    let clock = 0;
    const readRemotes = vi.fn(async () => [
      { name: "origin", url: "work:fork/project.git" },
      { name: "upstream", url: "work:team/project.git" },
    ]);
    const resolveSshHostname = vi.fn(async (): Promise<string | undefined> => {
      if (failure === "reject") {
        throw new Error("ssh failed");
      }
      return undefined;
    });
    const options = { readRemotes, resolveSshHostname, now: () => clock };
    await expect(hasGitHubRemoteForDirectory("/repo", options)).resolves.toBe(false);
    await expect(hasGitHubRemoteForDirectory("/repo", options)).resolves.toBe(false);
    expect(resolveSshHostname).toHaveBeenCalledTimes(1);
    resolveSshHostname.mockResolvedValue("github.com");
    clock = 5 * 60_000;
    await expect(resolveGitHubReposForDirectory("/repo", options)).resolves.toHaveLength(2);
    expect(resolveSshHostname).toHaveBeenCalledTimes(2);
    clearGitHubRemoteCache();
    resolveSshHostname.mockResolvedValue("gitlab.com");
    await expect(hasGitHubRemoteForDirectory("/repo", options)).resolves.toBe(false);
    expect(resolveSshHostname).toHaveBeenCalledTimes(3);
  });

  it("starts the TTL at completion and invalidates during SSH expansion", async () => {
    let clock = 0;
    const hostname = deferred<string | undefined>();
    const started = deferred<void>();
    const readRemotes = vi.fn(async () => [{ name: "origin", url: "work:owner/project.git" }]);
    const resolveSshHostname = vi.fn(() => {
      started.resolve();
      return hostname.promise;
    });
    const options = { readRemotes, resolveSshHostname, now: () => clock };
    const old = hasGitHubRemoteForDirectory("/repo", options);
    await started.promise;
    clearGitHubRemoteCache();
    resolveSshHostname.mockResolvedValue("gitlab.com");
    const fresh = hasGitHubRemoteForDirectory("/repo", options);
    clock = 10 * 60_000;
    await expect(fresh).resolves.toBe(false);
    hostname.resolve("github.com");
    await expect(old).resolves.toBe(true);
    clock += 5 * 60_000 - 1;
    await expect(hasGitHubRemoteForDirectory("/repo", options)).resolves.toBe(false);
    expect(readRemotes).toHaveBeenCalledTimes(2);
    expect(resolveSshHostname).toHaveBeenCalledTimes(2);
  });

  it("keeps different directories independent", async () => {
    const pending = deferred<GitRemote[]>();
    const readRemotes = vi.fn((cwd: string) => cwd === "/slow" ? pending.promise : Promise.resolve(githubRemote("fast")));
    const slow = resolveGitHubRepoForDirectory("/slow", { readRemotes });
    await expect(resolveGitHubRepoForDirectory("/fast", { readRemotes })).resolves.toMatchObject({ repo: "fast" });
    pending.resolve([]);
    await expect(slow).resolves.toBeUndefined();
    expect(readRemotes).toHaveBeenCalledTimes(2);
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
