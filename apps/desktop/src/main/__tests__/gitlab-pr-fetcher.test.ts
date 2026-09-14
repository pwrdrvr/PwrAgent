import { describe, expect, it, vi } from "vitest";
import { GitLabPrFetcher, parseGitLabMr, parseGitLabMrUrl } from "../pr-status/gitlab-pr-fetcher";
import { ForgePrFetcher, parseForgePrRefFromUrl } from "../pr-status/forge-pr-fetcher";
import { parsePrRefFromUrl } from "../pr-status/github-graphql-client";
import { clearGitHubRemoteCache, resolveGitHubReposForDirectory, resolveGitLabReposForDirectory } from "../pr-status/git-remote";
import { parseGlabVersionOutput } from "../settings/glab-discovery";
import { desktopSettingsPatchToEdits, parseDesktopSettingsToml } from "../settings/desktop-config";
import { applyTomlEdits } from "../settings/toml-editor";

const ref = { host: "gitlab.com", owner: "team/sub/group", repo: "project", number: 17 };
const mr = {
  iid: 17, web_url: "https://gitlab.com/team/sub/group/project/-/merge_requests/17",
  state: "opened", source_branch: "feature/a+b", target_branch: "main", sha: "new-head",
  detailed_merge_status: "mergeable", head_pipeline: { status: "success", sha: "new-head" },
};
const discovery = { selectedCommand: "/fixture/glab", candidates: [{ command: "/fixture/glab", source: "config" as const, executable: true, selected: true, version: "1.75.0" }] };

function fixture(respond: (endpoint: string) => unknown) {
  const run = vi.fn(async (_command: string, args: string[]) => JSON.stringify(respond(args.at(-1)!)));
  const discover = vi.fn(async () => discovery);
  const fetcher = new GitLabPrFetcher({ run, discover, resolveRepos: async () => [ref] });
  return { fetcher, run, discover };
}

describe("GitLab MR routing and status", () => {
  it("preserves nested namespaces and keeps GitLab identities out of GitHub", () => {
    expect(parseGitLabMrUrl(mr.web_url)).toEqual(ref);
    expect(parseGitLabMrUrl(mr.web_url.replace("/-/", "/"))).toEqual(ref);
    expect(parsePrRefFromUrl(mr.web_url)).toBeUndefined();
    expect(parsePrRefFromUrl("https://gitlab.com/team/project/pull/17")).toBeUndefined();
    expect(parseGitLabMrUrl("https://github.com/team/project/-/merge_requests/17")).toBeUndefined();
    expect(parseForgePrRefFromUrl(mr.web_url)).toEqual({ owner: ref.owner, repo: ref.repo, number: 17, kind: "gitlab", host: "gitlab.com" });
    expect(parseForgePrRefFromUrl("https://github.com/team/project/pull/17")).toEqual({ owner: "team", repo: "project", number: 17, kind: "github", host: "github.com" });
    expect(parseGitLabMrUrl(mr.web_url.replace("gitlab.com", "code.example.com"))?.host).toBe("code.example.com");
  });

  it("routes only matching remotes, including nested paths and SSH aliases", async () => {
    clearGitHubRemoteCache();
    const options = {
      readRemotes: async () => [
        { name: "origin", url: "git@work:team/sub/group/project.git" },
        { name: "upstream", url: "https://github.com/team/project.git" },
        { name: "other", url: "https://bitbucket.org/team/project.git" },
      ],
      resolveSshHostname: async () => "gitlab.com",
    };
    expect(await resolveGitLabReposForDirectory("/fixture/mixed", options)).toEqual([{ host: ref.host, owner: ref.owner, repo: ref.repo }]);
    expect(await resolveGitHubReposForDirectory("/fixture/mixed", options)).toEqual([{ host: "github.com", owner: "team", repo: "project" }]);
  });

  it("does not even discover glab for a checkout without GitLab remotes", async () => {
    const discover = vi.fn(async () => discovery);
    const run = vi.fn();
    const fetcher = new GitLabPrFetcher({ discover, run, resolveRepos: async () => [] });
    expect(await fetcher.fetchForBranch("/github-only", "feature")).toEqual([]);
    expect(discover).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("touches neither transport for a forge the operator disabled", async () => {
    // The switch has to bite at the fetcher, not just in Settings: an "off"
    // that still shells out to glab or mints a GitHub token is a setting
    // that lies. Each forge is gated independently, so disabling one must
    // leave the other working.
    const graphqlClient = {
      fetchPullRequests: vi.fn(async () => []),
      fetchPullRequestsForBranches: vi.fn(async () => new Map()),
    };
    const probeGhAvailable = vi.fn(async () => true);
    const { fetcher: gitlab, run } = fixture((endpoint) =>
      endpoint.includes("source_branch") ? [mr] : mr,
    );
    const fetcher = new ForgePrFetcher({
      graphqlClient,
      probeGhAvailable,
      resolveGitHubRepos: async () => [{ host: "github.com", owner: "team", repo: "project" }],
      isProviderEnabled: () => false,
    }, gitlab);

    expect(
      await fetcher.fetchAllPullRequestsForBranch({ cwd: "/mixed", branch: "feature" }),
    ).toEqual([]);
    expect(
      await fetcher.fetchPullRequestByUrl({ cwd: "/mixed", url: mr.web_url }),
    ).toBeUndefined();
    expect(
      await fetcher.getProviderAvailability(["/mixed"], [mr.web_url]),
    ).toEqual([]);
    expect(run).not.toHaveBeenCalled();
    expect(probeGhAvailable).not.toHaveBeenCalled();
    expect(graphqlClient.fetchPullRequests).not.toHaveBeenCalled();
    expect(graphqlClient.fetchPullRequestsForBranches).not.toHaveBeenCalled();
  });

  it("keeps GitHub working when only GitLab is disabled", async () => {
    const graphqlClient = {
      fetchPullRequests: vi.fn(async () => []),
      fetchPullRequestsForBranches: vi.fn(async () => new Map()),
    };
    const { fetcher: gitlab, run } = fixture((endpoint) =>
      endpoint.includes("source_branch") ? [mr] : mr,
    );
    const fetcher = new ForgePrFetcher({
      graphqlClient,
      probeGhAvailable: async () => true,
      resolveGitHubRepos: async () => [{ host: "github.com", owner: "team", repo: "project" }],
      isProviderEnabled: (provider) => provider === "github",
    }, gitlab);

    await fetcher.fetchAllPullRequestsForBranch({ cwd: "/mixed", branch: "feature" });
    expect(graphqlClient.fetchPullRequestsForBranches).toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("never sends GitLab branches or retained MR URLs to the GitHub transport", async () => {
    const graphqlClient = { fetchPullRequests: vi.fn(async () => []), fetchPullRequestsForBranches: vi.fn(async () => new Map()) };
    const probeGhAvailable = vi.fn(async () => true);
    const { fetcher: gitlab } = fixture((endpoint) => endpoint.includes("source_branch") ? [mr] : mr);
    const fetcher = new ForgePrFetcher({ graphqlClient, probeGhAvailable, resolveGitHubRepos: async () => [] }, gitlab);
    expect(await fetcher.fetchAllPullRequestsForBranch({ cwd: "/gitlab", branch: "feature" })).toHaveLength(1);
    expect(await fetcher.fetchPullRequestByUrl({ cwd: "/gitlab", url: mr.web_url })).toMatchObject({ provider: "gitlab.com", number: 17 });
    expect(probeGhAvailable).not.toHaveBeenCalled();
    expect(graphqlClient.fetchPullRequests).not.toHaveBeenCalled();
    expect(graphqlClient.fetchPullRequestsForBranches).not.toHaveBeenCalled();
  });

  it("routes reconnect polling and preserves an already paid GitLab request", async () => {
    const graphqlClient = {
      fetchPullRequests: vi.fn(async () => []),
      fetchPullRequestsAfterReconnect: vi.fn(async () => []),
      fetchPullRequestsForBranches: vi.fn(async () => new Map()),
    };
    const tryTakeRequestToken = vi.fn(() => false);
    const run = vi.fn(async () => JSON.stringify(mr));
    const gitlab = new GitLabPrFetcher({ discover: async () => discovery, run, tryTakeRequestToken });
    const fetcher = new ForgePrFetcher({ graphqlClient }, gitlab);
    const refs = [
      parseForgePrRefFromUrl("https://github.com/team/project/pull/17")!,
      parseForgePrRefFromUrl(mr.web_url)!,
    ];
    expect(await fetcher.fetchPullRequests(refs, { reconnect: true, requestTokenTaken: true })).toHaveLength(1);
    expect(graphqlClient.fetchPullRequestsAfterReconnect).toHaveBeenCalledWith([refs[0]]);
    expect(graphqlClient.fetchPullRequests).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledOnce();
    expect(tryTakeRequestToken).not.toHaveBeenCalled();
    expect(await fetcher.fetchPullRequests([refs[1]!])).toEqual([]);
    expect(tryTakeRequestToken).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledOnce();
  });

  it("queries the exact encoded project and branch and hydrates pipeline details", async () => {
    const { fetcher, run } = fixture((endpoint) => endpoint.includes("source_branch") ? [mr] : mr);
    expect(await fetcher.fetchForBranch("/fixture", "feature/a+b")).toEqual([expect.objectContaining({
      provider: "gitlab.com", org: "team/sub/group", repo: "project", number: 17,
      checkState: "passing", headSha: "new-head", mergeState: "mergeable",
    })]);
    expect(run.mock.calls.map((call) => call[1])).toEqual([
      ["api", "--hostname", "gitlab.com", "--method", "GET", "projects/team%2Fsub%2Fgroup%2Fproject/merge_requests?scope=all&state=all&source_branch=feature%2Fa%2Bb&per_page=100&page=1"],
      ["api", "--hostname", "gitlab.com", "--method", "GET", "projects/team%2Fsub%2Fgroup%2Fproject/merge_requests/17"],
    ]);
  });

  it.each(["opened", "locked", "merged", "closed"])("maps %s lifecycle without treating locked as terminal", (state) => {
    expect(parseGitLabMr({ ...mr, state }).lifecycleState).toBe(state === "locked" || state === "opened" ? "open" : state);
  });

  it("separates draft, conflicts, failed pipelines, running pipelines, and missing checks", () => {
    expect(parseGitLabMr({ ...mr, draft: true, detailed_merge_status: "conflict", head_pipeline: { status: "failed", web_url: "https://gitlab.com/pipeline/1" } })).toMatchObject({
      reviewState: "draft", mergeState: "conflicting", checkState: "failing", failedCheckUrl: "https://gitlab.com/pipeline/1",
    });
    expect(parseGitLabMr({ ...mr, head_pipeline: { status: "running" } })).toMatchObject({ checkState: "pending", checksStillRunning: true });
    expect(parseGitLabMr({ ...mr, head_pipeline: null }).checkState).toBe("unknown");
    expect(parseGitLabMr({ ...mr, head_pipeline: { status: "success", sha: "old-head" } }).checkState).toBe("unknown");
  });

  it("coalesces concurrent reads and does not leak CLI diagnostics", async () => {
    const { fetcher, run } = fixture(() => mr);
    await Promise.all([fetcher.fetchByRef(ref), fetcher.fetchByRef(ref)]);
    expect(run).toHaveBeenCalledTimes(1);
    run.mockRejectedValue(new Error("PRIVATE-TOKEN: glpat-secret-do-not-publish"));
    await expect(fetcher.fetchByRef(ref)).rejects.toThrow("GitLab request failed on gitlab.com");
    await expect(fetcher.fetchByRef(ref)).rejects.not.toThrow("glpat");
  });

  it("isolates cached login probes by host and rechecks after explicit invalidation", async () => {
    const { fetcher, run } = fixture((endpoint) => endpoint === "user" ? { username: "fixture" } : { scopes: ["read_api"] });
    const statuses = await Promise.all([fetcher.getAuthStatus(), fetcher.getAuthStatus()]);
    expect(statuses[0]).toMatchObject({ loggedIn: true, permissionState: "sufficient", scopes: ["read_api"] });
    expect(run).toHaveBeenCalledTimes(2);
    await fetcher.getAuthStatus("gitlab.example.com");
    expect(run).toHaveBeenCalledTimes(4);
    await fetcher.getAuthStatus("gitlab.com", true);
    expect(run).toHaveBeenCalledTimes(6);
  });

  it("reports missing CLI, invalid login and insufficient scopes distinctly", async () => {
    expect(await new GitLabPrFetcher({ discover: async () => ({ candidates: [] }) }).getAuthStatus()).toMatchObject({ installed: false, loggedIn: false });
    const invalid = fixture(() => { throw new Error("401"); });
    expect(await invalid.fetcher.getAuthStatus()).toMatchObject({ installed: true, loggedIn: false, permissionState: "unknown" });
    const restricted = fixture((endpoint) => endpoint === "user" ? { username: "fixture" } : { scopes: ["read_user"] });
    expect(await restricted.fetcher.getAuthStatus()).toMatchObject({ loggedIn: true, permissionState: "insufficient", hasRepoScope: false });
  });

  it("verifies actual MR read access when token introspection is unavailable", async () => {
    const { fetcher } = fixture((endpoint) => {
      if (endpoint === "user") return { username: "oauth-user" };
      if (endpoint === "personal_access_tokens/self") throw new Error("404");
      return [];
    });
    expect(await fetcher.getAuthStatus()).toMatchObject({ loggedIn: true, permissionState: "sufficient", scopes: [] });
  });

  it("verifies glab's own version signature", () => {
    expect(parseGlabVersionOutput("glab 1.75.0 (abcdef)")).toBe("1.75.0");
    expect(parseGlabVersionOutput("glab version 1.75.0")).toBe("1.75.0");
    expect(parseGlabVersionOutput("gh version 2.88.1")).toBeUndefined();
  });

  it("round-trips a glab override without changing gh or comments", () => {
    const original = '# keep\n[applications.gh]\npath = "/fixture/gh"\n';
    const written = applyTomlEdits(original, desktopSettingsPatchToEdits({ applications: { glab: { path: "/fixture/glab" } } }));
    expect(written).toContain(original.trim());
    expect(parseDesktopSettingsToml(written, "fixture.toml").applications).toMatchObject({ gh: { path: "/fixture/gh" }, glab: { path: "/fixture/glab" } });
  });
});

describe("review regressions", () => {
  it.each(["missing", "expired", "outage"])("keeps successful GitHub discovery when GitLab is %s", async (failure) => {
    const github = { ...parseGitLabMr(mr), provider: "github.com", org: "team", repo: "project",
      url: "https://github.com/team/project/pull/17" };
    const gitlab = new GitLabPrFetcher({
      discover: async () => failure === "missing" ? { candidates: [] } : discovery,
      resolveRepos: async () => [ref],
      run: async () => { throw new Error(failure); },
    });
    const fetcher = new ForgePrFetcher({
      probeGhAvailable: async () => true,
      resolveGitHubRepos: async () => [{ host: "github.com", owner: "team", repo: "project" }],
      graphqlClient: { fetchPullRequests: async () => [], fetchPullRequestsForBranches: async () => new Map([["team/project#feature", [github]]]) },
    }, gitlab);
    const onProviderFailure = vi.fn();
    expect(await fetcher.fetchAllPullRequestsForBranch({ cwd: "/mixed", branch: "feature", onProviderFailure })).toEqual([github]);
    expect(onProviderFailure).toHaveBeenCalledOnce();
  });

  it.each(["merge", "train"])("verifies the source parent of a synthetic %s pipeline", async (kind) => {
    for (const [status, expected] of [["running", "pending"], ["success", "passing"], ["failed", "failing"]]) {
      const { fetcher, run } = fixture((endpoint) => endpoint.includes("/repository/commits/")
        ? { id: "synthetic", parent_ids: ["target-or-previous-train", "new-head"] }
        : { ...mr, head_pipeline: { status, sha: "synthetic", ref: `refs/merge-requests/17/${kind}`, project_id: 123 } });
      expect(await fetcher.fetchByRef(ref)).toMatchObject({ headSha: "new-head", checkState: expected });
      expect(run).toHaveBeenLastCalledWith("/fixture/glab", ["api", "--hostname", "gitlab.com", "--method", "GET", "projects/123/repository/commits/synthetic"]);
    }
  });

  it("does not apply a synthetic pipeline for an older source head", async () => {
    const { fetcher } = fixture((endpoint) => endpoint.includes("/repository/commits/")
      ? { id: "synthetic", parent_ids: ["target", "old-head"] }
      : { ...mr, head_pipeline: { status: "success", sha: "synthetic", ref: "refs/merge-requests/17/train" } });
    expect(await fetcher.fetchByRef(ref)).toMatchObject({ headSha: "new-head", checkState: "unknown" });
  });

  it("charges every REST request, including synthetic commit verification", async () => {
    let remaining = 1;
    const tryTakeRequestToken = vi.fn(() => remaining-- > 0);
    const run = vi.fn(async () => JSON.stringify({ ...mr, head_pipeline: {
      status: "success", sha: "synthetic", ref: "refs/merge-requests/17/merge",
    } }));
    const fetcher = new GitLabPrFetcher({ discover: async () => discovery, run, tryTakeRequestToken });
    await expect(fetcher.fetchByRef(ref)).rejects.toThrow("budget");
    expect(run).toHaveBeenCalledTimes(1);
    expect(tryTakeRequestToken).toHaveBeenCalledTimes(2);
  });

  it("uses the scheduler's admission for exactly the initial MR request", async () => {
    const tryTakeRequestToken = vi.fn(() => true);
    const run = vi.fn(async (_command: string, args: string[]) => JSON.stringify(args.at(-1)?.includes("/repository/commits/")
      ? { id: "synthetic", parent_ids: ["target", "new-head"] }
      : { ...mr, head_pipeline: { status: "success", sha: "synthetic", ref: "refs/merge-requests/17/merge" } }));
    const fetcher = new GitLabPrFetcher({ discover: async () => discovery, run, tryTakeRequestToken });
    expect(await fetcher.fetchByRef(ref, true)).toMatchObject({ checkState: "passing" });
    expect(run).toHaveBeenCalledTimes(2);
    expect(tryTakeRequestToken).toHaveBeenCalledTimes(1);
  });

  it("bounds concurrent subprocesses without an unbounded wait queue", async () => {
    const releases: Array<() => void> = [];
    const run = vi.fn((_command: string, args: string[]) => new Promise<string>((resolve) => {
      const number = Number(args.at(-1)?.split("/").pop());
      releases.push(() => resolve(JSON.stringify({ ...mr, iid: number, web_url: mr.web_url.replace(/17$/, String(number)) })));
    }));
    const tryTakeRequestToken = vi.fn(() => true);
    const fetcher = new GitLabPrFetcher({ discover: async () => discovery, run, tryTakeRequestToken });
    const pending = Promise.allSettled(Array.from({ length: 40 }, (_, index) => fetcher.fetchByRef({ ...ref, number: index + 1 })));
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(3));
    releases.forEach((release) => release());
    const results = await pending;
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(3);
    expect(tryTakeRequestToken).toHaveBeenCalledTimes(3);
  });
});
