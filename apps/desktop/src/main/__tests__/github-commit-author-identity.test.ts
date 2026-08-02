import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  GithubCommitAuthorIdentityInput,
  GithubCommitAuthorIdentityProof,
} from "@pwragent/shared";
import { GhCliCommitAuthorIdentityTransport } from "../github/commit-author-identity-gh-transport";
import {
  buildGithubCommitAuthorIdentityCacheKey,
  GithubCommitAuthorIdentityResolver,
  type GithubCommitAuthorIdentityRemoteCommit,
  type GithubCommitAuthorIdentityTransport,
} from "../github/commit-author-identity-resolver";
import { GithubCommitAuthorIdentityCacheStore } from "../github/commit-author-identity-store";
import { StateDb } from "../state/state-db";

const AUTHOR = {
  name: "Ada Lovelace",
  email: "ada@example.test",
};
const PROOF: GithubCommitAuthorIdentityProof = {
  owner: "octo-org",
  repo: "example-repo",
  commitSha: "0123456789abcdef0123456789abcdef01234567",
};
const INPUT: GithubCommitAuthorIdentityInput = { author: AUTHOR, proof: PROOF };

let tempDir: string;
let stateDb: StateDb;
let cache: GithubCommitAuthorIdentityCacheStore;
let now: number;
let fetchCalls: number;
let fetchImpl: () => Promise<GithubCommitAuthorIdentityRemoteCommit>;
let resolver: GithubCommitAuthorIdentityResolver;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "pwragent-github-identity-"));
  stateDb = StateDb.open(path.join(tempDir, "state.db"));
  cache = new GithubCommitAuthorIdentityCacheStore(stateDb);
  now = 1_000_000;
  fetchCalls = 0;
  fetchImpl = async () => resolvedRemoteCommit();
  resolver = createResolver();
});

afterEach(() => {
  stateDb.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("GithubCommitAuthorIdentityResolver", () => {
  it("returns cache data immediately, then persists a proof-backed identity", async () => {
    const request = resolver.request(INPUT);

    expect(request.lookup).toEqual({
      cacheState: "miss",
      refreshState: "in-flight",
    });
    const completion = await requireCompletion(request.completion);
    expect(completion).toEqual({
      identity: {
        login: "ada",
        avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
      },
      cacheState: "fresh",
      refreshState: "idle",
    });
    expect(fetchCalls).toBe(1);

    const key = buildGithubCommitAuthorIdentityCacheKey(AUTHOR)!;
    expect(cache.read(key)).toMatchObject({
      status: "resolved",
      identity: { login: "ada" },
      fetchedAt: now,
      expiresAt: now + 7 * 24 * 60 * 60 * 1000,
    });
    const raw = stateDb.raw
      .prepare("SELECT * FROM github_commit_author_identity_cache WHERE identity_key = ?")
      .get(key) as Record<string, unknown>;
    const serialized = JSON.stringify(raw);
    expect(serialized).not.toContain(AUTHOR.name);
    expect(serialized).not.toContain(AUTHOR.email);
    expect(serialized).not.toContain("gho_");

    const cacheOnly = resolver.request({ author: AUTHOR });
    expect(cacheOnly).toEqual({
      lookup: {
        identity: {
          login: "ada",
          avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
        },
        cacheState: "fresh",
        refreshState: "idle",
      },
    });
    expect(fetchCalls).toBe(1);
  });

  it("requires an exact GitHub commit, name, and email match before resolving", async () => {
    fetchImpl = async () => ({
      ...resolvedRemoteCommit(),
      author: { name: AUTHOR.name, email: "different@example.test" },
    });

    const request = resolver.request(INPUT);
    const completion = await requireCompletion(request.completion);

    expect(completion).toEqual({
      cacheState: "miss",
      refreshState: "backing-off",
    });
    const entry = cache.read(buildGithubCommitAuthorIdentityCacheKey(AUTHOR)!);
    expect(entry).toMatchObject({
      status: "unavailable",
      failureCount: 1,
      nextRetryAt: now + 60_000,
    });
    expect(entry?.identity).toBeUndefined();

    const retryGated = resolver.request(INPUT);
    expect(retryGated).toEqual({
      lookup: {
        cacheState: "miss",
        refreshState: "backing-off",
      },
    });
    expect(fetchCalls).toBe(1);
  });

  it("negative-caches an exact commit with no GitHub account", async () => {
    fetchImpl = async () => ({
      sha: PROOF.commitSha,
      author: AUTHOR,
      githubAuthor: null,
    });

    const initial = resolver.request(INPUT);
    expect(await requireCompletion(initial.completion)).toEqual({
      cacheState: "fresh",
      refreshState: "idle",
    });
    expect(cache.read(buildGithubCommitAuthorIdentityCacheKey(AUTHOR)!)?.status).toBe(
      "negative",
    );

    const repeated = resolver.request(INPUT);
    expect(repeated).toEqual({
      lookup: {
        cacheState: "fresh",
        refreshState: "idle",
      },
    });
    expect(fetchCalls).toBe(1);
  });

  it("serves a stale verified identity while a single refresh runs", async () => {
    const initial = resolver.request(INPUT);
    await requireCompletion(initial.completion);

    let releaseFetch: ((value: GithubCommitAuthorIdentityRemoteCommit) => void) | undefined;
    fetchImpl = async () => await new Promise<GithubCommitAuthorIdentityRemoteCommit>((resolve) => {
      releaseFetch = resolve;
    });
    now += 7 * 24 * 60 * 60 * 1000 + 1;

    const stale = resolver.request(INPUT);
    expect(stale.lookup).toEqual({
      identity: {
        login: "ada",
        avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
      },
      cacheState: "stale",
      refreshState: "in-flight",
    });
    expect(fetchCalls).toBe(1);

    await Promise.resolve();
    expect(fetchCalls).toBe(2);
    releaseFetch?.({
      ...resolvedRemoteCommit(),
      githubAuthor: {
        login: "ada-lovelace",
        avatarUrl: "https://avatars.githubusercontent.com/u/2?v=4",
      },
    });

    expect(await requireCompletion(stale.completion)).toEqual({
      identity: {
        login: "ada-lovelace",
        avatarUrl: "https://avatars.githubusercontent.com/u/2?v=4",
      },
      cacheState: "fresh",
      refreshState: "idle",
    });
  });

  it("backs off transient failures without rejecting the caller", async () => {
    fetchImpl = async () => {
      throw new Error("offline");
    };
    resolver = createResolver({ initialBackoffMs: 1_000, maxBackoffMs: 8_000 });

    const first = resolver.request(INPUT);
    expect(await requireCompletion(first.completion)).toEqual({
      cacheState: "miss",
      refreshState: "backing-off",
    });
    expect(fetchCalls).toBe(1);
    expect(cache.read(buildGithubCommitAuthorIdentityCacheKey(AUTHOR)!)?.nextRetryAt).toBe(
      now + 1_000,
    );

    now += 999;
    expect(resolver.request(INPUT)).toEqual({
      lookup: { cacheState: "miss", refreshState: "backing-off" },
    });
    expect(fetchCalls).toBe(1);

    now += 1;
    const second = resolver.request(INPUT);
    await requireCompletion(second.completion);
    expect(fetchCalls).toBe(2);
    expect(cache.read(buildGithubCommitAuthorIdentityCacheKey(AUTHOR)!)?.nextRetryAt).toBe(
      now + 2_000,
    );
  });

  it("never performs an email-only or short-SHA lookup", () => {
    expect(resolver.request({ author: AUTHOR })).toEqual({
      lookup: {
        cacheState: "miss",
        refreshState: "not-eligible",
      },
    });
    expect(resolver.request({
      author: AUTHOR,
      proof: { ...PROOF, commitSha: PROOF.commitSha.slice(0, 12) },
    })).toEqual({
      lookup: {
        cacheState: "miss",
        refreshState: "not-eligible",
      },
    });
    expect(fetchCalls).toBe(0);
  });
});

describe("GhCliCommitAuthorIdentityTransport", () => {
  it("uses gh api with no token-extraction command or credential parameter", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const transport = new GhCliCommitAuthorIdentityTransport({
      resolveGhCommand: async () => "/custom/bin/gh",
      exec: async (command, args) => {
        calls.push({ command, args });
        return {
          stdout: JSON.stringify({
            sha: PROOF.commitSha,
            commit: { author: AUTHOR },
            author: {
              login: "ada",
              avatar_url: "https://avatars.githubusercontent.com/u/1?v=4",
            },
          }),
        };
      },
    });

    await expect(transport.fetchCommit(PROOF)).resolves.toEqual(resolvedRemoteCommit());
    expect(calls).toEqual([
      {
        command: "/custom/bin/gh",
        args: [
          "api",
          "--hostname",
          "github.com",
          "repos/octo-org/example-repo/commits/0123456789abcdef0123456789abcdef01234567",
          "--method",
          "GET",
          "--header",
          "Accept: application/vnd.github+json",
          "--header",
          "X-GitHub-Api-Version: 2022-11-28",
        ],
      },
    ]);
    expect(calls[0]?.args).not.toContain("auth");
    expect(calls[0]?.args).not.toContain("token");
  });
});

function createResolver(options?: {
  initialBackoffMs?: number;
  maxBackoffMs?: number;
}): GithubCommitAuthorIdentityResolver {
  const transport: GithubCommitAuthorIdentityTransport = {
    fetchCommit: async () => {
      fetchCalls += 1;
      return await fetchImpl();
    },
  };
  return new GithubCommitAuthorIdentityResolver({
    cache,
    transport,
    now: () => now,
    ...options,
  });
}

function resolvedRemoteCommit(): GithubCommitAuthorIdentityRemoteCommit {
  return {
    sha: PROOF.commitSha,
    author: AUTHOR,
    githubAuthor: {
      login: "ada",
      avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
    },
  };
}

async function requireCompletion(
  completion: Promise<unknown> | undefined,
): Promise<unknown> {
  expect(completion).toBeDefined();
  return await completion!;
}
