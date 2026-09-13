import { describe, expect, it, vi } from "vitest";
import { FORGE_KINDS, type ForgeKind, type PrSummary } from "@pwragent/shared";
import { ForgePrFetcher, parseForgePrRefFromUrl, type ForgePrProvider } from "../pr-status/forge-pr-fetcher";

const urls = {
  github: "https://github.com/team/project/pull/17",
  gitlab: "https://code.example.com/team/sub/project/-/merge_requests/17",
} satisfies Record<ForgeKind, string>;

function providerFixture(kind: ForgeKind) {
  const ref = parseForgePrRefFromUrl(urls[kind])!;
  const pr = { provider: ref.host, org: ref.owner, repo: ref.repo, number: ref.number, url: urls[kind], state: "passing" } as PrSummary;
  const observations = [pr];
  return {
    pr,
    observations,
    provider: {
      resolveRepos: vi.fn(async () => [ref]),
      isAvailable: vi.fn(async () => true),
      availabilityError: vi.fn(() => undefined),
      fetchForBranch: vi.fn(async () => [pr]),
      fetchByUrl: vi.fn(async () => pr),
      fetchRefs: vi.fn(async () => observations),
    } satisfies ForgePrProvider,
  };
}

function fixture() {
  const github = providerFixture("github");
  const gitlab = providerFixture("gitlab");
  const enabled = new Set<ForgeKind>(FORGE_KINDS);
  const fetcher = new ForgePrFetcher({
    providers: { github: github.provider, gitlab: gitlab.provider },
    isProviderEnabled: (kind) => enabled.has(kind),
  });
  return { fetcher, github, gitlab, enabled };
}

describe("forge provider registry", () => {
  it.each(FORGE_KINDS)("routes %s URLs only to their provider, including custom hosts", async (kind) => {
    const h = fixture();
    expect(await h.fetcher.fetchPullRequestByUrl({ cwd: "/fixture", url: urls[kind] })).toEqual(h[kind].pr);
    for (const other of FORGE_KINDS.filter((entry) => entry !== kind)) {
      expect(h[other].provider.fetchByUrl).not.toHaveBeenCalled();
    }
  });

  it("never falls through to a transport for an unsupported URL", async () => {
    const h = fixture();
    expect(await h.fetcher.fetchPullRequestByUrl({ cwd: "/fixture", url: "https://bitbucket.org/team/project/pull/17" })).toBeUndefined();
    for (const kind of FORGE_KINDS) expect(h[kind].provider.fetchByUrl).not.toHaveBeenCalled();
  });

  it.each(FORGE_KINDS)("rechecks the %s enable switch on every entry point", async (kind) => {
    const h = fixture();
    h.enabled.delete(kind);
    const ref = parseForgePrRefFromUrl(urls[kind])!;
    const failure = vi.fn();
    await h.fetcher.fetchPullRequestByUrl({ cwd: "/fixture", url: urls[kind], onProviderFailure: failure });
    await h.fetcher.fetchAllPullRequestsForBranch({ cwd: "/fixture", branch: "feature", onProviderFailure: failure });
    await h.fetcher.getProviderAvailability(["/fixture"], Object.values(urls));
    await h.fetcher.fetchPullRequests([ref], { reconnect: true, requestTokenTaken: true });
    for (const method of Object.values(h[kind].provider)) expect(method).not.toHaveBeenCalled();
    expect(failure).not.toHaveBeenCalled();
    h.enabled.add(kind);
    await h.fetcher.fetchPullRequests([ref]);
    expect(h[kind].provider.fetchRefs).toHaveBeenCalledWith([ref], {});
  });

  it("isolates branch failures and reports them without losing another forge's PRs", async () => {
    const h = fixture();
    h.github.provider.fetchForBranch.mockRejectedValue(new Error("offline"));
    const failure = vi.fn();
    expect(await h.fetcher.fetchAllPullRequestsForBranch({ cwd: "/fixture", branch: "feature", onProviderFailure: failure })).toEqual([h.gitlab.pr]);
    expect(failure).toHaveBeenCalledOnce();
  });

  it("partitions polling refs and forwards reconnect and paid-request semantics", async () => {
    const h = fixture();
    const refs = FORGE_KINDS.map((kind) => parseForgePrRefFromUrl(urls[kind])!);
    const options = { reconnect: true, requestTokenTaken: true };
    const results = await h.fetcher.fetchPullRequests(refs, options);
    expect(results).toEqual([h.github.pr, h.gitlab.pr]);
    for (const kind of FORGE_KINDS) {
      expect(h[kind].provider.fetchRefs).toHaveBeenCalledWith(refs.filter((ref) => ref.kind === kind), options);
    }
    results.pop();
    expect(h.github.observations).toEqual([h.github.pr]);
    expect(h.gitlab.observations).toEqual([h.gitlab.pr]);
  });

  it("discovers availability through every registered resolver and retains host identity", async () => {
    const h = fixture();
    expect(await h.fetcher.getProviderAvailability(["/fixture"], Object.values(urls))).toEqual([
      { provider: "github.com", cli: "gh", available: true },
      { provider: "code.example.com", cli: "glab", available: true },
    ]);
    for (const kind of FORGE_KINDS) expect(h[kind].provider.isAvailable).toHaveBeenCalledOnce();
  });
});
