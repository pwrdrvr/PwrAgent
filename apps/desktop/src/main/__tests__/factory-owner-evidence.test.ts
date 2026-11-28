import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import fc from "fast-check";
import { afterEach, expect, it, vi } from "vitest";
import type { FactoryProjectProjection } from "@pwragent/shared/factory-projection";
import { validateOpenAIDecisionInput } from "@pwragent/shared/openai-decisions";
import { appServerService, resetAppServerServiceForTests } from "../app-server/desktop-app-server-service";
import { runGitCommand } from "../app-server/git-executable";
import { collectFactoryProject } from "../factory/factory-evidence-collector";
import { handleOutpostCommand } from "../headless/outpost";
import { FACTORY_PR_DEFINITION, factoryEvidenceProblem } from "../openai-decisions/factory-pr-assessment";
import { ForgeCiClient } from "../pr-status/forge-ci-client";
import { resolveGitHubRepoForDirectory } from "../pr-status/git-remote";
import { measureSqliteWrites, readSqliteWriteMetrics, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { resetDesktopOverlayStoreForTests, setDesktopOverlayStoreForTests } from "../storage/desktop-overlay-store";
import { createThreadReviewStorage } from "../storage/desktop-runtime-storage";
import { SqliteOverlayStore } from "../storage/overlay-store-sqlite";
import { SqliteThreadReviewStorage } from "../storage/thread-review-storage-sqlite";
import { createTempStateDb, openFreshStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

vi.mock(import("../pr-status/git-remote"), async (load) => ({
  ...await load(),
  resolveGitHubRepoForDirectory: vi.fn(),
}));
vi.mock(import("../storage/desktop-runtime-storage"), async (load) => ({
  ...await load(), createThreadReviewStorage: vi.fn(),
}));

const projectKey = "directory:/synthetic/project";
const repositoryId = "R_synthetic";
const remote = { host: "github.com", owner: "pwrdrvr", repo: "Synthetic" };
const headOid = "a".repeat(40);
const baseOid = "b".repeat(40);
const older = "c".repeat(40);
const check = (conclusion = "SUCCESS") => ({ name: "build", status: "COMPLETED", conclusion });
const review = (state: string, revision = headOid) => ({ id: state, state, commit: { oid: revision } });

function pull(number = 7, id = repositoryId) {
  return { number, title: `Change ${number}`, state: "OPEN", isDraft: false, headRepository: { id } };
}

type ForgeFixtureOptions = {
  history?: number; limit?: number; actualHead?: string; actualBase?: string; checkHead?: string;
  checks?: ReturnType<typeof check>[]; checkRollup?: string; reviews?: ReturnType<typeof review>[];
  truncated?: boolean; selected?: boolean; headRepositoryId?: string;
  suites?: { status: string; workflowRun: { id: string } | null }[]; suitesTruncated?: boolean;
};

function forgeFixture({
  history = 25, limit = 25, actualHead = headOid, actualBase = baseOid, checkHead = actualHead,
  checks = [check()], checkRollup = "SUCCESS", reviews = [review("APPROVED")],
  truncated = false, selected = true, headRepositoryId = repositoryId, suites = [], suitesTruncated = false,
}: ForgeFixtureOptions = {}) {
  return { data: { repository: {
    id: repositoryId, nameWithOwner: "pwrdrvr/Synthetic",
    pullRequests: {
      nodes: Array.from({ length: Math.min(history, limit) }, (_, index) => pull(index + 1)),
      pageInfo: { hasNextPage: history > limit },
    },
    selected: selected ? {
      ...pull(7, headRepositoryId), headRefOid: actualHead, baseRefOid: actualBase, baseRef: { target: { oid: actualBase } },
      headRefName: "factory/fixture", baseRefName: "main",
      commits: { nodes: [{ commit: { oid: checkHead, checkSuites: { nodes: suites, pageInfo: { hasNextPage: suitesTruncated } }, statusCheckRollup: {
        state: checkRollup, contexts: { pageInfo: { hasNextPage: truncated }, nodes: checks },
      } } }] },
      reviews: { nodes: reviews },
    } : null,
  } } };
}

const request = {
  projectKey, repository: remote.repo,
  selection: {
    repositoryId, number: 7, expected: { headOid, baseOid }, requiredChecks: ["build"],
    assessment: { outcome: "Exercise the core behavior", change: "Add a guarded owner read" },
  },
};

function readEvidence(page: FactoryProjectProjection) {
  if (page.selected?.kind !== "observed") throw new Error("Expected a selected PR observation.");
  return page.selected.evidence;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.mocked(resolveGitHubRepoForDirectory).mockReset();
  vi.mocked(createThreadReviewStorage).mockReset();
  resetDesktopOverlayStoreForTests();
});

it("reads a parked or checked-out issue candidate without a forge call and keeps its identity after publication", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const root = await mkdtemp(path.join(tmpdir(), "factory-branch-"));
  const projectPath = path.join(root, "project");
  const worktree = path.join(root, "worktree");
  const dbFixture = createTempStateDb("factory-branch-db-");
  const db = openFreshStateDb(dbFixture.dbPath);
  try {
    await mkdir(projectPath);
    const commit = ["-c", "user.name=Factory", "-c", "user.email=factory@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m"];
    await runGitCommand(projectPath, ["init", "--template=", "-b", "main"]);
    await runGitCommand(projectPath, [...commit, "base"]);
    await runGitCommand(projectPath, ["worktree", "add", "-b", "factory/fixture", worktree]);
    await runGitCommand(worktree, [...commit, "candidate"]);
    const actualHead = (await runGitCommand(worktree, ["rev-parse", "HEAD"])).stdout.trim();
    const actualBase = (await runGitCommand(projectPath, ["rev-parse", "HEAD"])).stdout.trim();
    await runGitCommand(projectPath, ["remote", "add", "origin", "https://github.com/pwrdrvr/Synthetic.git"]);
    await runGitCommand(projectPath, ["update-ref", "refs/remotes/origin/main", actualBase]);
    const store = new SqliteOverlayStore(db);
    const key = `directory:${projectPath}`;
    await store.upsertDirectoryLaunchpad({
      directoryKey: key, directoryKind: "directory", directoryLabel: "Synthetic", directoryPath: projectPath,
      registeredAt: 1, backend: "codex", executionMode: "default", workMode: "local", prompt: "", createdAt: 1, updatedAt: 1,
    });
    const reviews = new SqliteThreadReviewStorage(db);
    reviews.insert({
      backend: "codex", threadId: "fixture-thread", id: "fixture-review", origin: "automatic", sourceKey: "fixture-artifact",
      title: "Synthetic review", status: "handled", items: [], createdAt: 1, updatedAt: 1,
      context: { workspacePath: worktree, repositoryPath: projectPath, gitBranch: "factory/fixture", baseCommit: actualBase, headCommit: actualHead },
    });
    setDesktopOverlayStoreForTests(store);
    vi.mocked(createThreadReviewStorage).mockReturnValue(reviews);
    resetAppServerServiceForTests();
    vi.mocked(resolveGitHubRepoForDirectory).mockResolvedValue(remote);
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(forgeFixture({ actualHead, actualBase })));
    vi.spyOn(appServerService, "getForgeCiClient").mockReturnValue(new ForgeCiClient({
      gitlab: {} as never, enabled: () => true, takeToken: () => true, fetch: fetcher, githubToken: async () => "synthetic-token",
    }));
    const services = { service: appServerService } as Parameters<typeof handleOutpostCommand>[0];
    const read = (params: Record<string, unknown>) => handleOutpostCommand(services, "factory-board", params) as Promise<FactoryProjectProjection>;
    const candidate = {
      issueId: "10000000-0000-4000-a000-000000000001", branch: "factory/fixture", baseRef: "refs/remotes/origin/main",
      worktree, reviewIds: ["fixture-review"], assessment: request.selection.assessment,
    };
    const params = { projectKey: key, repository: remote.repo, candidate };
    const { writes } = await measureSqliteWrites(async () => {
      const unpublished = await read(params);
      expect(unpublished.authority.source).toBe("local_owner_git");
      expect(unpublished.inventory).toBe("unobserved");
      expect(unpublished.pullRequests).toEqual([]);
      expect(unpublished.selected).toBeUndefined();
      expect(unpublished.candidate).toMatchObject({
        stage: "branch", publication: "unobserved", headOid: actualHead, baseOid: actualBase,
        authority: { source: "local_owner_git", runtimeInstanceId: expect.any(String), profile: expect.any(String) },
        receipts: [{ source: "owner_review", kind: "review", status: "inconclusive", headOid: actualHead, mergeBaseOid: actualBase }],
      });
      expect(unpublished.candidate?.assessment).not.toHaveProperty("pullRequest");
      expect(validateOpenAIDecisionInput(FACTORY_PR_DEFINITION.inputSchema, unpublished.candidate?.assessment).ok).toBe(true);
      expect(factoryEvidenceProblem(unpublished.candidate?.assessment)).toBeUndefined();
      const parked = await read({ ...params, candidate: { ...candidate, worktree: undefined } });
      expect(parked.candidate).toMatchObject({ stage: "parked", headOid: actualHead, outcomeId: unpublished.candidate?.outcomeId });
      expect(parked.candidate?.receipts).toHaveLength(1);
      await runGitCommand(projectPath, ["update-ref", "refs/tags/refs/heads/missing", actualHead]);
      const absent = await read({ ...params, candidate: { ...candidate, branch: "missing" } });
      expect(absent.candidate?.headOid).toBeUndefined();
      expect(absent.candidate?.assessment).toBeUndefined();
      expect(fetcher).not.toHaveBeenCalled();
      const { issueId, ...branch } = candidate;
      const workItems = [
        { provider: "github", kind: "issue", repositoryId, number: 7 },
        { provider: "github", kind: "pull_request", repositoryId, number: 7 },
        { provider: "jira", siteId: "site-a", id: "10007" },
        { provider: "jira", siteId: "site-b", id: "10007" },
        { provider: "linear", id: issueId },
      ];
      const keys = new Set<string>();
      for (const workItem of workItems) {
        const observed = (await read({ ...params, candidate: { ...branch, workItem } })).candidate!;
        expect(observed.workItem).toEqual(workItem);
        expect(observed.stage).toBe("branch");
        expect(observed.assessment).toMatchObject({ candidate: { issue: observed.outcomeId } });
        if (workItem.provider === "linear") expect(observed.outcomeId).toBe(unpublished.candidate?.outcomeId);
        keys.add(observed.outcomeId);
      }
      expect(keys.size).toBe(workItems.length);
      await expect(read({ ...params, candidate: { ...candidate, workItem: workItems[0] } })).rejects.toThrow();
      expect(fetcher).not.toHaveBeenCalled();
      const published = await read({ ...params, selection: { repositoryId, number: 7 } });
      expect(readEvidence(published).revision).toEqual({ headOid: actualHead, baseOid: actualBase });
      expect(published.candidate).toMatchObject({ stage: "published", publication: "confirmed", outcomeId: unpublished.candidate?.outcomeId });
      expect(fetcher).toHaveBeenCalledTimes(1);
      const selectPr = (number: number, repoId: string) => read({ ...params, selection: { repositoryId, number: 7 },
        candidate: { ...branch, workItem: { provider: "github", kind: "pull_request", repositoryId: repoId, number } } });
      expect((await selectPr(7, repositoryId)).candidate?.publication).toBe("confirmed");
      expect((await selectPr(8, repositoryId)).candidate?.publication).toBe("mismatch");
      expect((await selectPr(7, "another-repository")).candidate?.publication).toBe("mismatch");
      fetcher.mockResolvedValueOnce(Response.json(forgeFixture({ actualHead: older, actualBase })));
      const changed = await read({ ...params, selection: { repositoryId, number: 7, expected: { headOid: actualHead, baseOid: actualBase } } });
      expect(readEvidence(changed).revisionState).toBe("head_changed");
      expect(changed.candidate).toMatchObject({ publication: "revision_changed", outcomeId: unpublished.candidate?.outcomeId });
      fetcher.mockResolvedValueOnce(Response.json(forgeFixture({ actualHead, actualBase: older })));
      const movedBase = await read({ ...params, selection: { repositoryId, number: 7 } });
      expect(movedBase.candidate).toMatchObject({ publication: "revision_changed", outcomeId: unpublished.candidate?.outcomeId });
      await runGitCommand(projectPath, [...commit, "advance target"]);
      const advanced = (await runGitCommand(projectPath, ["rev-parse", "HEAD"])).stdout.trim();
      await runGitCommand(projectPath, ["update-ref", "refs/remotes/origin/main", advanced]);
      const behind = await read(params);
      expect(behind.candidate?.receipts).toContainEqual(expect.objectContaining({ status: "inconclusive", mergeBaseOid: actualBase }));
      expect(behind.candidate?.assessment?.evidence).toContainEqual(expect.objectContaining({ kind: "review", headSha: actualHead }));
      expect(behind.candidate?.assessment?.evidence[0]).not.toHaveProperty("baseSha");
    });
    expect(writes).toMatchObject({ commits: 0, statements: 0, rowsChanged: 0 });
  } finally {
    db.close();
    removeTempStateDbDir(dbFixture.tempDir);
    await rm(root, { recursive: true, force: true });
  }
});

it("reads unattached project PRs and a selected revision through the Outpost operator command with zero SQLite writes", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const fixture = createTempStateDb("factory-evidence-");
  const db = openFreshStateDb(fixture.dbPath);
  const store = new SqliteOverlayStore(db);
  try {
    setDesktopOverlayStoreForTests(store);
    await store.upsertDirectoryLaunchpad({
      directoryKey: projectKey, directoryKind: "directory", directoryLabel: "Synthetic",
      directoryPath: "/synthetic/project", registeredAt: 1, backend: "codex", executionMode: "default",
      workMode: "local", prompt: "", createdAt: 1, updatedAt: 1,
    });
    expect(readSqliteWriteMetrics()?.commits).toBeGreaterThan(0);
    resetAppServerServiceForTests();
    vi.mocked(resolveGitHubRepoForDirectory).mockResolvedValue(remote);
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const { query, variables } = JSON.parse(String(init?.body));
      expect(query).toContain("repository(owner: $owner, name: $name)");
      expect(variables).toMatchObject({ owner: remote.owner, name: remote.repo, limit: 25 });
      return Response.json(forgeFixture());
    });
    const client = new ForgeCiClient({
      gitlab: {} as never, enabled: () => true, takeToken: () => true, fetch: fetcher,
      githubToken: async () => "synthetic-token",
    });
    vi.spyOn(appServerService, "getForgeCiClient").mockReturnValue(client);
    const services = { service: appServerService } as Parameters<typeof handleOutpostCommand>[0];
    const { writes } = await measureSqliteWrites(async () => {
      const first = await handleOutpostCommand(services, "factory-board", { projectKey, repository: remote.repo }) as FactoryProjectProjection;
      expect(first.pullRequests).toHaveLength(25);
      expect(first.repository).toEqual({ host: remote.host, id: repositoryId, owner: remote.owner, name: remote.repo });
      expect(first.selected).toBeUndefined();
      const second = await handleOutpostCommand(services, "factory-board", request) as FactoryProjectProjection;
      const evidence = readEvidence(second);
      expect(evidence).toMatchObject({ revision: { headOid, baseOid }, ci: "passed", review: "inconclusive", candidate: { kind: "none" } });
      expect(evidence.assessment?.evidence).toContainEqual(expect.objectContaining({ observation: expect.stringContaining("build") }));
      expect(factoryEvidenceProblem(evidence.assessment)).toBeUndefined();
      expect(validateOpenAIDecisionInput(FACTORY_PR_DEFINITION.inputSchema, evidence.assessment).ok).toBe(true);
      await expect(handleOutpostCommand(services, "factory-board", { ...request, projectKey: "directory:/other-profile" }))
        .rejects.toThrow("Select a registered first-party project");
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(writes).toMatchObject({ commits: 0, statements: 0, rowsChanged: 0, walBytes: 0 });
  } finally {
    db.close();
    removeTempStateDbDir(fixture.tempDir);
  }
});

function collector(fixture = forgeFixture()) {
  return {
    resolveProject: vi.fn(async () => ({ path: "/synthetic/project", origin: remote })),
    github: vi.fn(async () => fixture),
    cachedStatus: vi.fn(() => undefined),
    readReview: vi.fn(() => undefined),
    now: () => 100_000,
  };
}

it("compares an open PR against the live target tip even when its recorded base has not changed", async () => {
  const fixture = forgeFixture();
  fixture.data.repository.selected!.baseRef.target.oid = older;
  const evidence = readEvidence(await collectFactoryProject(request, collector(fixture)));
  expect(evidence).toMatchObject({ revision: { headOid, baseOid: older }, revisionState: "base_changed" });
  expect(evidence.assessment).toBeUndefined();
});

it("resolves repository ownership from the registered project", async () => {
  const fixture = forgeFixture();
  fixture.data.repository.nameWithOwner = "AnotherTeam/Synthetic";
  const ports = {
    ...collector(fixture),
    resolveProject: vi.fn(async () => ({ path: "/synthetic/project", origin: { ...remote, owner: "AnotherTeam" } })),
  };
  const result = await collectFactoryProject(request, ports);
  expect(result.repository.owner).toBe("AnotherTeam");
  expect(ports.github).toHaveBeenCalledTimes(1);
});

it("carries a failing rollup and blocked review into the advisory evidence even when another test passed", async () => {
  const result = await collectFactoryProject(request, collector(forgeFixture({
    checks: [check(), { ...check("FAILURE"), name: "upgrade" }], checkRollup: "FAILURE",
    reviews: [review("CHANGES_REQUESTED")],
  })));
  const packet = readEvidence(result).assessment;
  expect(packet?.evidence).toEqual(expect.arrayContaining([
    expect.objectContaining({ observation: expect.stringMatching(/failed/i) }),
    expect.objectContaining({ observation: expect.stringMatching(/blocked/i) }),
  ]));
  expect(factoryEvidenceProblem(packet)).toBeUndefined();
});

it("distinguishes empty, failed, skipped, incomplete and conflicting CI receipts", async () => {
  const examples = [
    { checks: [], checkRollup: "SUCCESS", ci: "absent" },
    { checks: [check("FAILURE")], checkRollup: "FAILURE", ci: "failed" },
    { checks: [check("SKIPPED")], checkRollup: "SUCCESS", ci: "inconclusive" },
    { checks: [check()], truncated: true, ci: "inconclusive" },
    { checks: [check(), check("FAILURE")], ci: "conflict" },
    { checkHead: older, ci: "absent" },
    { suites: [{ status: "QUEUED", workflowRun: { id: "run" } }], ci: "pending" },
    { suites: [{ status: "QUEUED", workflowRun: null }], ci: "passed" },
    { suitesTruncated: true, ci: "inconclusive" },
  ];
  for (const { ci, ...example } of examples) {
    const evidence = readEvidence(await collectFactoryProject(request, collector(forgeFixture(example))));
    expect(evidence.ci).toBe(ci);
    expect(evidence.candidate.kind).toBe("none");
  }
});

it("does not treat an old review or stale cache as evidence for the selected revision", async () => {
  const fixture = forgeFixture({ actualBase: older, reviews: [review("APPROVED", older)] });
  const ports = {
    ...collector(fixture),
    cachedStatus: () => ({
      pr: { headSha: headOid, baseSha: baseOid, checkState: "passing" as const },
      fetchedAt: 99_999,
    }),
  };
  const evidence = readEvidence(await collectFactoryProject(request, ports));
  expect(evidence).toMatchObject({ revisionState: "base_changed", review: "stale_head" });
  expect(evidence.receipts).toContainEqual(expect.objectContaining({ source: "owner_pr_status", status: "stale_base" }));
  expect(evidence.assessment).toBeUndefined();
});

it("distinguishes current contradictory receipts from an expired cache observation", async () => {
  const ports = collector(forgeFixture({ reviews: [review("APPROVED"), review("CHANGES_REQUESTED")] }));
  const pr = { headSha: headOid, baseSha: baseOid, checkState: "failing" as const };
  const conflicting = readEvidence(await collectFactoryProject(request, {
    ...ports, cachedStatus: () => ({ pr, fetchedAt: 99_999 }),
  }));
  expect(conflicting).toMatchObject({ ci: "conflict", review: "conflict" });
  expect(conflicting.receipts).toContainEqual(expect.objectContaining({ source: "owner_pr_status", status: "conflict" }));
  const expired = readEvidence(await collectFactoryProject(request, {
    ...ports, cachedStatus: () => ({ pr, fetchedAt: 1 }),
  }));
  expect(expired.ci).toBe("passed");
  expect(expired.receipts).toContainEqual(expect.objectContaining({ source: "owner_pr_status", status: "stale" }));
});

it("refuses a different immutable repo and withholds evidence for forks and missing PRs", async () => {
  await expect(collectFactoryProject({
    ...request, selection: { ...request.selection, repositoryId: "R_replacement" },
  }, collector())).rejects.toThrow("could not be confirmed");
  const fork = readEvidence(await collectFactoryProject(request, collector(forgeFixture({ headRepositoryId: "R_other" }))));
  expect(fork).toMatchObject({ revisionState: "outside_scope", ci: "absent", review: "absent" });
  expect(fork.revision).toBeUndefined();
  expect(fork.assessment).toBeUndefined();
  const missing = await collectFactoryProject(request, collector(forgeFixture({ selected: false })));
  expect(missing.selected).toEqual({ kind: "absent" });
});

it("binds evidence and the advisory packet to exactly the observed head/base pair", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), fc.boolean(), fc.boolean(), async (moveHead, moveBase, reverse) => {
    const actualHead = moveHead ? older : headOid;
    const actualBase = moveBase ? older : baseOid;
    const checks = [check(), { ...check(), name: "lint" }];
    const fixture = forgeFixture({ actualHead, actualBase, checks: reverse ? checks.toReversed() : checks });
    const evidence = readEvidence(await collectFactoryProject(request, collector(fixture)));
    const oracle = moveHead ? moveBase ? "head_and_base_changed" : "head_changed" : moveBase ? "base_changed" : "current";
    expect(evidence.revisionState).toBe(oracle);
    expect(evidence.revision).toEqual({ headOid: actualHead, baseOid: actualBase });
    expect(evidence.assessment !== undefined).toBe(!moveHead && !moveBase);
    const baseline = readEvidence(await collectFactoryProject(request, collector(forgeFixture({ actualHead, actualBase, checks }))));
    expect(evidence.digest).toBe(baseline.digest);
  }), { seed: 41073, numRuns: 5 });
});

it.each([25, 50, 100])("reads one bounded page and one selected PR at a project size of %s", async (history) => {
  const ports = collector(forgeFixture({ history }));
  const result = await collectFactoryProject(request, ports);
  expect(result.pullRequests).toHaveLength(25);
  expect(result.truncated).toBe(history > 25);
  expect(ports.github).toHaveBeenCalledTimes(1);
  expect(ports.resolveProject).toHaveBeenCalledTimes(1);
  expect(ports.cachedStatus).toHaveBeenCalledTimes(1);
});
