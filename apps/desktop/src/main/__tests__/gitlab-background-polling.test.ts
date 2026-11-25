import { expect, it, vi } from "vitest";
import fc from "fast-check";
import { buildPullRequestStatusKey, type PrSummary } from "@pwragent/shared/contracts/navigation";
import { FORGE_PRODUCTS } from "@pwragent/shared/forge-product";
import { ForgePrFetcher } from "../pr-status/forge-pr-fetcher";
import { GitLabPrFetcher, parseGitLabMr, type GitLabMrPayload } from "../pr-status/gitlab-pr-fetcher";
import { PrPollingScheduler } from "../pr-status/pr-polling-scheduler";
import { PrStatusTokenBucket } from "../pr-status/pr-status-token-bucket";
import { TranscriptPrSubscriptions } from "../pr-status/transcript-pr-subscriptions";

const host = "gitlab.example.com";
const project = "team/sub/project";
const prefix = `projects/${encodeURIComponent(project)}/merge_requests`;
const discover = async () => ({ selectedCommand: "/fixture/glab", candidates: [] });

function ref(number: number) {
  return { host, owner: "team/sub", repo: "project", number };
}

function fixtureMr(iid: number): GitLabMrPayload {
  const sha = `head-${iid}`;
  return {
    iid,
    web_url: `https://${host}/${project}/-/merge_requests/${iid}`,
    state: "opened",
    title: `MR ${iid}`,
    draft: iid % 2 === 0,
    source_branch: `branch-${iid}`,
    target_branch: "main",
    sha,
    detailed_merge_status: "mergeable",
    has_conflicts: false,
    created_at: "2026-11-01T00:00:00Z",
    head_pipeline: { status: "success", sha },
  };
}

function graphNode(row: GitLabMrPayload) {
  return {
    iid: String(row.iid),
    webUrl: row.web_url,
    state: row.state,
    title: row.title,
    draft: row.draft,
    sourceBranch: row.source_branch,
    targetBranch: row.target_branch,
    diffHeadSha: row.sha,
    detailedMergeStatus: row.detailed_merge_status?.toUpperCase(),
    conflicts: row.has_conflicts,
    createdAt: row.created_at,
    mergedAt: row.merged_at ?? null,
    closedAt: row.closed_at ?? null,
    headPipeline: row.head_pipeline && {
      status: row.head_pipeline.status?.toUpperCase(),
      sha: row.head_pipeline.sha,
      ref: row.head_pipeline.ref ?? row.source_branch,
      path: row.head_pipeline.web_url ? new URL(row.head_pipeline.web_url).pathname : null,
      project: { id: `gid://gitlab/Project/${row.head_pipeline.project_id ?? 123}` },
    },
  };
}

function graphPage(rows: GitLabMrPayload[], endCursor: string | null = null, errors?: unknown[]) {
  return JSON.stringify({ data: { project: { mergeRequests: {
    nodes: rows.map(graphNode), pageInfo: { hasNextPage: endCursor !== null, endCursor },
  } } }, errors });
}

function cliHttpError(status: number, headers = "", body = "{}") {
  return Object.assign(new Error("nonzero glab exit"), { stdout: `HTTP/2.0 ${status}\r\n${headers}\r\n${body}` });
}

it("completes a merge-train observation under repeated small shared-budget refills", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 5 }), async (refill) => {
    let tokens = refill;
    let now = Date.now();
    const takeToken = () => tokens > 0 && --tokens >= 0;
    const rows = Array.from({ length: 6 }, (_, index) => {
      const row = fixtureMr(index + 1);
      const projectIndex = Math.floor(index / 2);
      row.web_url = row.web_url.replace(project, `${project}-${projectIndex}`);
      row.head_pipeline = { status: "running", sha: `train-${row.iid}`,
        ref: `refs/merge-requests/${row.iid}/train`, project_id: 432 };
      return row;
    });
    const gitlab = new GitLabPrFetcher({ discover, tryTakeRequestToken: takeToken, run: async (_command, args) => {
      const endpoint = args.at(-1)!;
      if (endpoint === "graphql") {
        const query = args.find((arg) => arg.startsWith("query="))!;
        const projectIndex = Number(query.match(/fullPath: "[^"]+-(\d+)"/)?.[1]);
        return graphPage(rows.filter((row) => row.web_url.includes(`${project}-${projectIndex}/`)));
      }
      const commit = endpoint.match(/\/repository\/commits\/(train-(\d+))$/);
      if (commit) return JSON.stringify({ id: commit[1], parent_ids: [`head-${commit[2]}`] });
      if (endpoint.includes("/merge_trains/")) return '{"status":"fresh","pipeline":{"status":"running"}}';
      if (/^projects\/[^/]+$/.test(endpoint)) return '{"merge_trains_enabled":true}';
      const row = rows.find((row) => endpoint.endsWith(`/merge_requests/${row.iid}`));
      if (row) return JSON.stringify(row);
      throw new Error(`Unexpected fake transport request ${endpoint}`);
    } });
    const observed: PrSummary[] = [];
    const targets = rows.map((row) => {
      const pr = parseGitLabMr(row);
      return { prKey: buildPullRequestStatusKey(pr), pr, threadKeys: [] };
    });
    const forge = new ForgePrFetcher({}, gitlab);
    const scheduler = new PrPollingScheduler({
      listTargets: () => targets, getFocusedThreadKeys: () => new Set(), isWindowVisible: () => true, now: () => now,
      tryTakeToken: takeToken, fetchPullRequests: (refs, gitlabPoll) => forge.fetchPullRequests(refs, { gitlabPoll }),
      applyResults: async (prs) => { observed.push(...prs); return []; },
    });
    // The independent model needs four paid operations for the first MR:
    // status, synthetic commit parent, project setting, and train car.
    for (let tick = 0; tick < Math.ceil(4 / refill); tick++) {
      await scheduler.tick();
      tokens = refill;
      now += 15_000;
    }
    expect(observed[0]).toMatchObject({ number: 1, checkState: "pending", mergeQueue: { state: "group_checks_running" } });
  }), { examples: [[5]], numRuns: 12 });
});

it.each(["unchecked", "forbidden"])("uses budgeted REST detail for the %s GraphQL response", async (scenario) => {
  const run = vi.fn(async (_command: string, args: string[]) => {
    const endpoint = args.at(-1)!;
    if (endpoint === "graphql") {
      if (scenario === "forbidden") throw cliHttpError(403);
      return graphPage([{ ...fixtureMr(1), detailed_merge_status: "unchecked" }, fixtureMr(2)]);
    }
    if (endpoint.startsWith(`${prefix}/`)) return JSON.stringify(fixtureMr(Number(endpoint.at(-1))));
    return "{}";
  });
  const pay = vi.fn(() => true);
  const gitlab = new GitLabPrFetcher({ discover, run, tryTakeRequestToken: pay });
  const results = await gitlab.pollProject([ref(1), ref(2)], { takeFirstRequestToken: pay, defer: vi.fn() });
  expect(results).toHaveLength(2);
  expect(results.every((pr) => pr.mergeState === "mergeable")).toBe(true);
  expect(run.mock.calls.map(([, args]) => args.at(-1))).toContain(`${prefix}/1`);
  expect(pay).toHaveBeenCalledTimes(run.mock.calls.length);
});

it("orders a page and a later fallback around an overlapping foreground observation", async () => {
  let timestamp = Date.now();
  const nextAt = () => ++timestamp;
  const rows = [fixtureMr(1), fixtureMr(2), fixtureMr(3)];
  const stored = new Map<number, { title?: string; at: number }>();
  const gitlab = new GitLabPrFetcher({ discover, getObservationTimestamp: nextAt, run: async (_command, args) => {
    const endpoint = args.at(-1)!;
    if (endpoint === "graphql") {
      if (args.some((arg) => arg.includes('after: "next"'))) return graphPage([rows[1]!]);
      // The first page started already. A foreground refresh of all rows
      // completes before the next page and the singleton fallback start.
      const at = nextAt();
      for (const row of rows) stored.set(row.iid, { title: "foreground", at });
      return graphPage([rows[0]!], "next");
    }
    if (endpoint === `${prefix}/3`) return JSON.stringify(rows[2]);
    return "{}";
  } });
  const forge = new ForgePrFetcher({}, gitlab);
  const scheduler = new PrPollingScheduler({
    listTargets: () => rows.map((row) => {
      const pr = parseGitLabMr(row);
      return { pr, prKey: buildPullRequestStatusKey(pr), threadKeys: [] };
    }),
    getFocusedThreadKeys: () => new Set(), isWindowVisible: () => true, tryTakeToken: () => true,
    getObservationTimestamp: nextAt,
    fetchPullRequests: (refs, gitlabPoll) => forge.fetchPullRequests(refs, { gitlabPoll }),
    applyResults: async (prs, fallbackAt, fetchedAtByKey) => {
      for (const pr of prs) {
        const at = fetchedAtByKey?.get(buildPullRequestStatusKey(pr)) ?? fallbackAt;
        if (at >= (stored.get(pr.number)?.at ?? 0)) stored.set(pr.number, { title: pr.title, at });
      }
      return [];
    },
  });
  await scheduler.tick();
  expect([...stored.values()].map(({ title }) => title)).toEqual(["foreground", "MR 2", "MR 3"]);
  expect(stored.get(2)!.at).toBeLessThan(stored.get(3)!.at);
});

it("keeps a transcript-only MR pending until provider cooldown ends with background polling off", async () => {
  vi.useFakeTimers();
  const subscriptions = new TranscriptPrSubscriptions();
  try {
    const row = { ...fixtureMr(1), web_url: fixtureMr(1).web_url.replace(host, "gitlab.com") };
    const run = vi.fn(async (_command: string, args: string[]) => {
      if (args.at(-1) === "blocker") throw cliHttpError(429, "Retry-After: 61\r\n");
      if (args.at(-1) === `${prefix}/1`) return JSON.stringify(row);
      return "{}";
    });
    const gitlab = new GitLabPrFetcher({ discover, run });
    await expect(gitlab.readApi("gitlab.com", "blocker")).rejects.toThrow("429");
    const forge = new ForgePrFetcher({}, gitlab);
    const scheduler = new PrPollingScheduler({
      listTargets: () => subscriptions.targets(), getFocusedThreadKeys: () => new Set(), isWindowVisible: () => true,
      tryTakeToken: () => true, fetchPullRequests: (refs, gitlabPoll) => forge.fetchPullRequests(refs, { gitlabPoll }),
      applyResults: async (prs, at, atByKey) => { subscriptions.observe(prs, at, atByKey); return []; },
      onTargetsHandled: (keys) => subscriptions.markHandled(keys),
    });
    subscriptions.set(1, { removedUrls: [], updates: [{ url: row.web_url, visible: true }] }, vi.fn());
    subscriptions.requestRefresh(() => scheduler.tick(() => subscriptions.pendingTargets()));
    await vi.advanceTimersByTimeAsync(60_999);
    expect(run).toHaveBeenCalledOnce();
    expect(subscriptions.pendingTargets()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(run).toHaveBeenCalledTimes(3);
    expect(subscriptions.pendingTargets()).toEqual([]);
    expect(subscriptions.targets()[0]?.pr.checkState).toBe("passing");
  } finally {
    subscriptions.clear();
    vi.useRealTimers();
  }
});

it("reports a temporary login check failure and probes again after Retry-After", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const run = vi.fn(async (_command: string, args: string[]) => {
      if (args.at(-1) === "blocker") throw cliHttpError(429, "Retry-After: 61\r\n");
      if (args.at(-1) === "user") return '{"username":"fixture"}';
      return '{"scopes":["read_api"]}';
    });
    const gitlab = new GitLabPrFetcher({ discover, run });
    await expect(gitlab.readApi(host, "blocker")).rejects.toThrow("429");
    await expect(gitlab.getAuthStatus(host, true)).rejects.toThrow("rate-limiting");
    expect(run).toHaveBeenCalledOnce();
    vi.setSystemTime(Date.now() + 61_000);
    await expect(gitlab.getAuthStatus(host)).resolves.toMatchObject({ loggedIn: true, account: "fixture" });
    expect(run).toHaveBeenCalledTimes(3);
  } finally {
    vi.useRealTimers();
  }
});

it("shares one in-flight detail read and its original timestamp with a manual refresh", async () => {
  const gate = Promise.withResolvers<string>();
  const recordObservation = vi.fn();
  const paid = vi.fn(() => true);
  const run = vi.fn(async (_command: string, args: string[]) => args.at(-1) === `${prefix}/1` ? await gate.promise : "{}");
  const getObservationTimestamp = vi.fn().mockReturnValueOnce(100).mockReturnValue(200);
  const gitlab = new GitLabPrFetcher({ discover, run, tryTakeRequestToken: paid, getObservationTimestamp });
  const manual = gitlab.fetchByRef(ref(1));
  await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
  const background = gitlab.pollProject([ref(1)], { takeFirstRequestToken: paid, defer: vi.fn(), recordObservation });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(run).toHaveBeenCalledOnce();
  gate.resolve(JSON.stringify(fixtureMr(1)));
  expect(await background).toEqual([await manual]);
  expect(paid).toHaveBeenCalledTimes(2);
  expect(recordObservation).toHaveBeenCalledWith(expect.objectContaining({ number: 1 }), 100);
});

it.each([false, true])("matches singleton status with fewer paid background requests (synthetic pipelines: %s)", async (synthetic) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const rows = Array.from({ length: 18 }, (_, index) => {
      const row = fixtureMr(index + 1);
      if (synthetic && index % 6 === 0) {
        row.head_pipeline = { status: "failed", sha: `train-${row.iid}`, ref: `refs/merge-requests/${row.iid}/train`, project_id: 432,
          web_url: `https://${host}/fork/source/-/pipelines/${row.iid}` };
      }
      return row;
    });
    const expected = rows.map((row) => parseGitLabMr(row, row.sha));
    const bucket = new PrStatusTokenBucket();
    let paid = 0;
    const takeToken = () => {
      if (!bucket.tryTake()) return false;
      paid++;
      return true;
    };
    const requests: string[] = [];
    const gitlab = new GitLabPrFetcher({
      discover,
      tryTakeRequestToken: takeToken,
      run: async (_command, args) => {
        const endpoint = args.at(-1)!;
        requests.push(endpoint);
        if (endpoint === "graphql") {
          const query = args.find((arg) => arg.startsWith("query="))!;
          const iids = query.match(/iids:\s*\[([^\]]+)\]/)?.[1]?.match(/\d+/g)?.map(Number) ?? [];
          expect(iids.length).toBeLessThanOrEqual(FORGE_PRODUCTS.gitlab.pollBatchSize);
          expect(query).toContain(`first: ${iids.length}`);
          return graphPage(iids.map((iid) => rows[iid - 1]!));
        }
        if (endpoint.startsWith(`${prefix}/`)) return JSON.stringify(rows[Number(endpoint.slice(prefix.length + 1)) - 1]);
        const commit = endpoint.match(/^projects\/432\/repository\/commits\/(train-(\d+))$/);
        if (commit) return JSON.stringify({ id: commit[1], parent_ids: ["base", `head-${commit[2]}`] });
        if (endpoint === `projects/${encodeURIComponent(project)}`) return JSON.stringify({ merge_trains_enabled: false });
        throw new Error(`Unexpected fake transport request ${endpoint}`);
      },
    });
    const forge = new ForgePrFetcher({}, gitlab);
    const observed = new Map<number, PrSummary>();
    const scheduler = new PrPollingScheduler({
      listTargets: () => expected.map((pr) => ({ prKey: buildPullRequestStatusKey(pr), pr, threadKeys: [] })),
      getFocusedThreadKeys: () => new Set(),
      isWindowVisible: () => true,
      tryTakeToken: takeToken,
      fetchPullRequests: (refs, gitlabPoll) => forge.fetchPullRequests(refs, { gitlabPoll }),
      applyResults: async (prs) => {
        for (const pr of prs) observed.set(pr.number, pr);
        return [];
      },
    });
    let ticks = 0;
    for (; ticks < 10 && observed.size < rows.length; ticks++) {
      await scheduler.tick();
      vi.setSystemTime(Date.now() + 15_000);
    }
    expect([...observed.values()].sort((a, b) => a.number - b.number)).toEqual(expected);
    expect({ requests: requests.length, paid, ticks }).toEqual({ requests: synthetic ? 7 : 4, paid: synthetic ? 7 : 4, ticks: 1 });
  } finally {
    vi.useRealTimers();
  }
});

it("reduces a truncated page, pays for every cursor, and keeps valid siblings of missing and moved MRs", async () => {
  const moved = fixtureMr(3);
  moved.web_url = moved.web_url.replace(project, "moved/new-name");
  const queries: string[] = [];
  const takeToken = vi.fn(() => true);
  const run = vi.fn(async (_command: string, args: string[]) => {
    const endpoint = args.at(-1)!;
    if (endpoint === "graphql") {
      const query = args.find((arg) => arg.startsWith("query="))!;
      queries.push(query);
      if (query.includes("first: 4")) throw Object.assign(new Error(), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
      if (query.includes('after: "page-two"')) {
        return graphPage([fixtureMr(4), moved], null, [{ path: ["project", "mergeRequests", "nodes", 1, "headPipeline"] }]);
      }
      return graphPage([fixtureMr(1)], "page-two");
    }
    if (endpoint === `${prefix}/2`) throw cliHttpError(404);
    if (endpoint === `${prefix}/3`) return JSON.stringify(moved);
    if (endpoint === `projects/${encodeURIComponent(project)}` || endpoint === "projects/moved%2Fnew-name") return "{}";
    throw new Error(`Unexpected fake transport request ${endpoint}`);
  });
  const gitlab = new GitLabPrFetcher({ discover, run, tryTakeRequestToken: takeToken });
  const takeFirstRequestToken = vi.fn(() => true);
  const actual = await gitlab.pollProject([ref(1), ref(2), ref(3), ref(4)], { takeFirstRequestToken, defer: vi.fn() });
  expect(actual).toEqual([parseGitLabMr(fixtureMr(1)), parseGitLabMr(fixtureMr(4)), parseGitLabMr(moved)]);
  expect(queries.map((query) => query.match(/first: (\d+)/)?.[1])).toEqual(["4", "2", "2"]);
  expect(run).toHaveBeenCalledTimes(7);
  expect(takeFirstRequestToken).toHaveBeenCalledOnce();
  expect(takeToken).toHaveBeenCalledTimes(6);
});

it("uses fresh REST detail for older schemas and keeps merge-train observations per MR", async () => {
  const takeToken = vi.fn(() => true);
  const run = vi.fn(async (_command: string, args: string[]) => {
    const endpoint = args.at(-1)!;
    if (endpoint === "graphql") {
      throw cliHttpError(200, "", JSON.stringify({ errors: [{ extensions: { code: "undefinedField" } }] }));
    }
    if (endpoint.endsWith("/merge_trains/merge_requests/1")) {
      return JSON.stringify({ status: "fresh", pipeline: { status: "running" } });
    }
    if (endpoint.endsWith("/merge_trains/merge_requests/2")) throw cliHttpError(404);
    if (endpoint === `${prefix}/1`) return JSON.stringify(fixtureMr(1));
    if (endpoint === `${prefix}/2`) return JSON.stringify({ ...fixtureMr(2), has_conflicts: true });
    if (endpoint === `projects/${encodeURIComponent(project)}`) return '{"merge_trains_enabled":true}';
    throw new Error(`Unexpected fake transport request ${endpoint}`);
  });
  const gitlab = new GitLabPrFetcher({ discover, run, tryTakeRequestToken: takeToken });
  const request = { takeFirstRequestToken: takeToken, defer: vi.fn() };
  const actual = await gitlab.pollProject([ref(1), ref(2)], request);
  expect(actual).toHaveLength(2);
  expect(actual[0]?.mergeQueue?.state).toBe("group_checks_running");
  expect(actual[1]?.mergeState).toBe("conflicting");
  expect(takeToken).toHaveBeenCalledTimes(6);
  expect(await gitlab.pollProject([ref(1), ref(2)], request)).toEqual(actual);
  expect(await gitlab.fetchByRef(ref(2))).toEqual(actual[1]);
  expect(run.mock.calls.filter(([, args]) => args.at(-1) === "graphql")).toHaveLength(1);
  expect(run.mock.calls.filter(([, args]) => args.at(-1) === `${prefix}/2`)).toHaveLength(3);
});

it("leaves an already observed page standing while a later page honors date Retry-After", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const retryAt = Date.now() + 125_000;
    const takeToken = vi.fn(() => true);
    const run = vi.fn(async (_command: string, args: string[]) => {
      const endpoint = args.at(-1);
      if (endpoint === "graphql") {
        if (args.some((arg) => arg.includes('after: "next"'))) {
          throw cliHttpError(503, `Retry-After: ${new Date(retryAt).toUTCString()}\r\n`);
        }
        return graphPage([fixtureMr(1)], "next");
      }
      if (endpoint === `projects/${encodeURIComponent(project)}`) return "{}";
      throw new Error(`Unexpected fake transport request ${endpoint}`);
    });
    const gitlab = new GitLabPrFetcher({ discover, run, tryTakeRequestToken: takeToken });
    const request = { takeFirstRequestToken: takeToken, defer: vi.fn() };
    expect(await gitlab.pollProject([ref(1), ref(2)], request)).toEqual([parseGitLabMr(fixtureMr(1))]);
    expect(await gitlab.pollProject([ref(1), ref(2)], request)).toEqual([]);
    expect(run).toHaveBeenCalledTimes(3);
    expect(takeToken).toHaveBeenCalledTimes(3);
  } finally {
    vi.useRealTimers();
  }
});

it("admits a queued older-schema fallback only after the provider deadline", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 61, max: 300 }), async (seconds) => {
      const takeToken = vi.fn(() => true);
      const blockers = Array.from({ length: 3 }, () => Promise.withResolvers<string>());
      const run = vi.fn(async (_command: string, args: string[]) => {
        const endpoint = args.at(-1)!;
        if (endpoint.startsWith("blocker/")) return await blockers[Number(endpoint.at(-1))]!.promise;
        if (endpoint === "graphql") return JSON.stringify({ errors: [{ extensions: { code: "undefinedField" } }] });
        if (endpoint.startsWith(`${prefix}/`)) return JSON.stringify(fixtureMr(Number(endpoint.at(-1))));
        return "{}";
      });
      const gitlab = new GitLabPrFetcher({ discover, run, tryTakeRequestToken: takeToken });
      const request = { takeFirstRequestToken: takeToken, defer: vi.fn() };
      const refs = [ref(1), ref(2)];
      await gitlab.pollProject(refs, request);
      run.mockClear();
      takeToken.mockClear();
      const reads = blockers.map((_, index) => gitlab.readApi(host, `blocker/${index}`));
      const settled = Promise.allSettled(reads);
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(3));

      const waiting = gitlab.pollProject(refs, request);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(run).toHaveBeenCalledTimes(3);
      blockers[0]!.reject(cliHttpError(429, `Retry-After: ${seconds}\r\n`));
      expect(await waiting).toEqual([]);
      blockers[1]!.resolve("{}");
      blockers[2]!.resolve("{}");
      await settled;
      expect(run).toHaveBeenCalledTimes(3);
      expect(takeToken).toHaveBeenCalledTimes(3);

      const retryAt = Date.now() + seconds * 1000;
      vi.setSystemTime(retryAt - 1);
      expect(await gitlab.pollProject(refs, request)).toEqual([]);
      expect(takeToken).toHaveBeenCalledTimes(3);
      vi.setSystemTime(retryAt);
      expect(await gitlab.pollProject(refs, request)).toEqual([parseGitLabMr(fixtureMr(1)), parseGitLabMr(fixtureMr(2))]);
      expect(run).toHaveBeenCalledTimes(5);
      expect(takeToken).toHaveBeenCalledTimes(5);
    }), { numRuns: 20 });
  } finally {
    vi.useRealTimers();
  }
});
