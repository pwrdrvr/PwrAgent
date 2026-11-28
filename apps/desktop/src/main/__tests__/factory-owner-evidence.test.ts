import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import fc from "fast-check";
import { afterEach, expect, it, vi } from "vitest";
import { buildPullRequestStatusKey, type PrSummary } from "@pwragent/shared/contracts/navigation";
import type { FactoryProjectProjection } from "@pwragent/shared/factory-projection";
import { validateOpenAIDecisionInput } from "@pwragent/shared/openai-decisions";
import { appServerService, resetAppServerServiceForTests } from "../app-server/desktop-app-server-service";
import { runGitCommand } from "../app-server/git-executable";
import * as gitExecutable from "../app-server/git-executable";
import { resolveReviewProvenance } from "../app-server/review-provenance";
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
import { isolateProcessGitEnvironment } from "./helpers/isolated-git";
import { createTempStateDb, openFreshStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

vi.mock(import("../pr-status/git-remote"), async (load) => {
  const actual = await load();
  return {
    ...actual,
    resolveGitHubFetchUrl: (url: string) => actual.resolveGitHubFetchUrl(url,
      async (host) => host === "github-work" ? "github.com" : host),
  };
});
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
const review = (state: string, revision = headOid, url?: string) => ({ id: state, state, url, commit: { oid: revision } });

function pull(number = 7, id = repositoryId) {
  return { number, title: `Change ${number}`, state: "OPEN", isDraft: false, headRepository: { id } };
}

type ForgeFixtureOptions = {
  history?: number; limit?: number; actualHead?: string; actualBase?: string; checkHead?: string;
  checks?: ReturnType<typeof check>[]; checkRollup?: string; reviews?: ReturnType<typeof review>[];
  truncated?: boolean; reviewsTruncated?: boolean; selected?: boolean; headRepositoryId?: string;
  suites?: { status: string; workflowRun: { id: string } | null }[]; suitesTruncated?: boolean;
};

function forgeFixture({
  history = 25, limit = 25, actualHead = headOid, actualBase = baseOid, checkHead = actualHead,
  checks = [check()], checkRollup = "SUCCESS", reviews = [review("APPROVED")],
  truncated = false, reviewsTruncated = false, selected = true, headRepositoryId = repositoryId, suites = [], suitesTruncated = false,
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
      reviews: { nodes: reviews, pageInfo: { hasPreviousPage: reviewsTruncated } },
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
  vi.mocked(createThreadReviewStorage).mockReset();
  resetDesktopOverlayStoreForTests();
});

it("reads a parked or checked-out issue candidate without a forge call and keeps its identity after publication", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const root = await mkdtemp(path.join(tmpdir(), "factory-branch-"));
  const projectPath = path.join(root, "project");
  const worktree = path.join(root, "literal", "review");
  const restoreEnv = isolateProcessGitEnvironment(root);
  const dbFixture = createTempStateDb("factory-branch-db-");
  const db = openFreshStateDb(dbFixture.dbPath);
  try {
    await mkdir(projectPath);
    const commit = ["-c", "user.name=Factory", "-c", "user.email=factory@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m"];
    await runGitCommand(projectPath, ["init", "--template=", "-b", "main"]);
    await writeFile(path.join(projectPath, "answer.txt"), "40\n");
    await runGitCommand(projectPath, ["add", "--", "answer.txt"]);
    await runGitCommand(projectPath, [...commit, "base"]);
    await mkdir(path.dirname(worktree));
    await runGitCommand(projectPath, ["worktree", "add", "-b", "factory/fixture", worktree]);
    const answer = path.join(worktree, "answer.txt");
    await writeFile(answer, "41\n");
    await runGitCommand(worktree, ["add", "--", "answer.txt"]);
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
    // A reviewer reading the checkout saw the unstaged fix. The committed
    // branch still returns the wrong answer even after that review settles.
    await writeFile(answer, "42\n");
    const context = await resolveReviewProvenance({
      cwd: worktree, target: { type: "baseBranch", branch: "origin/main" },
    });
    expect(context).toMatchObject({ headCommit: actualHead, baseCommit: actualBase });
    expect(context?.reviewedTree).toBeUndefined();
    expect((await runGitCommand(worktree, ["show", "HEAD:answer.txt"])).stdout.trim()).toBe("41");
    expect((await runGitCommand(worktree, ["diff", actualBase, "--", "answer.txt"])).stdout).toContain("+42");
    await writeFile(answer, "41\n");
    expect(await readFile(answer, "utf8")).toBe("41\n");
    expect((await runGitCommand(worktree, ["status", "--porcelain"])).stdout).toBe("");
    const reviews = new SqliteThreadReviewStorage(db);
    reviews.insert({
      backend: "codex", threadId: "fixture-thread", id: "fixture-review", origin: "automatic", sourceKey: "fixture-artifact",
      title: "Synthetic review", status: "handled", items: [], createdAt: 1, updatedAt: 1,
      context: { ...context!, repositoryPath: projectPath },
    });
    setDesktopOverlayStoreForTests(store);
    vi.mocked(createThreadReviewStorage).mockReturnValue(reviews);
    resetAppServerServiceForTests();
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
    const caseVariant = path.join(root, "literal", "Review");
    const sameDirectory = await stat(caseVariant).then(() => true, () => false);
    if (!sameDirectory) await mkdir(caseVariant);
    reviews.insert({
      backend: "codex", threadId: "fixture-thread", id: "case-review", origin: "automatic", sourceKey: "fixture-case",
      title: "Review from a case variant", status: "handled", items: [], createdAt: 1, updatedAt: 1,
      context: { ...context!, workspacePath: caseVariant },
    });
    if (process.platform !== "win32") {
      const different = path.join(root, "literal\\review");
      await mkdir(different);
      reviews.insert({
        backend: "codex", threadId: "fixture-thread", id: "different-path-review", origin: "automatic", sourceKey: "fixture-path",
        title: "Review from a different directory", status: "handled", items: [], createdAt: 1, updatedAt: 1,
        context: { ...context!, workspacePath: different },
      });
    }
    const params = { projectKey: key, repository: remote.repo, candidate };
    const { writes } = await measureSqliteWrites(async () => {
      await runGitCommand(projectPath, ["remote", "set-url", "origin", "git@github-work:pwrdrvr/Synthetic.git"]);
      await runGitCommand(projectPath, ["branch", "fixture+ipc", actualHead]);
      await runGitCommand(projectPath, ["branch", "target+ipc", actualBase]);
      const plus = await read({ ...params, candidate: { ...candidate, branch: "fixture+ipc", baseRef: "refs/heads/target+ipc" } });
      expect(plus.candidate).toMatchObject({ headOid: actualHead, baseOid: actualBase });
      const git = vi.spyOn(gitExecutable, "runGitCommand");
      const unpublished = await read(params);
      const gitCalls = git.mock.calls.map(([, args]) => args);
      expect(gitCalls).toHaveLength(10);
      expect(gitCalls.filter(([command]) => command === "symbolic-ref")).toEqual([["symbolic-ref", "--quiet", "HEAD"]]);
      expect(gitCalls.every(([command]) =>
        ["remote", "rev-parse", "check-ref-format", "for-each-ref", "symbolic-ref", "config"].includes(command))).toBe(true);
      await expect(read({ ...params, candidate: { ...candidate, branch: "fixture*ipc" } })).rejects.toThrow();
      expect(unpublished.authority.source).toBe("local_owner_git");
      expect(unpublished.inventory).toBe("unobserved");
      expect(unpublished.pullRequests).toEqual([]);
      expect(unpublished.selected).toBeUndefined();
      expect.soft(unpublished.candidate).toMatchObject({
        stage: "branch", publication: "unobserved", headOid: actualHead, baseOid: actualBase,
        authority: { source: "local_owner_git", runtimeInstanceId: expect.any(String), profile: expect.any(String) },
        receipts: [{ source: "owner_review", kind: "review", status: "inconclusive" }],
      });
      expect.soft(unpublished.candidate?.receipts[0]).not.toHaveProperty("headOid");
      expect.soft(unpublished.candidate?.assessment?.evidence).toEqual([]);
      expect(unpublished.candidate?.assessment).not.toHaveProperty("pullRequest");
      expect(validateOpenAIDecisionInput(FACTORY_PR_DEFINITION.inputSchema, unpublished.candidate?.assessment).ok).toBe(true);
      expect(factoryEvidenceProblem(unpublished.candidate?.assessment)).toBeUndefined();
      const parked = await read({ ...params, candidate: { ...candidate, worktree: undefined } });
      expect(parked.candidate).toMatchObject({ stage: "parked", headOid: actualHead, outcomeId: unpublished.candidate?.outcomeId });
      expect(parked.candidate?.receipts).toHaveLength(1);
      const caseRead = await read({ ...params, candidate: { ...candidate, reviewIds: ["case-review"] } });
      expect.soft(caseRead.candidate?.receipts).toHaveLength(sameDirectory ? 1 : 0);
      if (process.platform !== "win32") {
        const otherPath = await read({ ...params, candidate: { ...candidate, reviewIds: ["different-path-review"] } });
        expect.soft(otherPath.candidate?.receipts).toHaveLength(0);
      }
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
      expect(behind.candidate?.receipts).toContainEqual(expect.objectContaining({ status: "inconclusive", name: "fixture-review" }));
      expect.soft(behind.candidate?.assessment?.evidence).toEqual([]);
      await runGitCommand(projectPath, ["config", "--replace-all", "remote.origin.fetch", "+refs/heads/main:refs/cache/target"]);
      await runGitCommand(projectPath, ["update-ref", "refs/cache/target", actualBase]);
      await runGitCommand(projectPath, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/cache/target"]);
      const symbolic = { ...params, candidate: { ...candidate, baseRef: "refs/remotes/origin/HEAD" }, selection: { repositoryId, number: 7 } };
      expect.soft((await read(symbolic)).candidate).toMatchObject({ baseOid: actualBase, publication: "confirmed" });
      await runGitCommand(projectPath, ["config", "--add", "remote.origin.fetch", "+refs/heads/release:refs/cache/target"]);
      expect.soft((await read(symbolic)).candidate).toMatchObject({ publication: "mismatch", baseOid: undefined });
    });
    expect(writes).toMatchObject({ commits: 0, statements: 0, rowsChanged: 0 });
  } finally {
    db.close();
    removeTempStateDbDir(dbFixture.tempDir);
    restoreEnv();
    await rm(root, { recursive: true, force: true });
  }
});

it("reads unattached project PRs and a selected revision through the Outpost operator command with zero SQLite writes", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const root = await mkdtemp(path.join(tmpdir(), "factory-owner-origin-"));
  const restoreEnv = isolateProcessGitEnvironment(root);
  const key = `directory:${root}`;
  const fixture = createTempStateDb("factory-evidence-");
  const db = openFreshStateDb(fixture.dbPath);
  const store = new SqliteOverlayStore(db);
  try {
    await runGitCommand(root, ["init", "--template=", "-b", "main"]);
    await runGitCommand(root, ["remote", "add", "origin", "https://github.com/pwrdrvr/Synthetic.git"]);
    setDesktopOverlayStoreForTests(store);
    await store.upsertDirectoryLaunchpad({
      directoryKey: key, directoryKind: "directory", directoryLabel: "Synthetic",
      directoryPath: root, registeredAt: 1, backend: "codex", executionMode: "default",
      workMode: "local", prompt: "", createdAt: 1, updatedAt: 1,
    });
    expect(readSqliteWriteMetrics()?.commits).toBeGreaterThan(0);
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
    const pr: PrSummary = {
      provider: "github.com", org: remote.owner, repo: remote.repo, number: 7,
      url: "https://github.com/pwrdrvr/Synthetic/pull/7", state: "unknown",
      lifecycleState: "open", headSha: headOid, baseSha: baseOid, checkState: "failing",
    };
    const prKey = buildPullRequestStatusKey(pr);
    await store.writePrStatusCacheEntries([
      { prKey, pr, provider: pr.provider, fetchedAt: Date.now() - 1_000 },
      ...Array.from({ length: 100 }, (_, i) => {
        const unrelated = { ...pr, number: i + 8, url: `https://github.com/pwrdrvr/Synthetic/pull/${i + 8}` };
        return { prKey: buildPullRequestStatusKey(unrelated), pr: unrelated, provider: pr.provider, fetchedAt: Date.now() };
      }),
    ]);
    resetAppServerServiceForTests();
    vi.spyOn(appServerService, "getForgeCiClient").mockReturnValue(client);
    const services = { service: appServerService } as Parameters<typeof handleOutpostCommand>[0];
    const durable = vi.spyOn(store, "readPrStatusCache");
    const { writes } = await measureSqliteWrites(async () => {
      const first = await handleOutpostCommand(services, "factory-board", { projectKey: key, repository: remote.repo }) as FactoryProjectProjection;
      expect(first.pullRequests).toHaveLength(25);
      expect(first.repository).toEqual({ host: remote.host, id: repositoryId, owner: remote.owner, name: remote.repo });
      expect(first.selected).toBeUndefined();
      const second = await handleOutpostCommand(services, "factory-board", { ...request, projectKey: key }) as FactoryProjectProjection;
      const evidence = readEvidence(second);
      expect(evidence).toMatchObject({ revision: { headOid, baseOid }, ci: "conflict", review: "inconclusive", candidate: { kind: "none" } });
      expect(evidence.assessment?.evidence).toContainEqual(expect.objectContaining({ observation: expect.stringContaining("build") }));
      expect(factoryEvidenceProblem(evidence.assessment)).toBeUndefined();
      expect(validateOpenAIDecisionInput(FACTORY_PR_DEFINITION.inputSchema, evidence.assessment).ok).toBe(true);
      await expect(handleOutpostCommand(services, "factory-board", { ...request, projectKey: "directory:/other-profile" }))
        .rejects.toThrow("Select a registered first-party project");
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(durable.mock.calls).toEqual([[prKey]]);
    expect(Object.keys(await durable.mock.results[0]?.value)).toEqual([prKey]);
    expect(appServerService.getCachedPrStatus(prKey)).toBeUndefined();
    expect(writes).toMatchObject({ commits: 0, statements: 0, rowsChanged: 0, walBytes: 0 });

    const readDurable = SqliteOverlayStore.prototype.readPrStatusCache.bind(store);
    const pointRead = Promise.withResolvers<void>();
    const releasePoint = Promise.withResolvers<void>();
    durable.mockImplementationOnce(async (...args) => {
      const entries = await readDurable(...args);
      pointRead.resolve();
      await releasePoint.promise;
      return entries;
    });
    const board = appServerService.readFactoryProject({ ...request, projectKey: key });
    await Promise.race([pointRead.promise, board]);
    expect(durable).toHaveBeenCalledTimes(2);
    await store.writePrStatusCacheEntries([{
      prKey, pr: { ...pr, checkState: "passing" }, provider: pr.provider, fetchedAt: Date.now(),
    }]);
    try {
      await appServerService.canonicalizeStoredPullRequests([pr], undefined, false);
    } finally {
      releasePoint.resolve();
    }
    expect(readEvidence(await board)).toEqual(readEvidence(await appServerService.readFactoryProject({ ...request, projectKey: key })));
    expect(durable.mock.calls.slice(1)).toEqual([[prKey], []]);

    const git = vi.spyOn(gitExecutable, "runGitCommand");
    const discoverySampled = Promise.withResolvers<void>();
    const releaseDiscovery = Promise.withResolvers<void>();
    const staleDiscovery = resolveGitHubRepoForDirectory(root, {
      readRemotes: async () => {
        const { stdout } = await runGitCommand(root, ["remote", "get-url", "origin"]);
        discoverySampled.resolve();
        await releaseDiscovery.promise;
        return [{ name: "origin", url: stdout.trim() }];
      },
    });
    await discoverySampled.promise;
    await runGitCommand(root, ["remote", "add", "upstream", "https://github.com/other/Other.git"]);
    await runGitCommand(root, ["remote", "set-url", "origin", "git@github-work:second-fork/Synthetic.git"]);
    git.mockClear();
    const fork = forgeFixture();
    fork.data.repository.nameWithOwner = "second-fork/Synthetic";
    fork.data.repository.id = "R_second_fork";
    fetcher.mockResolvedValueOnce(Response.json(fork));
    const switched = appServerService.readFactoryProject({ projectKey: key, repository: remote.repo });
    // Let the new owner read start while the earlier discovery is still pending.
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseDiscovery.resolve();
    expect(await staleDiscovery).toMatchObject(remote);
    expect((await switched).repository).toMatchObject({ owner: "second-fork", id: "R_second_fork" });
    expect(git.mock.calls.map(([, args]) => args)).toEqual([["remote", "get-url", "--", "origin"]]);
    await runGitCommand(root, ["remote", "remove", "origin"]);
    await expect(appServerService.readFactoryProject({ projectKey: key, repository: remote.repo }))
      .rejects.toThrow("Select a registered first-party project");
  } finally {
    db.close();
    removeTempStateDbDir(fixture.tempDir);
    restoreEnv();
    await rm(root, { recursive: true, force: true });
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
    { checkHead: older, ci: "inconclusive" },
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

it("accepts only a selected-PR NOT_FOUND partial response through ForgeCiClient", async () => {
  const missing = forgeFixture({ selected: false });
  const error = { type: "NOT_FOUND", path: ["repository", "selected"], message: "Could not resolve pull request" };
  const fetcher = vi.fn<typeof fetch>();
  const client = new ForgeCiClient({
    gitlab: {} as never, enabled: () => true, takeToken: () => true, fetch: fetcher, githubToken: async () => "synthetic-token",
  });
  const read = () => collectFactoryProject(request, { ...collector(), github: client.requestGithub.bind(client) });
  for (const errors of [
    [{ ...error, type: "FORBIDDEN" }],
    [{ ...error, path: ["repository"] }],
    [{ ...error, path: ["repository", "selected", "commits"] }],
    [error, { ...error, path: ["repository", "pullRequests"] }],
  ]) {
    fetcher.mockResolvedValueOnce(Response.json({ ...missing, errors }));
    await expect(read()).rejects.toThrow("GitHub GraphQL refused");
  }
  fetcher.mockResolvedValueOnce(Response.json({ ...forgeFixture(), errors: [error] }));
  await expect(read()).rejects.toThrow("GitHub GraphQL refused");
  const partial = (repository: object) => Response.json({ data: { repository }, errors: [error] });
  fetcher.mockResolvedValueOnce(partial({ ...missing.data.repository, id: "incorrect-repository" }));
  await expect(read()).rejects.toThrow("could not be confirmed");
  fetcher.mockResolvedValueOnce(partial({ ...missing.data.repository, pullRequests: null }));
  await expect(read()).rejects.toThrow("invalid project PR list");
  fetcher.mockResolvedValueOnce(Response.json({ ...missing, errors: [error] }));
  await expect(read()).resolves.toMatchObject({ inventory: "observed", selected: { kind: "absent" } });
});

it("qualifies review coverage when GitHub has earlier opinionated reviews", async () => {
  for (const state of [undefined, "CHANGES_REQUESTED"]) {
    const ports = collector(forgeFixture({ reviews: state ? [review(state)] : [], reviewsTruncated: true }));
    const evidence = readEvidence(await collectFactoryProject(request, ports));
    expect.soft(ports.github.mock.calls[0]).toEqual([
      expect.anything(),
      expect.objectContaining({ body: expect.objectContaining({ query: expect.stringContaining("hasPreviousPage") }) }),
    ]);
    expect.soft(evidence).toMatchObject({ reviewCoverage: "incomplete", review: state ? "blocked" : "inconclusive" });
    expect(ports.github).toHaveBeenCalledOnce();
  }
});

it.each([64, 65, 128, 256])("distinguishes a missing required check from the unread tail of %s contexts", async (count) => {
  const checks = Array.from({ length: count }, (_, i) => ({ ...check(), name: i === 64 ? "build" : `extra-${i}` }));
  const ports = collector(forgeFixture({ checks: checks.slice(0, 64), truncated: count > 64 }));
  const evidence = readEvidence(await collectFactoryProject(request, ports));
  expect(ports.github).toHaveBeenCalledOnce();
  expect(evidence.receipts.find(({ required, name }) => required && name === "build")?.status)
    .toBe(count > 64 ? "inconclusive" : "absent");
});

it("treats live ERROR and FAILURE as conflicting with a fresh passing cache for the same revision", async () => {
  for (const checkRollup of ["FAILURE", "ERROR"]) {
    const evidence = readEvidence(await collectFactoryProject(request, {
      ...collector(forgeFixture({ checkRollup })), cachedStatus: () => ({
        pr: { headSha: headOid, baseSha: baseOid, checkState: "passing" }, fetchedAt: 99_999,
      }),
    }));
    expect(evidence.ci).toBe("conflict");
  }
});

it("opens GitHub review permalinks without credentials, query, or arbitrary fragments", async () => {
  const canonical = "https://github.com/pwrdrvr/Synthetic/pull/7";
  for (const [url, expected] of [
    ["https://reader:token@github.com/pwrdrvr/Synthetic/pull/7?private=yes#pullrequestreview-123", canonical + "#pullrequestreview-123"],
    [canonical + "?private=yes#pullrequestreview-nope", canonical],
    [canonical + "#unrelated", canonical],
    ["https://example.invalid/pull/7#pullrequestreview-123", canonical],
    ["blob:" + canonical + "#pullrequestreview-123", canonical],
  ]) {
    const fixture = forgeFixture({ reviews: [review("CHANGES_REQUESTED", headOid, url)] });
    const evidence = readEvidence(await collectFactoryProject(request, collector(fixture)));
    expect.soft(evidence.receipts).toContainEqual(expect.objectContaining({ kind: "review", reference: expected }));
  }
});
