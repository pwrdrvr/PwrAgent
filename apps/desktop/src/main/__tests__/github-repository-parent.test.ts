import { describe, expect, it, vi } from "vitest";
import { ForgeCiClient } from "../pr-status/forge-ci-client";
import { createGitHubRepositoryParentLookup } from "../pr-status/github-repository-parent";

const fork = { host: "github.com", owner: "contributor", repo: "engine" };
const parent = { host: "github.com", owner: "project", repo: "engine" };
const forkResponse = {
  data: { repository: {
    nameWithOwner: "contributor/renamed-engine",
    isFork: true,
    parent: { nameWithOwner: "project/engine" },
  } },
};
const afterBackgroundRead = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("GitHub repository parent lookup", () => {
  it("resolves a renamed fork without cooling down unrelated GitHub reads", async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      if (url === "https://api.github.com/repos/contributor/engine") {
        return new Response(null, { status: 301, headers: { Location: "https://api.github.com/repositories/42" } });
      }
      if (url === "https://api.github.com/graphql") return Response.json(forkResponse);
      return Response.json({ ok: true });
    });
    const client = new ForgeCiClient({
      gitlab: { readApi: vi.fn() },
      enabled: () => true,
      takeToken: () => true,
      githubToken: async () => "test-token",
      fetch: fetcher,
    });
    const resolve = createGitHubRepositoryParentLookup((...args) => client.requestGithub(...args));
    expect(resolve(fork)).toBeUndefined();
    await afterBackgroundRead();
    expect(resolve(fork)).toEqual(parent);
    await expect(client.requestGithub({ ...parent, provider: "github" }, { path: "repos/project/engine" })).resolves.toEqual({ ok: true });
  });

  it("coalesces case-insensitive reads and refreshes the answer after five minutes", async () => {
    let now = 0;
    const request = vi.fn()
      .mockResolvedValueOnce(forkResponse)
      .mockResolvedValue({ data: { repository: { isFork: false } } });
    const resolve = createGitHubRepositoryParentLookup(request, () => now);

    expect(resolve(fork)).toBeUndefined();
    expect(resolve({ ...fork, owner: "CONTRIBUTOR" })).toBeUndefined();
    await afterBackgroundRead();
    expect(resolve({ ...fork, owner: "CONTRIBUTOR" })).toEqual(parent);
    expect(request).toHaveBeenCalledExactlyOnceWith(
      { ...fork, provider: "github" },
      { path: "graphql", graphql: true, body: {
        query: expect.stringContaining("followRenames: true"),
        variables: { owner: "contributor", name: "engine" },
      } },
      expect.any(AbortSignal),
    );

    now = 5 * 60_000 - 1;
    expect(resolve(fork)).toEqual(parent);
    expect(request).toHaveBeenCalledOnce();

    now++;
    expect(resolve(fork)).toEqual(parent);
    await afterBackgroundRead();
    expect(resolve(fork)).toBeUndefined();
    now += 60_000;
    expect(resolve(fork)).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("retries an unavailable answer after one minute", async () => {
    let now = 0;
    const request = vi.fn().mockRejectedValueOnce(new Error("GitHub unavailable"))
      .mockResolvedValue(forkResponse);
    const resolve = createGitHubRepositoryParentLookup(request, () => now);

    expect(resolve(fork)).toBeUndefined();
    await afterBackgroundRead();
    now = 60_000 - 1;
    expect(resolve(fork)).toBeUndefined();
    expect(request).toHaveBeenCalledOnce();

    now++;
    expect(resolve(fork)).toBeUndefined();
    await afterBackgroundRead();
    expect(resolve(fork)).toEqual(parent);
    expect(request).toHaveBeenCalledTimes(2);
  });
});
