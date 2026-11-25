import { describe, expect, it, vi } from "vitest";
import { createGitHubRepositoryParentLookup } from "../pr-status/github-repository-parent";

const fork = { host: "github.com", owner: "contributor", repo: "engine" };
const parent = { host: "github.com", owner: "project", repo: "engine" };

describe("GitHub repository parent lookup", () => {
  it("coalesces case-insensitive reads and refreshes the answer after five minutes", async () => {
    let now = 0;
    const request = vi.fn()
      .mockResolvedValueOnce({
        fork: true,
        parent: { full_name: "project/engine" },
        source: { full_name: "root/engine" },
      })
      .mockResolvedValue({ fork: false });
    const resolve = createGitHubRepositoryParentLookup(request, () => now);

    expect(await Promise.all([resolve(fork), resolve({ ...fork, owner: "CONTRIBUTOR" })])).toEqual([parent, parent]);
    expect(request).toHaveBeenCalledExactlyOnceWith(
      { ...fork, provider: "github" }, { path: "repos/contributor/engine" }, expect.any(AbortSignal),
    );

    now = 5 * 60_000 - 1;
    expect(await resolve(fork)).toEqual(parent);
    expect(request).toHaveBeenCalledOnce();

    now++;
    expect(await resolve(fork)).toBeUndefined();
    now += 60_000;
    expect(await resolve(fork)).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("retries an unavailable answer after one minute", async () => {
    let now = 0;
    const request = vi.fn().mockRejectedValueOnce(new Error("GitHub unavailable"))
      .mockResolvedValue({ fork: true, parent: { full_name: "project/engine" } });
    const resolve = createGitHubRepositoryParentLookup(request, () => now);

    expect(await resolve(fork)).toBeUndefined();
    now = 60_000 - 1;
    expect(await resolve(fork)).toBeUndefined();
    expect(request).toHaveBeenCalledOnce();

    now++;
    expect(await resolve(fork)).toEqual(parent);
    expect(request).toHaveBeenCalledTimes(2);
  });
});
