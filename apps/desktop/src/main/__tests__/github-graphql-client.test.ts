import { describe, expect, it, vi } from "vitest";
import {
  GithubGraphqlPrClient,
  branchRefKey,
  buildBatchedPrQuery,
  buildBatchedStatusContextQuery,
  buildBranchPrQuery,
  mapGraphqlPrNode,
  parsePrRefFromUrl,
  readGithubDotComAuthToken,
  retryDelayMs,
} from "../pr-status/github-graphql-client";
import type {
  GithubRepositoryAccessEvent,
  GraphqlPrNode,
  PrRef,
} from "../pr-status/github-graphql-client";

function node(overrides: Partial<GraphqlPrNode> = {}): GraphqlPrNode {
  return {
    number: 12,
    title: "Add polling",
    url: "https://github.com/pwrdrvr/PwrAgent/pull/12",
    state: "OPEN",
    isDraft: false,
    mergeable: "MERGEABLE",
    baseRefName: "agent/github-pr-auto-fix-settings",
    headRefName: "agent/pr-auto-dispatch-budget",
    headRepository: { name: "PwrAgent" },
    headRepositoryOwner: { login: "pwrdrvr" },
    commits: {
      nodes: [
        {
          commit: {
            id: "commit-a",
            oid: "a".repeat(40),
            statusCheckRollup: {
              state: "SUCCESS",
              contexts: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [],
              },
            },
          },
        },
      ],
    },
    ...overrides,
  };
}

describe("parsePrRefFromUrl", () => {
  it("extracts the BASE repo, which is what a PR number belongs to", () => {
    expect(parsePrRefFromUrl("https://github.com/pwrdrvr/PwrAgent/pull/981")).toEqual({
      owner: "pwrdrvr",
      repo: "PwrAgent",
      number: 981,
    });
  });

  it("rejects urls that are not pull requests", () => {
    expect(parsePrRefFromUrl("https://github.com/pwrdrvr/PwrAgent/issues/5")).toBeUndefined();
    expect(parsePrRefFromUrl("https://github.com/pwrdrvr/PwrAgent")).toBeUndefined();
    expect(parsePrRefFromUrl("not a url")).toBeUndefined();
  });
});

describe("buildBatchedPrQuery", () => {
  const refs: PrRef[] = [
    { owner: "pwrdrvr", repo: "PwrAgent", number: 981 },
    { owner: "other", repo: "infra", number: 7 },
  ];

  it("puts disparate repos into ONE aliased document", () => {
    const { query } = buildBatchedPrQuery(refs);
    // The whole point: two different repos, one request.
    expect(query).toContain("r0: repository(owner: $o0, name: $n0)");
    expect(query).toContain("r1: repository(owner: $o1, name: $n1)");
    expect(query).toContain("pullRequest(number: $p0)");
    expect(query).toContain("pullRequest(number: $p1)");
    expect(query.match(/repository\(/g)).toHaveLength(2);
    expect(query).toContain("baseRefName");
    expect(query).toContain("headRefName");
    expect(query).toContain("contexts(first: 100)");
    expect(query).toContain("pageInfo { hasNextPage endCursor }");
    expect(query).toContain("conclusion detailsUrl status");
    expect(query).toContain("state targetUrl");
  });

  it("asks for the hover-card stats, which cost no rate-limit points", () => {
    // GitHub prices GraphQL by connection, so these scalars are free, and
    // totalCount rides the commits connection the fragment already selects.
    const { query } = buildBatchedPrQuery([
      { owner: "pwrdrvr", repo: "PwrAgent", number: 981 },
    ]);

    expect(query).toContain("additions");
    expect(query).toContain("deletions");
    expect(query).toContain("changedFiles");
    expect(query).toContain("createdAt");
    expect(query).toContain("mergedAt");
    expect(query).toContain("closedAt");
    expect(query).toContain("commits(last: 1) {\n    totalCount");
    // Deliberately not requested: it moves on every comment and label, and no
    // surface shows it.
    expect(query).not.toContain("updatedAt");
  });

  it("passes every input as a variable rather than interpolating it", () => {
    const { query, variables } = buildBatchedPrQuery([
      // A repo name that would rewrite the document if it were interpolated.
      { owner: 'evil") { x } #', repo: "repo", number: 1 },
    ]);
    expect(variables).toEqual({ o0: 'evil") { x } #', n0: "repo", p0: 1 });
    expect(query).not.toContain("evil");
  });

  it("declares one typed variable triple per ref", () => {
    const { query, variables } = buildBatchedPrQuery(refs);
    expect(query).toContain("$o0: String!, $n0: String!, $p0: Int!");
    expect(variables).toEqual({
      o0: "pwrdrvr",
      n0: "PwrAgent",
      p0: 981,
      o1: "other",
      n1: "infra",
      p1: 7,
    });
  });
});

describe("buildBatchedStatusContextQuery", () => {
  it("uses commit ids and pagination cursors as variables", () => {
    const { query, variables } = buildBatchedStatusContextQuery([
      { commitId: "commit-1", cursor: "cursor-1" },
      { commitId: "commit-2", cursor: "cursor-2" },
    ]);

    expect(query).toContain("r0: node(id: $id0)");
    expect(query).toContain("r1: node(id: $id1)");
    expect(query).toContain("contexts(first: 100, after: $c0)");
    expect(query).toContain("contexts(first: 100, after: $c1)");
    expect(query).toContain("conclusion detailsUrl status");
    expect(query).toContain("state targetUrl");
    expect(variables).toEqual({
      id0: "commit-1",
      c0: "cursor-1",
      id1: "commit-2",
      c1: "cursor-2",
    });
  });
});

describe("buildBranchPrQuery", () => {
  it("aliases branches from different repos into one document", () => {
    const { query, variables } = buildBranchPrQuery([
      { owner: "pwrdrvr", repo: "PwrAgent", branch: "feat/a" },
      { owner: "other", repo: "infra", branch: "fix/b" },
    ]);

    expect(query).toContain("r0: repository(owner: $o0, name: $n0)");
    expect(query).toContain("r1: repository(owner: $o1, name: $n1)");
    expect(query).toContain("pullRequests(headRefName: $b0");
    expect(query).toContain("pullRequests(headRefName: $b1");
    // Merged/closed included, so a branch whose PR already landed still resolves.
    expect(query).toContain("states: [OPEN, MERGED, CLOSED]");
    expect(variables).toEqual({
      o0: "pwrdrvr",
      n0: "PwrAgent",
      b0: "feat/a",
      o1: "other",
      n1: "infra",
      b1: "fix/b",
    });
  });

  it("passes branch names as variables, never interpolated", () => {
    const { query, variables } = buildBranchPrQuery([
      { owner: "o", repo: "r", branch: 'evil") { x } #' },
    ]);
    expect(variables.b0).toBe('evil") { x } #');
    expect(query).not.toContain("evil");
  });
});

describe("branchRefKey", () => {
  it("is case-insensitive on repo but not on the branch", () => {
    // Git branches are case-sensitive; GitHub owner/repo are not.
    expect(branchRefKey({ owner: "PwrDrvr", repo: "PwrAgent", branch: "Feat/A" })).toBe(
      "pwrdrvr/pwragent#Feat/A",
    );
  });
});

describe("mapGraphqlPrNode", () => {
  it("maps a clean open PR", () => {
    expect(mapGraphqlPrNode(node())).toEqual({
      provider: "github.com",
      number: 12,
      org: "pwrdrvr",
      repo: "PwrAgent",
      title: "Add polling",
      baseRefName: "agent/github-pr-auto-fix-settings",
      headRefName: "agent/pr-auto-dispatch-budget",
      state: "passing",
      checkState: "passing",
      lifecycleState: "open",
      reviewState: "ready_for_review",
      mergeState: "mergeable",
      headSha: "a".repeat(40),
      commitShas: ["a".repeat(40)],
      url: "https://github.com/pwrdrvr/PwrAgent/pull/12",
    });
  });

  it.each([
    ["SUCCESS", "passing"],
    ["FAILURE", "failing"],
    ["ERROR", "failing"],
    ["PENDING", "pending"],
    // A required check that hasn't reported yet is owed, not broken.
    ["EXPECTED", "pending"],
  ])("maps rollup %s to chip %s", (rollup, chip) => {
    const summary = mapGraphqlPrNode(
      node({
        commits: {
          nodes: [{ commit: { oid: "b".repeat(40), statusCheckRollup: { state: rollup } } }],
        },
      }),
    );
    expect(summary.checkState).toBe(chip);
    // `state` is the deprecated alias and must stay in lockstep with checkState.
    expect(summary.state).toBe(chip);
  });

  it("records checks still running alongside a failing rollup", () => {
    const summary = mapGraphqlPrNode(
      node({
        commits: {
          nodes: [{
            commit: {
              oid: "b".repeat(40),
              statusCheckRollup: {
                state: "FAILURE",
                contexts: {
                  nodes: [
                    {
                      __typename: "CheckRun",
                      conclusion: "FAILURE",
                      detailsUrl: "https://github.com/pwrdrvr/PwrAgent/actions/runs/123",
                      status: "COMPLETED",
                    },
                    {
                      __typename: "CheckRun",
                      conclusion: null,
                      status: "IN_PROGRESS",
                    },
                  ],
                },
              },
            },
          }],
        },
      }),
    );

    expect(summary).toMatchObject({
      checkState: "failing",
      checksStillRunning: true,
      failedCheckUrl: "https://github.com/pwrdrvr/PwrAgent/actions/runs/123",
    });
  });

  it("treats a missing rollup (no checks configured) as unknown, not passing", () => {
    const summary = mapGraphqlPrNode(
      node({
        commits: { nodes: [{ commit: { oid: "c".repeat(40), statusCheckRollup: null } }] },
      }),
    );
    expect(summary.checkState).toBe("unknown");
  });

  it("reports conflicting merge state", () => {
    expect(mapGraphqlPrNode(node({ mergeable: "CONFLICTING" })).mergeState).toBe(
      "conflicting",
    );
  });

  it("reports merged and closed lifecycles, and drops merge state for them", () => {
    expect(mapGraphqlPrNode(node({ state: "MERGED" })).lifecycleState).toBe("merged");
    expect(mapGraphqlPrNode(node({ state: "MERGED" })).mergeState).toBe("unknown");
    expect(mapGraphqlPrNode(node({ state: "CLOSED" })).lifecycleState).toBe("closed");
  });

  it("reports draft review state", () => {
    expect(mapGraphqlPrNode(node({ isDraft: true })).reviewState).toBe("draft");
  });

  it("keys off the HEAD repo so fork PRs match the gh path's status key", () => {
    // Queried against base pwrdrvr/PwrAgent, but the PR came from a fork.
    const summary = mapGraphqlPrNode(
      node({
        headRepositoryOwner: { login: "contributor" },
        headRepository: { name: "PwrAgent-fork" },
      }),
    );
    expect(summary.org).toBe("contributor");
    expect(summary.repo).toBe("PwrAgent-fork");
  });

  it("carries diff, commit, and timestamp stats for the hover card", () => {
    const summary = mapGraphqlPrNode(
      node({
        additions: 412,
        deletions: 198,
        changedFiles: 18,
        createdAt: "2026-07-31T12:00:00Z",
        commits: {
          totalCount: 7,
          nodes: [{ commit: { oid: "a".repeat(40) } }],
        },
      }),
    );

    expect(summary.additions).toBe(412);
    expect(summary.deletions).toBe(198);
    expect(summary.changedFiles).toBe(18);
    expect(summary.commitCount).toBe(7);
    // ISO-8601 is converted at this boundary; everything downstream is epoch ms.
    expect(summary.createdAt).toBe(Date.parse("2026-07-31T12:00:00Z"));
  });

  it("records the terminal timestamp GitHub actually reported", () => {
    const merged = mapGraphqlPrNode(
      node({ state: "MERGED", mergedAt: "2026-08-01T09:30:00Z" }),
    );
    expect(merged.mergedAt).toBe(Date.parse("2026-08-01T09:30:00Z"));
    expect(merged.closedAt).toBeUndefined();
  });

  it("omits hover-card stats entirely when the provider returns none", () => {
    // Absent must stay absent all the way to the renderer: a `0` here would
    // claim the PR changes nothing, which is a different (and false) statement.
    const summary = mapGraphqlPrNode(node());

    expect(summary).not.toHaveProperty("additions");
    expect(summary).not.toHaveProperty("deletions");
    expect(summary).not.toHaveProperty("changedFiles");
    expect(summary).not.toHaveProperty("commitCount");
    expect(summary).not.toHaveProperty("createdAt");
  });

  it("drops nonsense counts and unparseable timestamps", () => {
    const summary = mapGraphqlPrNode(
      node({
        additions: -3,
        deletions: Number.NaN,
        createdAt: "not a date",
        commits: { totalCount: null, nodes: [{ commit: { oid: "a".repeat(40) } }] },
      }),
    );

    expect(summary).not.toHaveProperty("additions");
    expect(summary).not.toHaveProperty("deletions");
    expect(summary).not.toHaveProperty("createdAt");
    expect(summary).not.toHaveProperty("commitCount");
  });

  it("omits title when blank rather than writing an empty string", () => {
    expect(mapGraphqlPrNode(node({ title: "   " }))).not.toHaveProperty("title");
  });
});

describe("retryDelayMs", () => {
  it("honors retry-after above everything else", () => {
    const error = { status: 403, response: { headers: { "retry-after": "7" } } };
    expect(retryDelayMs(error, 1)).toBe(7000);
  });

  it("waits for the reset when the primary rate limit is exhausted", () => {
    const resetAt = Math.floor((Date.now() + 30_000) / 1000);
    const error = {
      status: 403,
      response: {
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(resetAt),
        },
      },
    };
    const delay = retryDelayMs(error, 1);
    expect(delay).toBeGreaterThan(25_000);
    expect(delay).toBeLessThanOrEqual(30_000);
  });

  it("backs off exponentially on 5xx and on transport failures with no status", () => {
    expect(retryDelayMs({ status: 500 }, 1)).toBe(1000);
    expect(retryDelayMs({ status: 500 }, 2)).toBe(2000);
    expect(retryDelayMs({ status: 502 }, 3)).toBe(4000);
    expect(retryDelayMs(new Error("socket hang up"), 1)).toBe(1000);
  });

  it("clamps any wait to a minute", () => {
    const error = { status: 429, response: { headers: { "retry-after": "9999" } } };
    expect(retryDelayMs(error, 1)).toBe(60_000);
  });

  it("gives up on errors retrying cannot fix", () => {
    expect(retryDelayMs({ status: 401 }, 1)).toBeNull();
    expect(retryDelayMs({ status: 404 }, 1)).toBeNull();
    expect(retryDelayMs({ status: 422 }, 1)).toBeNull();
    // 403 without a rate-limit header is a permissions problem, not throttling.
    expect(retryDelayMs({ status: 403 }, 1)).toBeNull();
  });
});

describe("GithubGraphqlPrClient", () => {
  const refs: PrRef[] = [
    { owner: "pwrdrvr", repo: "PwrAgent", number: 12 },
    { owner: "other", repo: "infra", number: 7 },
  ];

  function client(
    request: (query: string, variables: Record<string, string | number>) => Promise<unknown>,
    options: {
      batchSize?: number;
      onRepositoryAccess?: (event: GithubRepositoryAccessEvent) => void;
    } = {},
  ): GithubGraphqlPrClient {
    return new GithubGraphqlPrClient({
      request,
      getToken: async () => "token",
      sleep: async () => {},
      ...options,
    });
  }

  it("returns one PrSummary per resolved alias", async () => {
    const request = vi.fn(async () => ({
      r0: { pullRequest: node({ number: 12 }) },
      r1: {
        pullRequest: node({
          number: 7,
          url: "https://github.com/other/infra/pull/7",
          headRepositoryOwner: { login: "other" },
          headRepository: { name: "infra" },
        }),
      },
    }));
    const prs = await client(request).fetchPullRequests(refs);

    expect(request).toHaveBeenCalledTimes(1);
    expect(prs.map((pr) => pr.number)).toEqual([12, 7]);
  });

  it("paginates contexts before clearing a failed PR's running marker", async () => {
    const truncated = node({
      commits: {
        nodes: [{
          commit: {
            id: "commit-12",
            oid: "b".repeat(40),
            statusCheckRollup: {
              state: "FAILURE",
              contexts: {
                pageInfo: { hasNextPage: true, endCursor: "page-1" },
                nodes: [{
                  __typename: "CheckRun",
                  conclusion: "FAILURE",
                  detailsUrl: "https://github.com/pwrdrvr/PwrAgent/actions/runs/456",
                  status: "COMPLETED",
                }],
              },
            },
          },
        }],
      },
    });
    const continuationCursors: string[] = [];
    const request = vi.fn(async (
      query: string,
      variables: Record<string, string | number>,
    ) => {
      if (query.includes("PollStatusContextPages")) {
        continuationCursors.push(String(variables.c0));
        if (variables.c0 === "page-1") {
          return {
            r0: {
              statusCheckRollup: {
                contexts: {
                  pageInfo: { hasNextPage: true, endCursor: "page-2" },
                  nodes: [{
                    __typename: "CheckRun",
                    conclusion: "FAILURE",
                    status: "COMPLETED",
                  }],
                },
              },
            },
          };
        }
        return {
          r0: {
            statusCheckRollup: {
              contexts: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{
                  __typename: "CheckRun",
                  conclusion: null,
                  status: "IN_PROGRESS",
                }],
              },
            },
          },
        };
      }
      return { r0: { pullRequest: truncated } };
    });

    const [pr] = await client(request).fetchPullRequests([refs[0]!]);

    expect(request).toHaveBeenCalledTimes(3);
    expect(continuationCursors).toEqual(["page-1", "page-2"]);
    expect(pr).toMatchObject({
      checkState: "failing",
      checksStillRunning: true,
      failedCheckUrl: "https://github.com/pwrdrvr/PwrAgent/actions/runs/456",
    });
  });

  it("keeps cached status when a later context page cannot be resolved", async () => {
    const truncated = node({
      commits: {
        nodes: [{
          commit: {
            id: "commit-12",
            oid: "b".repeat(40),
            statusCheckRollup: {
              state: "FAILURE",
              contexts: {
                pageInfo: { hasNextPage: true, endCursor: "page-1" },
                nodes: [{
                  __typename: "CheckRun",
                  conclusion: "FAILURE",
                  status: "COMPLETED",
                }],
              },
            },
          },
        }],
      },
    });
    const request = vi.fn(async (query: string) => {
      if (query.includes("PollStatusContextPages")) {
        throw Object.assign(new Error("forbidden"), { status: 403 });
      }
      return { r0: { pullRequest: truncated } };
    });

    await expect(client(request).fetchPullRequests([refs[0]!])).resolves.toEqual([]);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("chunks into separate requests once past the batch size", async () => {
    const request = vi.fn(async () => ({ r0: { pullRequest: node() } }));
    await client(request, { batchSize: 1 }).fetchPullRequests(refs);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("keeps the good aliases when one PR in the batch fails to resolve", async () => {
    // Repo renamed / PR deleted / no access: GitHub errors but still returns
    // the aliases that DID resolve. One bad ref must not blank the batch.
    const request = vi.fn(async () => {
      throw Object.assign(new Error("Could not resolve to a Repository"), {
        data: { r0: { pullRequest: node({ number: 12 }) }, r1: null },
      });
    });
    const prs = await client(request).fetchPullRequests(refs);
    expect(prs.map((pr) => pr.number)).toEqual([12]);
  });

  it("retries a transient failure and then succeeds", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("bad gateway"), { status: 502 }))
      .mockResolvedValueOnce({ r0: { pullRequest: node() } });
    const prs = await client(request).fetchPullRequests([refs[0]!]);

    expect(request).toHaveBeenCalledTimes(2);
    expect(prs).toHaveLength(1);
  });

  it("gives up on a batch without throwing, so one bad batch cannot kill a sweep", async () => {
    const request = vi.fn(async () => {
      throw Object.assign(new Error("unauthorized"), { status: 401 });
    });
    await expect(client(request).fetchPullRequests(refs)).resolves.toEqual([]);
    // 401 is not retryable — exactly one attempt.
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("looks up branches across repos in one request", async () => {
    const request = vi.fn(async () => ({
      r0: { pullRequests: { nodes: [node({ number: 12 })] } },
      r1: {
        pullRequests: {
          nodes: [
            node({ number: 7, url: "https://github.com/other/infra/pull/7" }),
          ],
        },
      },
    }));
    const result = await client(request).fetchPullRequestsForBranches([
      { owner: "pwrdrvr", repo: "PwrAgent", branch: "feat/a" },
      { owner: "other", repo: "infra", branch: "fix/b" },
    ]);

    expect(request).toHaveBeenCalledTimes(1);
    expect(result.get("pwrdrvr/pwragent#feat/a")?.map((pr) => pr.number)).toEqual([12]);
    expect(result.get("other/infra#fix/b")?.map((pr) => pr.number)).toEqual([7]);
  });

  it("records an authoritative empty answer for a branch with no PRs", async () => {
    const request = vi.fn(async () => ({ r0: { pullRequests: { nodes: [] } } }));
    const result = await client(request).fetchPullRequestsForBranches([
      { owner: "pwrdrvr", repo: "PwrAgent", branch: "feat/a" },
    ]);

    // Key PRESENT with an empty array — "GitHub says this branch has no PRs".
    expect(result.has("pwrdrvr/pwragent#feat/a")).toBe(true);
    expect(result.get("pwrdrvr/pwragent#feat/a")).toEqual([]);
  });

  it("omits the key entirely when a batch fails, so callers cannot record a false negative", async () => {
    const request = vi.fn(async () => {
      throw Object.assign(new Error("unauthorized"), { status: 401 });
    });
    const result = await client(request).fetchPullRequestsForBranches([
      { owner: "pwrdrvr", repo: "PwrAgent", branch: "feat/a" },
    ]);

    // Absent, NOT an empty array — the difference between "no PRs" and
    // "we don't know" is what keeps a failed request from blanking chips.
    expect(result.has("pwrdrvr/pwragent#feat/a")).toBe(false);
  });

  it("omits only the unresolved repo when part of a batch fails", async () => {
    const request = vi.fn(async () => ({
      r0: { pullRequests: { nodes: [node({ number: 12 })] } },
      r1: null,
    }));
    const result = await client(request).fetchPullRequestsForBranches([
      { owner: "pwrdrvr", repo: "PwrAgent", branch: "feat/a" },
      { owner: "gone", repo: "missing", branch: "fix/b" },
    ]);

    expect(result.has("pwrdrvr/pwragent#feat/a")).toBe(true);
    expect(result.has("gone/missing#fix/b")).toBe(false);
  });

  it("attributes a partial SAML failure to its repository alias", async () => {
    const onRepositoryAccess = vi.fn();
    const request = vi.fn(async () => {
      throw Object.assign(
        new Error("Resource protected by organization SAML enforcement"),
        {
          data: {
            r0: { pullRequests: { nodes: [node({ number: 12 })] } },
            r1: null,
          },
          errors: [{
            message: "Resource protected by organization SAML enforcement",
            path: ["r1"],
          }],
        },
      );
    });

    await client(request, { onRepositoryAccess })
      .fetchPullRequestsForBranches([
        { owner: "pwrdrvr", repo: "PwrAgent", branch: "feat/a" },
        { owner: "EXAMPLE", repo: "example-services", branch: "main" },
      ]);

    expect(onRepositoryAccess).toHaveBeenCalledWith({
      branch: "main",
      owner: "EXAMPLE",
      repo: "example-services",
      status: "saml-enforced",
    });
    expect(onRepositoryAccess).toHaveBeenCalledWith({
      branch: "feat/a",
      owner: "pwrdrvr",
      repo: "PwrAgent",
      status: "available",
    });
  });

  it("reports repository recovery after a later successful response", async () => {
    const onRepositoryAccess = vi.fn();
    const request = vi.fn()
      .mockRejectedValueOnce(Object.assign(
        new Error("Resource protected by organization SAML enforcement"),
        { status: 403 },
      ))
      .mockResolvedValueOnce({ r0: { pullRequests: { nodes: [] } } });
    const graphqlClient = client(request, { onRepositoryAccess });
    const branchRefs = [
      { owner: "EXAMPLE", repo: "example-services", branch: "main" },
    ];

    await graphqlClient.fetchPullRequestsForBranches(branchRefs);
    await graphqlClient.fetchPullRequestsForBranches(branchRefs);

    expect(onRepositoryAccess.mock.calls.map(([event]) => event.status)).toEqual([
      "saml-enforced",
      "available",
    ]);
  });

  it("attributes retained-PR SAML failures to the URL repository ref", async () => {
    const onRepositoryAccess = vi.fn();
    const request = vi.fn(async () => {
      throw Object.assign(
        new Error("Resource protected by organization SAML enforcement"),
        { status: 403 },
      );
    });

    await client(request, { onRepositoryAccess }).fetchPullRequests([
      { owner: "historical", repo: "retained-repo", number: 42 },
    ]);

    expect(onRepositoryAccess).toHaveBeenCalledWith({
      branch: undefined,
      owner: "historical",
      repo: "retained-repo",
      status: "saml-enforced",
    });
  });

  it("does not call GitHub at all when gh has no token", async () => {
    const request = vi.fn();
    const noToken = new GithubGraphqlPrClient({
      request,
      getToken: async () => null,
    });
    await expect(noToken.fetchPullRequests(refs)).resolves.toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });
});

describe("readGithubDotComAuthToken", () => {
  it("uses gh auth token when available", async () => {
    const run = vi.fn(async () => ({ stdout: "gho_test_token\n", stderr: "" }));

    await expect(readGithubDotComAuthToken("/opt/homebrew/bin/gh", run))
      .resolves.toBe("gho_test_token");
    expect(run).toHaveBeenCalledWith("/opt/homebrew/bin/gh", [
      "auth",
      "token",
      "--hostname",
      "github.com",
    ]);
  });

  it("preserves unprefixed legacy tokens from the direct token command", async () => {
    const legacyToken = "a".repeat(40);
    const run = vi.fn(async () => ({ stdout: `${legacyToken}\n` }));

    await expect(readGithubDotComAuthToken("gh", run)).resolves.toBe(legacyToken);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("falls back to legacy status output, including stderr", async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(new Error("unknown command: token"))
      .mockResolvedValueOnce({
        stdout: "github.com\n  - Token: *******************\n",
        stderr: "gho_test_token\n",
      });

    await expect(readGithubDotComAuthToken("/opt/homebrew/bin/gh", run))
      .resolves.toBe("gho_test_token");
    expect(run).toHaveBeenNthCalledWith(2, "/opt/homebrew/bin/gh", [
      "auth",
      "status",
      "--hostname",
      "github.com",
      "--show-token",
    ]);
  });

  it("does not expose token-bearing output from a failed status fallback", async () => {
    const exposedCredential = "plaintext-test-credential-that-must-not-escape";
    const statusError = Object.assign(new Error(`Token: ${exposedCredential}`), {
      stdout: `github.com token: ${exposedCredential}`,
      stderr: `Authentication failed for token ${exposedCredential}`,
    });
    const run = vi.fn()
      .mockRejectedValueOnce(new Error("unknown command token"))
      .mockRejectedValueOnce(statusError);

    let caught: unknown;
    try {
      await readGithubDotComAuthToken("gh", run);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe(
      "GitHub CLI authentication status check failed",
    );
    expect(String(caught)).not.toContain(exposedCredential);
  });
});
