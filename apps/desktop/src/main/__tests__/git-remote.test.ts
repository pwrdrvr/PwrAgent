import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearGitHubRemoteCache,
  parseGitHubRemote,
  resolveGitHubRepoForDirectory,
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

  it("preserves owner/repo casing, since GitHub keys are case-preserving", () => {
    expect(parseGitHubRemote("git@github.com:PwrDrvr/PwrAgent.git")).toEqual({
      host: "github.com",
      owner: "PwrDrvr",
      repo: "PwrAgent",
    });
  });

  it("strips embedded credentials and keeps the host", () => {
    expect(
      parseGitHubRemote("https://user:token@github.com/pwrdrvr/PwrAgent.git"),
    ).toEqual({ host: "github.com", owner: "pwrdrvr", repo: "PwrAgent" });
  });

  it("reports non-github hosts so the caller can skip them", () => {
    expect(parseGitHubRemote("git@gitlab.com:group/proj.git")).toEqual({
      host: "gitlab.com",
      owner: "group",
      repo: "proj",
    });
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
    const readRemoteUrl = vi.fn(async () => "git@github.com:pwrdrvr/PwrAgent.git");
    await expect(
      resolveGitHubRepoForDirectory("/repo", { readRemoteUrl }),
    ).resolves.toEqual({ host: "github.com", owner: "pwrdrvr", repo: "PwrAgent" });
  });

  it("caches so a sweep does not re-shell per directory", async () => {
    const readRemoteUrl = vi.fn(async () => "git@github.com:pwrdrvr/PwrAgent.git");
    await resolveGitHubRepoForDirectory("/repo", { readRemoteUrl });
    await resolveGitHubRepoForDirectory("/repo", { readRemoteUrl });
    expect(readRemoteUrl).toHaveBeenCalledTimes(1);
  });

  it("caches the negative result too, so a non-git dir does not re-shell", async () => {
    const readRemoteUrl = vi.fn(async () => undefined);
    await expect(
      resolveGitHubRepoForDirectory("/plain", { readRemoteUrl }),
    ).resolves.toBeUndefined();
    await resolveGitHubRepoForDirectory("/plain", { readRemoteUrl });
    expect(readRemoteUrl).toHaveBeenCalledTimes(1);
  });

  it("returns undefined when git throws, so the caller falls back to gh", async () => {
    const readRemoteUrl = vi.fn(async () => {
      throw new Error("not a git repository");
    });
    await expect(
      resolveGitHubRepoForDirectory("/broken", { readRemoteUrl }),
    ).resolves.toBeUndefined();
  });

  it("re-probes once the cache entry ages out", async () => {
    const readRemoteUrl = vi.fn(async () => "git@github.com:pwrdrvr/PwrAgent.git");
    let clock = 1_000_000;
    const now = () => clock;

    await resolveGitHubRepoForDirectory("/repo", { readRemoteUrl, now });
    clock += 10 * 60_000;
    await resolveGitHubRepoForDirectory("/repo", { readRemoteUrl, now });

    expect(readRemoteUrl).toHaveBeenCalledTimes(2);
  });
});
